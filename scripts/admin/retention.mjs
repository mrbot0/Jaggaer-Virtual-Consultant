// admin retention (§54.4, §48.2, §56.8) — WP09d. Le retention del cliente:
//   osservazioni, evidenze, sessioni   90 giorni (configurabile: customers/<C>/config/retention.yaml, minimo 30)
//   run e report                       12 mesi (configurabile, minimo 1 mese)
//   audit                              ≥ 24 mesi: MAI rimosso da qui; oltre i 24 mesi è solo segnalato come archiviabile
//                                      fuori dal repository (§54.4)
//   conoscenza (kb/, lessons, decisions, outcomes, analysis/, product/, digest, contradictions, config)   MAI
// Decisione WP09d (Deviazioni del report): la retention è la SCADENZA dichiarata dalla spec (§54.4 righe 1-2:
// "deprecato e poi rimosso dai file"), non una cancellazione a richiesta: la prova a secco elenca (e dichiara) ciò che è
// scaduto; --apply richiede UNA approvazione con frase (`APPROVO RETENTION <C>`, §56.8), la consuma, scrive un
// certificato (percorsi, sha256, categoria, età) in <workspace>/.jvc/retention-certificates/ e rimuove SOLO i percorsi
// scaduti delle categorie qui sopra; le righe del DB delle OBS e dei report rimossi escono dall'indice.
// Giro 1: la prova a secco REGISTRA gli scaduti come deprecati (<ws>/.jvc/retention/<C>.json, data della prima
// deprecazione); --apply rimuove solo i percorsi già deprecati e ancora scaduti, sotto il knowledge.lock del cliente;
// nessun collegamento (link o giunzione) e nessun percorso che risolve fuori dal cliente, verificato di nuovo prima di
// ogni rimozione; il guard conferma l'approvazione nel transcript.
// Forma esatta ammessa da guard-destructive (DR-OK-002): node <plugin>/scripts/admin/retention.mjs <C> [--apply --approval <token>]
//   [--session <id>] [--json]. Il workspace viene dall'ambiente.
import { readFileSync, writeFileSync, readdirSync, lstatSync, existsSync, mkdirSync, rmSync, realpathSync } from "node:fs";
import { withLock } from "../kb/lock.mjs";
import { join, resolve, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { approvalsFile, readApprovals, findGrant, consumeGrants } from "./approvals.mjs";
import { readPointer, readCurrentSession, CUSTOMER_RE } from "../../hooks/lib/workspace.mjs";
import { appendAudit } from "../../hooks/lib/audit.mjs";
import { canonical } from "../digest/align.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";

export const DEFAULTS = Object.freeze({ observations_days: 90, evidence_days: 90, sessions_days: 90, runs_months: 12, reports_months: 12, audit_months: 24 });
const MIN = { observations_days: 30, evidence_days: 30, sessions_days: 30, runs_months: 1, reports_months: 1, audit_months: 24 };
export class RetentionRefusal extends Error { constructor(m) { super(m); this.name = "RetentionRefusal"; } }
const DAY = 86400000;
const rel = (ws, p) => relative(ws, p).split(sep).join("/");
const sha = (buf) => createHash("sha256").update(buf).digest("hex");

export function policyFor(ws, c) {
  const p = { ...DEFAULTS };
  const f = join(ws, "customers", c, "config", "retention.yaml");
  if (existsSync(f)) {
    const d = YAML.parse(readFileSync(f, "utf8")) ?? {};
    for (const k of Object.keys(DEFAULTS)) if (Number.isInteger(d[k])) p[k] = Math.max(MIN[k], d[k]);
  }
  return p;
}

// Orario più recente di un percorso (file: mtime; cartella: il file più recente dentro, senza seguire link).
function newest(p) {
  const st = lstatSync(p);
  if (!st.isDirectory() || st.isSymbolicLink()) return st.mtimeMs;
  let m = 0;
  for (const e of readdirSync(p)) m = Math.max(m, newest(join(p, e)));
  return m || st.mtimeMs;
}
function files(p) {
  const st = lstatSync(p);
  if (st.isSymbolicLink() || !st.isDirectory()) return [p];
  return readdirSync(p).flatMap((e) => files(join(p, e)));
}
// WP09d giro 1 (I3): nessun collegamento. Una cartella di categoria (o una sua voce) che è un link simbolico o una
// giunzione, o che risolve fuori da customers/<C>/, è RIFIUTATA: la retention non segue mai un collegamento (potrebbe
// portare a product/kb, all'audit o fuori dal workspace).
const realOf = (p) => realpathSync.native(p);
function contained(realRoot, p) {
  const st = lstatSync(p);
  if (st.isSymbolicLink()) throw new RetentionRefusal(`percorso collegato (link o giunzione) rifiutato: ${p}`);
  const r = realOf(p);
  if (r !== realRoot && !r.startsWith(realRoot + sep)) throw new RetentionRefusal(`percorso che risolve fuori dal cliente rifiutato: ${p} → ${r}`);
  return st;
}
function entriesIn(realRoot, d) {
  if (!existsSync(d) && !isLink(d)) return [];
  const st = contained(realRoot, d);
  if (!st.isDirectory()) return [];
  return readdirSync(d).filter((x) => x !== ".gitkeep").map((x) => { const p = join(d, x); contained(realRoot, p); return p; });
}
const isLink = (p) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };

// Sessioni da non toccare: la corrente e quelle i cui puntatori nominano il cliente e sono recenti.
function liveSessions(ws, c, now, days) {
  const live = new Set();
  const cur = readCurrentSession(ws);
  if (cur) live.add(cur);
  const d = join(ws, ".jvc", "sessions");
  if (existsSync(d)) for (const f of readdirSync(d).filter((x) => x.endsWith(".json"))) {
    const s = f.slice(0, -5);
    try { const p = readPointer(ws, s); if (p?.customer === c && now - Date.parse(p.updated_at ?? 0) < days * DAY) live.add(s); } catch { /* puntatore illeggibile: la sessione non si tocca */ live.add(s); }
  }
  return live;
}

export function candidates(ws, c, { now = Date.now(), policy = policyFor(ws, c) } = {}) {
  const root = join(ws, "customers", c);
  if (isLink(root)) throw new RetentionRefusal(`customers/${c} è un collegamento: retention rifiutata`);
  const realRoot = realOf(root);
  const entries = (d) => entriesIn(realRoot, d);
  const out = [];
  const archivable = [];
  const push = (category, p, limitDays) => {
    const age = (now - newest(p)) / DAY;
    if (age >= limitDays) out.push({ category, path: p, age_days: Math.floor(age) });
  };
  for (const p of entries(join(root, "observations"))) push("observations", p, policy.observations_days);
  for (const p of entries(join(root, "evidence"))) push("evidence", p, policy.evidence_days);
  const live = liveSessions(ws, c, now, policy.sessions_days);
  for (const p of entries(join(root, ".sessions"))) {
    const name = p.split(sep).pop();
    if (!lstatSync(p).isDirectory() || live.has(name)) continue;
    push("sessions", p, policy.sessions_days);
  }
  const runsDays = policy.runs_months * 30;
  for (const run of entries(join(root, "runs"))) {
    if (!lstatSync(run).isDirectory()) continue;
    const age = (now - newest(run)) / DAY;
    if (age >= runsDays) { out.push({ category: "runs", path: run, age_days: Math.floor(age) }); continue; }
    for (const p of entries(join(run, "evidence"))) push("evidence", p, policy.evidence_days);   // evidenze dei run: 90 giorni
  }
  for (const p of entries(join(root, "reports"))) push("reports", p, policy.reports_months * 30);
  for (const p of entries(join(root, "audit"))) {
    const age = (now - newest(p)) / DAY;
    if (age >= policy.audit_months * 30) archivable.push({ category: "audit", path: rel(ws, p), age_days: Math.floor(age), action: "archiviare fuori dal repository (mai rimosso da retention)" });
  }
  return { policy, items: out.map((x) => ({ ...x, path: rel(ws, x.path) })), archivable };
}

export function verifyApproval(ws, c, { sid, token, now = Date.now() }) {
  if (!token) throw new RetentionRefusal(`--apply richiede un'approvazione: l'utente scrive \`APPROVO RETENTION ${c}\` e si passa --approval <token>`);
  if (!sid) throw new RetentionRefusal("nessuna sessione: l'approvazione vive nel registro della sessione");
  const ptr = readPointer(ws, sid);
  if (!ptr?.customer) throw new RetentionRefusal(`la sessione ${sid} non ha un cliente attivo`);
  const file = approvalsFile(ws, ptr.customer, sid);
  const reg = readApprovals(file);
  if (!reg.ok) throw new RetentionRefusal(`registro delle approvazioni non valido: ${reg.reason}`);
  const g = findGrant(reg.records, { kind: "retention", target: c, token, now });
  if (!g.ok) throw new RetentionRefusal(`approvazione non valida: ${g.reason}`);
  return { file, grant: g.record };
}

export async function retention({ ws, customer: c, apply = false, token = null, sid = null, now = new Date() }) {
  if (!CUSTOMER_RE.test(String(c ?? ""))) throw new Error(`codice cliente non valido: ${c}`);
  if (!existsSync(join(ws, "customers", c))) throw new Error(`cliente inesistente: customers/${c}`);
  const all = candidates(ws, c, { now: now.getTime() });
  const mfile = deprecationFile(ws, c);
  if (!apply) {
    // Fase 1 (§54.4 "deprecato"): l'elenco degli scaduti è registrato con la data di deprecazione (la prima volta che un
    // percorso risulta scaduto); un percorso non più scaduto o sparito esce dall'elenco.
    const prev = readDeprecation(mfile);
    const items = {};
    for (const x of all.items) items[x.path] = { category: x.category, age_days: x.age_days, deprecated_at: prev.items?.[x.path]?.deprecated_at ?? now.toISOString() };
    mkdirSync(join(ws, ".jvc", "retention"), { recursive: true });
    writeFileSync(mfile, JSON.stringify({ customer: c, updated_at: now.toISOString(), items }, null, 2) + "\n");
    return { dry_run: true, customer: c, ...all, deprecation: { file: mfile, count: Object.keys(items).length, new: all.items.filter((x) => !prev.items?.[x.path]).length } };
  }
  const { file, grant } = verifyApproval(ws, c, { sid, token, now: now.getTime() });
  // Fase 2 ("poi rimosso"): solo ciò che era già deprecato da una prova a secco precedente ed è ancora scaduto
  const dep = readDeprecation(mfile);
  if (!dep.items) throw new RetentionRefusal(`nessun percorso deprecato per ${c}: esegui prima la prova a secco (retention.mjs ${c}), che registra gli scaduti come deprecati`);
  const cand = { ...all, items: all.items.filter((x) => dep.items[x.path] && Date.parse(dep.items[x.path].deprecated_at) <= now.getTime()) };
  const pending = all.items.filter((x) => !cand.items.includes(x)).map((x) => x.path);
  // giro 1 (m12): sotto il lock del cliente (nessuna digestione o promozione in corso)
  try {
    return await withLock(join(ws, "customers", c), "knowledge", 10 * 60000, () => applyRemoval({ ws, c, sid, now, file, grant, cand, pending, mfile, dep }));
  } catch (err) {
    if (/lock attivo/.test(String(err?.message))) throw new RetentionRefusal(`${err.message}: una digestione o una promozione è in corso sul cliente (admin lock)`);
    throw err;
  }
}

export const deprecationFile = (ws, c) => join(ws, ".jvc", "retention", `${c}.json`);
function readDeprecation(f) { try { return JSON.parse(readFileSync(f, "utf8")); } catch { return {}; } }

async function applyRemoval({ ws, c, sid, now, file, grant, cand, pending, mfile, dep }) {
  consumeGrants(file, [grant], { date: now });
  const realRoot = realOf(join(ws, "customers", c));
  const removed = cand.items.map((x) => ({ ...x, files: files(join(ws, x.path)).map((f) => ({ path: rel(ws, f), sha256: lstatSync(f).isSymbolicLink() ? null : sha(readFileSync(f)), bytes: lstatSync(f).size })) }));
  const cdir = join(ws, ".jvc", "retention-certificates");
  mkdirSync(cdir, { recursive: true });
  const cfile = join(cdir, `${c}-${now.toISOString().replace(/[:.]/g, "-")}.json`);
  const cert = { kind: "retention", customer: c, executed_at: now.toISOString(), session: sid, approval: { hash: grant.hash, approver_declared: grant.approver_declared, ts: grant.ts },
    policy: cand.policy, removed, archivable: cand.archivable, never: ["kb/", "lessons/", "decisions/", "outcomes/", "analysis/", "product/", "audit/"] };
  cert.certificate_sha256 = sha(canonical(cert));
  writeFileSync(cfile, JSON.stringify(cert, null, 2) + "\n");
  // Scadenza: si rimuovono SOLO i percorsi elencati (dentro customers/<C>/, categorie ammesse)
  const base = join(ws, "customers", c) + sep;
  for (const x of cand.items) {
    const abs = join(ws, x.path);
    if (!abs.startsWith(base)) throw new RetentionRefusal(`percorso fuori dal cliente: ${x.path}`);
    contained(realRoot, abs);   // giro 1 (I3): di nuovo subito prima di rimuovere (nessun link, dentro il cliente)
    rmSync(abs, { recursive: true, force: true, maxRetries: 3 });
  }
  // l'elenco di deprecazione perde ciò che è stato rimosso
  const left = Object.fromEntries(Object.entries(dep.items).filter(([k]) => !cand.items.some((x) => x.path === k)));
  writeFileSync(mfile, JSON.stringify({ customer: c, updated_at: now.toISOString(), items: left }, null, 2) + "\n");
  // l'indice perde le OBS e i report rimossi
  const dbf = join(ws, "customers", c, "knowledge.db");
  if (existsSync(dbf)) {
    const { openDb } = await import("../kb/db.mjs");
    const db = openDb(dbf);
    try {
      const obs = cand.items.filter((x) => x.category === "observations").map((x) => x.path.split("/").pop().replace(/\.ya?ml$/, ""));
      const rep = cand.items.filter((x) => x.category === "reports").map((x) => x.path.split("/").pop().replace(/\.ya?ml$/, ""));
      db.transaction(() => {
        for (const o of obs) db.prepare("delete from observations where code = ?").run(o);
        for (const r of rep) db.prepare("delete from reports where code = ?").run(r);
      })();
    } finally { db.close(); }
  }
  try {
    appendAudit(ws, { session: sid, customer: c, kind: "decision", actor: "script:admin-retention",
      payload: { retention: c, removed: cand.items.length, certificate: rel(ws, cfile), certificate_sha256: cert.certificate_sha256 } });
  } catch { /* il certificato resta la prova */ }
  return { dry_run: false, customer: c, removed: cand.items.length, pending_deprecation: pending, archivable: cand.archivable, certificate: cfile, certificate_sha256: cert.certificate_sha256 };
}

export const HELP = `uso: node <plugin>/scripts/admin/retention.mjs <C> [--apply --approval <token>] [--session <id>] [--json]

Retention (§54.4): osservazioni, evidenze e sessioni oltre 90 giorni; run e report oltre 12 mesi (customers/<C>/config/
retention.yaml per cliente); l'audit non si rimuove mai (oltre 24 mesi: archiviabile fuori repo); la conoscenza mai.
Senza --apply: elenco degli scaduti. --apply: UNA approvazione con frase \`APPROVO RETENTION <C>\` (monouso),
certificato in <workspace>/.jvc/retention-certificates/, rimozione dei soli percorsi scaduti.

Exit code: 0 ok · 1 argomenti non validi · 2 errore di sistema · 3 approvazione mancante o non valida.`;

export async function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv, { flags: ["apply"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const c = positional[0];
  if (positional.length !== 1 || !CUSTOMER_RE.test(String(c))) return fail(asJson, 1, "uso: retention.mjs <C> [--apply --approval <token>]");
  const ws = resolve(env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    const { resolveSessionId } = await import("./session.mjs");
    const sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
    const r = await retention({ ws, customer: c, apply: !!opts.apply, token: opts.approval ?? null, sid });
    console.log(JSON.stringify({ ok: true, ...r }));
    return 0;
  } catch (err) {
    if (err instanceof RetentionRefusal) return fail(asJson, 3, err.message);
    if (/non valido|inesistente/.test(String(err?.message))) return fail(asJson, 1, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 2; });
