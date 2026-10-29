// observe-append, stadio "snapshot su file" (29/10/2026, punto 7): take_snapshot di Chrome DevTools con filePath letto come
// una lettura completa in linea, con le regole di sicurezza descritte sotto.
import { readFileSync, realpathSync, statSync } from "node:fs";
import { join, resolve, sep, isAbsolute } from "node:path";
import { responseText, stripDataUris } from "../../../scripts/chrome/snapshot-parse.mjs";

// Correzione 1 dopo la revisione (27/10/2026): Chrome DevTools non ha letture a pezzi; sulle pagine pesanti l'agente salva
// lo snapshot in un file (take_snapshot { filePath }) e lo legge a pezzi con Read. observe-append legge QUEL file e lo tratta
// come una lettura COMPLETA in linea (legame, nomi, record del registro), con le stesse regole: marcatore di pagina
// (RootWebArea), conteggi dei ref, storia.
// Sicurezza 1 (il modello potrebbe scrivere il file e forgiare una pagina): si legge solo il file che lo strumento ha scritto
// in QUESTA chiamata — filePath assoluto, .txt, nella cartella customers/<C>/.sessions/<sid>/snapshots/ (che Write, Edit e la
// shell non possono scrivere: guard-scope) dopo il realpath; risposta riuscita che nomina esattamente quel file ("Saved
// snapshot to <file>.", chrome-devtools-mcp); marcatore della chiamata scritto da guard-environment in PreToolUse
// (session.browser.snapshot_calls[<tool_use_id>]: percorso, ora, mtime precedente) e file modificato dopo;
// nessun limite in byte (guard sulla grandezza tolto il 27/10/2026, decisione dell'utente: i data URI in base64 del file
// si tolgono alla lettura). Ogni discordanza ⇒ la risposta resta quella dello strumento: nessuna lettura, nessun legame.
export const snapshotsDir = (ws, customer, sid) => join(ws, "customers", customer, ".sessions", sid, "snapshots");
const SELECTED_NOTE = /^Note: there is a selected element[^\n]*\n[^\n]*\n\n/;
const WINFS = process.platform === "win32";
const foldP = (p) => (WINFS ? p.toLowerCase() : p);
export function snapshotFileResponse({ ws, customer, sid, call, resp, state = "ok", marker = null, now = Date.now() }) {
  if (call?.family !== "chrome-devtools" || call.op !== "take_snapshot" || !Array.isArray(call.outputs) || call.outputs.length !== 1) return null;
  if (state !== "ok" || (Array.isArray(call.unknownKeys) && call.unknownKeys.length)) return null;
  const raw = call.outputs[0];
  if (typeof raw !== "string" || !raw.trim() || /[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(raw)) return null;
  if (!isAbsolute(raw) || (WINFS && !/^([A-Za-z]:[\\/]|[\\/]{2})/.test(raw)) || !/\.txt$/i.test(raw)) return null;
  const abs = resolve(raw);
  const text0 = responseText(resp);
  if (/^## Latest page snapshot\s*$/m.test(text0)) return null;   // già in linea
  // la risposta riuscita nomina esattamente quel file
  const saved = [...text0.matchAll(/^Saved snapshot to (.+)\.\s*$/gm)].map((m) => m[1]);
  if (saved.length !== 1 || foldP(resolve(saved[0])) !== foldP(abs)) return null;
  // marcatore di questa chiamata (PreToolUse, guard-environment): stesso file, scritto dopo
  if (!marker || typeof marker !== "object" || typeof marker.path !== "string" || foldP(resolve(marker.path)) !== foldP(abs) || !Number.isFinite(marker.ts)) return null;
  let real;
  let dir;
  try { real = realpathSync(abs); dir = realpathSync(snapshotsDir(ws, customer, sid)); } catch { return null; }
  if (!foldP(real).startsWith(foldP(dir.endsWith(sep) ? dir : dir + sep))) return null;
  let st;
  try { st = statSync(real); } catch { return null; }
  if (!st.isFile()) return null;
  if (st.mtimeMs < marker.ts - 1000 || (Number.isFinite(marker.before) && st.mtimeMs <= marker.before) || st.mtimeMs - now > 60000) return null;
  let body;
  try { body = readFileSync(real, "utf8"); } catch { return null; }
  body = stripDataUris(body).replace(/^\s*## Latest page snapshot\s*\n/, "").replace(SELECTED_NOTE, "");
  const block = { type: "text", text: `## Latest page snapshot\n${body}` };
  if (Array.isArray(resp)) return [...resp, block];
  if (resp && typeof resp === "object" && Array.isArray(resp.content)) return { ...resp, content: [...resp.content, block] };
  return [{ type: "text", text: text0 }, block];
}

