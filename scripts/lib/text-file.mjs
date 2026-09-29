// Testo libero da file (WP10a): i guard negano le invocazioni degli script del plugin che non sono semplici (virgole,
// punti interrogativi, lettere accentate, $ …), quindi i comandi passano il testo dell'utente da un file della sessione.
// → { text } | { error }. Percorso relativo alla cartella indicata (il workspace), al più `max` byte, UTF-8.
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";

export const TEXT_FILE_MAX = 64 * 1024;
export function readTextFile(base, file, { max = TEXT_FILE_MAX } = {}) {
  if (typeof file !== "string" || !file) return { error: "serve il percorso del file di testo" };
  const abs = resolve(base, file);
  try {
    if (statSync(abs).size > max) return { error: `file di testo oltre ${Math.round(max / 1024)} KB: ${file}` };
    const text = readFileSync(abs, "utf8").replace(/^﻿/, "").trim();
    return text ? { text } : { error: `file di testo vuoto: ${file}` };
  } catch (err) { return { error: `file di testo illeggibile: ${file} (${err.code ?? err.message})` }; }
}
