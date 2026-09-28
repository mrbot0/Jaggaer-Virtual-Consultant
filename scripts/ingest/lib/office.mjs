// Metadati dei pacchetti Office Open XML (docProps/core.xml): data del documento per il profilo DOC (§19.7 `dated`).
//   officeMeta(zip) → { dated: "AAAA-MM-GG" | null, title: string | null, creator: string | null }
import { parseXml, kid, textOf } from "./xml.mjs";

export function officeMeta(zip) {
  if (!zip.has("docProps/core.xml")) return { dated: null, title: null, creator: null };
  try {
    const root = parseXml(zip.text("docProps/core.xml"));
    const v = (n) => { const t = textOf(kid(root, n)).trim(); return t || null; };
    const d = v("modified") ?? v("created");
    return { dated: d && /^\d{4}-\d{2}-\d{2}/.test(d) ? d.slice(0, 10) : null, title: v("title"), creator: v("creator") };
  } catch { return { dated: null, title: null, creator: null }; }
}
