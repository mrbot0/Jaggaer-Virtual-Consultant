// kb promote / kb deprecate (§8.4, §22.2, §29.6, §49.4, §54.3) — WP09d. Gli agenti non scrivono mai in kb/ né in
// product/: questi script lo fanno dopo la validazione, con il codice assegnato dal DB, in transazione.
//
// promote <codice> --customer C                  L → C nello stesso cliente: nuovo codice C (SEQ dal DB) con
//                                                promoted_from; l'L diventa deprecato con superseded_by (mai cancellato).
// promote <codice> --customer C --to product --approval <token>
//                                                C/L → S: NUOVO codice S con promoted_from, contenuto pseudonimizzato
//                                                (sale solo da JVC_PSEUDO_SALT), richiede un'approvazione umana
//                                                registrata (frase APPROVO PROMOZIONE <codice>, kind promote, creata
//                                                solo da approval-capture), monouso. L'item del cliente resta, con promoted_to.
// deprecate <codice> --superseded-by <codice> [--customer C]
//                                                F12 deprecato + superseded_by nel file; mai cancellato (§49.4).
// Solo item in stato validato o clusterizzato si promuovono; lo schema dell'item nuovo è validato prima di scriverlo.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import YAML from "yaml";
import { openDb } from "./db.mjs";
import { parseCode, isValidCode } from "./codes.mjs";
import { assignSeq, formatCode } from "./assign-seq.mjs";
import { validateItem } from "./validate-schema.mjs";
import { indexItemFile, sourceWeight } from "./reindex.mjs";
import { BOUNDARY_RULES } from "./validate-boundary.mjs";
import { itemFile, loadItem } from "../lib/kb-items.mjs";
import { pseudonymizer, saltFrom, PseudonymError } from "../digest/pseudonymize.mjs";
import { approvalsFile, readApprovals, findGrant, consumeGrants } from "../admin/approvals.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";

export const PROMOTABLE = new Set(["validato", "clusterizzato"]);
export class LifecycleError extends Error { constructor(code, m) { super(m); this.name = "LifecycleError"; this.code = code; } }
const E1 = (m) => new LifecycleError(1, m);
const E3 = (m) => new LifecycleError(3, m);

export const customerDbPath = (ws, c) => join(ws, "customers", c, "knowledge.db");
export const productDbPath = (ws) => join(ws, "product", "knowledge.db");
const rootOf = (ws, level, c) => (level === "S" ? join(ws, "product") : join(ws, "customers", c));

// Nomi del cliente da pseudonimizzare (profilo: name, legal_name, companies[].name, people[]/contacts[].name, suppliers[]).
export function customerNames(ws, customer) {
  const dir = join(ws, "customers", customer, "profile");
  const names = { customerNames: [], people: [], suppliers: [] };
  if (!existsSync(dir)) return names;
  for (const f of ["profile.yaml", `${customer}.yaml`, "customer.yaml"]) {
    const p = join(dir, f);
    if (!existsSync(p)) continue;
    let d;
    try { d = YAML.parse(readFileSync(p, "utf8")); } catch { continue; }
    for (const k of ["name", "legal_name", "short_name"]) if (typeof d?.[k] === "string") names.customerNames.push(d[k]);
    for (const c of d?.companies ?? []) if (typeof c?.name === "string") names.customerNames.push(c.name);
    for (const p2 of [...(d?.people ?? []), ...(d?.contacts ?? [])]) if (typeof (p2?.name ?? p2) === "string") names.people.push(p2?.name ?? p2);
    for (const s of d?.suppliers ?? []) if (typeof (s?.name ?? s) === "string") names.suppliers.push(s?.name ?? s);
  }
  return names;
}

// Scrive un item nuovo con il codice assegnato dal DB, in transazione: SEQ, validazione, riga, poi il file (per ultimo:
// se la scrittura fallisce la transazione annulla SEQ e riga; nessun file da togliere).
function createItem(db, ws, { level, customer, scope, type }, build) {
  return db.transaction(() => {
    const key = { level, customer, scope, type };
    const code = formatCode({ ...key, seq: assignSeq(db, key) });
    if (!isValidCode(code)) throw E1(`codice ${code} non valido per livello/tipo (registro): il tipo ${type} non esiste al livello ${level}`);
    const obj = build(code);
    const v = validateItem(obj);
    if (!v.ok) throw E1(`item ${code} non valido: ${v.errors.join("; ")}`);
    const file = itemFile(ws, code);
    if (existsSync(file)) throw E1(`il file ${code} esiste già`);
    const text = YAML.stringify(obj);
    indexItemFile(db, rootOf(ws, level, customer), file, text);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
    return { code, file, obj };
  })();
}

function updateItem(db, ws, code, customer, mutate) {
  const file = itemFile(ws, code, customer);
  const cur = YAML.parse(readFileSync(file, "utf8"));
  const next = mutate(structuredClone(cur));
  const v = validateItem(next);
  if (!v.ok) throw E1(`aggiornamento di ${code} non valido: ${v.errors.join("; ")}`);
  const text = YAML.stringify(next);
  const pc = parseCode(code);
  db.transaction(() => { indexItemFile(db, rootOf(ws, pc.level, pc.customer), file, text); writeFileSync(file, text); })();
  return next;
}

const KB_BOUNDARY = BOUNDARY_RULES.filter((r) => r.dir === "kb");
// Campi che un item S non porta (sono del cliente o del ciclo di vita dell'item di origine).
const DROP_ON_PROMOTE = ["promoted_to", "superseded_by", "confirmed_by_observation", "observed", "deviates_from", "derives_from"];

export function promote({ ws, code, customer, to = null, approval = null, sid = null, env = process.env, now = new Date() }) {
  const p = parseCode(code);
  if (!p) throw E1(`codice non valido: ${code}`);
  if (p.level === "S") throw E1("un item S non si promuove");
  if (!customer || customer !== p.customer) throw E1(`--customer ${customer ?? "(assente)"} diverso dal cliente del codice (${p.customer}): le scritture richiedono il cliente esplicito (§46.4)`);
  if (to && to !== "product") throw E1(`--to ammette solo product (ricevuto ${to})`);
  const src = loadItem(ws, code, customer);
  if (!src) throw E1(`item non trovato: ${code}`);
  const status = src.facets?.F12;
  if (!PROMOTABLE.has(status)) throw E3(`solo item validato o clusterizzato si promuovono (${code}: ${status})`);
  const sv = validateItem(src);
  if (!sv.ok) throw E1(`l'item di origine non valida lo schema: ${sv.errors.join("; ")}`);
  const cdb = openDb(customerDbPath(ws, customer));
  try {
    if (!to) {
      if (p.level !== "L") throw E1(`${code} è già di livello C: per il livello S usa --to product --approval <token>`);
      const made = createItem(cdb, ws, { level: "C", customer, scope: p.scope, type: p.type }, (newCode) => {
        const o = { ...structuredClone(src), id: newCode, promoted_from: code };
        for (const k of ["promoted_to", "superseded_by"]) delete o[k];
        o.facets = { ...o.facets, F12: "promosso" };
        return o;
      });
      updateItem(cdb, ws, code, customer, (o) => { o.facets.F12 = "deprecato"; o.superseded_by = made.code; o.promoted_to = made.code; return o; });
      return { code: made.code, from: code, level: "C", file: made.file };
    }
    // --- a product/: approvazione umana registrata, pseudonimizzazione, nuovo codice S ---
    if (!approval) throw E3("la promozione a product/ richiede un'approvazione umana registrata: l'utente scrive `APPROVO PROMOZIONE " + code + "` e si passa --approval <token>");
    if (!sid) throw E3("nessuna sessione: l'approvazione della promozione vive nel registro della sessione del cliente (--session o sessione corrente)");
    const file = approvalsFile(ws, customer, sid);
    const reg = readApprovals(file);
    if (!reg.ok) throw E3(`registro delle approvazioni non valido: ${reg.reason}`);
    const g = findGrant(reg.records, { kind: "promote", target: code, token: approval, now: now.getTime() });
    if (!g.ok) throw E3(`approvazione non valida: ${g.reason}`);
    // Un item S non cita item di un cliente: i riferimenti vanno prima promossi (o sostituiti con i loro S).
    const own = new RegExp(String.raw`\b[CL]\.${customer}\.[A-Z0-9]{3}\.[A-Z]{3}\.\d{4}(?:\.v\d+)?\b`, "g");
    const cited = [...new Set((JSON.stringify({ ...src, id: null }).match(own) ?? []))];
    if (cited.length) throw E3(`l'item cita item del cliente (${cited.slice(0, 5).join(", ")}${cited.length > 5 ? ", …" : ""}): un item S non cita il livello cliente — promuovi prima i riferimenti o sostituiscili con i loro S`);
    let salt;
    try { salt = saltFrom(env); } catch (err) { throw E3(err.message); }
    const ps = pseudonymizer({ salt, customers: [customer], ...customerNames(ws, customer) });
    const pdb = openDb(productDbPath(ws));
    try {
      const made = createItem(pdb, ws, { level: "S", customer: "STD", scope: p.scope, type: p.type }, (newCode) => {
        const o = structuredClone(src);
        for (const k of DROP_ON_PROMOTE) delete o[k];
        const body = ps.object(o, new Set(["facets", "classification", "cluster", "type"]));
        const out = { ...body, id: newCode, type: src.type, promoted_from: code,
          facets: { ...src.facets, F1: "promozione-digest", F12: "promosso" }, source_weight: sourceWeight(src) };
        const text = YAML.stringify(out);
        for (const r of KB_BOUNDARY) { const m = r.re.exec(text); if (m) throw E3(`l'item promosso violerebbe il confine dei domini (${r.rule}: ${m[0]})`); }
        return out;
      });
      updateItem(cdb, ws, code, customer, (o) => { o.promoted_to = made.code; return o; });
      consumeGrants(file, [g.record], { date: now });
      return { code: made.code, from: code, level: "S", file: made.file, approval: g.record.hash, pseudonymized: [...new Set(ps.map.values())] };
    } finally { pdb.close(); }
  } finally { cdb.close(); }
}

export function deprecate({ ws, code, supersededBy, customer = null }) {
  const p = parseCode(code);
  const q = parseCode(supersededBy ?? "");
  if (!p) throw E1(`codice non valido: ${code}`);
  if (!q) throw E1("deprecate richiede --superseded-by <codice>: un item si depreca solo a favore di un successore (mai cancellato)");
  if (code === supersededBy) throw E1("un item non sostituisce sé stesso");
  if (p.level !== "S" && customer !== p.customer) throw E1(`--customer ${customer ?? "(assente)"} diverso dal cliente del codice (${p.customer}) (§46.4)`);
  if (p.level === "S" && q.level !== "S") throw E1("un item S si depreca solo a favore di un item S (il livello S non cita i clienti)");
  if (p.type !== q.type) throw E1(`tipi diversi: ${p.type} ≠ ${q.type}`);
  const cur = loadItem(ws, code, p.level === "S" ? null : customer);
  if (!cur) throw E1(`item non trovato: ${code}`);
  const next = loadItem(ws, supersededBy, q.level === "S" ? null : customer);
  if (!next) throw E1(`successore non trovato: ${supersededBy}`);
  if (next.facets?.F12 === "deprecato") throw E1(`il successore ${supersededBy} è a sua volta deprecato`);
  const db = openDb(p.level === "S" ? productDbPath(ws) : customerDbPath(ws, p.customer));
  try {
    const o = updateItem(db, ws, code, p.level === "S" ? null : customer, (x) => { x.facets.F12 = "deprecato"; x.superseded_by = supersededBy; return x; });
    return { code, status: o.facets.F12, superseded_by: supersededBy };
  } finally { db.close(); }
}

async function sessionOf(ws, opts, env) {
  const { resolveSessionId } = await import("../admin/session.mjs");
  return resolveSessionId({ workspace: ws, arg: opts.session, env });
}

async function sessionCustomer(ws, sid) {
  if (!sid) return null;
  const { loadSession } = await import("../admin/session.mjs");
  try { return loadSession(ws, sid).session?.customer ?? null; } catch { return null; }
}

export const HELP_PROMOTE = `uso: kb promote <codice> --customer <C> [--to product --approval <token>] [--session <id>] [--workspace <dir>] [--json]

L → C (senza --to): nuovo codice C con promoted_from; l'L diventa deprecato (superseded_by).
C/L → S (--to product): nuovo codice S con promoted_from, contenuto pseudonimizzato (JVC_PSEUDO_SALT), solo con
l'approvazione registrata dalla frase dell'utente \`APPROVO PROMOZIONE <codice>\` (token = hash del record, monouso).
Solo item validato/clusterizzato. Codice dal DB, schema validato, transazione.

Exit code: 0 ok · 1 errore d'uso o di dati · 2 errore di sistema · 3 rifiutato per policy (stato, approvazione, sale).`;
export const HELP_DEPRECATE = `uso: kb deprecate <codice> --superseded-by <codice> [--customer <C>] [--workspace <dir>] [--json]

F12 deprecato + superseded_by nel file (§49.4: resta leggibile; nessuna cancellazione).

Exit code: 0 ok · 1 errore d'uso o di dati · 2 errore di sistema.`;

export async function main(cmd, argv, env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(cmd === "promote" ? HELP_PROMOTE : HELP_DEPRECATE); return 0; }
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  const code = positional[0];
  if (!code) return fail(asJson, 1, `${cmd} richiede il codice dell'item`);
  try {
    const sid = await sessionOf(ws, opts, env);
    const sc = await sessionCustomer(ws, sid);
    const customer = opts.customer ?? null;
    if (sc && customer && sc !== customer) return fail(asJson, 3, `--customer ${customer} diverso dal cliente della sessione (${sc}) (§46.4)`);
    const r = cmd === "promote"
      ? promote({ ws, code, customer, to: opts.to ?? null, approval: opts.approval ?? null, sid, env })
      : deprecate({ ws, code, supersededBy: opts["superseded-by"], customer });
    console.log(JSON.stringify({ ok: true, ...r }));
    return 0;
  } catch (err) {
    if (err instanceof LifecycleError) return fail(asJson, err.code, err.message);
    if (err instanceof PseudonymError) return fail(asJson, 3, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) { const [cmd, ...rest] = process.argv.slice(2); main(cmd, rest).then((c) => { process.exitCode = c; }); }
