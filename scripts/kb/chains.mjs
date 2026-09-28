// Ricostruzione delle catene logiche fra documenti (§19.6.4 passi 5-6, §19.6.3, §27.2, ADR-77).
//
//   lineageRelations(item) → [{ from, to, kind, detail }]    kind: propagates_to · required_by · derived_from
//     FLD: lineage.propagates_to (campo → campo a valle), lineage.required_by (campo → chi lo
//          richiede: INT, FLD…), lineage.derived_from (campo → sorgente);
//     INT: mappings[{ field, target, mandatory }] → (campo → INT, required_by, mandatory_there);
//     LCY: mandatory_by_state{ STATO: [campi] } → (campo → LCY, required_by, reason_kind workflow).
//   chains(items, { existing? }) → { proposed[], rejected[], reasons[], questions[], unexplained[], relations[] }
//     Passata separata SOLO sui FLD con mandatory.kind ≠ never (+ i mapping INT obbligatori e i LCY):
//     componenti connesse del grafo lineage; una catena entra (proposta CL-FLD-CHAIN) solo con
//     ≥ 3 FLD di ≥ 2 documenti, altrimenti è rifiutata con il motivo. I campi sono in ordine di
//     processo (propagates_to/derived_from). Se il campo d'origine soddisfa i criteri di un
//     CL-FLD-CHAIN esistente, la proposta punta a quello (niente duplicati); altrimenti propone il
//     primo codice libero con un file CLS in stato quarantena (da confermare dal consulente).
//     reasons: reason.kind dedotta (integration se un mapping INT obbligatorio lo richiede, workflow
//     se un LCY lo richiede per stato) quando diversa da quella dichiarata;
//     questions: campi obbligatori con reason ui e nessun'altra ragione a valle → domanda (ADR-77);
//     unexplained: campi obbligatori senza ragione né catena a valle (§19.6.4: candidati a domande).
//   writeRelations(db, relations) → n   upsert in relations (+ field_lineage se la tabella esiste).
// CLI: node scripts/kb/chains.mjs --root <dir> [--db <file>] [--write-proposals] [--json]
import { readFileSync, readdirSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { parseCode } from "./codes.mjs";
import { evaluateCriterion } from "./cluster-rules.mjs";
import { openDb } from "./db.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";

const CLUSTERS_DIR = fileURLToPath(new URL("../../clusters/CL-FLD-CHAIN", import.meta.url));
const MANDATORY = new Set(["always", "conditional", "undocumented"]);
const typeOf = (code) => parseCode(String(code ?? ""))?.type ?? null;

const mappingField = (m) => (m?.field && typeOf(m.field) === "FLD" ? m.field : m?.field_ref && typeOf(m.field_ref) === "FLD" ? m.field_ref : null);

// field_ref (id grezzo dell'estrazione, scripts/ingest/extract.mjs) → field (codice FLD assegnato dalla digestione).
// codeOf: { rawId: codice } | (rawId) => codice. Un field_ref già codice FLD resta; uno non risolto va in unresolved.
export function normalizeIntMappings(intItem, codeOf = {}) {
  const lookup = typeof codeOf === "function" ? codeOf : (r) => codeOf?.[r] ?? null;
  const mappings = [];
  const unresolved = [];
  for (const m of intItem?.mappings ?? []) {
    const { field_ref: ref, field: f0, ...rest } = m ?? {};
    const field = f0 && typeOf(f0) === "FLD" ? f0 : ref && typeOf(ref) === "FLD" ? ref : ref ? lookup(ref) : null;
    if (!field || typeOf(field) !== "FLD") { unresolved.push(ref ?? f0 ?? null); continue; }
    mappings.push({ field, ...rest });
  }
  return { ...intItem, mappings, unresolved };
}

export function lineageRelations(item) {
  const out = [];
  if (!item?.id) return out;
  if (item.type === "FLD") {
    const l = item.lineage ?? {};
    for (const p of l.propagates_to ?? []) if (p?.field) out.push({ from: item.id, to: p.field, kind: "propagates_to", detail: { document: p.document ?? null, transform: p.transform ?? null, source: item.id } });
    for (const r of l.required_by ?? []) if (r?.ref) out.push({ from: item.id, to: r.ref, kind: "required_by", detail: { mapping: r.mapping ?? null, mandatory_there: r.mandatory_there ?? null, note: r.note ?? null, reason_kind: typeOf(r.ref) === "INT" ? "integration" : null, source: item.id, ...(r.one_of ? { one_of: { group: String(r.one_of.group), required: r.one_of.required === true } } : {}) } });
    if (l.derived_from) out.push({ from: item.id, to: l.derived_from, kind: "derived_from", detail: { source: item.id } });
  } else if (item.type === "INT") {
    // WP09b: mappings[].field è il codice FLD (schemas/int.schema.json); field_ref vale solo se è già un codice FLD
    // (l'id grezzo dell'estrazione si converte con normalizeIntMappings). one_of: obbligatorietà uno-fra (xs:choice).
    for (const m of item.mappings ?? []) {
      const field = mappingField(m);
      if (!field) continue;
      out.push({ from: field, to: item.id, kind: "required_by", detail: { mapping: m.target ?? null, mandatory_there: m.mandatory === true, reason_kind: "integration", source: item.id,
        ...(m.one_of ? { one_of: { group: String(m.one_of.group), required: m.one_of.required === true }, note: `uno fra le alternative del gruppo ${m.one_of.group}${m.one_of.required === true ? " (obbligatorio)" : " (facoltativo)"}` } : {}) } });
    }
  } else if (item.type === "LCY") {
    for (const [state, list] of Object.entries(item.mandatory_by_state ?? {})) for (const f of list ?? []) out.push({ from: f, to: item.id, kind: "required_by", detail: { note: `obbligatorio nello stato ${state} (${item.id})`, state, reason_kind: "workflow", source: item.id } });
  }
  return out;
}

export function writeRelations(db, relations) {
  const ins = db.prepare("insert or ignore into relations(from_code, to_code, kind) values (?,?,?)");
  const hasDetail = !!db.prepare("select name from sqlite_master where type='table' and name='field_lineage'").get();
  const det = hasDetail ? db.prepare(`insert into field_lineage(source_code, from_code, to_code, kind, document, transform, mapping, mandatory_there, note, reason_kind)
    values (@source,@from,@to,@kind,@document,@transform,@mapping,@mandatory_there,@note,@reason_kind)
    on conflict(source_code, from_code, to_code, kind) do update set document=excluded.document, transform=excluded.transform, mapping=excluded.mapping,
    mandatory_there=excluded.mandatory_there, note=excluded.note, reason_kind=excluded.reason_kind`) : null;
  let n = 0;
  db.transaction(() => {
    for (const r of relations) {
      n += ins.run(r.from, r.to, r.kind).changes;
      if (det) {
        const d = r.detail ?? {};
        det.run({ source: d.source ?? r.from, from: r.from, to: r.to, kind: r.kind, document: d.document ?? null, transform: d.transform ?? null, mapping: d.mapping ?? null,
          mandatory_there: d.mandatory_there === null || d.mandatory_there === undefined ? null : d.mandatory_there ? 1 : 0, note: d.note ?? null, reason_kind: d.reason_kind ?? null });
      }
    }
  })();
  return n;
}

export function loadChainClusters(dir = CLUSTERS_DIR) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^CL-FLD-CHAIN-\d{3}\.ya?ml$/.test(f)).map((f) => YAML.parse(readFileSync(join(dir, f), "utf8")));
}

const satisfies = (cluster, item) => (cluster.inclusion ?? []).every((c) => evaluateCriterion(c, item) === true)
  && !(cluster.exclusion ?? []).some((c) => evaluateCriterion(c, item) === true);
const shortDoc = (d) => String(d ?? "?").replace(/^document\./, "");

function processOrder(nodes, edges, rank) {
  const indeg = new Map(nodes.map((n) => [n, 0]));
  const next = new Map(nodes.map((n) => [n, []]));
  for (const [a, b] of edges) if (indeg.has(a) && indeg.has(b) && a !== b) { next.get(a).push(b); indeg.set(b, indeg.get(b) + 1); }
  const cmp = (x, y) => (rank(x) - rank(y)) || x.localeCompare(y);
  const queue = nodes.filter((n) => indeg.get(n) === 0).sort(cmp);
  const out = [];
  while (queue.length) {
    const n = queue.shift();
    out.push(n);
    for (const m of next.get(n)) { indeg.set(m, indeg.get(m) - 1); if (indeg.get(m) === 0) { queue.push(m); queue.sort(cmp); } }
  }
  for (const n of [...nodes].sort(cmp)) if (!out.includes(n)) out.push(n);   // cicli: in coda, in ordine stabile
  return out;
}

export function chains(items, { existing } = {}) {
  const byId = new Map(items.filter((i) => i?.id).map((i) => [i.id, i]));
  const flds = items.filter((i) => i?.type === "FLD");
  const relations = items.flatMap(lineageRelations);
  const seeds = new Set(flds.filter((f) => MANDATORY.has(f?.mandatory?.kind)).map((f) => f.id));
  // documento di ogni FLD: dal file, o da chi lo cita in propagates_to
  const docOf = new Map(flds.map((f) => [f.id, f.document]));
  for (const r of relations) if (r.kind === "propagates_to" && r.detail.document && !docOf.has(r.to)) docOf.set(r.to, r.detail.document);
  // lati della passata: dai soli FLD con obbligo; i mapping INT solo se obbligatori; i LCY
  const passEdges = relations.filter((r) => seeds.has(r.from) || (r.kind !== "required_by" && seeds.has(r.to)))
    .filter((r) => !(r.kind === "required_by" && typeOf(r.to) === "INT" && r.detail.mandatory_there === false && r.detail.one_of?.required !== true))
    .filter((r) => typeOf(r.to) !== "LCY");
  const parent = new Map();
  const find = (x) => { if (!parent.has(x)) parent.set(x, x); while (parent.get(x) !== x) { parent.set(x, parent.get(parent.get(x))); x = parent.get(x); } return x; };
  const union = (a, b) => { const ra = find(a); const rb = find(b); if (ra !== rb) parent.set(rb, ra); };
  for (const s of seeds) find(s);
  for (const r of passEdges) union(r.from, r.to);
  const comps = new Map();
  for (const n of parent.keys()) { const k = find(n); if (!comps.has(k)) comps.set(k, []); comps.get(k).push(n); }
  const chainClusters = existing ?? loadChainClusters();
  let nextSeq = Math.max(0, ...chainClusters.map((c) => Number(String(c.code).slice(-3))).filter(Number.isFinite)) + 1;
  const proposed = [];
  const rejected = [];
  const docRank = new Map();
  for (const [code, d] of docOf) if (!docRank.has(d)) docRank.set(d, docRank.size);
  for (const nodes of [...comps.values()].sort((a, b) => [...a].sort()[0].localeCompare([...b].sort()[0]))) {
    const fields = nodes.filter((n) => typeOf(n) === "FLD");
    if (nodes.length < 2) continue;   // campo isolato: nessuna catena da valutare
    const dirEdges = passEdges.filter((r) => nodes.includes(r.from) && nodes.includes(r.to))
      .flatMap((r) => (r.kind === "propagates_to" ? [[r.from, r.to]] : r.kind === "derived_from" ? [[r.to, r.from]] : []));
    const ordered = processOrder(fields, dirEdges, (n) => docRank.get(docOf.get(n)) ?? 999);
    const documents = [...new Set(ordered.map((f) => docOf.get(f)).filter(Boolean))];
    const ints = [...new Set(nodes.filter((n) => typeOf(n) === "INT"))].sort();
    const edges = passEdges.filter((r) => nodes.includes(r.from) && nodes.includes(r.to)).map((r) => ({ from: r.from, to: r.to, kind: r.kind, transform: r.detail.transform ?? null, mapping: r.detail.mapping ?? null }));
    if (fields.length < 3 || documents.length < 2) {
      rejected.push({ fields: ordered, documents, ints, reason: `${fields.length} FLD di ${documents.length} documenti: una catena richiede ≥ 3 FLD di ≥ 2 documenti (§19.6.4 passo 6)` });
      continue;
    }
    const head = byId.get(ordered[0]);
    const match = head ? chainClusters.find((c) => satisfies(c, head)) : null;
    const scope = parseCode(ordered[0])?.scope ?? null;
    const label = head?.label?.it ?? head?.label?.en ?? ordered[0];
    let cluster = null;
    let code;
    if (match) code = match.code;
    else {
      code = `CL-FLD-CHAIN-${String(nextSeq++).padStart(3, "0")}`;
      const known = ordered.map((f) => byId.get(f)).filter(Boolean);
      const keys = [...new Set(known.map((f) => f.key_ref).filter(Boolean))];
      cluster = {
        code, family: "CL-FLD-CHAIN", name: `${label} → ${documents.map(shortDoc).slice(1).join(" → ")}`,
        definition: `Insieme degli item che portano ${label} lungo la catena ${documents.map(shortDoc).join(", ")}${ints.length ? `, ${ints.join(", ")}` : ""}.`,
        inclusion: [keys.length === 1 && known.every((f) => f.key_ref === keys[0]) ? { id: "I1", field: "key_ref", op: "eq", value: keys[0] } : { id: "I1", field: "id", op: "in", value: ordered },
          { id: "I2", field: "type", op: "eq", value: "FLD" }],
        exclusion: [{ id: "E1", field: "type", op: "in", value: ["PAT", "PBK", "BRF", "RUL"], note: "dominio analitico escluso (§1.1)" }],
        facet_signature: { F4: "struttura-dati" }, owner: "process-mapper", portability: { class: "condizionata", condition: "F7" },
        domain: "kb", status: "quarantena", depth: 1, note: "proposta da scripts/kb/chains.mjs: catena da confermare (consulente, §33 K4)",
        sources: ["§19.6.3", "§19.6.4"],
      };
    }
    proposed.push({ cluster_code: code, new: !match, scope, fields: ordered, documents, ints, edges, cluster });
  }
  // ragioni dedotte e domande (§19.6.2 "mandatory.reason", ADR-77)
  const reasons = [];
  const questions = [];
  const unexplained = [];
  for (const f of flds.filter((x) => seeds.has(x.id))) {
    const req = relations.filter((r) => r.from === f.id && r.kind === "required_by");
    const intReq = req.find((r) => typeOf(r.to) === "INT" && r.detail.mandatory_there !== false);
    const wfReq = req.find((r) => r.detail.reason_kind === "workflow");
    const downstream = relations.some((r) => r.from === f.id && (r.kind === "propagates_to" || r.kind === "required_by"));
    const current = f.mandatory?.reason?.kind ?? null;
    const inferred = intReq ? { kind: "integration", ref: intReq.to } : wfReq ? { kind: "workflow", ref: wfReq.to } : null;
    if (inferred && current !== inferred.kind) reasons.push({ field: f.id, current, inferred });
    if (current === "ui" && !inferred && !downstream) {
      questions.push({ field: f.id, adr: "ADR-77", custom: !!f.custom, question: `Il campo ${f.id} è obbligatorio solo per la UI, senza ragione a valle: è voluto? (scelta di configurazione non documentata)` });
    } else if (!current && !inferred && !downstream) {
      unexplained.push({ field: f.id, custom: !!f.custom });
    }
  }
  return { proposed, rejected, reasons, questions, unexplained, relations };
}

// ——— CLI ———
function* walkItems(dir, { skipInbox = true } = {}) {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!e.name.startsWith(".") && !(skipInbox && e.name === "_inbox")) yield* walkItems(p, { skipInbox }); }
    else if (/^[SCL]\..+\.ya?ml$/.test(e.name)) yield p;
  }
}
export function loadItems(root) {
  const dirs = [];
  if (existsSync(join(root, "kb"))) dirs.push(join(root, "kb"));
  const inbox = join(root, "_inbox");
  if (existsSync(inbox)) for (const s of readdirSync(inbox, { withFileTypes: true })) if (s.isDirectory() && existsSync(join(inbox, s.name, "digested"))) dirs.push(join(inbox, s.name, "digested"));
  if (!dirs.length) dirs.push(root);
  const out = [];
  for (const d of dirs) for (const f of walkItems(d)) {
    const it = YAML.parse(readFileSync(f, "utf8"));
    if (it && ["FLD", "INT", "LCY"].includes(it.type)) out.push(it);
  }
  return out;
}

const HELP = `uso: node scripts/kb/chains.mjs --root <dir> [--db <file>] [--write-proposals] [--json] [--help]

Ricostruisce le catene logiche fra documenti (§19.6.4 passo 5) dai FLD con obbligo (kind ≠ never),
dai mapping INT obbligatori e dai LCY letti da <dir>/kb e <dir>/_inbox/*/digested: CL-FLD-CHAIN
proposti (≥ 3 FLD di ≥ 2 documenti, altrimenti rifiutati), reason dedotte, domande ADR-77.
--db: scrive il grafo lineage in relations. --write-proposals: le proposte in _inbox/<scope>/chains/.

Exit code: 0 ok · 1 errore utente (argomenti, DB assente) · 2 errore di sistema.`;

function main(argv) {
  const { opts } = parseArgs(argv, { flags: ["write-proposals"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.root || !existsSync(opts.root)) return fail(asJson, 1, "richiesto --root <dir> esistente");
  let db = null;
  try { if (opts.db) db = openDb(opts.db, { createIfMissing: false }); } catch (e) { return fail(asJson, 1, String(e.message ?? e)); }
  try {
    const r = chains(loadItems(opts.root));
    let relations_written = null;
    if (db) relations_written = writeRelations(db, r.relations);
    const written = [];
    if (opts["write-proposals"]) {
      for (const p of r.proposed) {
        const dir = join(opts.root, "_inbox", p.scope ?? "XSC", "chains");
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${p.cluster_code}.proposal.yaml`);
        writeFileSync(file, YAML.stringify(p));
        written.push(file);
      }
    }
    const { relations, ...rest } = r;
    console.log(JSON.stringify({ ok: true, ...rest, relations: relations.length, relations_written, proposals_written: written }));
    return 0;
  } catch (e) {
    return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`);
  } finally { db?.close(); }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
