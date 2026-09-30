// Thread e-mail (.eml, .txt esportati) → documento normalizzato (§19.8). Unità = messaggio: una sezione
// per messaggio con data e autore (sections[].meta { from, date, subject }); le righe citate ("> …",
// "Il giorno … ha scritto:", "On … wrote:", "-----Original Message-----") sono tolte (citazioni ripetute:
// modo di fallimento noto). Le frasi di decisione ("abbiamo deciso", "abbiamo concordato", "si è deciso",
// "agreed", "we decided") sono record `decision` → unità `decisione` con data e autore.
//
//   parseEmail(buffer, { id, title?, source? }) → parsed-doc (sections[].kind = "messaggio")
//   looksLikeEmail(text) → boolean     intestazioni From:/Da: + Date:/Data: + Subject:/Oggetto:
//   DECISION_RE
// Limiti: MIME multipart letto per la sola parte text/plain (o text/html spogliata); quoted-printable e
// base64 decodificati; allegati ignorati (elencati nei record).
// CLI: node scripts/ingest/parse-email.mjs --in <file.eml|txt> [--id <id>] [--out <file.json>] [--json]
import { newDoc, newSection, finishDoc, oneLine, cleanText, ParseError, sha256 } from "./lib/parsed.mjs";
import { runParserCli } from "./lib/cli.mjs";

export const DECISION_RE = /\b(abbiamo deciso|abbiamo concordato|si è deciso|si e' deciso|è stato deciso|e' stato deciso|concordiamo che|resta inteso che|decisione:|we (?:have )?decided|(?:we )?agreed(?: that| to)?|it was agreed|decision:)\b/i;
const HDR = /^(From|Da|To|A|Cc|Date|Data|Inviato|Sent|Subject|Oggetto|Content-Type|Content-Transfer-Encoding|MIME-Version|Message-ID)\s*:\s*(.*)$/i;
const SPLIT = /^(?:-{2,}\s*(?:Original Message|Messaggio originale|Forwarded message|Messaggio inoltrato)\s*-{2,}|From:\s.+|Da:\s.+)$/i;

export function looksLikeEmail(text) {
  const head = String(text).slice(0, 3000);
  return /^(From|Da)\s*:/im.test(head) && /^(Date|Data|Inviato|Sent)\s*:/im.test(head) && /^(Subject|Oggetto)\s*:/im.test(head);
}

function qp(s) { return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); }
function decodeBody(body, headers) {
  const enc = (headers["content-transfer-encoding"] ?? "").toLowerCase();
  let b = body;
  if (enc === "base64") b = Buffer.from(b.replace(/\s+/g, ""), "base64").toString("utf8");
  else if (enc === "quoted-printable") b = Buffer.from(qp(b), "latin1").toString("utf8");
  if (/text\/html/i.test(headers["content-type"] ?? "")) b = b.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
  return b;
}

function mimeText(headers, body) {
  const ct = headers["content-type"] ?? "";
  const bm = /boundary="?([^";]+)"?/i.exec(ct);
  if (!/multipart\//i.test(ct) || !bm) return { text: decodeBody(body, headers), attachments: [] };
  const parts = body.split(`--${bm[1]}`).slice(1).filter((p) => !p.startsWith("--"));
  let text = null; const attachments = [];
  for (const p of parts) {
    const [h, ...rest] = p.replace(/^\r?\n/, "").split(/\r?\n\r?\n/);
    const ph = {};
    for (const line of h.split(/\r?\n(?!\s)/)) { const m = /^([\w-]+)\s*:\s*([\s\S]*)$/.exec(line); if (m) ph[m[1].toLowerCase()] = m[2].replace(/\s+/g, " "); }
    const name = /name="?([^";]+)"?/i.exec(ph["content-disposition"] ?? ph["content-type"] ?? "")?.[1];
    if (name) { attachments.push(name); continue; }
    const t = mimeText(ph, rest.join("\n\n"));
    if (/text\/plain/i.test(ph["content-type"] ?? "text/plain") && text === null) text = t.text;
    else if (text === null && /text\/html/i.test(ph["content-type"] ?? "")) text = t.text;
    attachments.push(...t.attachments);
  }
  return { text: text ?? "", attachments };
}

function splitMessages(text) {
  const lines = text.split(/\r?\n/);
  const msgs = [];
  let cur = null;
  let inHeaders = true;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (cur && !inHeaders && SPLIT.test(l.trim())) { msgs.push(cur); cur = null; inHeaders = true; if (!/^(From|Da)\s*:/i.test(l.trim())) continue; }
    if (!cur) cur = { headers: {}, body: [] };
    const hm = inHeaders ? HDR.exec(l) : null;
    if (hm) { cur.headers[hm[1].toLowerCase()] = hm[2].trim(); continue; }
    if (inHeaders && /^\s+\S/.test(l) && Object.keys(cur.headers).length) continue;   // intestazione ripiegata
    if (inHeaders && !l.trim() && Object.keys(cur.headers).length) { inHeaders = false; continue; }
    inHeaders = false;
    cur.body.push(l);
  }
  if (cur) msgs.push(cur);
  return msgs.filter((m) => Object.keys(m.headers).length || m.body.some((x) => x.trim()));
}

const dropQuoted = (body) => {
  const out = [];
  for (const l of body.split(/\r?\n/)) {
    if (/^\s*>/.test(l)) continue;
    if (/^(Il giorno .* ha scritto:|On .* wrote:)\s*$/i.test(l.trim())) break;
    out.push(l);
  }
  return out.join("\n");
};

export function parseEmail(buffer, { id, title, source = null } = {}) {
  const raw = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  if (!looksLikeEmail(raw)) throw new ParseError("intestazioni e-mail assenti (From/Date/Subject)", { residue: "unsupported" });
  const msgs = splitMessages(raw);
  const doc = newDoc({ id, title, format: /\.eml$/i.test(source ?? "") ? "eml" : "txt", source, parser: "parse-email" });
  doc.meta.sha256 = sha256(Buffer.from(raw));
  doc.meta.kind_hint = "thread-email";
  msgs.forEach((m, i) => {
    const h = { "content-type": m.headers["content-type"], "content-transfer-encoding": m.headers["content-transfer-encoding"] };
    const { text, attachments } = mimeText(h, m.body.join("\n"));
    const body = cleanText(dropQuoted(text));
    const from = m.headers.from ?? m.headers.da ?? null;
    const date = m.headers.date ?? m.headers.data ?? m.headers.inviato ?? m.headers.sent ?? null;
    const subject = m.headers.subject ?? m.headers.oggetto ?? null;
    const sec = newSection({ path: `m${i + 1}`, title: subject ? oneLine(subject) : `Messaggio ${i + 1}`, level: 1 });
    sec.kind = "messaggio";
    sec.meta = { from, date, subject };
    sec.paragraphs = body.split(/\n{2,}/).map(oneLine).filter(Boolean);
    const sentences = sec.paragraphs.flatMap((p) => p.split(/(?<=[.!?])\s+/));
    sec.records = [
      ...sentences.filter((s) => DECISION_RE.test(s)).map((s) => ({ kind: "decision", name: s.slice(0, 80), text: s, author: from, date })),
      ...attachments.map((a) => ({ kind: "attachment", name: a })),
    ];
    if (!sec.records.length) delete sec.records;
    doc.sections.push(sec);
  });
  if (!title && msgs[0]) doc.title = oneLine(msgs[0].headers.subject ?? msgs[0].headers.oggetto ?? id);
  return finishDoc(doc);
}

export const parse = parseEmail;
runParserCli(import.meta.url, { name: "parse-email", ext: ".eml", parse: parseEmail });
