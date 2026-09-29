// Testo libero e dati strutturati da file (WP10a): i guard negano le invocazioni degli script del plugin che non sono
// semplici (virgole, punti interrogativi, lettere accentate, $, JSON in linea), quindi i comandi passano il testo
// dell'utente e i payload da un file della sessione.
//   confinedPath(base, file) → { abs } | { error }   il file deve stare DENTRO la cartella base (il workspace): percorsi
//                              assoluti fuori, `..` che escono e collegamenti che portano fuori sono rifiutati (WP10a giro 1)
//   readTextFile(base, file, { max }) → { text } | { error }   UTF-8, al più `max` byte, non vuoto
//   readDataFile(base, file, { max }) → { data } | { error }   JSON o YAML (YAML caricato solo qui), un oggetto
import { readFileSync, statSync, realpathSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";

export const TEXT_FILE_MAX = 64 * 1024;
export const DATA_FILE_MAX = 256 * 1024;

const real = (p) => { try { return realpathSync.native(p); } catch { return p; } };
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
