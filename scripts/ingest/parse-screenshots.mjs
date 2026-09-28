// Schermate e set di immagini → documento normalizzato (§19.8, §19.17). Nessuna dipendenza di OCR:
// decisione del controllore — l'agente produce il testo OCR/visione con le proprie capacità e lo salva
// accanto all'immagine come `<immagine>.ocr.txt` (+ facoltativo `<immagine>.layout.json` con campi, pulsanti,
// tab e messaggi); lo script ingerisce i metadati dell'immagine (sha256, dimensioni, formato) e i sidecar.
// Immagine senza sidecar ⇒ ParseError con residuo `deferred` e il motivo (va prodotto l'OCR).
//
//   imageInfo(buffer) → { format: png|jpeg|gif|bmp|webp, width, height } | null
//   parseScreenshot(buffer, { id, title?, source?, path }) → parsed-doc (una sezione `schermata`)
//     layout.json: { page?, fields: [{ label, type?, required?, options?, section? }], buttons: [], tabs: [],
//                    messages: [{ text, severity? }] } → records (field, button, tab, message)
//   sidecars(path) → { ocr, layout }   percorsi attesi
// CLI: node scripts/ingest/parse-screenshots.mjs --in <immagine> [--id <id>] [--out <file.json>] [--json]
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { newDoc, newSection, finishDoc, oneLine, cleanText, ParseError, sha256 } from "./lib/parsed.mjs";
import { runParserCli } from "./lib/cli.mjs";

export function imageInfo(b) {
  if (!Buffer.isBuffer(b) || b.length < 12) return null;
  if (b.readUInt32BE(0) === 0x89504e47 && b.length >= 24) return { format: "png", width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
  if (b[0] === 0xff && b[1] === 0xd8) {
    let p = 2;
    while (p + 9 < b.length) {
      if (b[p] !== 0xff) { p++; continue; }
      const m = b[p + 1];
      if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { format: "jpeg", width: b.readUInt16BE(p + 7), height: b.readUInt16BE(p + 5) };
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { p += 2; continue; }
      p += 2 + b.readUInt16BE(p + 2);
    }
    return { format: "jpeg", width: null, height: null };
  }
  if (b.toString("latin1", 0, 3) === "GIF") return { format: "gif", width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
  if (b.toString("latin1", 0, 2) === "BM") return { format: "bmp", width: b.readInt32LE(18), height: Math.abs(b.readInt32LE(22)) };
  if (b.toString("latin1", 0, 4) === "RIFF" && b.toString("latin1", 8, 12) === "WEBP") return { format: "webp", width: null, height: null };
  return null;
}

export const sidecars = (path) => ({ ocr: `${path}.ocr.txt`, layout: `${path}.layout.json` });

export function parseScreenshot(buffer, { id, title, source = null, path = null, ocrText = null, layout = null } = {}) {
  const info = imageInfo(buffer);
  if (!info) throw new ParseError("immagine in formato non riconosciuto", { residue: "unsupported" });
  let ocr = ocrText, lay = layout;
  if (path) {
    const sc = sidecars(path);
    if (ocr === null && existsSync(sc.ocr)) ocr = readFileSync(sc.ocr, "utf8");
    if (lay === null && existsSync(sc.layout)) {
      try { lay = JSON.parse(readFileSync(sc.layout, "utf8")); } catch (e) { throw new ParseError(`layout.json non valido: ${e.message}`, { residue: "ambiguous" }); }
    }
  }
  if (ocr === null && lay === null) {
    throw new ParseError(`manca il sidecar OCR (${basename(path ?? source ?? "immagine")}.ocr.txt): l'agente deve produrre il testo dell'immagine`, { residue: "deferred" });
  }
  const doc = newDoc({ id, title: title ?? lay?.page ?? basename(source ?? path ?? id), format: "image", source, parser: "parse-screenshots" });
  doc.meta.sha256 = sha256(buffer);
  doc.meta.size = buffer.length;
  doc.meta.kind_hint = "set-screenshot";
  const sec = newSection({ path: "schermata", title: lay?.page ?? doc.title, level: 1 });
  sec.kind = "schermata";
  sec.meta = { image: { ...info, sha256: doc.meta.sha256, size: buffer.length } };
  doc.sections.push(sec);
  if (ocr) sec.paragraphs.push(...cleanText(ocr).split(/\n{2,}|\n/).map(oneLine).filter(Boolean));
  sec.figures.push({ ref: basename(source ?? path ?? id), caption: lay?.caption ?? undefined });
  if (lay) {
    sec.records = [
      ...(lay.fields ?? []).map((f) => ({ kind: "field", name: String(f.label ?? f.name ?? ""), type: f.type ?? null, required: f.required ?? null, options: f.options ?? [], section: f.section ?? null })),
      ...(lay.buttons ?? []).map((b) => ({ kind: "button", name: String(b.label ?? b) })),
      ...(lay.tabs ?? []).map((t, i) => ({ kind: "tab", name: String(t.label ?? t), order: i + 1 })),
      ...(lay.messages ?? []).map((m) => ({ kind: "message", name: String(m.text ?? m), severity: m.severity ?? null })),
    ].filter((r) => r.name);
    const fields = (lay.fields ?? []).filter((f) => f.label || f.name);
    if (fields.length) sec.tables.push({ caption: "campi osservati", headers: ["Campo", "Tipo", "Obbligatorio", "Valori ammessi", "Note"],
      rows: fields.map((f) => [String(f.label ?? f.name), f.type ?? "", f.required === true ? "Sì" : f.required === false ? "No" : "", (f.options ?? []).join("; "), f.section ? `sezione ${f.section}` : ""]) });
  }
  return finishDoc(doc);
}

export const parse = parseScreenshot;
runParserCli(import.meta.url, { name: "parse-screenshots", ext: ".png", parse: parseScreenshot });
