// Validazione di un piano di esecuzione contro il catalogo delle azioni (§29.4)
// e l'ambiente (§52.1 strato 2): "un'azione fuori catalogo non esiste per il
// plugin; validate-schema la rifiuta nel piano".
//   validatePlan(plan, { env, catalog }) → { ok, errors, policy, warnings }
//     - schema execution-plan (verbi del vocabolario: DELETE non esiste);
//     - ogni passo ha action_class, e la classe è in catalogo;
//     - ACT-DELETE ⇒ invalido ovunque; colonna dell'ambiente `never` ⇒ invalido;
//     - effect write con env.type prod ⇒ invalido;
//     - ACT-CFG-CHANGE in prod ⇒ serve approvals: 3A nel piano;
//     - passo di configurazione con effetto ⇒ serve `config` (oggetto/area, livello);
//     - verbo del passo fuori da verbs_allowed della classe ⇒ invalido;
//     - plan.env deve essere l'id dell'ambiente (se env.id è noto).
//   policy = errori di policy (exit 3 della CLI); il resto è input malformato (exit 1).
//   loadCatalog(dir) → Map code → ACT (product/kb/actions del plugin per default).
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { validateWith } from "../lib/schemas.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { confineInputs, inputFile } from "../lib/text-file.mjs";

export const DEFAULT_CATALOG_DIR = fileURLToPath(new URL("../../product/kb/actions", import.meta.url));
const READ_VERBS = new Set(["NAVIGATE", "READ", "CAPTURE", "WAIT", "VERIFY", "ASK"]);
// dev si comporta come sandbox (§51.1: dev · sandbox · preprod · prod; il catalogo ha tre colonne).
export const envColumn = (type) => (type === "prod" ? "prod" : type === "preprod" ? "preprod" : "sandbox");

const cache = new Map();
export function loadCatalog(dir = DEFAULT_CATALOG_DIR) {
  if (cache.has(dir)) return cache.get(dir);
  const map = new Map();
  for (const f of readdirSync(dir).filter((x) => /^S\.STD\.XSC\.ACT\.\d{4}\.ya?ml$/.test(x)).sort()) {
    const it = YAML.parse(readFileSync(join(dir, f), "utf8"));
    if (it?.type === "ACT" && typeof it.code === "string") map.set(it.code, it);
  }
  cache.set(dir, map);
  return map;
}

export function validatePlan(plan, { env, catalog = loadCatalog() } = {}) {
  const errors = [];
  const policy = [];
  const warnings = [];
  const v = validateWith("execution-plan.schema.json", plan);
  if (!v.ok) errors.push(...v.raw.filter((e) => e.keyword !== "if").map((e) => `schema ${e.instancePath || "/"} ${e.message}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(" ")})` : ""}`));
  const type = env?.type;
  if (!type) errors.push("ambiente mancante: validatePlan richiede env.type (sandbox · preprod · prod)");
  if (env?.id && plan?.env && plan.env !== env.id) errors.push(`il piano dichiara l'ambiente ${plan.env}, l'ambiente attivo è ${env.id}`);
  const col = envColumn(type);
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  for (const s of steps) {
    const at = `passo ${s?.n ?? "?"}`;
    if (s?.verb === "DELETE") { policy.push(`${at}: il verbo DELETE non esiste nel vocabolario dei piani (ADR-06: close/cancel)`); continue; }
    const code = s?.action_class;
    if (!code) { errors.push(`${at}: action_class mancante (ogni passo appartiene a una classe del catalogo, §29.4)`); continue; }
    if (code === "ACT-DELETE") { policy.push(`${at}: ACT-DELETE non è ammessa in nessun ambiente (§29.4, ADR-06)`); continue; }
    const act = catalog.get(code);
    if (!act) { policy.push(`${at}: classe di azione fuori catalogo: ${code}`); continue; }
    if (!type) continue;
    const adm = act.environments?.[col];
    if (adm === "never") policy.push(`${at}: ${code} non è ammessa in ${type}${type === "prod" ? " — in produzione non si scrivono dati; posso farlo in sandbox o pre-produzione (§52.1)" : ""}`);
    else if (act.effect === "write" && type === "prod") policy.push(`${at}: ${code} scrive dati: in prod mai (§52.1)`);
    if (adm === "3A" && plan?.approvals !== "3A") policy.push(`${at}: ${code} in ${type} richiede il protocollo 3A: il piano deve dichiarare approvals: 3A (§52.2)`);
    if (adm === "referent") warnings.push(`${at}: ${code} in ${type} solo con referente presente`);
    if (adm === "approval") warnings.push(`${at}: ${code} in ${type} solo con approvazione esplicita`);
    if (s.verb && Array.isArray(act.verbs_allowed) && !act.verbs_allowed.includes(s.verb)) errors.push(`${at}: il verbo ${s.verb} non appartiene alla classe ${code} (${act.verbs_allowed.join(" ")})`);
    if (act.effect === "config" && s.verb && !READ_VERBS.has(s.verb) && !s.config) errors.push(`${at}: passo di configurazione ${s.verb} senza config (oggetto o area CL-CFG, livello DT-007)`);
  }
  const all = [...policy, ...errors];
  return { ok: all.length === 0, errors: all, policy, warnings };
}

const HELP = `uso: node scripts/decide/validate-plan.mjs <piano.yaml|json> (--env-type <sandbox|preprod|prod> [--env-id <id>] | --customer <C> --env <id>)
       [--catalog <dir>] [--workspace <dir>] [--json]

Valida un piano di esecuzione contro schemas/execution-plan.schema.json e il
catalogo delle azioni (product/kb/actions, §29.4): classe fuori catalogo,
ACT-DELETE, scritture in prod, ACT-CFG-CHANGE in prod senza approvals: 3A.

Exit code: 0 valido · 1 piano malformato · 2 errore di sistema · 3 violazione di policy (§29.4, §52).`;

export async function run(argv, envv = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  { const bad = confineInputs(opts, ["catalog"], { env: envv }); if (bad) return fail(asJson, 1, bad); }
  if (!positional[0]) { console.log(HELP); return 1; }
  const conf = inputFile(positional[0], { env: envv });
  if (conf.error) return fail(asJson, 1, conf.error);
  const file = conf.abs;
  try {
    let plan;
    try { plan = YAML.parse(readFileSync(file, "utf8")); } catch (err) { return fail(asJson, 1, `piano illeggibile: ${err.message.split("\n")[0]}`); }
    let env = opts["env-type"] ? { type: opts["env-type"], id: opts["env-id"] ?? null } : null;
    if (!env && opts.customer && opts.env) {
      const { loadEnvironmentsFile, environmentsFile } = await import("../kb/validate-env.mjs");
      const ws = resolve(opts.workspace || envv.JVC_WORKSPACE || envv.CLAUDE_PROJECT_DIR || process.cwd());
      const d = loadEnvironmentsFile(environmentsFile(ws, opts.customer)).doc.environments.find((e) => e.id === opts.env);
      if (!d) return fail(asJson, 1, `ambiente inesistente: ${opts.env}`);
      env = { id: d.id, type: d.type };
    }
    if (!env || !["dev", "sandbox", "preprod", "prod"].includes(env.type)) return fail(asJson, 1, "serve --env-type <sandbox|preprod|prod> o --customer <C> --env <id>");
    const r = validatePlan(plan, { env, ...(opts.catalog ? { catalog: loadCatalog(resolve(opts.catalog)) } : {}) });
    if (asJson) console.log(JSON.stringify(r));
    else console.log(r.ok ? `piano valido${r.warnings.length ? ` (avvisi: ${r.warnings.join("; ")})` : ""}` : `piano non valido:\n  ${r.errors.join("\n  ")}`);
    return r.ok ? 0 : r.policy.length ? 3 : 1;
  } catch (err) {
    if (err?.code === 1 || err?.code === 3) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
