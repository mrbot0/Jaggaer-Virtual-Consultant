// Validazione di customers/<C>/config/environments.yaml (§51.1, §52.1 strato 1).
// Lo schema (schemas/environments.schema.json) impone le regole di produzione
// con if/then: le violazioni di $defs/prodPolicy sono violazioni di policy
// (exit 3), il resto è input malformato (exit 1). Controlli che lo schema non
// esprime: id univoci, regex compilabili, host di base_url fra allowed_hosts.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import YAML from "yaml";
import { validateWith } from "../lib/schemas.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { normalizeHost } from "../../hooks/lib/browser-tools.mjs";

const POLICY_PATH = /prodPolicy/;
const fmt = (e) => `${e.instancePath || "/"} ${e.message}${e.params?.missingProperty ? ` (${e.params.missingProperty})` : ""}${e.params?.allowedValue !== undefined ? ` (atteso ${JSON.stringify(e.params.allowedValue)})` : ""}`;

export const environmentsFile = (ws, customer) => join(ws, "customers", customer, "config", "environments.yaml");
export const remediationScopeFile = (ws, customer) => join(ws, "customers", customer, "config", "remediation-scope.yaml");
export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

// Host come lo confrontano i guard (una sola definizione, in hooks/lib/browser-tools.mjs).
export { normalizeHost };

function regexOk(src) { try { new RegExp(src); return true; } catch { return false; } }

// → { ok, errors: [string], policy: [string] (sottoinsieme di errors), malformed: [string] }
export function validateEnvironments(doc) {
  const v = validateWith("environments.schema.json", doc);
  const policy = [];
  const malformed = [];
  // Gli errori "if" di Ajv accompagnano quelli veri del ramo then: non si ripetono.
  for (const e of v.raw) {
    if (e.keyword === "if") continue;
    (POLICY_PATH.test(e.schemaPath) ? policy : malformed).push(fmt(e));
  }
  if (v.ok || Array.isArray(doc?.environments)) {
    const ids = new Set();
    (doc?.environments ?? []).forEach((env, i) => {
      if (!env || typeof env !== "object") return;
      if (ids.has(env.id)) malformed.push(`/environments/${i}/id duplicato: ${env.id}`);
      ids.add(env.id);
      const fp = env.fingerprint ?? {};
      for (const [k, src] of [["title_pattern", fp.title_pattern], ["banner.text_pattern", fp.banner?.text_pattern], ["login_url_pattern", fp.login_url_pattern]]) {
        if (typeof src === "string" && !regexOk(src)) malformed.push(`/environments/${i}/fingerprint/${k} non è una regex valida`);
      }
      if (typeof env.base_url === "string" && Array.isArray(env.allowed_hosts)) {
        let host = null;
        try { const u = new URL(env.base_url); host = normalizeHost(u.port ? `${u.hostname}:${u.port}` : u.hostname); } catch { malformed.push(`/environments/${i}/base_url non è un URL`); }
        if (host && !env.allowed_hosts.map(normalizeHost).includes(host)) malformed.push(`/environments/${i}/base_url: l'host ${host} non è in allowed_hosts`);
      }
    });
  }
  const errors = [...policy, ...malformed];
  return { ok: errors.length === 0, errors, policy, malformed };
}

// Valori di default dello schema che i guard non devono indovinare (§52.1):
// prod_allowed_red [] · config_window_minutes 60 · second_approver_required
// true in produzione (fail-closed: A2 da persona diversa se il file tace), false altrove.
export function normalizeEnvironment(env) {
  const policy = { ...env.policy };
  policy.prod_allowed_red ??= [];
  policy.config_window_minutes ??= 60;
  policy.second_approver_required ??= env.type === "prod";
  return { ...env, allowed_hosts: env.allowed_hosts.map(normalizeHost), policy };
}

export class EnvFileError extends Error { constructor(code, msg, extra = {}) { super(msg); this.code = code; this.extra = extra; } }

// Legge e valida un environments.yaml → { file, text, sha256, doc }. Errori:
// EnvFileError con code 1 (assente, YAML o schema) o 3 (policy di produzione).
export function loadEnvironmentsFile(file) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (err) { throw new EnvFileError(1, `environments.yaml illeggibile: ${file} (${err.code ?? err.message})`); }
  let doc;
  try { doc = YAML.parse(text); } catch (err) { throw new EnvFileError(1, `environments.yaml: YAML non valido (${err.message.split("\n")[0]})`); }
  const r = validateEnvironments(doc);
  if (!r.ok) throw new EnvFileError(r.policy.length ? 3 : 1, `environments.yaml non valido: ${r.errors.join("; ")}`, { errors: r.errors, policy: r.policy });
  return { file, text, sha256: sha256(text), doc };
}

// remediation-scope.yaml (§28.1): aree CL-CFG e oggetti CFG modificabili per livello.
export function validateRemediationScope(doc) {
  const v = validateWith("remediation-scope.schema.json", doc);
  return { ok: v.ok, errors: v.errors };
}

// → { doc, sha256 } (null/null se il file non esiste). Invalido ⇒ EnvFileError(1).
export function loadRemediationScope(ws, customer) {
  const file = remediationScopeFile(ws, customer);
  let text;
  try { text = readFileSync(file, "utf8"); } catch (err) { if (err.code === "ENOENT") return { doc: null, sha256: null }; throw new EnvFileError(1, `remediation-scope.yaml illeggibile (${err.code ?? err.message})`); }
  let doc;
  try { doc = YAML.parse(text); } catch (err) { throw new EnvFileError(1, `remediation-scope.yaml: YAML non valido (${err.message.split("\n")[0]})`); }
  const r = validateRemediationScope(doc);
  if (!r.ok) throw new EnvFileError(1, `remediation-scope.yaml non valido: ${r.errors.join("; ")}`, { errors: r.errors });
  return { doc, sha256: sha256(text) };
}

const HELP = `uso: node scripts/kb/validate-env.mjs <environments.yaml> [--json]
     node scripts/kb/validate-env.mjs --customer <C> [--workspace <dir>] [--json]

Valida gli ambienti del cliente contro schemas/environments.schema.json (§51.1).
In produzione lo schema impone write_data: false, 3 approvazioni per livello e
nessun rosso in config_levels: una violazione è di policy, non un avviso.

Exit code: 0 valido · 1 malformato (YAML, schema, regex, host) · 2 errore di sistema · 3 violazione di policy (§52.1).`;

export function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  let file = positional[0];
  if (!file && opts.customer) file = environmentsFile(resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd()), opts.customer);
  if (!file) { console.log(HELP); return 1; }
  try {
    const { doc, sha256: hash } = loadEnvironmentsFile(file);
    const out = { ok: true, file, sha256: hash, environments: doc.environments.map((e) => ({ id: e.id, type: e.type })) };
    console.log(asJson ? JSON.stringify(out) : `valido: ${out.environments.map((e) => `${e.id} (${e.type})`).join(", ")}`);
    return 0;
  } catch (err) {
    if (err instanceof EnvFileError) return fail(asJson, err.code, err.message, err.extra);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
