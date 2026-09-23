// env-check (§51.2): l'agente apre base_url con gli strumenti MCP del browser e
// salva lo snapshot (o il testo) della pagina in un file; questo script valuta
// l'impronta dell'ambiente DICHIARATO:
//   - segnali: title_pattern (titolo), banner (testo dell'elemento o della
//     pagina), tenant_id (valore dell'elemento o parola intera nel testo),
//     login_url_pattern (URL della pagina o di login);
//   - segnali contrari: parole di absence_required presenti; banner dichiarato
//     ma assente; tenant diverso nell'elemento dichiarato; host della pagina
//     fuori da allowed_hosts;
//   - verified ⇔ ≥ 2 segnali e nessun segnale contrario; altrimenti `unknown`.
// Con --write-session scrive session.env.{verified, verified_at, signals}, solo
// per l'ambiente dichiarato con `use env` e solo se environments.yaml non è
// cambiato da allora (hash). Rischio residuo: lo snapshot lo salva l'agente.
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { loadEnvironmentsFile, environmentsFile, normalizeHost, EnvFileError } from "../kb/validate-env.mjs";
import { resolveSessionId, loadSession, updateSession, actorOf } from "../admin/session.mjs";
import { appendAudit } from "../../hooks/lib/audit.mjs";

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Parola intera: niente lettere, cifre, '_' o '-' ai lati ("acme" non è in "acme-sbx").
const wordRe = (w, flags = "") => new RegExp(`(?<![\\p{L}\\p{N}_-])${reEsc(w)}(?![\\p{L}\\p{N}_-])`, `u${flags}`);
const tryRe = (src) => { try { return new RegExp(src, "u"); } catch { return new RegExp(src); } };

// Snapshot salvato dall'agente → { url, title, text, elements }.
// JSON ({ url, title, text, elements: [{ sel, text, color }] }) oppure testo:
// take_snapshot di Chrome DevTools (`RootWebArea "titolo" url="…"`), righe
// `URL: …` / `Title: …`, altrimenti solo testo.
export function parseSnapshot(raw) {
  const s = String(raw ?? "");
  const t = s.trim();
  if (t.startsWith("{")) {
    const o = JSON.parse(t);
    return {
      url: typeof o.url === "string" ? o.url : null,
      title: typeof o.title === "string" ? o.title : null,
      text: typeof o.text === "string" ? o.text : "",
      login_url: typeof o.login_url === "string" ? o.login_url : null,
      elements: Array.isArray(o.elements) ? o.elements.filter((e) => e && typeof e === "object") : [],
    };
  }
  let url = null;
  let title = null;
  const root = /RootWebArea\s+"((?:[^"\\]|\\.)*)"(?:[^\n]*?\burl="([^"]*)")?/.exec(s);
  if (root) { title = root[1]; url = root[2] ?? null; }
  url ??= /^\s*(?:page\s+)?url:\s*(\S+)/im.exec(s)?.[1] ?? null;
  title ??= /^\s*(?:page\s+)?title:\s*(.+?)\s*$/im.exec(s)?.[1] ?? null;
  return { url, title, text: s, login_url: null, elements: [] };
}

function hostOf(url) {
  try { const u = new URL(url); return normalizeHost(u.port ? `${u.hostname}:${u.port}` : u.hostname); } catch { return null; }
}

// envDecl: una voce di environments.yaml; page: parseSnapshot(...).
// → { env: id|"unknown", signals_matched: [], signals_contrary: [], verified }
export function check(envDecl, page) {
  const fp = envDecl?.fingerprint ?? {};
  const matched = [];
  const contrary = [];
  const elements = page.elements ?? [];
  const allText = [page.title ?? "", page.text ?? "", ...elements.map((e) => String(e.text ?? ""))].join("\n");
  const bySel = (sel) => (sel ? elements.find((e) => e.sel === sel || e.selector === sel) : undefined);

  if (typeof fp.title_pattern === "string" && typeof page.title === "string" && tryRe(fp.title_pattern).test(page.title)) matched.push("title");

  if (fp.banner && typeof fp.banner === "object") {
    const re = tryRe(fp.banner.text_pattern);
    const el = bySel(fp.banner.selector);
    const found = el ? re.test(String(el.text ?? "")) : re.test(allText);
    const colorOk = !(el && fp.banner.color && el.color) || String(el.color).toLowerCase() === String(fp.banner.color).toLowerCase();
    if (found && colorOk) matched.push("banner");
    else contrary.push(found ? `banner di colore diverso (${el.color} ≠ ${fp.banner.color})` : `banner "${fp.banner.text_pattern}" assente`);
  }

  if (fp.tenant_id && typeof fp.tenant_id === "object") {
    const v = String(fp.tenant_id.value);
    const el = bySel(fp.tenant_id.selector);
    if (el) {
      if (String(el.text ?? "").trim() === v) matched.push("tenant_id");
      else contrary.push(`tenant diverso: "${String(el.text ?? "").trim()}" ≠ "${v}"`);
    } else if (wordRe(v).test(allText)) matched.push("tenant_id");
  }

  if (typeof fp.login_url_pattern === "string") {
    const re = tryRe(fp.login_url_pattern);
    if ([page.url, page.login_url].some((u) => typeof u === "string" && re.test(u))) matched.push("login_url");
  }

  for (const w of fp.absence_required ?? []) if (wordRe(w, "i").test(allText)) contrary.push(`presente "${w}" (absence_required)`);

  if (typeof page.url === "string") {
    const h = hostOf(page.url);
    const allowed = (envDecl.allowed_hosts ?? []).map(normalizeHost);
    if (!h || !allowed.includes(h)) contrary.push(`host non dichiarato: ${h ?? page.url}`);
  }

  const verified = contrary.length === 0 && matched.length >= 2;
  return { env: verified ? envDecl.id : "unknown", signals_matched: matched, signals_contrary: contrary, verified };
}

class CliError extends Error { constructor(code, msg, extra = {}) { super(msg); this.code = code; this.extra = extra; } }

const HELP = `uso: node scripts/chrome/env-check.mjs --env <id> --snapshot <file> [--customer <C> | --env-file <environments.yaml>]
       [--url <u>] [--title <t>] [--write-session] [--session <id>] [--workspace <dir>] [--json]

Valuta l'impronta dell'ambiente <id> (§51.2) sulla pagina salvata in <file>
(snapshot JSON { url, title, text, elements } o testo di take_snapshot).
≥ 2 segnali e nessun segnale contrario ⇒ verified; altrimenti env: unknown.
--write-session: scrive session.env.verified/verified_at/signals, solo per
l'ambiente dichiarato con \`use env\` e con environments.yaml invariato.

Exit code: 0 verificato · 1 input malformato · 2 errore di sistema · 3 ambiente non verificato o rifiutato (policy).`;

export async function run(argv, env = process.env) {
  const { opts } = parseArgs(argv, { flags: ["write-session"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.env || !opts.snapshot) { console.log(HELP); return 1; }
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    let customer = opts.customer ?? null;
    let sid = null;
    let active = null;
    if (opts["write-session"]) {
      sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
      if (!sid) throw new CliError(1, "nessuna sessione risolvibile: passa --session <id>");
      try { active = loadSession(ws, sid); } catch (err) { throw new CliError(1, `stato di sessione illeggibile: ${err.message}`); }
      if (!active.session) throw new CliError(1, "nessun cliente attivo: esegui prima use customer <ID>");
      if (customer && customer !== active.session.customer) throw new CliError(3, `la sessione è sul cliente ${active.session.customer}, non ${customer}`);
      customer = active.session.customer;
    }
    const file = opts["env-file"] ? resolve(opts["env-file"]) : customer ? environmentsFile(ws, customer) : null;
    if (!file) throw new CliError(1, "serve --customer <C> o --env-file <file>");
    const envs = loadEnvironmentsFile(file);
    const decl = envs.doc.environments.find((e) => e.id === opts.env);
    if (!decl) throw new CliError(1, `ambiente inesistente: ${opts.env} (${envs.doc.environments.map((e) => e.id).join(", ")})`);
    if (!existsSync(opts.snapshot)) throw new CliError(1, `snapshot inesistente: ${opts.snapshot}`);
    let page;
    try { page = parseSnapshot(readFileSync(opts.snapshot, "utf8")); } catch (err) { throw new CliError(1, `snapshot illeggibile: ${err.message}`); }
    if (opts.url) page.url = opts.url;
    if (opts.title) page.title = opts.title;
    const result = check(decl, page);
    let refused = null;
    if (opts["write-session"]) {
      const cur = active.session.env;
      if (!cur) refused = "nessun ambiente dichiarato: esegui /use env <id>";
      else if (cur.id !== decl.id) refused = `ambiente dichiarato ${cur.id}, non ${decl.id}: si verifica solo l'ambiente dichiarato`;
      else if (cur.source_sha256 !== envs.sha256) refused = "environments.yaml è cambiato dopo /use env: riesegui /use env";
      const at = new Date().toISOString();
      updateSession(active.file, (s) => {
        if (!s.env) return;
        const ok = !refused && result.verified && s.env.id === decl.id;
        s.env.verified = ok;
        s.env.verified_at = ok ? at : null;
        s.env.signals = { matched: result.signals_matched, contrary: result.signals_contrary, checked_at: at, env_detected: result.env, ...(refused ? { refused } : {}) };
      });
      appendAudit(ws, { session: sid, customer, scope: active.session.scope, kind: "session", actor: actorOf(env), payload: { action: "env-check", env: decl.id, detected: result.env, verified: !refused && result.verified, matched: result.signals_matched, contrary: result.signals_contrary, refused } });
    }
    const out = { ok: !refused && result.verified, ...result, ...(refused ? { refused } : {}) };
    if (asJson) console.log(JSON.stringify(out));
    else console.log(refused ? `rifiutato: ${refused}` : result.verified ? `ambiente ${result.env} verificato (${result.signals_matched.join(", ")})` : `ambiente non riconosciuto (${result.signals_matched.length} segnali su 2${result.signals_contrary.length ? `; contrari: ${result.signals_contrary.join("; ")}` : ""})`);
    return out.ok ? 0 : 3;
  } catch (err) {
    if (err instanceof CliError || err instanceof EnvFileError) return fail(asJson, err.code, err.message, err.extra);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
