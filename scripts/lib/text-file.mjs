// Testo libero e dati strutturati da file (WP10a): i guard negano le invocazioni degli script del plugin che non sono
// semplici (virgole, punti interrogativi, lettere accentate, $, JSON in linea), quindi i comandi passano il testo
// dell'utente e i payload da un file della sessione.
//   confinedPath(base, file) → { abs } | { error }   il file deve stare DENTRO la cartella base (il workspace): percorsi
//                              assoluti fuori, `..` che escono e collegamenti che portano fuori sono rifiutati (WP10a giro 1)
//   readTextFile(base, file, { max }) → { text } | { error }   UTF-8, al più `max` byte, non vuoto
//   readDataFile(base, file, { max }) → { data } | { error }   JSON o YAML (YAML caricato solo qui), un oggetto
//
// Revisione finale (confinamento reale): la base dei file d'ingresso è il workspace DEGLI HOOK
// (JVC_WORKSPACE > CLAUDE_PROJECT_DIR > cwd, come hooks/lib/workspace.mjs), mai un --workspace/--root scelto da chi
// invoca lo script: così un file d'ingresso sta sempre dove i guard vedono e proteggono.
//   inputBase(env) → la radice del workspace degli hook
//   inputFile(file, { env, max, dir }) → { abs } | { error }   contenimento (realpath) nel workspace degli hook e tetto
//                              di dimensione (file) o cartella (dir: true); un file inesistente passa (errore del lettore)
//   confineInputs(opts, names, { env, max, dirs, skip }) → null | "messaggio"   le opzioni-file nominate diventano
//                              percorsi assoluti confinati; skip(v) ⇒ il valore non è un file (un codice, JSON in linea)
//   confineList(files, { env, max }) → { files } | { error }   percorsi posizionali
import { readFileSync, statSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname, basename, join } from "node:path";
import { workspaceRoot } from "../../hooks/lib/workspace.mjs";

export const TEXT_FILE_MAX = 64 * 1024;
export const DATA_FILE_MAX = 256 * 1024;
export const INPUT_FILE_MAX = 16 * 1024 * 1024;

// realpath del percorso o, se non esiste ancora, del suo antenato esistente più vicino (una cartella-collegamento
// intermedia che porta fuori è vista anche per un file non ancora creato).
const real = (p) => {
  try { return realpathSync.native(p); } catch { /* non esiste */ }
  const parent = dirname(p);
  return parent === p ? p : join(real(parent), basename(p));
};
const inside = (root, p) => { const r = relative(root, p); return r === "" || (!!r && !r.startsWith("..") && !isAbsolute(r)); };

export function confinedPath(base, file) {
  if (typeof file !== "string" || !file.trim() || file.includes("\0")) return { error: "serve il percorso del file" };
  const root = real(resolve(base));
  const abs = resolve(root, file);
  if (!inside(root, abs)) return { error: `file fuori dal workspace: ${file} (i file di ingresso stanno nel workspace, es. customers/<C>/.sessions/<sessione>/)` };
  const r = real(abs);
  if (!inside(root, r)) return { error: `file fuori dal workspace tramite un collegamento: ${file}` };
  return { abs: r };
}

export function readTextFile(base, file, { max = TEXT_FILE_MAX } = {}) {
  const c = confinedPath(base, file);
  if (c.error) return c;
  try {
    if (statSync(c.abs).size > max) return { error: `file di testo oltre ${Math.round(max / 1024)} KB: ${file}` };
    const text = readFileSync(c.abs, "utf8").replace(/^\uFEFF/, "").trim();
    return text ? { text } : { error: `file di testo vuoto: ${file}` };
  } catch (err) { return { error: `file di testo illeggibile: ${file} (${err.code ?? err.message})` }; }
}

export async function readDataFile(base, file, { max = DATA_FILE_MAX } = {}) {
  const c = confinedPath(base, file);
  if (c.error) return c;
  let text;
  try {
    if (statSync(c.abs).size > max) return { error: `file di dati oltre ${Math.round(max / 1024)} KB: ${file}` };
    text = readFileSync(c.abs, "utf8").replace(/^\uFEFF/, "");
  } catch (err) { return { error: `file di dati illeggibile: ${file} (${err.code ?? err.message})` }; }
  let data;
  try { data = JSON.parse(text); } catch {
    try { data = (await import("yaml")).default.parse(text); } catch (err) { return { error: `file di dati né JSON né YAML: ${file} (${String(err.message).slice(0, 80)})` }; }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { error: `file di dati: serve un oggetto (${file})` };
  return { data };
}

// Variante sincrona per gli script che già caricano YAML in testa (passano il parser).
export function readDataFileSync(base, file, parse, { max = DATA_FILE_MAX } = {}) {
  const c = confinedPath(base, file);
  if (c.error) return c;
  let text;
  try {
    if (statSync(c.abs).size > max) return { error: `file di dati oltre ${Math.round(max / 1024)} KB: ${file}` };
    text = readFileSync(c.abs, "utf8").replace(/^\uFEFF/, "");
  } catch (err) { return { error: `file di dati illeggibile: ${file} (${err.code ?? err.message})` }; }
  try { return { data: /^\s*[{[]/.test(text) ? JSON.parse(text) : parse(text) }; } catch (err) { return { error: `file di dati non valido: ${file} (${String(err.message).slice(0, 80)})` }; }
}

export const inputBase = (env = process.env) => workspaceRoot({}, env);

export function inputFile(file, { env = process.env, max = INPUT_FILE_MAX, dir = false } = {}) {
  const c = confinedPath(inputBase(env), file);
  if (c.error) return c;
  let st;
  try { st = statSync(c.abs); } catch { return c; }
  if (dir) return st.isDirectory() ? c : { error: `non è una cartella: ${file}` };
  if (!st.isFile()) return { error: `non è un file: ${file}` };
  if (st.size > max) return { error: `file d'ingresso oltre ${Math.round(max / 1024)} KB: ${file}` };
  return c;
}

export function confineInputs(opts, names, { env = process.env, max = INPUT_FILE_MAX, dirs = [], skip = null } = {}) {
  for (const n of names) {
    const v = opts[n];
    if (v === undefined || v === null || v === true) continue;
    if (skip && skip(n, String(v))) continue;
    const r = inputFile(String(v), { env, max, dir: dirs.includes(n) });
    if (r.error) return `--${n}: ${r.error}`;
    opts[n] = r.abs;
  }
  return null;
}

export function confineList(files, { env = process.env, max = INPUT_FILE_MAX } = {}) {
  const out = [];
  for (const f of files) {
    const r = inputFile(String(f), { env, max });
    if (r.error) return { error: r.error };
    out.push(r.abs);
  }
  return { files: out };
}
