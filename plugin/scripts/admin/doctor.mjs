// doctor (F0.4, §48.1, §55.2, §54.7, §58): prima di lavorare, "deve essere tutto verde". Ogni controllo è
// { id, status: green|yellow|red, detail, fix }. Controlli: versione di Node, dipendenze installate e importabili,
// versione del plugin rispetto a knowledge_version dei DB, integrità del pacchetto, DB per cliente (WAL, migrazioni),
// environments.yaml (regole di produzione comprese), credenziali per prefisso (solo i NOMI, mai i valori), server del
// browser (non sondabili dal plugin ⇒ giallo), ALM/Jira (coda offline o raggiungibilità con --network), compensazioni
// pendenti di sessioni precedenti, prod_allowed_red (§52.2), checklist di hardening §54.7, catena dell'audit del mese
// corrente; con --network: risoluzione DNS degli host dichiarati (offline ⇒ saltato) e host configurati fuori allow-list.
// Nessun modulo esterno in testa: con le dipendenze non installate doctor deve comunque rispondere.
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { verifyPackage, devMode } from "../../hooks/lib/integrity.mjs";
import { verifyChain } from "../../hooks/lib/audit.mjs";
import { NETWORK_CATEGORIES, parseNetworkMd } from "../lib/network-md.mjs";

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CUSTOMER_RE = /^[A-Z0-9]{4}$/;
const DEPS = ["ajv", "ajv-formats", "yaml", "better-sqlite3"];
const BROWSER_SERVER = /chrome|browser|playwright|puppeteer|selenium|devtools/i;
// Host che il plugin contatta per costruzione (§53.2) oltre a quelli dichiarati dal cliente; NETWORK.md li estende.
const DEFAULT_ALLOW = ["*.atlassian.net", "*.getxray.app", "registry.npmjs.org", "api.anthropic.com"];
const PROBE_HOST = "registry.npmjs.org";

const C = (id, status, detail, fix = null, extra = {}) => ({ id, status, detail, fix, ...extra });
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const worst = (list) => (list.includes("red") ? "red" : list.includes("yellow") ? "yellow" : "green");
const hostOf = (u) => { try { return new URL(u).hostname.toLowerCase().replace(/\.$/, ""); } catch { return null; } };
const monthOf = (d) => d.toISOString().slice(0, 7);

function customers(ws) {
  try { return readdirSync(join(ws, "customers"), { withFileTypes: true }).filter((e) => e.isDirectory() && CUSTOMER_RE.test(e.name)).map((e) => e.name).sort(); } catch { return []; }
}

// Sessione corrente (--session > JVC_SESSION_ID > .jvc/current-session) e il suo session.json, senza moduli esterni.
function currentSession(ws, sid, env) {
  const id = sid || env.JVC_SESSION_ID || (() => { try { return readFileSync(join(ws, ".jvc", "current-session"), "utf8").trim(); } catch { return null; } })();
  if (!id || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(id)) return { sid: null, customer: null, session: null };
  let customer = null;
  try { customer = readJson(join(ws, ".jvc", "sessions", `${id}.json`)).customer ?? null; } catch { customer = null; }
  if (!customer || !CUSTOMER_RE.test(customer)) return { sid: id, customer: null, session: null };
  let session = null;
  try { session = readJson(join(ws, "customers", customer, ".sessions", id, "session.json")); } catch { session = null; }
  return { sid: id, customer, session };
}

// ---------------- singoli controlli ----------------
export function checkNode(version = process.versions.node) {
  const major = Number(String(version).split(".")[0]);
  return major >= 22 ? C("node", "green", `Node ${version}`) : C("node", "red", `Node ${version}: serve Node ≥ 22`, "installare Node 22 LTS o successivo (§55.1)");
}

export function checkDeps(plugin) {
  const req = createRequire(join(plugin, "package.json"));
  const missing = [];
  for (const d of DEPS) {
    try {
      const m = req(d);
      if (d === "better-sqlite3") new m(":memory:").close();
    } catch (err) { missing.push(`${d} (${String(err.code ?? err.message).slice(0, 60)})`); }
  }
  return missing.length
    ? C("deps", "red", `dipendenze non installate o non importabili: ${missing.join(", ")} — senza di esse ogni guard nega (fail-closed)`, `npm ci nel plugin (cd "${plugin}" && npm ci): installa esattamente le versioni di package-lock.json, che è sotto integrità — npm install può riscriverlo e far fallire il controllo d'integrità`)
    : C("deps", "green", `dipendenze importabili: ${DEPS.join(", ")}`);
}

function pluginManifest(plugin) { return readJson(join(plugin, ".claude-plugin", "plugin.json")); }

async function openReadonly(file) {
  const Database = (await import("better-sqlite3")).default;
  return new Database(file, { readonly: true, fileMustExist: true });
}

export async function checkVersion(ws, plugin, custs) {
  let m;
  try { m = pluginManifest(plugin); } catch (err) { return C("version", "red", `plugin.json illeggibile (${err.message})`, "reinstallare il plugin"); }
  const min = Number(m.metadata?.knowledge_version_min);
  const max = Number(m.metadata?.knowledge_version_max);
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) return C("version", "red", `plugin ${m.version}: metadata.knowledge_version_min/max assenti o non validi in plugin.json`, "reinstallare il plugin da una release (§49.4)");
  const out = [];
  const bad = [];
  for (const c of custs) {
    const f = join(ws, "customers", c, "knowledge.db");
    if (!existsSync(f)) continue;
    let kv = null;
    try { const db = await openReadonly(f); try { kv = db.prepare("select value from meta where key='knowledge_version'").get()?.value ?? null; } finally { db.close(); } } catch { continue; }
    const n = Number(kv);
    out.push(`${c}=${kv}`);
    if (!Number.isInteger(n) || n < min || n > max) bad.push(`${c}=${kv}`);
  }
  const range = `plugin ${m.version}, knowledge_version ammessa ${min}..${max}`;
  if (bad.length) return C("version", "red", `${range}; fuori intervallo: ${bad.join(", ")} — un DB incompatibile blocca tutto tranne kb migrate`, "kb migrate (conoscenza più vecchia) o aggiorna il plugin (conoscenza più nuova) (§49.4, §58)");
  return C("version", "green", `${range}; DB: ${out.join(", ") || "nessuno"}`);
}

export function checkIntegrity(plugin, env) {
  let v;
  try { v = verifyPackage(plugin); } catch (err) { return C("integrity", "red", `verifica non riuscita: ${err.message}`, "reinstallare dalla release firmata"); }
  if (v.ok) return C("integrity", devMode(env) ? "yellow" : "green", `integrità ok (${v.version}; firma: ${v.signature === "ok" ? "verificata" : "assente, pacchetto non firmato"})${devMode(env) ? "; JVC_DEV attivo: gate dei guard saltato (solo sviluppo del plugin)" : ""}`, devMode(env) ? "togliere JVC_DEV fuori dallo sviluppo del plugin" : null);
  const what = [v.reason, v.mismatched.length ? `alterati: ${v.mismatched.slice(0, 5).join(", ")}` : null, v.missing.length ? `mancanti: ${v.missing.slice(0, 5).join(", ")}` : null,
    v.extra.length ? `in più: ${v.extra.slice(0, 5).join(", ")}` : null, v.signature !== "ok" && v.key_present ? `firma ${v.signature}` : v.signature === "invalid" ? "firma invalida" : null].filter(Boolean).join("; ");
  return C("integrity", "red", `integrità del pacchetto fallita (${what || v.status})${devMode(env) ? "; JVC_DEV attivo" : ": i guard negano tutto"}`, "reinstallare dalla release firmata; non operare (§58)");
}

function migrationTables(plugin) {
  const dir = join(plugin, "scripts", "kb", "migrations");
  const out = new Set();
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql"))) for (const m of readFileSync(join(dir, f), "utf8").matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)) out.add(m[1].toLowerCase());
  return [...out];
}

export async function checkDb(ws, plugin, c) {
  const id = `db:${c}`;
  const f = join(ws, "customers", c, "knowledge.db");
  if (!existsSync(f)) return C(id, "yellow", `knowledge.db assente per ${c}`, `use customer ${c} --new (o kb reindex) per crearlo`);
  try {
    const db = await openReadonly(f);
    try {
      const mode = String(db.pragma("journal_mode", { simple: true })).toLowerCase();
      const have = new Set(db.prepare("select lower(name) as n from sqlite_master where type in ('table','view')").all().map((r) => r.n));
      const pending = migrationTables(plugin).filter((t) => !have.has(t));
      if (pending.length) return C(id, "yellow", `migrazioni non applicate (tabelle mancanti: ${pending.join(", ")})`, "si applicano alla prossima apertura in scrittura del DB (kb reindex)");
      if (mode !== "wal") return C(id, "yellow", `journal_mode ${mode} (atteso wal)`, "kb reindex (riapre il DB in WAL)");
      return C(id, "green", `apribile, WAL, migrazioni applicate`);
    } finally { db.close(); }
  } catch (err) { return C(id, "red", `DB non apribile: ${String(err.message).slice(0, 120)}`, "kb reindex --all da git (§49.5 Ripristino); se il DB è bloccato: admin lock"); }
}

async function loadEnvDoc(ws, c) {
  const { loadEnvironmentsFile, environmentsFile } = await import("../kb/validate-env.mjs");
  const file = environmentsFile(ws, c);
  if (!existsSync(file)) return { missing: true };
  try { return { doc: loadEnvironmentsFile(file).doc }; } catch (err) { return { error: err }; }
}

export async function checkEnvironments(ws, c, envDoc) {
  const id = `environments:${c}`;
  if (envDoc.missing) return C(id, "yellow", "environments.yaml assente: nessun ambiente dichiarato (default deny, §53.5)", `compilare customers/${c}/config/environments.yaml fuori sessione, con il referente (§51.1)`);
  if (envDoc.error) return C(id, "red", String(envDoc.error.message).slice(0, 300), envDoc.error.code === 3 ? "correggere il file: in produzione write_data: false, 3 approvazioni, niente rosso (§52.1)" : "correggere lo YAML secondo schemas/environments.schema.json");
  return C(id, "green", `valido: ${envDoc.doc.environments.map((e) => `${e.id} (${e.type})`).join(", ")}`);
}

export function checkCredentials(env, cur, envDocs, almCustomers) {
  const names = Object.keys(env);
  const has = (prefix) => names.filter((n) => n.startsWith(prefix)).sort();
  const parts = [];
  let status = "green";
  const active = cur.session?.env;
  const activePrefix = active && cur.customer ? envDocs[cur.customer]?.doc?.environments?.find((e) => e.id === active.id)?.credentials_prefix : null;
  if (activePrefix) {
    const found = has(activePrefix);
    if (found.length) parts.push(`ambiente attivo ${active.id}: ${found.join(", ")}`);
    else { status = "red"; parts.push(`ambiente attivo ${active.id}: nessuna variabile ${activePrefix}*`); }
  }
  for (const [c, d] of Object.entries(envDocs)) {
    for (const e of d.doc?.environments ?? []) {
      if (!e.credentials_prefix || (cur.customer === c && e.id === active?.id)) continue;
      const found = has(e.credentials_prefix);
      if (!found.length) { status = worst([status, "yellow"]); parts.push(`${c}/${e.id}: nessuna variabile ${e.credentials_prefix}*`); } else parts.push(`${c}/${e.id}: ${found.length} variabili ${e.credentials_prefix}*`);
    }
  }
  if (almCustomers.length) {
    const alm = [...has("XRAY_"), ...has("JIRA_")];
    if (!alm.length) { status = worst([status, "yellow"]); parts.push(`ALM (${almCustomers.join(", ")}): nessuna variabile XRAY_* o JIRA_*`); } else parts.push(`ALM: ${alm.join(", ")}`);
  }
  if (!parts.length) parts.push("nessun ambiente con credentials_prefix dichiarato");
  return C("credentials", status, parts.join(" · "), status === "green" ? null : "esportare le variabili dal vault del cliente (NRT_<ENV>_*, XRAY_*, JIRA_*): mai nei file (§48.1)");
}

export function checkBrowser(plugin) {
  let m;
  try { m = readJson(join(plugin, ".mcp.json")); } catch (err) { return C("browser", "red", `.mcp.json del plugin illeggibile (${String(err.message).slice(0, 80)})`, "reinstallare il plugin dalla release firmata"); }
  const servers = Object.keys(m?.mcpServers ?? {});
  const browsers = servers.filter((s) => BROWSER_SERVER.test(s));
  return C("browser", "yellow", browsers.length ? `server del browser dichiarati dal plugin: ${browsers.join(", ")} — non sondabili da doctor` : "nessun server del browser nel .mcp.json del plugin: si usano Claude in Chrome / Claude Browser o Chrome DevTools MCP installati a parte — non sondabili da doctor",
    "verificare in sessione: /use env <id>, navigate su base_url, env-check (§51.2)");
}

async function xrayConfig(ws, c) {
  const f = join(ws, "customers", c, "config", "xray.yaml");
  if (!existsSync(f)) return null;
  const YAML = (await import("yaml")).default;
  return YAML.parse(readFileSync(f, "utf8")) ?? {};
}

export async function checkAlm(c, xray, { network, fetcher }) {
  const id = `alm:${c}`;
  if (!xray) return C(id, "green", "ALM non configurato per il cliente (nessun config/xray.yaml)");
  const queue = xray.offline_queue === true || xray.queue?.enabled === true || xray.offline_queue?.enabled === true;
  if (queue) return C(id, "green", "coda offline abilitata: una run non fallisce se Jira non risponde");
  const url = xray.base_url ?? xray.jira_url ?? null;
  if (!url) return C(id, "red", "xray.yaml senza base_url né coda offline", "dichiarare base_url o offline_queue: true");
  if (!network) return C(id, "yellow", `coda offline disabilitata; raggiungibilità di ${hostOf(url)} non verificata`, "doctor --network, oppure offline_queue: true in xray.yaml");
  try { const r = await fetcher(url); return C(id, "green", `Jira raggiungibile (${hostOf(url)}, HTTP ${r?.status ?? "?"})`); } catch (err) {
    return C(id, "red", `Jira irraggiungibile (${hostOf(url)}: ${String(err.message).slice(0, 80)}) e coda offline disabilitata`, "offline_queue: true in xray.yaml, o verificare rete e credenziali (§58)");
  }
}

export function checkCompensations(ws, custs, cur) {
  const pending = [];
  for (const c of custs) {
    let dirs = [];
    try { dirs = readdirSync(join(ws, "customers", c, ".sessions"), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name); } catch { continue; }
    for (const sid of dirs) {
      if (sid === cur.sid && c === cur.customer) continue;
      let s;
      try { s = readJson(join(ws, "customers", c, ".sessions", sid, "session.json")); } catch { continue; }
      const comps = Array.isArray(s?.pending?.compensations) ? s.pending.compensations : [];
      if (comps.length) pending.push(`${c}/${sid}: ${comps.map((x) => (typeof x === "string" ? x : x?.code ?? x?.id ?? `${x?.plan ?? "?"}#${x?.step ?? "?"}`)).join(", ")}`);
    }
  }
  return pending.length
    ? C("compensations", "red", `compensazioni pendenti di sessioni precedenti: ${pending.join(" · ")}`, "vc status → compensa tutto o lascia, prima di nuove operazioni (§58)")
    : C("compensations", "green", "nessuna compensazione pendente di sessioni precedenti");
}

export function checkProdRed(envDocs) {
  const red = [];
  for (const [c, d] of Object.entries(envDocs)) for (const e of d.doc?.environments ?? []) if (e.type === "prod" && (e.policy?.prod_allowed_red ?? []).length) red.push(`${c}/${e.id}: ${e.policy.prod_allowed_red.join(", ")}`);
  return red.length
    ? C("prod_allowed_red", "yellow", `oggetti rossi configurabili in produzione: ${red.join(" · ")}`, "confermare la decisione scritta del cliente (§52.2, §54.7 n. 10)")
    : C("prod_allowed_red", "green", "nessun oggetto rosso configurabile in produzione");
}

const SIGNALS = (fp = {}) => [fp.title_pattern, fp.banner && (fp.banner.text_pattern || fp.banner.selector), fp.tenant_id && (fp.tenant_id.value || fp.tenant_id.selector), fp.login_url_pattern].filter(Boolean).length;
function settingsItem(ws, plugin) {
  let tpl;
  try { tpl = readJson(join(plugin, "templates", "settings.template.json")); } catch { return { status: "yellow", detail: "template dei settings assente nel plugin" }; }
  const f = join(ws, ".claude", "settings.json");
  if (!existsSync(f)) return { status: "yellow", detail: ".claude/settings.json assente nel workspace", fix: "copiare templates/settings.template.json in .claude/settings.json (§55.2 passo 3)" };
  let s;
  try { s = readJson(f); } catch { return { status: "red", detail: ".claude/settings.json non è JSON valido" }; }
  const allow = s.permissions?.allow ?? [];
  const deny = s.permissions?.deny ?? [];
  const extra = allow.filter((a) => !tpl.permissions.allow.includes(a));
  const lost = tpl.permissions.deny.filter((d) => !deny.includes(d));
  const bypass = s.permissions?.defaultMode === "bypassPermissions" || s.disableAllHooks === true;
  if (extra.length || lost.length || bypass) return { status: "red", detail: `settings allargati rispetto al template: ${[extra.length ? `allow in più ${extra.join(", ")}` : null, lost.length ? `deny tolti ${lost.join(", ")}` : null, bypass ? "bypassPermissions/disableAllHooks" : null].filter(Boolean).join("; ")}`, fix: "ripristinare da templates/settings.template.json" };
  return { status: "green", detail: "settings dal template, senza allargamenti" };
}

export function checkHardening(ws, plugin, envDocs, custs, { integrity, network, networkChecks }) {
  const envs = Object.entries(envDocs).flatMap(([c, d]) => (d.doc?.environments ?? []).map((e) => ({ c, e })));
  const prods = envs.filter((x) => x.e.type === "prod");
  const I = (n, text, status, detail = "", fix = null) => ({ n, text, status, detail, fix });
  const items = [
    I(1, "environments.yaml con type: prod corretto e impronte con ≥ 2 segnali", !envs.length ? "yellow" : envs.every((x) => SIGNALS(x.e.fingerprint) >= 2) && Object.values(envDocs).every((d) => !d.error) ? "green" : "red",
      !envs.length ? "nessun ambiente dichiarato" : envs.filter((x) => SIGNALS(x.e.fingerprint) < 2).map((x) => `${x.c}/${x.e.id}: ${SIGNALS(x.e.fingerprint)} segnali`).join(", ")),
    network ? I(2, "nessun host fuori lista raggiungibile: doctor --network", worst(networkChecks.map((x) => x.status)) === "red" ? "red" : "green", networkChecks.map((x) => `${x.id}: ${x.status}`).join(", "))
      : I(2, "nessun host fuori lista raggiungibile: doctor --network", "manual", "eseguire doctor --network"),
    I(3, "credenziali di produzione solo per persone amministrative; nessuna persona di business", "manual", prods.map((x) => `${x.c}/${x.e.id}: personas ${(x.e.personas ?? []).join(", ") || "—"}`).join("; ")),
    (() => { const s = settingsItem(ws, plugin); return I(4, "settings.json dal template minimo, senza allargamenti", s.status, s.detail, s.fix ?? null); })(),
    I(5, "suite avversa dei guard verde sulla macchina di installazione", "manual", "npm test nel plugin (con il corpus JAGGAER DOC dura ~15 minuti; per un giro rapido senza il corpus: JVC_SKIP_CORPUS=1 npm test)"),
    I(6, "integrità del pacchetto verificata", integrity.status === "red" ? "red" : "green", integrity.detail),
    I(7, "profilo di redazione strict verificato su una schermata con dati reali (in pre-produzione)", "manual"),
    I(8, "retention configurata e concordata con il cliente", custs.length && custs.every((c) => existsSync(join(ws, "customers", c, "config", "retention.yaml"))) ? "green" : "yellow",
      custs.filter((c) => !existsSync(join(ws, "customers", c, "config", "retention.yaml"))).map((c) => `${c}: config/retention.yaml assente`).join(", ")),
    I(9, "second_approver_required deciso con il cliente", !prods.length ? "yellow" : prods.every((x) => typeof x.e.policy?.second_approver_required === "boolean") ? "green" : "yellow",
      prods.filter((x) => typeof x.e.policy?.second_approver_required !== "boolean").map((x) => `${x.c}/${x.e.id}: non esplicito (default true)`).join(", ")),
    I(10, "prod_allowed_red vuoto, salvo decisione scritta", prods.every((x) => !(x.e.policy?.prod_allowed_red ?? []).length) ? "green" : "yellow"),
    I(11, "backup di audit/ fuori repository attivo", "manual"),
    I(12, "procedura di purge provata su un cliente di test", "manual"),
  ];
  const auto = items.filter((i) => i.status !== "manual").map((i) => i.status);
  const st = worst(auto);
  const bad = items.filter((i) => i.status === "red" || i.status === "yellow").map((i) => `n. ${i.n} ${i.status === "red" ? "rosso" : "giallo"}${i.detail ? ` (${i.detail})` : ""}`);
  return C("hardening", st, `§54.7: ${items.filter((i) => i.status === "green").length} verdi, ${items.filter((i) => i.status === "manual").length} manuali${bad.length ? `; ${bad.join("; ")}` : ""}`,
    st === "green" ? "le voci manuali si spuntano presso il cliente prima della prima installazione" : "vedi le voci non verdi", { items });
}

export function checkAudit(ws, custs, now = new Date()) {
  const ym = monthOf(now);
  const files = [...custs.map((c) => join(ws, "customers", c, "audit", `${ym}.jsonl`)), join(ws, ".jvc", "audit", `${ym}.jsonl`)].filter((f) => existsSync(f));
  const broken = [];
  let lines = 0;
  for (const f of files) { const v = verifyChain(f); lines += v.lines ?? 0; if (!v.ok) broken.push(`${f.slice(ws.length + 1).replace(/\\/g, "/")}: riga ${v.broken_at} (${v.reason})`); }
  return broken.length
    ? C("audit", "red", `catena dell'audit di ${ym} rotta: ${broken.join(" · ")}`, "manomissione dell'audit (T8): ripristinare dal backup fuori repo e indagare (§54.6)")
    : C("audit", "green", files.length ? `catena di ${ym} valida (${files.length} file, ${lines} eventi)` : `nessun evento di audit in ${ym}`);
}

// WP10a (ruling 7): Claude Code sostituisce ${CLAUDE_PLUGIN_ROOT} con il percorso letterale nei corpi dei comandi del plugin;
// le eccezioni a forma esatta dei guard (purge, retention, promozione, integrity verify) ci contano (un $ rende il comando
// non semplice ⇒ deny). La prova sta nell'audit del mese (riassunto dell'input di Bash/PowerShell, com'era prima della
// shell): un comando con il percorso letterale del plugin ⇒ verde; un comando con il segnaposto rimasto ⇒ giallo con la
// correzione; nessun comando del plugin ancora in audit ⇒ giallo (si riesegue doctor dopo un comando del plugin).
const SHELL_TOOLS = new Set(["Bash", "PowerShell"]);
const PLACEHOLDER = "${CLAUDE_PLUGIN_ROOT}";
const PLACEHOLDER_CALL = /\bnode(\.exe)?\s+["']?\$\{?CLAUDE_PLUGIN_ROOT\}?[\\/]+scripts[\\/]/i;
const flatPath = (p) => String(p).replace(/\\+/g, "/").toLowerCase();
export function checkPluginRoot(ws, custs, { plugin = PLUGIN_ROOT, now = new Date() } = {}) {
  const ym = monthOf(now);
  const files = [...custs.map((c) => join(ws, "customers", c, "audit", `${ym}.jsonl`)), join(ws, ".jvc", "audit", `${ym}.jsonl`)].filter((f) => existsSync(f));
  const root = `${flatPath(plugin)}/scripts/`;
  // WP10a giro 1 (minore 3): contano solo le INVOCAZIONI di uno script del plugin (node "<radice>/scripts/…"), non una
  // menzione qualsiasi (echo, la riga del manuale copiata); vale la prova più recente (un Claude Code aggiornato risolve).
  let literal = 0;
  let placeholder = 0;
  let last = null;
  for (const f of files) {
    for (const line of readFileSync(f, "utf8").split("\n")) {
      if (!line.trim()) continue;
      let ev;
      try { ev = JSON.parse(line); } catch { continue; }
      if (!SHELL_TOOLS.has(ev?.payload?.tool) || typeof ev.payload.input_summary !== "string") continue;
      let cmd = ev.payload.input_summary;
      try { const o = JSON.parse(cmd); if (typeof o?.command === "string") cmd = o.command; } catch { /* riassunto troncato: il testo così com'è */ }
      const kind = PLACEHOLDER_CALL.test(cmd) ? "placeholder" : (/\bnode(\.exe)?\b/i.test(cmd) && flatPath(cmd).includes(root)) ? "literal" : null;
      if (!kind) continue;
      if (kind === "placeholder") placeholder++; else literal++;
      if (!last || String(ev.ts ?? "") >= last.ts) last = { kind, ts: String(ev.ts ?? "") };
    }
  }
  if (last?.kind === "placeholder") {
    return C("plugin-root", "yellow", `segnaposto ${PLACEHOLDER} non sostituito in ${placeholder} comandi di ${ym}${literal ? ` (percorso letterale in ${literal})` : ""}`,
      `docs/MANUAL.md §58 ("${PLACEHOLDER} non sostituito"): aggiornare Claude Code; finché resta, le operazioni a forma esatta (purge, retention, promozione) sono negate dai guard — blocco, non rischio`);
  }
  if (last?.kind === "literal") return C("plugin-root", "green", `${PLACEHOLDER} sostituito con il percorso del plugin (ultima prova ${last.ts.slice(0, 16)}; ${literal} comandi con il percorso, ${placeholder} con il segnaposto in ${ym})`);
  return C("plugin-root", "yellow", `nessun comando del plugin in audit in ${ym}: la sostituzione di ${PLACEHOLDER} non è ancora verificabile`,
    "rieseguire /jaggaer-virtual-consultant:vc doctor dopo un altro comando del plugin (es. /jaggaer-virtual-consultant:vc status)");
}

// WP09c: NETWORK.md (§53.2) — tabella "categoria | host | quando | dichiarato in"; host fra backtick, "none" per nessuno.
// → { ok, categories: { <id>: { hosts[], none } }, error? }. Solo le righe della tabella contano (mai il testo libero).
// WP09c giro 1: il parser è condiviso con l'AlmAdapter (scripts/lib/network-md.mjs)
export { NETWORK_CATEGORIES, parseNetworkMd };

export function checkNetworkCategories(plugin) {
  const n = parseNetworkMd(plugin);
  if (!n.ok) return C("network-categories", "red", n.error, "reinstallare il plugin dalla release (NETWORK.md è sotto integrità)");
  const missing = NETWORK_CATEGORIES.filter((c) => !n.categories[c]);
  const telemetry = n.categories.telemetry;
  const problems = [missing.length ? `categorie mancanti: ${missing.join(", ")}` : null, telemetry && (!telemetry.none || telemetry.hosts.length) ? "telemetry deve essere none (§53.2)" : null,
    Object.keys(n.categories).filter((c) => !NETWORK_CATEGORIES.includes(c)).map((c) => `categoria non prevista: ${c}`).join(", ") || null].filter(Boolean);
  if (problems.length) return C("network-categories", "red", `NETWORK.md: ${problems.join("; ")}`, "reinstallare il plugin dalla release (NETWORK.md è sotto integrità)");
  return C("network-categories", "green", `NETWORK.md: ${NETWORK_CATEGORIES.map((c) => `${c} (${n.categories[c].none ? "nessun host" : n.categories[c].hosts.join(", ") || "dichiarati dal cliente"})`).join(" · ")}`);
}

function networkAllowList(plugin, envDocs) {
  const list = new Set(DEFAULT_ALLOW);
  for (const d of Object.values(envDocs)) for (const e of d.doc?.environments ?? []) { for (const h of e.allowed_hosts ?? []) list.add(String(h).toLowerCase().replace(/:\d+$/, "")); const b = hostOf(e.base_url); if (b) list.add(b); }
  for (const c of Object.values(parseNetworkMd(plugin).categories)) for (const h of c.hosts) list.add(h);
  return [...list];
}
const allowed = (host, list) => list.some((p) => (p.startsWith("*.") ? host.endsWith(p.slice(1)) : host === p));

export async function checkNetwork(plugin, envDocs, xrays, { resolver }) {
  const declared = new Set();
  for (const d of Object.values(envDocs)) for (const e of d.doc?.environments ?? []) { for (const h of e.allowed_hosts ?? []) declared.add(String(h).toLowerCase().replace(/:\d+$/, "")); const b = hostOf(e.base_url); if (b) declared.add(b); }
  const configured = Object.entries(xrays).filter(([, x]) => x).flatMap(([c, x]) => [x.base_url, x.jira_url, x.xray_url].filter(Boolean).map((u) => ({ c, host: hostOf(u), url: u }))).filter((x) => x.host);
  for (const x of configured) declared.add(x.host);
  const out = [];
  let online = true;
  try { await resolver(PROBE_HOST); } catch { online = false; }
  if (!online) out.push(C("network", "yellow", `offline (${PROBE_HOST} non si risolve): risoluzione degli host dichiarati saltata`, "ripetere doctor --network con la rete"));
  else {
    const unresolved = [];
    for (const h of declared) { try { await resolver(h); } catch { unresolved.push(h); } }
    out.push(unresolved.length
      ? C("network", "yellow", `host dichiarati non risolti: ${unresolved.join(", ")} (VPN o DNS interno?)`, "verificare rete/VPN o correggere environments.yaml fuori sessione")
      : C("network", "green", `${declared.size} host dichiarati risolti`));
  }
  const list = networkAllowList(plugin, envDocs);
  const outside = configured.filter((x) => !allowed(x.host, list));
  out.push(outside.length
    ? C("network-allowlist", "red", `host configurati fuori allow-list: ${outside.map((x) => `${x.c}: ${x.host}`).join(", ")}`, "il plugin parla solo con gli host dichiarati e quelli di NETWORK.md (§53.2): correggere la configurazione")
    : C("network-allowlist", "green", `host configurati tutti in allow-list (${configured.length})`));
  out.push(checkNetworkCategories(plugin));
  return out;
}

const defaultResolver = async (host) => {
  const dns = await import("node:dns");
  return Promise.race([dns.promises.lookup(host, { all: true }), new Promise((_, rej) => setTimeout(() => rej(new Error("timeout DNS")), 3000).unref())]);
};
const defaultFetcher = (url) => fetch(url, { method: "HEAD", redirect: "manual", signal: AbortSignal.timeout(4000) });

// Tutti i controlli → [{ id, status, detail, fix }]. Ogni controllo che fallisce per un errore interno è rosso.
export async function runChecks({ ws, plugin = PLUGIN_ROOT, env = process.env, network = false, session = null, nodeVersion, resolver = defaultResolver, fetcher = defaultFetcher, now = new Date() } = {}) {
  const safe = async (id, fn) => { try { return await fn(); } catch (err) { return C(id, "red", `controllo non riuscito: ${String(err?.message ?? err).slice(0, 200)}`, "dipendenze e installazione del plugin: vedi il controllo deps"); } };
  const custs = customers(ws);
  const cur = currentSession(ws, session, env);
  const checks = [checkNode(nodeVersion), checkDeps(plugin)];
  checks.push(await safe("version", () => checkVersion(ws, plugin, custs)));
  const integrity = checkIntegrity(plugin, env);
  checks.push(integrity);
  const envDocs = {};
  const xrays = {};
  for (const c of custs) {
    checks.push(await safe(`db:${c}`, () => checkDb(ws, plugin, c)));
    try { envDocs[c] = await loadEnvDoc(ws, c); } catch (err) { envDocs[c] = { error: err }; }
    checks.push(await safe(`environments:${c}`, () => checkEnvironments(ws, c, envDocs[c])));
    try { xrays[c] = await xrayConfig(ws, c); } catch (err) { xrays[c] = { __error: err.message }; }
  }
  checks.push(await safe("credentials", () => checkCredentials(env, cur, envDocs, custs.filter((c) => xrays[c]))));
  checks.push(checkBrowser(plugin));
  for (const c of custs) {
    checks.push(await safe(`alm:${c}`, () => (xrays[c]?.__error ? C(`alm:${c}`, "red", `xray.yaml non valido (${xrays[c].__error})`, "correggere config/xray.yaml") : checkAlm(c, xrays[c], { network, fetcher }))));
  }
  checks.push(await safe("compensations", () => checkCompensations(ws, custs, cur)));
  checks.push(await safe("prod_allowed_red", () => checkProdRed(envDocs)));
  const networkChecks = network ? await safe("network", () => checkNetwork(plugin, envDocs, Object.fromEntries(Object.entries(xrays).filter(([, x]) => x && !x.__error)), { resolver })) : [];
  const netList = Array.isArray(networkChecks) ? networkChecks : [networkChecks];
  checks.push(await safe("hardening", () => checkHardening(ws, plugin, envDocs, custs, { integrity, network, networkChecks: netList })));
  checks.push(await safe("audit", () => checkAudit(ws, custs, now)));
  checks.push(await safe("plugin-root", () => checkPluginRoot(ws, custs, { plugin, now })));
  checks.push(...netList);
  return checks;
}

const LABEL = { green: "VERDE", yellow: "GIALLO", red: "ROSSO" };
export function renderTable(checks) {
  const w = Math.max(9, ...checks.map((c) => c.id.length));
  const lines = [`STATO   ${"CONTROLLO".padEnd(w)}  DETTAGLIO · CORREZIONE`];
  for (const c of checks) {
    lines.push(`${LABEL[c.status].padEnd(7)} ${c.id.padEnd(w)}  ${c.detail}${c.fix && c.status !== "green" ? ` · → ${c.fix}` : ""}`);
    if (c.items) for (const i of c.items) if (i.status !== "green") lines.push(`${"".padEnd(8)}${"".padEnd(w)}    ${String(i.n).padStart(2)}. [${i.status === "manual" ? "manuale" : LABEL[i.status].toLowerCase()}] ${i.text}${i.detail ? ` — ${i.detail}` : ""}`);
  }
  const st = worst(checks.map((c) => c.status));
  lines.push("", st === "red" ? "Esito: ROSSO — correggere prima di continuare (§55.2)." : st === "yellow" ? "Esito: nessun rosso; voci gialle da verificare." : "Esito: tutto verde.");
  return lines.join("\n");
}

const HELP = `uso: node scripts/admin/doctor.mjs [--network] [--workspace <dir>] [--session <id>] [--json] [--help]

Controlli (§55.2, §48.1, §54.7): node, deps, version (plugin.json metadata.knowledge_version_min/max vs DB),
integrity, db:<C>, environments:<C>, credentials (solo i nomi delle variabili NRT_<ENV>_*, XRAY_*, JIRA_*),
browser (non sondabile: giallo, da verificare in sessione), alm:<C> (coda offline o Jira raggiungibile),
compensations (pendenze di sessioni precedenti), prod_allowed_red, hardening (checklist §54.7: voci automatiche e
manuali), audit (catena del mese corrente), plugin-root (\${CLAUDE_PLUGIN_ROOT} sostituito dal percorso letterale nei
comandi eseguiti, prova nell'audit). --network: DNS degli host dichiarati (offline ⇒ saltato) e host
configurati fuori allow-list (environments.yaml, NETWORK.md); network-categories: le categorie di NETWORK.md
(jaggaer, alm, npm, claude, telemetry = none).

Exit code: 0 nessun rosso · 1 argomenti non validi · 2 errore di sistema · 3 almeno un controllo rosso.`;

export async function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv, { flags: ["network"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (positional.length) { console.log(HELP); return 1; }
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    if (!existsSync(ws) || !statSync(ws).isDirectory()) return fail(asJson, 1, `workspace non trovato: ${ws}`);
    const checks = await runChecks({ ws, env, network: !!opts.network, session: opts.session ?? null });
    const st = worst(checks.map((c) => c.status));
    if (asJson) console.log(JSON.stringify({ ok: st !== "red", status: st, workspace: ws, checks, ...(opts.network ? {} : { skipped: ["network", "network-allowlist"] }) }));
    else console.log(renderTable(checks));
    return st === "red" ? 3 : 0;
  } catch (err) { return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`); }
}

// WP09d (riporto WP09c): su Windows/Node 24 process.exit dopo più fetch (doctor --network) termina il processo con
// 0xC0000409; si imposta process.exitCode e il processo esce da solo a coda vuota (fetch con AbortSignal.timeout).
if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => { process.exitCode = c; }, (e) => { console.error(e); process.exitCode = 2; });
