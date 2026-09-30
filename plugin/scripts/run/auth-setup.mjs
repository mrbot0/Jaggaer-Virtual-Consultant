// auth-setup (§45.5, §48.1, CL-CHK-006, CL-CHK-010): storageState per persona in <ws>/.auth/<persona>.json con i
// metadati in .auth/<persona>.meta.json (cliente, ambiente, TTL, scadenza, impronta). I segreti stanno SOLO in .auth/
// (mai nei metadati né nell'output: niente valori di cookie o token); le persone vengono da environments.yaml; in
// produzione solo persone amministrative (admin*: nessuna persona di business, non si creano documenti).
//
//   personasOf(ws, customer, envId) → { env, personas[] }         prod con persone non amministrative ⇒ AuthError(3)
//   register(ws, { customer, envId, persona, file, ttlHours?, now }) → meta   il file deve essere uno storageState
//       (cookies[] / origins[]); scadenza = min(expires dei cookie, now + TTL)
//   status(ws, { customer, envId, now }) → [{ persona, state: valid|expired|missing|foreign, expires_at, reason? }]
//
// CLI: node scripts/run/auth-setup.mjs personas|status|check [--env <id>] [--customer C]
//      node scripts/run/auth-setup.mjs register --persona <p> --file <storageState.json> [--env <id>] [--ttl-hours 8]
// Exit: 0 ok · 1 errore utente · 2 errore di sistema · 3 persona non valida (check) o persona di business in prod.
import { readFileSync, existsSync, mkdirSync, copyFileSync, statSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { workspaceCustomer } from "./fixtures.mjs";

export class AuthError extends Error { constructor(code, msg) { super(msg); this.code = code; } }
export const DEFAULT_TTL_HOURS = 8;
const PERSONA_RE = /^[a-z][a-z0-9-]{1,40}$/;
export const isAdminPersona = (p) => /^admin(-|$)/.test(String(p));

export function personasOf(ws, customer, envId) {
  const f = join(ws, "customers", customer, "config", "environments.yaml");
  if (!existsSync(f)) throw new AuthError(1, `environments.yaml assente per ${customer}`);
  const env = (YAML.parse(readFileSync(f, "utf8"))?.environments ?? []).find((e) => e.id === envId);
  if (!env) throw new AuthError(1, `ambiente ${envId} non dichiarato in environments.yaml`);
  const personas = Array.isArray(env.personas) ? env.personas : [];
  if (env.type === "prod") {
    const business = personas.filter((p) => !isAdminPersona(p));
    if (business.length) throw new AuthError(3, `in produzione solo persone amministrative (CL-CHK-006): ${business.join(", ")} non ammesse`);
  }
  return { env: { id: env.id, type: env.type, ttl_hours: env.policy?.storage_state_ttl_hours ?? DEFAULT_TTL_HOURS }, personas };
}

const authDir = (ws) => join(ws, ".auth");
const stateFile = (ws, p) => join(authDir(ws), `${p}.json`);
const metaFile = (ws, p) => join(authDir(ws), `${p}.meta.json`);

export function register(ws, { customer, envId, persona, file, ttlHours = null, now = new Date() }) {
  if (!PERSONA_RE.test(String(persona ?? ""))) throw new AuthError(1, `persona non valida: ${persona}`);
  const { env, personas } = personasOf(ws, customer, envId);
  if (!personas.includes(persona)) throw new AuthError(1, `la persona ${persona} non è dichiarata per l'ambiente ${envId} (${personas.join(", ") || "nessuna"})`);
  let st;
  try { st = JSON.parse(readFileSync(resolvePath(file), "utf8")); } catch (err) { throw new AuthError(1, `storageState illeggibile: ${err.message}`); }
  if (!st || !Array.isArray(st.cookies) || (st.origins !== undefined && !Array.isArray(st.origins))) throw new AuthError(1, "il file non è uno storageState (cookies[], origins[])");
  const ttl = ttlHours ?? env.ttl_hours;
  const cookieExp = st.cookies.map((c) => Number(c?.expires)).filter((x) => Number.isFinite(x) && x > 0).map((x) => x * 1000);
  const expires = Math.min(now.getTime() + ttl * 3600e3, ...cookieExp);
  mkdirSync(authDir(ws), { recursive: true });
  if (resolvePath(file) !== stateFile(ws, persona)) copyFileSync(resolvePath(file), stateFile(ws, persona));
  const meta = { persona, customer, env: envId, env_type: env.type, created_at: now.toISOString(), ttl_hours: ttl, expires_at: new Date(expires).toISOString(),
    cookies: st.cookies.length, origins: (st.origins ?? []).length, sha256: createHash("sha256").update(readFileSync(stateFile(ws, persona))).digest("hex") };
  writeFileAtomic(metaFile(ws, persona), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

export function status(ws, { customer, envId, now = new Date() }) {
  const { personas } = personasOf(ws, customer, envId);
  return personas.map((persona) => {
    if (!existsSync(stateFile(ws, persona)) || !existsSync(metaFile(ws, persona))) return { persona, state: "missing", reason: "nessuno storageState registrato (auth-setup register)" };
    let meta;
    try { meta = JSON.parse(readFileSync(metaFile(ws, persona), "utf8")); } catch { return { persona, state: "missing", reason: "metadati illeggibili" }; }
    if (meta.customer !== customer || meta.env !== envId) return { persona, state: "foreign", reason: `storageState di ${meta.customer}/${meta.env}, non di ${customer}/${envId}` };
    const sha = createHash("sha256").update(readFileSync(stateFile(ws, persona))).digest("hex");
    if (sha !== meta.sha256) return { persona, state: "missing", reason: "storageState cambiato dopo la registrazione: riregistra" };
    if (Date.parse(meta.expires_at) <= now.getTime()) return { persona, state: "expired", expires_at: meta.expires_at, reason: "scaduto: rifai il login e riregistra" };
    return { persona, state: "valid", expires_at: meta.expires_at, age_s: Math.round((now.getTime() - statSync(stateFile(ws, persona)).mtimeMs) / 1000) };
  });
}

const HELP = `uso: node scripts/run/auth-setup.mjs personas|status|check [--env <id>] [--customer C] [--workspace <dir>] [--json]
       node scripts/run/auth-setup.mjs register --persona <p> --file <storageState.json> [--env <id>] [--ttl-hours 8]

storageState per persona in .auth/<persona>.json (solo lì i segreti; metadati in .auth/<persona>.meta.json): persone da
environments.yaml, in produzione solo amministrative; check: exit 3 se una persona non ha uno storageState valido.

Exit code: 0 ok · 1 errore utente · 2 errore di sistema · 3 persona non valida o di business in prod.`;

export function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  const [cmd] = positional;
  if (opts.help || !cmd) { console.log(HELP); return opts.help ? 0 : 1; }
  const { ws, customer } = workspaceCustomer(opts, env);
  if (!customer) return fail(asJson, 1, "cliente non determinato: --customer <C>");
  const envId = opts.env ?? "sandbox";
  const out = (o) => console.log(asJson ? JSON.stringify({ ok: true, ...o }) : YAML.stringify(o).trim());
  try {
    if (cmd === "personas") { out(personasOf(ws, customer, envId)); return 0; }
    if (cmd === "register") { if (!opts.persona || !opts.file) return fail(asJson, 1, "richiesti --persona e --file"); out({ meta: register(ws, { customer, envId, persona: opts.persona, file: opts.file, ttlHours: opts["ttl-hours"] != null ? Number(opts["ttl-hours"]) : null }) }); return 0; }
    if (cmd === "status" || cmd === "check") {
      const s = status(ws, { customer, envId });
      const bad = s.filter((x) => x.state !== "valid");
      if (cmd === "check" && bad.length) { if (asJson) console.log(JSON.stringify({ ok: false, personas: s })); else console.error(`storageState non validi: ${bad.map((b) => `${b.persona} (${b.state})`).join(", ")}`); return 3; }
      out({ personas: s }); return 0;
    }
    return fail(asJson, 1, `comando sconosciuto: ${cmd}`);
  } catch (err) {
    if (err instanceof AuthError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
