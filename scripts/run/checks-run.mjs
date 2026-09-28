// checks-run (C1.3, §28.3 passi 8 e 11, §62): esegue i CHK di un cluster (o elencati) che hanno un'implementazione
// script (how.script) ed emette i passi READ del piano per quelli che richiedono il browser. Un pre-check che fallisce
// BLOCCA (exit 3): la modifica non parte.
//
//   SCRIPT_CHECKS[nome](ctx) → { status: pass|fail|skip|report|browser, detail }   ctx: { ws, customer, session, run,
//     plan?, cfp?, cases?, cost?, probe?, since?, now }
//   runChecks(ctx, { cluster?, codes? }) → { results[], plan_steps[], blocked }
//     results: { code, title, kind, status, detail, via: script|browser }; plan_steps: passi READ (ACT-READ) con il CHK
//     come check e l'atteso di how.expect, da eseguire sul browser con step-check.
//
// CLI: node scripts/run/checks-run.mjs --cluster CL-CHK-002 [--check <CHK>…] [--plan <file>] [--cfp <codice|file>] [--run <RUN>]
//      [--cost <token>] [--probe <file.yaml>] [--since <ISO>] [--session <id>] [--workspace <dir>] [--json]
//      con --run i passi browser vanno in runs/<RUN>/checks/<cluster>.plan.json
// Exit: 0 tutti superati (o da eseguire sul browser) · 1 argomenti · 2 errore di sistema · 3 un check fallito blocca.
import { readFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { loadItems, loadItem } from "../lib/kb-items.mjs";
import { runRefusal } from "../lib/run-code.mjs";
import { runResults } from "../lib/run-results.mjs";
import { loadSession, resolveSessionId } from "../admin/session.mjs";
import { governedObjects, snapshotCovers } from "../../hooks/lib/guards/config-scope.mjs";
import { obsMatchesLocation } from "../kb/snapshot.mjs";
import { loadRegistry, resolveCaseFixtures, createdEntities } from "./fixtures.mjs";
import { status as authStatus, personasOf, AuthError } from "./auth-setup.mjs";

export class ChecksError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
const SNAPSHOT_MS = 60000;
const DAY = 86400e3;
const pass = (detail) => ({ status: "pass", detail });
const failed = (detail) => ({ status: "fail", detail });
const skip = (detail) => ({ status: "skip", detail });

// WP09b giro 1: esiti per piano (runs/<RUN>/results/<plan_id>.yaml) e di run (result.yaml), scripts/lib/run-results.mjs
function greenRunsOf(ws, customer, planIds, sinceMs = 0) {
  return runResults(ws, customer, { planIds }).filter((y) => y.status === "green" && Date.parse(y.completed_at ?? 0) >= sinceMs)
    .map((y) => ({ run: y.run, completed_at: y.completed_at, plan_id: y.plan_id })).sort((x, y) => Date.parse(y.completed_at) - Date.parse(x.completed_at));
}
const governedOf = (ctx) => {
  const fromPlan = (ctx.plan?.steps ?? []).filter((s) => s.action_class === "ACT-CFG-CHANGE").flatMap((s) => governedObjects(s));
  return [...new Set([...fromPlan, ...(ctx.cfp?.snapshot_before ?? ctx.cfp?.governs ?? [])])];
};

export const SCRIPT_CHECKS = Object.freeze({
  // S.STD.ADM.CHK.0051 — lo snapshot (ultimi 60 s) copre tutti gli oggetti governati
  "snapshot-coverage": (ctx) => {
    const gov = governedOf(ctx);
    if (!gov.length) return skip("nessun oggetto governato nel piano o nella CFP");
    const fresh = (ctx.session?.snapshots ?? []).filter((x) => { const age = ctx.now.getTime() - Date.parse(x?.ts ?? ""); return age <= SNAPSHOT_MS && age >= -5000; });
    const step = { config: { object: gov[0], governs: gov } };
    if (fresh.some((x) => snapshotCovers(x, step))) return pass(`snapshot recente di ${gov.join(", ")}`);
    const missing = gov.filter((o) => !fresh.some((x) => (x.objects ?? []).includes(o)));
    return failed(`nessuno snapshot degli ultimi 60 s copre tutti gli oggetti governati (mancano ${missing.join(", ") || "—"}): kb snapshot ${gov.join(" ")}`);
  },
  // S.STD.ADM.CHK.0052 — CFP di rollback provata (run verde) negli ultimi 14 giorni, per R ≥ R2
  "rollback-proven": (ctx) => {
    const cfp = ctx.cfp;
    if (!cfp) return skip("nessuna CFP in esame (--cfp)");
    const S = cfp.derives_from ? loadItem(ctx.ws, cfp.derives_from, ctx.customer) ?? cfp : cfp;
    if (!["R2", "R3"].includes(S.risk)) return skip(`rischio ${S.risk}: il check vale per R ≥ R2`);
    const ref = S.rollback?.ref;
    if (!ref) return failed(`${S.id} (${S.risk}) senza rollback dichiarato`);
    // giro 1: la prova a vuoto (.DRY, SAVE/SUBMIT sostituiti da CAPTURE) non applica il rollback: non lo prova
    const g = greenRunsOf(ctx.ws, ctx.customer, [`PLAN.${ref}`], ctx.now.getTime() - 14 * DAY);
    return g.length ? pass(`rollback ${ref} verde in ${g[0].run}`) : failed(`nessun run verde della CFP di rollback ${ref} negli ultimi 14 giorni: provala (anche a vuoto) prima della modifica`);
  },
  // S.STD.XSC.CHK.0001 — ambiente dichiarato = rilevato (env-check con ≥ 2 segnali)
  "env-verified": (ctx) => {
    const e = ctx.session?.env;
    if (!e) return failed("nessun ambiente dichiarato: /use env <id>");
    if (e.verified !== true) return failed(`ambiente ${e.id} dichiarato ma non verificato: env-check`);
    if (ctx.plan?.env && ctx.plan.env !== e.id) return failed(`il piano è per ${ctx.plan.env}, l'ambiente verificato è ${e.id}`);
    return pass(`ambiente ${e.id} (${e.type}) verificato${e.verified_at ? ` alle ${e.verified_at}` : ""}`);
  },
  // S.STD.ADM.CHK.0045 — il verificatore NRT.*.CFG dell'oggetto è verde
  "cfg-verifier-green": (ctx) => {
    const cfp = ctx.cfp;
    const S = cfp?.derives_from ? loadItem(ctx.ws, cfp.derives_from, ctx.customer) ?? cfp : cfp;
    const vt = S?.verification_test;
    if (!vt) return skip("nessun verification_test dichiarato");
    const id = vt.replace(/^NRT\.STD\./, `NRT.${ctx.customer}.`);
    const g = greenRunsOf(ctx.ws, ctx.customer, [`PLAN.${id}`], ctx.since ? Date.parse(ctx.since) : 0);
    return g.length ? pass(`${id} verde in ${g[0].run}`) : failed(`${id} non ha un run verde${ctx.since ? ` dopo ${ctx.since}` : ""}`);
  },
  // S.STD.ADM.CHK.0046 — nessun nuovo ERR sulle pagine governate dopo la modifica
  "no-new-errors": (ctx) => {
    const gov = governedOf(ctx);
    const locs = gov.map((c) => loadItem(ctx.ws, c, ctx.customer)?.location).filter(Boolean);
    const since = ctx.since ? Date.parse(ctx.since) : ctx.now.getTime() - 3600e3;
    const dir = join(ctx.ws, "customers", ctx.customer, "observations");
    const hits = [];
    if (existsSync(dir)) for (const f of readdirSync(dir).filter((x) => x.endsWith(".yaml")).sort().slice(-500)) {
      let o; try { o = YAML.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
      if (Date.parse(o?.ts ?? 0) < since || !(o?.errors ?? []).length) continue;
      if (!locs.length || locs.some((l) => obsMatchesLocation(o, l))) hits.push(o.id);
    }
    return hits.length ? failed(`errori osservati sulle pagine governate: ${hits.join(", ")}`) : pass("0 errori nelle osservazioni delle pagine governate");
  },
  // S.STD.XSC.CHK.0004 — stub inbound raggiungibile: in sandbox, con la sonda della pipeline (--probe) o sul browser
  "stub-reachable": (ctx) => {
    if (ctx.session?.env?.type && ctx.session.env.type !== "sandbox") return failed(`lo stub L3 vale solo in sandbox (ambiente ${ctx.session.env.type})`);
    if (!ctx.probe) return { status: "browser", detail: "nessuna sonda: verificare lo stub dal browser (risposta 200)" };
    return Number(ctx.probe.status) === 200 ? pass("stub raggiungibile (200)") : failed(`stub non raggiungibile (${ctx.probe.status})`);
  },
  // S.STD.XSC.CHK.0005 — fixture strutturali presenti (lookup_or_fail per ognuna dei casi della run)
  "fixtures-present": (ctx) => {
    const cases = ctx.cases ?? [];
    if (!cases.length) return skip("nessun caso della run (manifest assente)");
    const reg = loadRegistry(ctx.ws, ctx.customer);
    const missing = cases.flatMap((c) => resolveCaseFixtures(c, reg, { env: ctx.session?.env?.id ?? null }).missing.map((m) => `${c.id}:${m.name}`));
    return missing.length ? failed(`fixture mancanti: ${missing.join(", ")}`) : pass(`fixture di ${cases.length} casi trovate`);
  },
  // S.STD.VEN.CHK.0001 — nessun fornitore duplicato per P.IVA fra i creati dai test
  "duplicate-test-suppliers": (ctx) => {
    const by = new Map();
    for (const e of createdEntities(ctx.ws, ctx.customer)) if (/supplier|fornitor/i.test(e.entity) && e.attrs?.vat) by.set(e.attrs.vat, [...(by.get(e.attrs.vat) ?? []), e.ref]);
    const dup = [...by.entries()].filter(([, v]) => v.length > 1);
    return dup.length ? failed(`fornitori di test duplicati per P.IVA: ${dup.map(([k, v]) => `${k} (${v.join(", ")})`).join("; ")}`) : pass("0 duplicati");
  },
  // S.STD.XSC.CHK.0006 — entità NRT-* aperte più vecchie di 30 giorni: elenco, mai cancellazione
  "stale-test-entities": (ctx) => {
    const old = createdEntities(ctx.ws, ctx.customer).filter((e) => e.status !== "compensated" && ctx.now.getTime() - Date.parse(e.created_at ?? 0) > 30 * DAY);
    return { status: "report", detail: old.length ? `${old.length} entità di test aperte da oltre 30 giorni (da chiudere o annullare, mai cancellare): ${old.map((e) => e.ref).join(", ")}` : "nessuna entità di test aperta da oltre 30 giorni", items: old.map((e) => ({ ref: e.ref, run: e.run, created_at: e.created_at })) };
  },
  // S.STD.XSC.CHK.0007 — in produzione solo persone amministrative
  "prod-personas-admin": (ctx) => {
    const e = ctx.session?.env;
    if (!e) return failed("nessun ambiente dichiarato");
    try { const p = personasOf(ctx.ws, ctx.customer, e.id); return pass(e.type === "prod" ? `persone di produzione: ${p.personas.join(", ") || "nessuna"}` : `ambiente ${e.type}: check non applicabile`); }
    catch (err) { if (err instanceof AuthError) return failed(err.message); throw err; }
  },
  // S.STD.XSC.CHK.0008 — storageState valido per ogni persona dell'ambiente
  "storage-state-valid": (ctx) => {
    const e = ctx.session?.env;
    if (!e) return failed("nessun ambiente dichiarato");
    try {
      const s = authStatus(ctx.ws, { customer: ctx.customer, envId: e.id, now: ctx.now });
      const bad = s.filter((x) => x.state !== "valid");
      return bad.length ? failed(`storageState non validi: ${bad.map((b) => `${b.persona} (${b.state})`).join(", ")}`) : pass(`${s.length} persone con storageState valido`);
    } catch (err) { if (err instanceof AuthError) return failed(err.message); throw err; }
  },
  // S.STD.XSC.CHK.0010 — budget di sessione residuo ≥ costo stimato del compito
  "budget-residual": (ctx) => {
    const b = ctx.session?.budget;
    if (!b?.tokens) return failed("budget di sessione non dichiarato");
    const left = b.tokens - (b.used ?? 0);
    const cost = Number(ctx.cost ?? 0);
    return left >= cost ? pass(`residuo ${left} ≥ costo stimato ${cost}`) : failed(`residuo ${left} < costo stimato ${cost}: il compito non sta nel budget (§29.10)`);
  },
});

export function loadChecks(ws, customer, { cluster = null, codes = null } = {}) {
  const all = loadItems(ws, { customer, types: ["CHK"] });
  return all.filter((c) => (codes?.length ? codes.includes(c.id) : true) && (cluster ? (c.cluster ?? []).includes(cluster) : true)).sort((a, b) => a.id.localeCompare(b.id));
}

export function runChecks(ctx, { cluster = null, codes = null } = {}) {
  const checks = loadChecks(ctx.ws, ctx.customer, { cluster, codes });
  if (!checks.length) throw new ChecksError(1, `nessun check${cluster ? ` nel cluster ${cluster}` : ""}${codes?.length ? ` fra ${codes.join(", ")}` : ""}`);
  const results = [];
  const planSteps = [];
  for (const c of checks) {
    const impl = c.how?.script ? SCRIPT_CHECKS[c.how.script] : null;
    // giro 1: uno script nominato ma non implementato fallisce (fail-closed), mai un passo del browser silenzioso
    let r = c.how?.script && !impl ? { status: "fail", detail: `how.script ${c.how.script} non implementato in checks-run: il check non si può eseguire` }
      : impl ? impl(ctx) : { status: "browser", detail: `da eseguire sul browser: ${c.how?.verb} ${c.how?.target ?? ""} · atteso ${c.how?.expect}` };
    if (r.status === "browser") {
      const n = planSteps.length + 1;
      planSteps.push(c.how?.target
        ? { n, verb: "READ", action_class: "ACT-READ", target: c.how.target, expect: { check: c.id, expected: c.how.expect }, note: `${c.id}: ${c.title}` }
        : { n, verb: "VERIFY", action_class: "ACT-READ", check: c.id, expect: { check: c.id, expected: c.how?.expect ?? "ok" }, note: `${c.id}: ${c.title}` });
    }
    results.push({ code: c.id, title: c.title, kind: c.kind, status: r.status, detail: r.detail, via: c.how?.script && r.status !== "browser" ? "script" : "browser", ...(r.items ? { items: r.items } : {}) });
  }
  const blocked = results.some((r) => r.status === "fail");
  return { results, plan_steps: planSteps, blocked };
}

const HELP = `uso: node scripts/run/checks-run.mjs --cluster CL-CHK-002 [--check <CHK>…] [--plan <file>] [--cfp <codice|file>] [--run <RUN>]
       [--cost <token>] [--probe <file.yaml>] [--since <ISO>] [--session <id>] [--workspace <dir>] [--json] [--help]

Esegue i CHK (§62) che hanno un'implementazione script e prepara i passi READ per quelli da fare sul browser.
Un check fallito blocca (exit 3).

Exit code: 0 superati (o da completare sul browser) · 1 argomenti · 2 errore di sistema · 3 un check fallito blocca.`;

export function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const codes = [...(opts.check ? [opts.check] : []), ...positional.filter((p) => /\.CHK\.\d{4}$/.test(p))];
  if (!opts.cluster && !codes.length) return fail(asJson, 1, "richiesto --cluster CL-CHK-nnn o --check <CHK>");
  const ws = resolvePath(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    const sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
    const { session, pointer } = sid ? loadSession(ws, sid) : { session: null, pointer: null };
    const customer = opts.customer ?? pointer?.customer ?? null;
    if (!customer) return fail(asJson, 1, "cliente non determinato: sessione attiva o --customer");
    const runCode = opts.run ?? session?.active_plan?.run ?? null;
    if (runCode) { const bad = runRefusal(ws, customer, runCode); if (bad) return fail(asJson, 1, bad); }
    const readYaml = (f) => YAML.parse(readFileSync(resolvePath(ws, f), "utf8"));
    const plan = opts.plan ? (() => { const p = join(ws, "customers", customer, opts.plan); return JSON.parse(readFileSync(existsSync(p) ? p : resolvePath(opts.plan), "utf8")); })() : null;
    const cfp = opts.cfp ? (/^[SC]\..*\.CFP\.\d{4}$/.test(opts.cfp) ? loadItem(ws, opts.cfp, customer) : readYaml(opts.cfp)) : null;
    if (opts.cfp && !cfp) return fail(asJson, 1, `${opts.cfp} non trovata`);
    let cases = null;
    if (runCode) {
      const m = join(ws, "customers", customer, "runs", runCode, "manifest.yaml");
      if (existsSync(m)) cases = (YAML.parse(readFileSync(m, "utf8"))?.cases ?? []).map((c) => { try { return YAML.parse(readFileSync(join(ws, "customers", customer, c.file), "utf8")); } catch { return null; } }).filter(Boolean);
    }
    const ctx = { ws, customer, session, run: runCode, plan, cfp, cases, cost: opts.cost ?? 0, probe: opts.probe ? readYaml(opts.probe) : null, since: opts.since ?? null, now: new Date() };
    const r = runChecks(ctx, { cluster: opts.cluster ?? null, codes: codes.length ? codes : null });
    let planFile = null;
    if (runCode && r.plan_steps.length) {
      const dir = join(ws, "customers", customer, "runs", runCode, "checks");
      mkdirSync(dir, { recursive: true });
      const id = String(opts.cluster ?? "CHECKS").replace(/[^A-Za-z0-9-]/g, "");
      const p = { plan_id: `PLAN.${runCode}.${id}`, customer, env: session?.env?.id ?? "sandbox", goal: `check ${opts.cluster ?? codes.join(", ")} sul browser`, steps: r.plan_steps, repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: r.plan_steps.map((s) => s.n) } };
      planFile = `runs/${runCode}/checks/${id}.plan.json`;
      writeFileAtomic(join(ws, "customers", customer, planFile), `${JSON.stringify(p, null, 2)}\n`);
    }
    if (asJson) console.log(JSON.stringify({ ok: !r.blocked, ...r, plan_file: planFile }));
    else for (const x of r.results) console.log(`${x.status.padEnd(7)} ${x.code} ${x.title} — ${x.detail}`);
    return r.blocked ? 3 : 0;
  } catch (err) {
    if (err instanceof ChecksError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
