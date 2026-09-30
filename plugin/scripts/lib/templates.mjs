// Template dei documenti prodotti dagli script (WP10a, ruling del controller: albero templates/ di §31.2 e §43.3 — spec,
// page object, contact sheet, report, Defect). Lo script produttore usa il file di templates/ se c'è, altrimenti genera
// dal codice lo stesso testo (i test verificano che i due percorsi coincidano sul template distribuito).
//
//   loadTemplate(name, { dir? }) → testo del template senza il commento iniziale (<!-- … --> o {{!-- … --}}) | null se il
//                                  file manca (il chiamante genera dal codice)
//   fillTemplate(tpl, values, { required? }) → testo | null (null: il template non ha un segnaposto obbligatorio ⇒ il
//                                  chiamante genera dal codice). {{chiave}} sostituito in UN solo passaggio (un valore che
//                                  contiene {{…}} non viene riletto); una riga fatta solo di {{chiave}} con valore vuoto
//                                  sparisce con il suo a capo; chiave sconosciuta ⇒ testo vuoto.
//   fillParagraphs(tpl, values, { required? }) → come fillTemplate, per paragrafi (separati da una riga vuota): un
//                                  paragrafo che risulta vuoto sparisce (descrizioni a sezioni facoltative, es. il Defect).
// Solo moduli built-in.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const TEMPLATES_DIR = fileURLToPath(new URL("../../templates/", import.meta.url));

export function stripHeader(text) {
  return String(text).replace(/\r\n/g, "\n").replace(/^(?:<!--[\s\S]*?-->|\{\{!--[\s\S]*?--\}\})[ \t]*\n?/, "");
}

export function loadTemplate(name, { dir = TEMPLATES_DIR } = {}) {
  if (!/^[\w.-]+$/.test(name)) throw new Error(`nome di template non valido: ${name}`);
  try { return stripHeader(readFileSync(join(dir, name), "utf8")); } catch (err) { if (err.code === "ENOENT") return null; throw err; }
}

const str = (v) => (v == null ? "" : String(v));
const hasAll = (tpl, required) => required.every((k) => tpl.includes(`{{${k}}}`));

export function fillTemplate(tpl, values, { required = [] } = {}) {
  if (typeof tpl !== "string" || !hasAll(tpl, required)) return null;
  return tpl.replace(/^\{\{(\w+)\}\}\n|\{\{(\w+)\}\}/gm, (m, line, inline) => {
    if (line !== undefined) { const v = str(values[line]); return v === "" ? "" : `${v}\n`; }
    return str(values[inline]);
  });
}

// WP10a giro 1 (minore 5): l'avviso per un template presente ma senza segnaposto obbligatori (ignorato, testo dal codice).
export function templateWarning(name, tpl, required) {
  if (typeof tpl !== "string") return null;
  const missing = required.filter((k) => !tpl.includes(`{{${k}}}`));
  return missing.length ? `template templates/${name} ignorato: mancano ${missing.map((k) => `{{${k}}}`).join(", ")} — testo generato dal codice` : null;
}
// Riempie o, se il template non è valido, registra l'avviso in `warnings` e restituisce null (il chiamante usa il codice).
export function fillOrWarn(name, tpl, values, required, warnings, { paragraphs = false } = {}) {
  if (tpl == null) return null;
  const w = templateWarning(name, tpl, required);
  if (w) { if (Array.isArray(warnings)) warnings.push(w); return null; }
  return paragraphs ? fillParagraphs(tpl, values, { required }) : fillTemplate(tpl, values, { required });
}

export function fillParagraphs(tpl, values, { required = [] } = {}) {
  if (typeof tpl !== "string" || !hasAll(tpl, required)) return null;
  const body = tpl.replace(/\n+$/, "");
  return body.split(/\n[ \t]*\n/).map((p) => fillTemplate(p, values)).filter((p) => p !== "").join("\n\n");
}
