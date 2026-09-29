// Integrità del pacchetto (F0.3, §53.1): impronte sha256 dei file che decidono il comportamento del plugin, confrontate
// con integrity.json (firmato facoltativamente con Ed25519, integrity.json.sig, verificato con la chiave pubblica
// .claude-plugin/signing-key.pem). Contenuto normalizzato a capo LF (checkout Windows con autocrlf). Solo moduli
// built-in: session-context lo usa a ogni avvio di sessione (< 2 s; cache sugli mtime/ctime/dimensione dei file).
import { readFileSync, readdirSync, statSync, existsSync, writeFileSync } from "node:fs";
import { createHash, createPublicKey, createPrivateKey, sign, verify as cryptoVerify } from "node:crypto";
import { join } from "node:path";

export const SCOPE_DIRS = ["hooks", "scripts", "decision-tables", "strategies", "policy", "schemas", "mcp"];
// WP09c: NETWORK.md sotto integrità (doctor --network ne legge le categorie e gli host dell'allow-list)
export const SCOPE_FILES = [".mcp.json", ".claude-plugin/plugin.json", "NETWORK.md"];
export const MANIFEST = "integrity.json";
export const SIGNATURE = "integrity.json.sig";
export const PUBLIC_KEY = ".claude-plugin/signing-key.pem";
const SKIP_DIRS = new Set(["node_modules", ".git"]);

export const hashText = (buf) => createHash("sha256").update(Buffer.from(buf).toString("latin1").replace(/\r\n/g, "\n"), "latin1").digest("hex");

function walk(root, rel, out) {
  let entries;
  try { entries = readdirSync(join(root, rel), { withFileTypes: true }); } catch (err) { if (err.code === "ENOENT") return; throw err; }
  for (const e of entries) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(root, r, out); } else if (e.isFile() || e.isSymbolicLink()) out.push(r);
  }
}

// File del perimetro presenti nel pacchetto, relativi con /, ordinati.
export function scopeFiles(root) {
  const out = [];
  for (const d of SCOPE_DIRS) walk(root, d, out);
  for (const f of SCOPE_FILES) if (existsSync(join(root, f))) out.push(f);
  return [...new Set(out)].sort();
}

function pluginVersion(root) {
  try { return JSON.parse(readFileSync(join(root, ".claude-plugin/plugin.json"), "utf8")).version ?? null; } catch { return null; }
}

// Impronta di un file, con cache { rel: [mtimeMs, ctimeMs, size, sha] } (aggiornata sul posto).
function fileHash(root, rel, cache) {
  const abs = join(root, ...rel.split("/"));
  const st = statSync(abs);
  const c = cache?.[rel];
  if (Array.isArray(c) && c[0] === st.mtimeMs && c[1] === st.ctimeMs && c[2] === st.size) return c[3];
  const h = hashText(readFileSync(abs));
  if (cache) cache[rel] = [st.mtimeMs, st.ctimeMs, st.size, h];
  return h;
}

export function buildManifest(root, { now = new Date() } = {}) {
  const files = {};
  for (const rel of scopeFiles(root)) files[rel] = fileHash(root, rel, null);
  return { version: pluginVersion(root), generated_at: now.toISOString(), algorithm: "sha256", files };
}

// Scrive integrity.json (e integrity.json.sig se c'è la chiave privata Ed25519 in PEM).
export function writeManifest(root, { signKeyFile = null, now = new Date() } = {}) {
  const m = buildManifest(root, { now });
  const text = `${JSON.stringify(m, null, 2)}\n`;
  writeFileSync(join(root, MANIFEST), text);
  let signed = false;
  if (signKeyFile) {
    const key = createPrivateKey(readFileSync(signKeyFile));
    writeFileSync(join(root, SIGNATURE), `${sign(null, Buffer.from(text, "utf8"), key).toString("base64")}\n`);
    signed = true;
  }
  return { manifest: m, signed, files: Object.keys(m.files).length };
}

function signatureState(root, text) {
  const keyFile = join(root, PUBLIC_KEY);
  if (!existsSync(keyFile)) return "absent";
  let sig;
  try { sig = readFileSync(join(root, SIGNATURE), "utf8").trim(); } catch { return "absent"; }
  try {
    const ok = cryptoVerify(null, Buffer.from(text, "utf8"), createPublicKey(readFileSync(keyFile)), Buffer.from(sig, "base64"));
    return ok ? "ok" : "invalid";
  } catch { return "invalid"; }
}

// → { ok, status: ok|fail|absent, version, mismatched[], missing[], extra[], signature: ok|absent|invalid, key_present }
// ok = manifesto presente, nessuna differenza, firma non invalida; con la chiave pubblica nel pacchetto la firma è
// obbligatoria (assente ⇒ ok false). `cache`: oggetto { rel: [...] } riusato e aggiornato.
export function verifyPackage(root, { cache = null } = {}) {
  let text;
  try { text = readFileSync(join(root, MANIFEST), "utf8"); } catch {
    return { ok: false, status: "absent", version: pluginVersion(root), mismatched: [], missing: [], extra: [], signature: "absent", key_present: existsSync(join(root, PUBLIC_KEY)), reason: "integrity.json assente" };
  }
  let m;
  try { m = JSON.parse(text); } catch { return { ok: false, status: "fail", version: pluginVersion(root), mismatched: [], missing: [], extra: [], signature: "invalid", key_present: existsSync(join(root, PUBLIC_KEY)), reason: "integrity.json non è JSON" }; }
  const want = m && typeof m.files === "object" && m.files ? m.files : {};
  const have = scopeFiles(root);
  const haveSet = new Set(have);
  const mismatched = [];
  const missing = [];
  for (const [rel, h] of Object.entries(want)) {
    if (!haveSet.has(rel)) { missing.push(rel); continue; }
    let cur;
    try { cur = fileHash(root, rel, cache); } catch { missing.push(rel); continue; }
    if (cur !== h) mismatched.push(rel);
  }
  const extra = have.filter((rel) => !Object.hasOwn(want, rel));
  const keyPresent = existsSync(join(root, PUBLIC_KEY));
  const signature = signatureState(root, text);
  const clean = !mismatched.length && !missing.length && !extra.length && m.algorithm === "sha256";
  const ok = clean && signature !== "invalid" && !(keyPresent && signature !== "ok");
  return { ok, status: ok ? "ok" : "fail", version: m.version ?? null, generated_at: m.generated_at ?? null, mismatched: mismatched.sort(), missing: missing.sort(), extra, signature, key_present: keyPresent };
}

// WP08 giro 1 (I8): solo il valore esatto "1" (non "true", "yes", " 1", …).
export const devMode = (env = process.env) => env.JVC_DEV === "1";
