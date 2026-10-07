// Operazioni sul foglio di un template xlsx condivise da kb template-learn e ops template-fill (spec 2026-10-06 §3.8,
// revisione finale I5/F3): risoluzione del foglio per nome (workbook.xml → r:id → workbook.xml.rels, nessun ripiego su
// sheet1.xml) e rimozione delle righe sotto l'intestazione nel XML del foglio.
//   sheetPathOf(zip, name) → { path } | { error: "unresolved" | "missing", path? }
//   stripRowsBelow(xml, headerRow) → xml senza le righe di numero > headerRow (anche vuote o senza r=)
//   blankTemplate(buf, sheet, headerRow) → Buffer: il file con il foglio ripulito (dimensione ricalcolata) e le shared
//     strings non più usate da nessuna cella svuotate (gli indici restano: le celle rimaste non cambiano)
import { openZip } from "./zip.mjs";
import { makeZip } from "./zip-write.mjs";

export const attr = (tag, name) => new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
export const unesc = (s) => String(s).replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");

export function sheetPathOf(zip, name) {
  const wb = zip.text("xl/workbook.xml");
  const sheetTag = [...wb.matchAll(/<(?:\w+:)?sheet\b[^>]*>/g)].map((m) => m[0]).find((t) => unesc(attr(t, "name") ?? "") === name);
  const rid = sheetTag && /\br:id="([^"]+)"/.exec(sheetTag)?.[1];
  const rels = zip.has("xl/_rels/workbook.xml.rels") ? zip.text("xl/_rels/workbook.xml.rels") : "";
  const relTag = rid && [...rels.matchAll(/<(?:\w+:)?Relationship\b[^>]*>/g)].map((m) => m[0]).find((t) => attr(t, "Id") === rid);
  const target = relTag && attr(relTag, "Target");
  if (!target) return { error: "unresolved" };
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  return zip.has(path) ? { path } : { error: "missing", path };
}

// Le righe sotto l'intestazione si tolgono (anche vuote o senza r=: numerate dopo la precedente); quelle fino
// all'intestazione restano.
export function stripRowsBelow(xml, headerRow) {
  let prev = 0;
  return xml.replace(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>[\s\S]*?<\/(?:\w+:)?row>)/g, (m, attrs) => { const n = Number(attr(attrs, "r") ?? prev + 1); prev = n; return n > headerRow ? "" : m; });
}

const SI = /<((?:\w+:)?)si\b[^>]*?(?:\/>|>[\s\S]*?<\/(?:\w+:)?si>)/g;
export function blankTemplate(buf, sheet, headerRow) {
  const zip = openZip(buf);
  const r = sheetPathOf(zip, sheet);
  if (r.error) throw new Error(`foglio "${sheet}" non ${r.error === "missing" ? "trovato" : "risolto"} nel file del template`);
  let xml = stripRowsBelow(zip.text(r.path), headerRow);
  xml = xml.replace(/<((?:\w+:)?)dimension ref="([A-Z]+)(\d+)(?::([A-Z]+)\d+)?"\s*\/>/, (_, p, c1, r1, c2) => `<${p}dimension ref="${c1}${r1}${c2 ? `:${c2}${Math.max(Number(r1), headerRow)}` : ""}"/>`);
  const texts = new Map([[r.path, xml]]);
  // shared strings: quelle non più citate da nessuna cella di nessun foglio si svuotano (i dati tolti non restano nel file)
  if (zip.has("xl/sharedStrings.xml")) {
    const used = new Set();
    for (const name of zip.names.filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n))) {
      const x = texts.get(name) ?? zip.text(name);
      for (const m of x.matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
        if (attr(m[1], "t") !== "s") continue;
        const v = /<(?:\w+:)?v>\s*(\d+)\s*<\/(?:\w+:)?v>/.exec(m[2] ?? "");
        if (v) used.add(Number(v[1]));
      }
    }
    let i = 0;
    texts.set("xl/sharedStrings.xml", zip.text("xl/sharedStrings.xml").replace(SI, (m, p) => (used.has(i++) ? m : `<${p}si><${p}t></${p}t></${p}si>`)));
  }
  return makeZip(zip.names.map((name) => ({ name, data: texts.has(name) ? Buffer.from(texts.get(name), "utf8") : zip.read(name) })));
}
