// Operazioni del validatore di cluster (§7.3): ammissione · rigetto motivato ·
// fusione (> 70%) · scissione (> 40 membri, varianza alta) · quarantena ·
// campionamento del 10% · deprecazione (vuoto per 2 digestioni).
//
// Severità: un item entra se e solo se soddisfa tutti i criteri di inclusione
// e nessuno di esclusione; nel dubbio non entra, e il dubbio è registrato
// (cluster_events). La decisione è di DT-005 valutata da dt-eval, sugli esiti
// dei criteri calcolati da cluster-rules. Transazioni brevi, output JSON.
import { readFileSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { openDb } from "./db.mjs";
import { rootFromDb } from "../lib/root-from-db.mjs";
import { evaluateCriterion, matchesSignature, jaccard, checkCluster, validateCluster } from "./cluster-rules.mjs";
import { evaluate, loadTable, writeDecision } from "../decide/dt-eval.mjs";
import { parseCode } from "./codes.mjs";
import { hasParsedMandatory } from "./validate-fld.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";

export class AdmissionError extends Error {
  constructor(verdict, rule, criterion, message) { super(message); this.name = "AdmissionError"; this.verdict = verdict; this.rule = rule; this.criterion = criterion; }
}
export class PolicyError extends Error { constructor(m) { super(m); this.name = "PolicyError"; } }
export class NotFoundError extends Error { constructor(m) { super(m); this.name = "NotFoundError"; } }
export class UsageError extends Error { constructor(m) { super(m); this.name = "UsageError"; } }

const DT005 = loadTable("DT-005");
const DEFAULT_CLUSTERS_DIR = fileURLToPath(new URL("../../clusters", import.meta.url));
const nowIso = (now) => now ?? new Date().toISOString();

// ——— giudizio puro ———
export function judgeAdmission(cluster, item, { priors = {} } = {}) {
  const inclusion = cluster.inclusion.map((c, i) => ({ id: c.id ?? `inclusion[${i}]`, result: evaluateCriterion(c, item) }));
  // §19.6.4 passo 6: un FLD entra in CL-FLD-MAND solo se la regola di obbligatorietà è
  // parsata (kind del vocabolario), mai da testo libero. Criterio implicito della famiglia,
  // valutato per primo: il rigetto nomina I-PARSED.
  if (cluster.family === "CL-FLD-MAND") inclusion.unshift({ id: "I-PARSED", result: hasParsedMandatory(item) });
  const exclusion = cluster.exclusion.map((c, i) => ({ id: c.id ?? `exclusion[${i}]`, result: evaluateCriterion(c, item) }));
  const incFalse = inclusion.find((x) => x.result === false);
  const incNull = inclusion.find((x) => x.result === null);
  const excTrue = exclusion.find((x) => x.result === true);
  const excNull = exclusion.find((x) => x.result === null);
  const inputs = {
    inclusion: incFalse ? "qualcuno-falso" : incNull ? "qualcuno-indeterminato" : "tutti-veri",
    exclusion: excTrue ? "almeno-uno" : excNull ? "indeterminato" : "nessuno",
    signature_match: matchesSignature(item, cluster.facet_signature ?? {}),
  };
  const dt = evaluate(DT005, inputs, { priors });
  const verdict = dt.outcome;
  // La regola attribuita segue l'ordine degli override di DT-005.
  let rule = "ok";
  let criterion = null;
  if (verdict !== "ammesso") {
    if (excTrue) { rule = `exclusion:${excTrue.id}`; criterion = excTrue.id; }
    else if (incFalse) { rule = `inclusion:${incFalse.id}`; criterion = incFalse.id; }
    else if (incNull) { rule = `undetermined:${incNull.id}`; criterion = incNull.id; }
    else if (excNull) { rule = `undetermined:${excNull.id}`; criterion = excNull.id; }
    else { rule = "signature"; criterion = "facet_signature"; }
  }
  return { verdict, rule, criterion, inclusion, exclusion, dt: { table: dt.table, table_version: dt.table_version, score: dt.score, outcome: dt.outcome, rule: dt.rule, inputs: dt.inputs }, dtResult: dt };
}

// ——— accesso al DB ———
function logEvent(db, { at, op, cluster = null, item = null, reason = null, decision = null, payload = null }) {
  db.prepare("insert into cluster_events(at,op,cluster_code,item_code,reason,decision_code,payload) values (?,?,?,?,?,?,?)")
    .run(at, op, cluster, item, reason, decision, payload === null ? null : JSON.stringify(payload));
}
export function loadCluster(db, code) {
  const r = db.prepare("select c.*, d.domain, d.depth, d.parent, d.empty_digests, d.merged_into from clusters c left join cluster_details d on d.code = c.code where c.code = ?").get(code);
  if (!r) throw new NotFoundError(`cluster inesistente: ${code}`);
  return { ...r, inclusion: JSON.parse(r.inclusion), exclusion: JSON.parse(r.exclusion), facet_signature: JSON.parse(r.facet_signature ?? "{}"),
    portability: JSON.parse(r.portability ?? "{}") };
}
export function loadItem(db, code, { root } = {}) {
  const r = db.prepare("select code, type, facets, path, status from items where code = ?").get(code);
  if (!r) throw new NotFoundError(`item inesistente: ${code}`);
  let content = {};
  if (root && r.path && existsSync(join(root, r.path))) content = YAML.parse(readFileSync(join(root, r.path), "utf8")) ?? {};
  // lo stato nel DB (es. quarantena) prevale su quello del file
  const facets = { ...(content.facets ?? {}), ...JSON.parse(r.facets), F12: r.status };
  return { ...content, id: r.code, type: r.type, facets };
}
const members = (db, code) => db.prepare("select item_code from cluster_members where cluster_code = ? order by item_code").all(code).map((r) => r.item_code);

// ——— operazioni ———
// La DEC di DT-005 (log_as: DEC) è scritta con lo stesso percorso di dt-eval
// (writeDecision: riga in decisions + <root>/decisions/<codice>.yaml) prima di
// restituire l'esito, anche quando l'item non entra (§29.6: una DEC per ogni
// valutazione). Il codice DEC è registrato nel membro e nell'evento.
// `root` = cartella del cliente (item YAML e decisions/); `customer` serve per
// gli item S (il codice DEC è sempre di livello L con un cliente, §5).
export function admit(db, clusterCode, itemCode, { root, customer, agent = "cluster-validator", session = null, priors = {}, now } = {}) {
  const at = nowIso(now);
  if (!root) throw new UsageError("admit richiede root (cartella del cliente: item e decisions/)");
  const cluster = loadCluster(db, clusterCode);
  if (["fuso", "deprecato"].includes(cluster.status)) throw new PolicyError(`cluster ${clusterCode} non ammette membri (stato ${cluster.status})`);
  const item = loadItem(db, itemCode, { root });
  const code = parseCode(itemCode);
  const cust = customer ?? (code && code.level !== "S" ? code.customer : null);
  if (!cust) throw new UsageError(`admit di ${itemCode}: serve customer (4 caratteri) per il codice della DEC`);
  // §19.6.3: un FLD appartiene a esattamente un cluster CL-FLD di sezione e a esattamente un
  // CL-FLD-MAND. Un secondo cluster della stessa famiglia è un rifiuto di policy: prima si
  // rigetta (reject) l'appartenenza esistente.
  if (["CL-FLD", "CL-FLD-MAND"].includes(cluster.family)) {
    const other = db.prepare(`select m.cluster_code from cluster_members m join clusters c on c.code = m.cluster_code
      where c.family = ? and m.item_code = ? and m.cluster_code <> ?`).get(cluster.family, itemCode, clusterCode);
    if (other) throw new PolicyError(`${itemCode} è già in ${other.cluster_code}: un FLD sta in esattamente un cluster ${cluster.family} (§19.6.3)`);
  }
  const j = judgeAdmission(cluster, item, { priors });
  let decCode = null;
  db.transaction(() => {
    decCode = writeDecision(db, { customer: cust, scope: code.scope, root, result: j.dtResult, agent, session, subject: itemCode, cluster: clusterCode, at });
    if (j.verdict === "ammesso") {
      db.prepare("insert or ignore into cluster_members(cluster_code,item_code,admitted_at,decision_code) values (?,?,?,?)").run(clusterCode, itemCode, at, decCode);
      logEvent(db, { at, op: "admit", cluster: clusterCode, item: itemCode, decision: decCode, payload: { dt: j.dt } });
    } else {
      logEvent(db, { at, op: "admit-denied", cluster: clusterCode, item: itemCode, reason: `${j.verdict}: ${j.rule}`, decision: decCode, payload: { dt: j.dt } });
    }
  })();
  if (j.verdict !== "ammesso") {
    const err = new AdmissionError(j.verdict, j.rule, j.criterion, `${itemCode} non entra in ${clusterCode}: ${j.verdict}, criterio ${j.criterion} (nel dubbio non entra)`);
    err.dec_code = decCode;
    throw err;
  }
  return { ok: true, verdict: j.verdict, rule: j.rule, cluster: clusterCode, item: itemCode, dec_code: decCode, dt: j.dt };
}

export function reject(db, clusterCode, itemCode, { reason, now } = {}) {
  if (!reason || !String(reason).trim()) throw new PolicyError("il rigetto richiede un motivo (rigetto motivato, §7.3)");
  loadCluster(db, clusterCode);
  const at = nowIso(now);
  let was_member = false;
  db.transaction(() => {
    was_member = db.prepare("delete from cluster_members where cluster_code = ? and item_code = ?").run(clusterCode, itemCode).changes > 0;
    logEvent(db, { at, op: "reject", cluster: clusterCode, item: itemCode, reason });
  })();
  return { ok: true, cluster: clusterCode, item: itemCode, reason, was_member };
}

export function merge(db, a, b, { now } = {}) {
  const ca = loadCluster(db, a);
  const cb = loadCluster(db, b);
  if (ca.family !== cb.family) throw new PolicyError(`fusione solo nella stessa famiglia (${ca.family} ≠ ${cb.family})`);
  const A = members(db, a);
  const B = members(db, b);
  const overlap = jaccard(A, B);
  if (!(overlap > 0.7)) throw new PolicyError(`sovrapposizione ${Math.round(overlap * 100)}%: la fusione richiede > 70%`);
  const at = nowIso(now);
  let moved = 0;
  db.transaction(() => {
    const ins = db.prepare("insert or ignore into cluster_members(cluster_code,item_code,admitted_at,decision_code) select ?, item_code, admitted_at, decision_code from cluster_members where cluster_code = ? and item_code = ?");
    for (const m of B) moved += ins.run(a, b, m).changes;
    db.prepare("delete from cluster_members where cluster_code = ?").run(b);
    db.prepare("update clusters set status = 'fuso' where code = ?").run(b);
    db.prepare("insert into cluster_details(code, merged_into) values (?, ?) on conflict(code) do update set merged_into = excluded.merged_into").run(b, a);
    logEvent(db, { at, op: "merge", cluster: a, reason: `${b} fuso in ${a}`, payload: { from: b, overlap } });
  })();
  return { ok: true, merged_into: a, from: b, overlap: Math.round(overlap * 1e4) / 1e4, moved };
}

export function split(db, code, { facet, minShare = 0.2, now } = {}) {
  if (!/^F([1-9]|1[0-5])$/.test(facet ?? "")) throw new PolicyError("split richiede --facet Fn su cui misurare la varianza");
  loadCluster(db, code);
  const ms = members(db, code);
  if (ms.length <= 40) throw new PolicyError(`${ms.length} membri: la scissione richiede > 40 membri`);
  const get = db.prepare("select facets, status from items where code = ?");
  const groups = new Map();
  for (const m of ms) {
    const row = get.get(m);
    const f = row ? JSON.parse(row.facets) : {};
    const v = f[facet] === undefined ? "(assente)" : Array.isArray(f[facet]) ? [...f[facet]].sort().join("+") : String(f[facet]);
    if (!groups.has(v)) groups.set(v, []);
    groups.get(v).push(m);
  }
  const list = [...groups.entries()].map(([value, mm]) => ({ value, count: mm.length, share: Math.round((mm.length / ms.length) * 1e4) / 1e4, members: mm }))
    .sort((x, y) => y.count - x.count || x.value.localeCompare(y.value));
  const strong = list.filter((g) => g.share >= minShare);
  if (strong.length < 2) throw new PolicyError(`varianza bassa su ${facet}: meno di due gruppi con quota ≥ ${minShare * 100}%`);
  logEvent(db, { at: nowIso(now), op: "split-proposed", cluster: code, reason: `scissione proposta su ${facet}`, payload: { groups: list.map(({ members: _, ...g }) => g) } });
  // Proposta, non esecuzione: i cluster figli richiedono nome, definizione e criteri (RC-02, RC-03).
  return { ok: true, proposal: true, cluster: code, members: ms.length, by: facet, groups: list };
}

// Il file è la verità (§8.1): la quarantena scrive `F12: quarantena` nel file
// dell'item (uno script, non un agente, §29.6) e nel DB, così il reindex la
// mantiene. Scrittura del file nella stessa transazione della riga.
export function quarantine(db, itemCode, reason, { root, now } = {}) {
  if (!reason || !String(reason).trim()) throw new PolicyError("la quarantena richiede un motivo (il dubbio è registrato)");
  if (!root) throw new UsageError("quarantine richiede root (cartella del cliente con il file dell'item)");
  const row = db.prepare("select path from items where code = ?").get(itemCode);
  if (!row) throw new NotFoundError(`item inesistente: ${itemCode}`);
  const file = join(root, row.path);
  if (!existsSync(file)) throw new NotFoundError(`file dell'item non trovato: ${file}`);
  const at = nowIso(now);
  db.transaction(() => {
    db.prepare("update items set status = 'quarantena' where code = ?").run(itemCode);
    logEvent(db, { at, op: "quarantine", item: itemCode, reason });
    const doc = YAML.parseDocument(readFileSync(file, "utf8"));
    doc.setIn(["facets", "F12"], "quarantena");
    writeFileSync(file, doc.toString());
  })();
  return { ok: true, item: itemCode, status: "quarantena", reason, file: row.path };
}

// PRNG deterministico (mulberry32) seminato dall'hash del seme.
function rng(seed) {
  let a = createHash("sha256").update(String(seed)).digest().readUInt32LE(0);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function sample(db, family, { pct = 10, seed } = {}) {
  if (seed === undefined || seed === null || seed === "") throw new PolicyError("il campionamento richiede un seed (riproducibile)");
  const pop = db.prepare(`select m.cluster_code as cluster, m.item_code as item from cluster_members m join clusters c on c.code = m.cluster_code
    where c.family = ? order by m.cluster_code, m.item_code`).all(family);
  const k = pop.length ? Math.ceil((pop.length * pct) / 100) : 0;
  const next = rng(seed);
  const idx = pop.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [idx[i], idx[j]] = [idx[j], idx[i]]; }
  const picked = idx.slice(0, k).sort((x, y) => x - y).map((i) => pop[i]);
  return { ok: true, family, pct, seed: String(seed), population: pop.length, sample: picked };
}

export function recordDigest(db, { now } = {}) {
  const at = nowIso(now);
  const rows = db.prepare(`select c.code, (select count(*) from cluster_members m where m.cluster_code = c.code) as n from clusters c
    where c.status not in ('fuso','deprecato') order by c.code`).all();
  let empty = 0;
  db.transaction(() => {
    const upd = db.prepare(`insert into cluster_details(code, empty_digests) values (?, ?) on conflict(code) do update set
      empty_digests = case when ? > 0 then 0 else cluster_details.empty_digests + 1 end`);
    for (const r of rows) { upd.run(r.code, r.n ? 0 : 1, r.n); if (!r.n) empty++; }
    logEvent(db, { at, op: "digest-tick", reason: `${empty} cluster vuoti su ${rows.length}` });
  })();
  return { ok: true, clusters: rows.length, empty };
}

export function deprecate(db, code, { now } = {}) {
  const c = loadCluster(db, code);
  const n = members(db, code).length;
  if (n > 0) throw new PolicyError(`${code} ha ${n} membri: si depreca solo un cluster vuoto`);
  if ((c.empty_digests ?? 0) < 2) throw new PolicyError(`${code} vuoto da ${c.empty_digests ?? 0} digestioni: servono 2 digestioni`);
  db.transaction(() => {
    db.prepare("update clusters set status = 'deprecato' where code = ?").run(code);
    logEvent(db, { at: nowIso(now), op: "deprecate", cluster: code, reason: "vuoto per 2 digestioni" });
  })();
  return { ok: true, cluster: code, status: "deprecato" };
}

// ——— CLI ———
const HELP = `uso: node scripts/kb/cluster.mjs <comando> [argomenti] --db <file> [--json] [--help]

Comandi (§7.3):
  admit <CL-…> <codice-item> [--root <dir cliente>] [--customer ACME]     ammissione con DT-005 (scrive la DEC)
  reject <CL-…> <codice-item> --reason "<motivo>"                        rigetto motivato
  merge <CL-a> <CL-b>                                                    fusione se sovrapposizione > 70%
  split <CL-…> --facet Fn                                                proposta di scissione (> 40 membri, varianza alta)
  quarantine <codice-item> --reason "<motivo>" [--root <dir cliente>]    item in quarantena (anche nel file)
            (--root: default la cartella di --db se è <cartella>/knowledge.db)
  sample <famiglia> --seed <seme> [--pct 10]                             campione deterministico
  digest-tick                                                            conta le digestioni a vuoto
  deprecate <CL-…>                                                       deprecazione (vuoto per 2 digestioni)
  check [--clusters <dir>]                                               RC-01..RC-10 sul catalogo di file

Exit code: 0 ok · 1 errore utente (argomenti, cluster o item inesistente) · 2 errore di sistema ·
3 rifiuto di policy (non ammesso: nel dubbio non entra; fusione/scissione/deprecazione non consentite).`;

function checkCatalog(dir) {
  const files = [];
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (/^CL-.+\.ya?ml$/.test(e.name)) files.push(p);
    }
  };
  walk(dir);
  const cat = files.map((f) => YAML.parse(readFileSync(f, "utf8")));
  return cat.map((c) => {
    const v = validateCluster(c);
    const r = checkCluster(c, { familyClusters: cat.filter((x) => x.family === c.family), members: [], catalog: cat });
    return { code: c.code, ok: v.ok && r.ok, schema: v.errors, failed: r.results.filter((x) => !x.ok) };
  });
}
function main(argv) {
  const [cmd, ...rest] = argv;
  const { opts, positional } = parseArgs(rest);
  const asJson = !!opts.json || argv.includes("--json");
  if (!cmd || cmd === "--help" || opts.help) { console.log(HELP); return cmd ? 0 : 1; }
  const out = (o) => { console.log(JSON.stringify(o)); return 0; };
  if (cmd === "check") {
    const dir = opts.clusters ?? DEFAULT_CLUSTERS_DIR;
    const res = checkCatalog(dir);
    const bad = res.filter((r) => !r.ok);
    console.log(JSON.stringify({ ok: bad.length === 0, checked: res.length, failed: bad }));
    return bad.length ? 3 : 0;
  }
  const need = { admit: 2, reject: 2, merge: 2, split: 1, quarantine: 1, sample: 1, deprecate: 1, "digest-tick": 0 }[cmd];
  if (need === undefined) return fail(asJson, 1, `comando sconosciuto: ${cmd}`);
  if (positional.length < need) return fail(asJson, 1, `${cmd}: argomenti mancanti (vedi --help)`);
  if (!opts.db) return fail(asJson, 1, "richiesto --db <file>");
  let db;
  try { db = openDb(opts.db, { createIfMissing: false }); } catch (e) { return fail(asJson, 1, String(e.message ?? e)); }
  try {
    const [a, b] = positional;
    switch (cmd) {
      case "admit": return out(admit(db, a, b, { root: rootFromDb(opts), customer: opts.customer, agent: opts.agent ?? "cluster-validator", session: opts.session ?? null }));
      case "reject": return out(reject(db, a, b, { reason: opts.reason }));
      case "merge": return out(merge(db, a, b));
      case "split": return out(split(db, a, { facet: opts.facet }));
      case "quarantine": return out(quarantine(db, a, opts.reason, { root: rootFromDb(opts) }));
      case "sample": return out(sample(db, a, { pct: opts.pct ? Number(opts.pct) : 10, seed: opts.seed }));
      case "digest-tick": return out(recordDigest(db));
      case "deprecate": return out(deprecate(db, a));
    }
    return 1;
  } catch (e) {
    if (e instanceof AdmissionError) return fail(asJson, 3, e.message, { verdict: e.verdict, rule: e.rule, criterion: e.criterion, dec_code: e.dec_code });
    if (e instanceof UsageError) return fail(asJson, 1, e.message);
    if (e instanceof PolicyError) return fail(asJson, 3, e.message);
    if (e instanceof NotFoundError) return fail(asJson, 1, e.message);
    return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`);
  } finally { db.close(); }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
