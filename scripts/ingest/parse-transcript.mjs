// Registrazioni di formazione: trascrizioni VTT, SRT o testo con marcatori di tempo → documento normalizzato
// (§19.8). Un blocco di parlato per paragrafo con il tempo d'inizio; i marcatori di cambio schermata
// ("[schermata: …]", "[screen: …]", "NOTE screen …") aprono una nuova sezione; la conoscenza TACITA
// ("di solito", "facciamo così", "in genere", "usually", "we always", "normally") è segnalata nei record
// (kind "tacit") per il residuo `tacit` (§19.15: candidato L a 0.60, domanda di apprendimento).
//
//   parseTranscript(buffer, { id, title?, source? }) → parsed-doc (sections[].kind = "trascrizione")
//   TACIT_RE                         i segnali di conoscenza tacita (it/en)
// CLI: node scripts/ingest/parse-transcript.mjs --in <file.vtt|srt|txt> [--id <id>] [--out <file.json>] [--json]
import { newDoc, newSection, finishDoc, oneLine, ParseError, sha256 } from "./lib/parsed.mjs";
import { runParserCli } from "./lib/cli.mjs";

export const TACIT_RE = /\b(di solito|solitamente|facciamo così|facciamo cosi|noi facciamo|in genere|di norma lo facciamo|abitualmente|per prassi|usually|we always|we normally|normally we|the way we do|as a rule we)\b/i;
const TIME = /(\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3}/;
const CUE = /^\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})\s*-->\s*((?:\d{1,2}:)?\d{1,2}:\d{2}[.,]\d{1,3})/;
const INLINE_TS = /^\s*\[?((?:\d{1,2}:)?\d{1,2}:\d{2})\]?\s+(.*)$/;
const SCREEN = /^\s*(?:\[(?:schermata|screen|slide)\s*:?\s*([^\]]*)\]|NOTE\s+(?:screen|schermata)\s*:?\s*(.*))\s*$/i;

export function looksLikeTranscript(text) {
  const t = String(text).slice(0, 4000);
  return /^WEBVTT/m.test(t) || CUE.test(t.split(/\r?\n/).find((l) => CUE.test(l)) ?? "") || (t.split(/\r?\n/).filter((l) => INLINE_TS.test(l)).length >= 3);
}

export function parseTranscript(buffer, { id, title, source = null } = {}) {
  const text = (Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer)).replace(/^\S*WEBVTT[^\n]*\n/, "");
  const lines = text.split(/\r?\n/);
  const doc = newDoc({ id, title, format: /\.srt$/i.test(source ?? "") ? "srt" : /\.vtt$/i.test(source ?? "") || /^WEBVTT/.test(String(buffer).slice(0, 10)) ? "vtt" : "txt", source, parser: "parse-transcript" });
  doc.meta.sha256 = sha256(Buffer.isBuffer(buffer) ? buffer : Buffer.from(text));
  doc.meta.kind_hint = "registrazione";
  let n = 0;
  let sec = null;
  const open = (t) => { sec = newSection({ path: `t${++n}`, title: t, level: 1 }); sec.kind = "trascrizione"; sec.records = []; doc.sections.push(sec); };
  open("Inizio");
  let cur = null;
  const flush = () => {
    if (!cur) return;
    const body = oneLine(cur.parts.join(" ").replace(/<[^>]+>/g, ""));
    if (body) {
      const speaker = /^([A-Z][\w .'-]{1,40}):\s/.exec(body)?.[1] ?? cur.voice ?? null;
      sec.paragraphs.push(`[${cur.start}] ${body}`);
      sec.records.push({ kind: TACIT_RE.test(body) ? "tacit" : "cue", name: cur.start, start: cur.start, end: cur.end ?? null, speaker, text: body });
    }
    cur = null;
  };
  for (const raw of lines) {
    const l = raw.trim();
    const sm = SCREEN.exec(l);
    if (sm) { flush(); open(oneLine(sm[1] ?? sm[2] ?? "") || `Schermata ${n + 1}`); continue; }
    const cm = CUE.exec(l);
    if (cm) { flush(); cur = { start: cm[1].replace(",", "."), end: cm[2].replace(",", "."), parts: [] }; continue; }
    if (!l) { flush(); continue; }
    if (/^\d+$/.test(l) && !cur) continue;              // numero di sequenza SRT
    if (/^(NOTE|STYLE|REGION)\b/.test(l)) continue;
    const im = !cur && INLINE_TS.exec(l);
    if (im && TIME.test(`${im[1]}.000`)) { flush(); cur = { start: im[1], end: null, parts: [im[2]] }; continue; }
    const voice = /^<v\s+([^>]+)>/.exec(l);
    if (!cur) cur = { start: "", end: null, parts: [] };
    if (voice) cur.voice = voice[1].trim();
    cur.parts.push(l);
  }
  flush();
  if (!doc.sections.some((s) => s.paragraphs.length)) throw new ParseError("trascrizione senza testo", { residue: "irrelevant" });
  return finishDoc(doc);
}

export const parse = parseTranscript;
runParserCli(import.meta.url, { name: "parse-transcript", ext: ".vtt", parse: parseTranscript });
