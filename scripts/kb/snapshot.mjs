// kb snapshot <CFG…> (§28.1 confine 2, §28.3 passo 9, §45.4, S.STD.ADM.CHK.0051): stato degli oggetti governati prima
// di una modifica di configurazione, dalle ultime OBS (observe-append) della PAGINA di ciascun oggetto.
//
//   takeSnapshot({ ws, sid, objects[], areas?, run?, obs?, maxAgeS = 900, now }) → { file, entry, objects[] }
//     per ogni CFG: l'item (kb) con la sua location (page_sig · url_pattern · selectors) lega lo snapshot alla pagina;
//     l'OBS più recente di quella pagina (o --obs, che deve comunque essere della pagina) entro maxAgeS; lo stato sono
//     gli elementi osservati dei SEL della location (valori già redatti dall'OBS). Un oggetto senza location o senza
//     un'OBS della sua pagina ⇒ rifiuto: niente snapshot "di una pagina qualsiasi" (WP07 security minor 1).
//     Scrive runs/<RUN>/snapshots/<ts>.yaml e session.snapshots[] { objects, ts, run, file, source: kb-snapshot, obs[],
//     areas? } — la voce che guard-config-scope (b) richiede negli ultimi 60 s e che deve COPRIRE tutti gli oggetti
//     governati del passo (config.object + config.governs).
//
// CLI: node scripts/kb/snapshot.mjs <CFG…> [--area CL-CFG-nnn] [--run <RUN>] [--obs <L.…OBS.nnnn>] [--max-age-s 900]
//      [--session <id>] [--workspace <dir>] [--json]      (anche: node scripts/kb/kb.mjs snapshot …)
// Exit: 0 ok · 1 errore utente · 2 errore di sistema · 3 rifiuto (oggetto non legato a una pagina osservata di recente).
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve as resolvePath, relative } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { updateSessionFile } from "../../hooks/lib/session-state.mjs";
import { sessionFile } from "../../hooks/lib/workspace.mjs";
import { appendAudit } from "../../hooks/lib/audit.mjs";
import { loadSession, resolveSessionId } from "../admin/session.mjs";
import { runRefusal } from "../lib/run-code.mjs";
import { loadItem } from "../lib/kb-items.mjs";

export class SnapshotError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const CFG_RE = /^[SCL]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.CFG\.\d{4}(\.v\d+)?$/;
const OBS_RE = /^L\.[A-Z0-9]{4}\.[A-Z0-9]{3}\.OBS\.\d{4}$/;
const MAX_OBS_FILES = 500;

// OBS del cliente, dalle più recenti (per codice decrescente: il SEQ cresce nel tempo), al più MAX_OBS_FILES.
function recentObservations(ws, customer) {
  const dir = join(ws, "customers", customer, "observations");
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => /^L\..+\.OBS\.\d{4}\.yaml$/.test(f)).sort((a, b) => b.localeCompare(a)).slice(0, MAX_OBS_FILES);
  const out = [];
  for (const f of files) { try { const o = YAML.parse(readFileSync(join(dir, f), "utf8")); if (o?.id) out.push(o); } catch { /* illeggibile: ignorata */ } }
  return out.sort((a, b) => Date.parse(b.ts ?? 0) - Date.parse(a.ts ?? 0));
}

// L'OBS è della pagina dell'oggetto? firma della pagina, URL o un elemento legato a un SEL della location.
export function obsMatchesLocation(o, loc) {
  if (!o || !loc) return false;
  if (loc.page_sig && typeof o.page_signature === "string" && o.page_signature.includes(loc.page_sig)) return true;
  if (loc.url_pattern && typeof o.url === "string" && o.url.includes(loc.url_pattern)) return true;
  const sels = Array.isArray(loc.selectors) ? loc.selectors : [];
  return sels.length > 0 && (o.elements_seen ?? []).some((e) => sels.includes(e?.atlas_match));
}

export function takeSnapshot({ ws, sid, objects = [], areas = [], run = null, obs = null, maxAgeS = 900, now = new Date() }) {
  const { session, pointer } = loadSession(ws, sid);
  if (!session) throw new SnapshotError(1, "nessuna sessione con cliente attivo: use customer <ID>");
  const customer = pointer.customer;
  if (!objects.length && !areas.length) throw new SnapshotError(1, "nessun oggetto CFG da fotografare");
  for (const c of objects) if (!CFG_RE.test(c)) throw new SnapshotError(1, `${c} non è un codice CFG`);
  for (const a of areas) if (!/^CL-CFG-\d{3}$/.test(a)) throw new SnapshotError(1, `${a} non è un'area CL-CFG`);
  if (obs && !OBS_RE.test(obs)) throw new SnapshotError(1, `${obs} non è un codice OBS`);
  const r = run ?? session.active_plan?.run ?? null;
  if (!r) throw new SnapshotError(1, "run non determinato: --run <RUN> (o attiva il piano con step-check)");
  const bad = runRefusal(ws, customer, r);
  if (bad) throw new SnapshotError(1, bad);
  const all = recentObservations(ws, customer);
  const recorded = [];
  for (const code of objects) {
    const cfg = loadItem(ws, code, customer);
    if (!cfg) throw new SnapshotError(3, `${code} non è nella knowledge base: lo snapshot non si lega a un oggetto sconosciuto`);
    const loc = cfg.location;
    if (!loc || !(loc.page_sig || loc.url_pattern || loc.selectors?.length)) throw new SnapshotError(3, `${code} senza location (page_sig, url_pattern o selectors): lo snapshot non si lega alla sua pagina`);
    const cand = obs ? all.filter((o) => o.id === obs) : all;
    const o = cand.find((x) => obsMatchesLocation(x, loc));
    if (!o) throw new SnapshotError(3, `${code}: nessuna osservazione della sua pagina${obs ? ` (${obs} non è della pagina dell'oggetto)` : ""}: leggi la pagina (READ/snapshot) e riprova`);
    const age = (now.getTime() - Date.parse(o.ts ?? 0)) / 1000;
    if (!(age <= maxAgeS && age >= -5)) throw new SnapshotError(3, `${code}: l'ultima osservazione della pagina (${o.id}) ha ${Math.round(age)} s (massimo ${maxAgeS}): rileggi la pagina prima dello snapshot`);
    const sels = Array.isArray(loc.selectors) ? loc.selectors : [];
    const state = (o.elements_seen ?? []).filter((e) => !sels.length || sels.includes(e?.atlas_match)).map((e) => ({ label: e.label ?? null, role: e.role ?? null, ...(e.value !== undefined ? { value: e.value } : {}), ...(e.atlas_match ? { sel: e.atlas_match } : {}) }));
    recorded.push({ code, obs: o.id, obs_ts: o.ts, page_signature: o.page_signature ?? null, url: o.url ?? null, state });
  }
  const ts = now.toISOString();
  const dir = join(ws, "customers", customer, "runs", r, "snapshots");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${ts.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.yaml`);
  writeFileAtomic(file, YAML.stringify({ ts, run: r, session: session.session_code ?? session.session_id, objects: recorded, areas }));
  const rel = relative(join(ws, "customers", customer), file).replace(/\\/g, "/");
  const entry = { objects: [...objects], ts, run: r, file: rel, source: "kb-snapshot", obs: recorded.map((x) => x.obs), ...(areas.length ? { areas: [...areas] } : {}) };
  updateSessionFile(sessionFile(ws, customer, sid), (s) => { s.snapshots = [...(Array.isArray(s.snapshots) ? s.snapshots : []), entry].slice(-20); });
  try { appendAudit(ws, { session: sid, customer, scope: session.scope ?? null, kind: "run", actor: "kb-snapshot", payload: { objects, areas, run: r, file: rel } }); } catch { /* audit */ }
  return { file: rel, entry, objects: recorded };
}

const HELP = `uso: node scripts/kb/snapshot.mjs <CFG…> [--area CL-CFG-nnn] [--run <RUN>] [--obs <OBS>] [--max-age-s 900]
       [--session <id>] [--workspace <dir>] [--json] [--help]

Snapshot degli oggetti governati prima di una modifica (§28.1): lo stato dalle ultime OBS della pagina di ciascun
oggetto (location del CFG), in runs/<RUN>/snapshots/ e in session.snapshots (guard-config-scope: ultimi 60 s, deve
coprire tutti gli oggetti governati del passo).

Exit code: 0 ok · 1 errore utente · 2 errore di sistema · 3 rifiuto (oggetto senza pagina osservata di recente).`;

export function main(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolvePath(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  const sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
  if (!sid) return fail(asJson, 1, "nessuna sessione risolvibile: --session <id>");
  try {
    const r = takeSnapshot({ ws, sid, objects: positional, areas: opts.area ? String(opts.area).split(",") : [], run: opts.run ?? null, obs: opts.obs ?? null, maxAgeS: opts["max-age-s"] != null ? Number(opts["max-age-s"]) : 900 });
    console.log(asJson ? JSON.stringify({ ok: true, ...r }) : `snapshot di ${r.objects.map((o) => o.code).join(", ") || "—"} → ${r.file}`);
    return 0;
  } catch (err) {
    if (err instanceof SnapshotError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
