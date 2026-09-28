// negative-generator (F6, F7, §27.2, §27.3): la tabella di deduzione vincolo → risk mode → test, come codice. Dagli item
// KEY, LCY, FLD, INT e HND produce SCHELETRI di casi NRT (NEG, INT, BSL, HND, POS) con derivation compilata, boundary
// dall'HND quando c'è, epistemic_at_generation e il proprietario del test; nrt-author compone poi i passi dalla FLW.
//
//   deduce(item, { byId }) → [deduzione]   una per risk mode (righe di §27.2):
//     KEY  uniqueness.scope ≠ none ⇒ NEG collisione · reuse_after_deactivation forbidden ⇒ NEG riuso · canale di
//          uniqueness.channels non in enforced_at ⇒ NEG aggiramento (BSL se enforced_at non è documentato) ·
//          immutable_after ⇒ NEG mutazione tardiva · max_length + transform senza troncamento esplicito ⇒ INT troncamento
//          silenzioso · format.pattern ⇒ NEG formato · cross_system senza verifica locale ⇒ INT (con l'INT) / BSL
//          riferimento pendente · document_impact blocking ⇒ INT propagazione · mandatory_in [S] ⇒ NEG obbligatorio omesso
//     LCY  validazione undocumented ⇒ BSL ignoto · mandatory_by_state ⇒ NEG obbligatorio omesso per stato · immutable_after
//     FLD  mandatory conditional con when ⇒ un NEG per stato × ruolo (condizione vera, campo vuoto) + un POS (condizione
//          falsa, campo vuoto) · by_role ⇒ NEG per ruolo · always ⇒ NEG obbligatorio omesso (per stato) · reason
//          integration ⇒ INT (il messaggio è rifiutato o segnalato, mai silente) · reason ui senza altra ragione ⇒ BSL +
//          domanda "è voluta?"
//     INT  contratto (L1 sul golden) · silence_semantics silenziosa ⇒ INT campo vuoto al tracciato
//     HND  asserts ⇒ HND · does_not_pass ⇒ NEG per voce (boundary dall'HND)
//     catene CL-FLD-CHAIN (lineage.propagates_to, scripts/kb/chains.mjs) ⇒ uno HND/INT per catena: valore integro a valle
//   Proprietà (§27.2, ultimo paragrafo): il proprietario della chiave testa gli invarianti intrinseci (scope del KEY);
//   chi possiede l'interfaccia testa la trasformazione (INT.owner_scope); il consumatore solo l'arrivo, fermandosi al
//   confine (HND); per le catene di campi il test è dello scope del documento di ORIGINE della catena.
//   Forma epistemica del soggetto (item.epistemic.shape, identity_quality.shape o shapes[codice]; senza dati: libresco,
//   la conoscenza dai documenti): ignoto ⇒ nessun caso, una richiesta di esplorazione (STR-EXPLORE-BUDGET); libresco ⇒
//   stato shadow con un'osservazione preliminare; altrimenti candidate.
//   generate(items, { customer, existing?, shapes? }) → { cases[], explorations[], questions[], dropped[] }
//     ogni caso passa da validateCase: senza derivation (o invalido) non è emesso (F7).
//
// CLI: node scripts/compile/negative-generator.mjs [--scope S] [--customer C] [--items-dir <dir>] [--write] [--workspace <dir>] [--json]
// Exit: 0 ok · 1 argomenti · 2 errore di sistema.
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { validateCase } from "../kb/validate-schema.mjs";
import { loadItems, scopeOf, typeOf, CODE_RE } from "../lib/kb-items.mjs";
import { chains as chainsOf } from "../kb/chains.mjs";
import { workspaceCustomer } from "../run/fixtures.mjs";

const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const labelOf = (it) => it?.label?.it ?? it?.label?.en ?? it?.title ?? it?.id;
const ERR_RE = /^[SCL]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.ERR\.\d{4}(\.v\d+)?$/;
const errorsOf = (it) => [...new Set([...asList(it?.validation).map((v) => v?.message_ref), ...asList(it?.validations).map((v) => v?.message_ref)].filter((x) => ERR_RE.test(String(x ?? ""))))];

export function deduce(item, { byId = new Map() } = {}) {
  const out = [];
  const t = item?.type;
  const s = scopeOf(item?.id);
  const lab = labelOf(item);
  const d = (genre, risk_mode, rule, extra = {}) => out.push({ genre, risk_mode, rule, from: [item.id, ...(extra.also ?? [])].filter((x) => CODE_RE.test(String(x))), owner: extra.owner ?? s, subject: item.id, label: lab, ...extra });
  const intOwner = (code) => (typeOf(code) === "INT" ? byId.get(code)?.owner_scope ?? scopeOf(code) : null);
  if (t === "KEY") {
    const u = item.uniqueness ?? {};
    if (u.scope && u.scope !== "none") d("NEG", "collisione", "§27.2 uniqueness.scope ≠ none", { expect: { rejected: true, reason: `${lab}: valore già usato nello scope ${u.scope}` } });
    if (item.reuse_after_deactivation === "forbidden") d("NEG", "riuso", "§27.2 reuse_after_deactivation: forbidden", { expect: { rejected: true, reason: `${lab}: riuso dopo la disattivazione` } });
    const enforced = asList(item.enforced_at);
    for (const ch of asList(u.channels).filter((c) => !enforced.includes(c))) {
      if (enforced.length) d("NEG", "aggiramento", `§27.2 enforced_at non copre il canale ${ch}`, { channel: ch, expect: { rejected: true, channel: ch } });
      else d("BSL", "aggiramento", `§27.2 enforcement sul canale ${ch} non documentato`, { channel: ch, expect: { baseline: `comportamento sul canale ${ch}` } });
    }
    const imm = item.immutable_after ?? item.mutability?.immutable_after;
    if (imm) d("NEG", "mutazione tardiva", `§27.2 immutable_after: ${imm}`, { state: imm, expect: { rejected: true, reason: `${lab} non modificabile dopo ${imm}` } });
    const f = item.format ?? {};
    if (f.max_length && f.transform && f.truncation !== "explicit") {
      const via = asList(item.cross_system).map((x) => x?.int).find((x) => typeOf(x) === "INT");
      d("INT", "troncamento silenzioso", "§27.2 max_length + transform senza troncamento esplicito", { owner: via ? intOwner(via) : s, also: via ? [via] : [], expect: { payload: `${lab} integro o rifiutato, mai troncato in silenzio (max ${f.max_length})` } });
    }
    if (f.pattern) d("NEG", "formato", "§27.2 format.pattern", { expect: { rejected: true, reason: `${lab} fuori formato ${f.pattern}` } });
    for (const x of asList(item.cross_system).filter((c) => c?.existence_validated_locally === false)) {
      if (typeOf(x.int) === "INT") d("INT", "riferimento pendente", `§27.2 cross_system ${x.system} senza verifica locale`, { owner: intOwner(x.int), also: [x.int], expect: { rejected_or_flagged: true, system: x.system } });
      else d("BSL", "riferimento pendente", `§27.2 cross_system ${x.system} senza verifica locale e senza INT`, { expect: { baseline: `riferimento a ${x.system} inesistente` } });
    }
    if (item.document_impact?.severity === "blocking") d("INT", "propagazione", "§27.2 document_impact.severity: blocking", { expect: { blocked_documents: asList(item.document_impact.documents) } });
    for (const st of asList(item.mandatory_in)) d("NEG", "obbligatorio omesso", `§27.2 mandatory_in: ${st}`, { state: st, expect: { rejected: true, reason: `${lab} obbligatorio in ${st}` } });
  } else if (t === "LCY") {
    for (const v of asList(item.validations).filter((x) => x?.on_fail === "undocumented")) d("BSL", "ignoto", `§27.2 validazione undocumented: ${v.rule}`, { expect: { baseline: `esito di "${v.rule}"` } });
    for (const [st, fields] of Object.entries(item.mandatory_by_state ?? {})) d("NEG", "obbligatorio omesso", `§27.2 mandatory_by_state ${st}`, { state: st, also: asList(fields), expect: { rejected: true, transition_to: st } });
    if (item.immutable_after) d("NEG", "mutazione tardiva", `§27.2 immutable_after: ${item.immutable_after}`, { state: item.immutable_after, expect: { rejected: true } });
  } else if (t === "FLD") {
    const m = item.mandatory ?? {};
    const roles = asList(m.by_role);
    const states = asList(m.in_states);
    const errs = errorsOf(item);
    if (m.kind === "conditional" && m.when) {
      for (const st of states.length ? states : [null]) for (const role of roles.length ? roles : [null]) {
        d("NEG", "obbligatorio condizionale non applicato", "§27.2 FLD.mandatory.kind: conditional con when", { condition: m.when, ...(st ? { state: st } : {}), ...(role ? { role } : {}), expected_errors: errs,
          expect: { rejected: true, reason: `${lab} obbligatorio quando ${m.when}`, field_empty: true } });
      }
      d("POS", "obbligatorio condizionale non applicato", "§27.2 FLD.mandatory.kind: conditional — condizione falsa", { condition: `non (${m.when})`, expect: { accepted: true, field_empty: true } });
    } else if (roles.length) {
      for (const role of roles) d("NEG", "obbligatorio per ruolo", "§27.2 FLD.mandatory.by_role", { role, expected_errors: errs, expect: { rejected: true, role } });
    } else if (m.kind === "always") {
      for (const st of states.length ? states : [null]) d("NEG", "obbligatorio omesso", "§27.2 mandatory_in / FLD.mandatory.kind: always", { ...(st ? { state: st } : {}), expected_errors: errs, expect: { rejected: true, field_empty: true } });
    }
    const reason = m.reason?.kind;
    if (reason === "integration") {
      const ref = m.reason?.ref;
      d("INT", "campo vuoto arriva al tracciato", "§27.2 FLD.mandatory.reason.kind: integration", { owner: typeOf(ref) === "INT" ? intOwner(ref) : s, also: typeOf(ref) === "INT" ? [ref] : [], expect: { message: "rifiutato o segnalato, mai silente" } });
    }
    const downstream = asList(item.lineage?.required_by).length + asList(item.lineage?.propagates_to).length;
    if (reason === "ui" && !downstream) d("BSL", "obbligatorietà senza catena", "§27.2 FLD.mandatory.reason.kind: ui senza altra ragione", { question: `Il campo ${lab} (${item.id}) è obbligatorio solo per la UI, senza ragione a valle: è voluto?`, expect: { baseline: `obbligatorietà di ${lab}` } });
  } else if (t === "INT") {
    const owner = item.owner_scope ?? s;
    d("INT", "contratto", "§27.4 L1: golden payload con tolleranze", { owner, strategy: "contratto", expect: { golden_diff: "nessuna differenza fuori tolleranza", checkpoint: item.e2e_checkpoint?.stage ?? "queued_accepted" } });
    if (item.silence_semantics?.silent_failure_possible) {
      const mand = asList(item.mappings).filter((x) => x?.mandatory === true || x?.one_of?.required === true).map((x) => x.field).filter(Boolean);
      if (mand.length) d("INT", "campo vuoto arriva al tracciato", "§27.2 silence_semantics: il controparte può fallire in silenzio", { owner, also: mand.slice(0, 20), expect: { message: "rifiutato o segnalato, mai silente", fields: mand.length } });
    }
  } else if (t === "HND") {
    const owner = item.owner_of_test ?? s;
    if (asList(item.asserts).length) d("HND", "handoff", "§27.3 strategia handoff: asserts", { owner, hnd: item, strategy: "handoff", expect: { asserts: asList(item.asserts) } });
    for (const x of asList(item.does_not_pass)) d("NEG", "handoff: non deve passare", `§27.3 HND.does_not_pass: ${x}`, { owner, hnd: item, strategy: "handoff", expect: { not_passed: x } });
  }
  return out;
}

export function chainDeductions(items) {
  const out = [];
  const byChain = new Map();
  for (const f of items.filter((x) => x?.type === "FLD")) for (const c of asList(f.cluster).filter((x) => /^CL-FLD-CHAIN-\d{3}$/.test(x))) byChain.set(c, [...(byChain.get(c) ?? []), f.id]);
  let proposed = [];
  try { proposed = chainsOf(items.filter((x) => ["FLD", "INT", "LCY"].includes(x?.type)), { existing: [] }).proposed; } catch { proposed = []; }
  for (const p of proposed) if (!byChain.has(p.cluster_code)) byChain.set(p.cluster_code, p.fields.concat(p.ints));
  for (const [code, members] of byChain) {
    const fields = members.filter((x) => typeOf(x) === "FLD");
    const ints = members.filter((x) => typeOf(x) === "INT");
    if (!fields.length) continue;
    out.push({ genre: ints.length ? "INT" : "HND", risk_mode: "valore alterato lungo la catena", rule: "§27.2 FLD.lineage.propagates_to: uno per CL-FLD-CHAIN", from: [...fields, ...ints], owner: scopeOf(fields[0]), subject: fields[0], chain: code, label: code,
      expect: { value_intact_downstream: true, through: fields.length } });
  }
  return out;
}

export function shapeOf(item, shapes = {}) {
  return shapes[item?.id] ?? item?.epistemic?.shape ?? item?.identity_quality?.shape ?? "libresco";
}

function skeleton(dd, { customer, id, shape }) {
  const h = dd.hnd ?? null;
  const stop = h ? (Number.isInteger(h.stop_at_step) ? h.stop_at_step : h.stop_at_step?.step ?? 1) : 1;
  const steps = [];
  for (let n = 1; n < stop; n++) steps.push({ n, verb: "ASK", note: `scheletro: passo ${n} da comporre dalla FLW (nrt-author)` });
  steps.push({ n: stop, verb: "ASK", expect: dd.expect, note: `scheletro (${dd.genre}, ${dd.risk_mode}): comporre i passi dalla FLW; verifica: ${JSON.stringify(dd.expect).slice(0, 160)}` });
  const c = {
    id, type: "NRT", title: `${dd.genre} ${dd.label}: ${dd.risk_mode}${dd.state ? ` (${dd.state})` : ""}${dd.role ? ` [${dd.role}]` : ""}${dd.channel ? ` via ${dd.channel}` : ""}`.slice(0, 140),
    scope: dd.owner, genre: dd.genre, state: shape === "libresco" ? "shadow" : "candidate",
    composition: { steps },
    derivation: { from: [...new Set(dd.from)], risk_mode: dd.risk_mode, rule: dd.rule, strategy: dd.strategy ?? (dd.genre === "INT" ? "contratto" : dd.chain ? "handoff" : "identita"),
      ...(dd.condition ? { condition: String(dd.condition) } : {}), ...(dd.role ? { role: String(dd.role) } : {}), ...(dd.state ? { state: String(dd.state) } : {}), ...(dd.chain ? { chain: dd.chain } : {}) },
    boundary: h ? { stop_at_step: stop, does_not_assert: asList(h.does_not_assert), handoff: h.id } : { stop_at_step: stop, does_not_assert: [`ciò che segue ${dd.risk_mode} (lo verificano altri casi)`] },
    epistemic_at_generation: { shape, subject: dd.subject, ...(shape === "libresco" ? { preliminary_observation: `osservazione preliminare richiesta su ${dd.subject}: la regola è nota dai documenti, mai vista funzionare qui (§27.3)` } : {}) },
    ...(dd.genre === "NEG" ? { expected_errors: asList(dd.expected_errors) } : {}),
    ...(dd.question ? { question: dd.question } : {}),
    sources: [{ generator: "negative-generator", rule: dd.rule }],
  };
  return c;
}

// Un caso si emette solo se valida (derivation e boundary compresi: F7 "caso senza derivation non emesso").
export function emit(c) {
  const v = validateCase(c);
  return v.ok ? { ok: true, case: c } : { ok: false, reason: v.errors.join("; ") };
}

export function generate(items, { customer, existing = {}, shapes = {} } = {}) {
  if (!customer || !/^[A-Z0-9]{4}$/.test(customer)) throw new Error("serve il cliente (4 caratteri)");
  const byId = new Map(items.filter((x) => x?.id).map((x) => [x.id, x]));
  const seq = new Map(Object.entries(existing));
  const next = (scope, genre) => { const k = `${scope}.${genre}`; const n = (seq.get(k) ?? 0) + 1; seq.set(k, n); return `NRT.${customer}.${scope}.${genre}.${String(n).padStart(4, "0")}`; };
  const cases = []; const explorations = []; const questions = []; const dropped = [];
  const deductions = [...items.flatMap((it) => deduce(it, { byId }).map((dd) => ({ dd, item: it }))), ...chainDeductions(items).map((dd) => ({ dd, item: byId.get(dd.subject) }))];
  const exploring = new Set();
  for (const { dd, item } of deductions) {
    const shape = shapeOf(item ?? { id: dd.subject }, shapes);
    if (shape === "ignoto") {
      if (!exploring.has(dd.subject)) { exploring.add(dd.subject); explorations.push({ subject: dd.subject, strategy: "STR-EXPLORE-BUDGET", reason: "soggetto ignoto: nessun test si genera, prima un'esplorazione (§27.3)" }); }
      continue;
    }
    if (!dd.owner) { dropped.push({ subject: dd.subject, risk_mode: dd.risk_mode, reason: "proprietario del test non determinato" }); continue; }
    const c = skeleton(dd, { customer, id: next(dd.owner, dd.genre), shape });
    const e = emit(c);
    if (!e.ok) { dropped.push({ subject: dd.subject, risk_mode: dd.risk_mode, reason: e.reason }); continue; }
    cases.push(c);
    if (dd.question) questions.push({ case: c.id, subject: dd.subject, question: dd.question });
  }
  return { cases, explorations, questions, dropped };
}

export function existingSeqs(ws, customer) {
  const base = join(ws, "customers", customer, "tests", "cases");
  const out = {};
  if (!existsSync(base)) return out;
  for (const s of readdirSync(base)) for (const f of readdirSync(join(base, s))) {
    const m = /^NRT\.[A-Z0-9]{4}\.([A-Z0-9]{3})\.([A-Z]{3})\.(\d{4})\.ya?ml$/.exec(f);
    if (m) out[`${m[1]}.${m[2]}`] = Math.max(out[`${m[1]}.${m[2]}`] ?? 0, Number(m[3]));
  }
  return out;
}

function readItemsDir(dir) {
  const out = [];
  const walk = (d) => { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.ya?ml$/.test(e.name)) { try { const y = YAML.parse(readFileSync(p, "utf8")); if (y?.id && y?.type) out.push(y); } catch { /* ignorato */ } } } };
  walk(dir);
  return out;
}

const HELP = `uso: node scripts/compile/negative-generator.mjs [--scope S] [--customer C] [--items-dir <dir>] [--write] [--workspace <dir>] [--json] [--help]

Tabella di deduzione §27.2 come codice: dagli item KEY, LCY, FLD, INT, HND (kb del prodotto e del cliente, o --items-dir)
scheletri di casi NEG/INT/BSL/HND/POS con derivation, boundary dall'HND, proprietario del test ed epistemic_at_generation
(ignoto ⇒ esplorazione, libresco ⇒ shadow con osservazione preliminare). --write: in customers/<C>/tests/cases/<S>/.

Exit code: 0 ok · 1 argomenti · 2 errore di sistema.`;

export function run(argv, env = process.env) {
  const { opts } = parseArgs(argv, { flags: ["write"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const { ws, customer } = workspaceCustomer(opts, env);
  if (!customer) return fail(asJson, 1, "cliente non determinato: --customer <C>");
  try {
    const types = ["KEY", "LCY", "FLD", "INT", "HND"];
    const items = opts["items-dir"] ? readItemsDir(opts["items-dir"]).filter((x) => types.includes(x.type)) : loadItems(ws, { customer, scope: opts.scope ?? null, types });
    const r = generate(items, { customer, existing: existingSeqs(ws, customer) });
    const written = [];
    if (opts.write) for (const c of r.cases) {
      const dir = join(ws, "customers", customer, "tests", "cases", c.scope);
      mkdirSync(dir, { recursive: true });
      const f = join(dir, `${c.id}.yaml`);
      if (existsSync(f)) continue;
      writeFileAtomic(f, YAML.stringify(c));
      written.push(`tests/cases/${c.scope}/${c.id}.yaml`);
    }
    const counts = r.cases.reduce((a, c) => { a[c.genre] = (a[c.genre] ?? 0) + 1; return a; }, {});
    console.log(asJson ? JSON.stringify({ ok: true, counts, ...r, written }) : `${r.cases.length} scheletri (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ")}), ${r.explorations.length} esplorazioni, ${r.questions.length} domande, ${r.dropped.length} scartati`);
    return 0;
  } catch (err) {
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
