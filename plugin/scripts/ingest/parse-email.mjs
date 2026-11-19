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
// 18/11/2026 (ciclo di bug fixing, .eml reali salvati da Outlook/Exchange): l'intestazione RFC 5322 comincia con decine di
// Received:/ARC-*/X-MS-* prima di From: (oltre i 3000 caratteri di looksLikeEmail e fuori dall'elenco HDR), quindi 3 file su
// 5 finivano nel residuo «intestazioni assenti» e gli altri davano intestazioni come testo, quoted-printable non decodificato
// (indirizzi e-mail spezzati da "=\n" che sfuggivano alla redazione) e nessun testo dalle parti multipart annidate. Ora il
// blocco di intestazioni in testa (campi ripiegati riuniti) si legge per intero, il corpo MIME si decodifica PRIMA di
// dividere il thread (charset compreso, encoded-word nelle intestazioni, HTML senza style/head), poi i messaggi citati.
// CLI: node scripts/ingest/parse-email.mjs --in <file.eml|txt> [--id <id>] [--out <file.json>] [--json]
import { newDoc, newSection, finishDoc, oneLine, cleanText, ParseError, sha256 } from "./lib/parsed.mjs";
import { decodeEntities } from "./lib/xml.mjs";
import { runParserCli } from "./lib/cli.mjs";

export const DECISION_RE = /\b(abbiamo deciso|abbiamo concordato|si è deciso|si e' deciso|è stato deciso|e' stato deciso|concordiamo che|resta inteso che|decisione:|we (?:have )?decided|(?:we )?agreed(?: that| to)?|it was agreed|decision:)\b/i;
const HDR = /^(From|Da|To|A|Cc|Date|Data|Inviato|Sent|Subject|Oggetto|Content-Type|Content-Transfer-Encoding|MIME-Version|Message-ID)\s*:\s*(.*)$/i;
const SPLIT = /^(?:-{2,}\s*(?:Original Message|Messaggio originale|Forwarded message|Messaggio inoltrato)\s*-{2,}|From:\s.+|Da:\s.+)$/i;

export function looksLikeEmail(text) {
  const head = String(text).slice(0, 3000);
  return /^(From|Da)\s*:/im.test(head) && /^(Date|Data|Inviato|Sent)\s*:/im.test(head) && /^(Subject|Oggetto)\s*:/im.test(head);
}

function qp(s) { return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))); }
// byte → testo nel charset dichiarato (utf-8 se assente o sconosciuto)
function decodeBytes(bytes, charset) {
  const cs = String(charset ?? "utf-8").toLowerCase();
  try { return new TextDecoder(cs === "us-ascii" ? "utf-8" : cs).decode(bytes); } catch { return new TextDecoder("utf-8").decode(bytes); }
}
const charsetOf = (ct) => /charset\s*=\s*"?([\w.:-]+)"?/i.exec(ct ?? "")?.[1] ?? null;
// encoded-word di RFC 2047 nelle intestazioni (=?utf-8?Q?…?= / =?iso-8859-1?B?…?=)
export function decodeWords(s) {
  if (typeof s !== "string" || !s.includes("=?")) return s;
  return s.replace(/=\?([^?]+)\?([QqBb])\?([^?]*)\?=(\s+(?==\?))?/g, (m, cs, enc, txt) => {
    try {
      const bytes = /b/i.test(enc) ? Buffer.from(txt, "base64") : Buffer.from(qp(txt.replace(/_/g, " ")), "latin1");
      return decodeBytes(bytes, cs);
    } catch { return m; }
  });
}
function decodeBody(body, headers) {
  const enc = (headers["content-transfer-encoding"] ?? "").toLowerCase().trim();
  const cs = charsetOf(headers["content-type"]);
  let b = body;
  if (enc === "base64") b = decodeBytes(Buffer.from(b.replace(/\s+/g, ""), "base64"), cs);
  else if (enc === "quoted-printable") b = decodeBytes(Buffer.from(qp(b), "latin1"), cs);
  if (/text\/html/i.test(headers["content-type"] ?? "")) {
    b = decodeEntities(b.replace(/<!--[\s\S]*?-->/g, " ").replace(/<(head|style|script)\b[\s\S]*?<\/\1\s*>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n").replace(/<\/(p|div|tr|li|h\d)\s*>/gi, "\n\n").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " "))
      .split("\n").map((l) => l.replace(/[ \t ]+/g, " ").trim()).join("\n");
  }
  return b;
}

// Blocco di intestazioni RFC 5322 in testa al file: ogni riga "Nome: valore" (anche Received:, ARC-*, X-MS-*…) con i
// campi ripiegati riuniti, fino alla prima riga vuota; dei campi ripetuti vale il primo. null se il file non comincia con
// un blocco di intestazioni che contenga From/Da e Date o Subject.
const FIELD = /^([!-9;-~]+)[ \t]*:[ \t]?(.*)$/;   // nome del campo: ASCII stampabile senza ":" (RFC 5322 §3.6.8; Outlook: msip_labels)
export function rfcHeaderBlock(raw) {
  const lines = String(raw).split(/\r?\n/);
  const headers = {};
  let last = null, i = 0;
  for (; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) break;
    if (/^[ \t]/.test(l)) { if (last === null) return null; if (last !== "#") headers[last] += ` ${l.trim()}`; continue; }
    const m = FIELD.exec(l);
    if (!m) return null;
    const k = m[1].toLowerCase();
    if (headers[k] === undefined) { headers[k] = m[2].trim(); last = k; } else last = "#";
  }
  const from = headers.from ?? headers.da;
  if (!from || !(headers.date ?? headers.data ?? headers.sent ?? headers.inviato ?? headers.subject ?? headers.oggetto)) return null;
  return { headers, body: lines.slice(i + 1).join("\n") };
}

function mimeText(headers, body) {
  const ct = headers["content-type"] ?? "";
  const bm = /boundary="?([^";]+)"?/i.exec(ct);
  if (!/multipart\//i.test(ct) || !bm) return { text: decodeBody(body, headers), attachments: [], plain: !/text\/html/i.test(ct) };
  const parts = body.split(`--${bm[1]}`).slice(1).filter((p) => !p.startsWith("--"));
  let text = null, plain = false; const attachments = [];
  for (const p of parts) {
    const [h, ...rest] = p.replace(/^\r?\n/, "").split(/\r?\n\r?\n/);
    const ph = {};
    for (const line of h.split(/\r?\n(?!\s)/)) { const m = /^([\w-]+)\s*:\s*([\s\S]*)$/.exec(line); if (m) ph[m[1].toLowerCase()] = m[2].replace(/\s+/g, " "); }
    const name = /name="?([^";]+)"?/i.exec(ph["content-disposition"] ?? ph["content-type"] ?? "")?.[1];
    if (name) { attachments.push(name); continue; }
    const t = mimeText(ph, rest.join("\n\n"));
    // multipart/related ⊃ multipart/alternative ⊃ text/plain + text/html (Outlook): il testo della parte annidata vale
    // come quello di una parte semplice; text/plain prima di text/html
    const pct = ph["content-type"] ?? "text/plain";
    if ((/text\/plain/i.test(pct) || (/multipart\//i.test(pct) && t.plain)) && (text === null || !plain)) { text = t.text; plain = true; }
    else if (text === null && (/text\/html/i.test(pct) || /multipart\//i.test(pct)) && t.text) text = t.text;
    attachments.push(...t.attachments);
  }
  return { text: text ?? "", attachments, plain };
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
  const top = rfcHeaderBlock(raw);
  if (!top && !looksLikeEmail(raw)) throw new ParseError("intestazioni e-mail assenti (From/Date/Subject)", { residue: "unsupported" });
  let msgs, topAttachments = [];
  if (top) {
    // corpo MIME decodificato prima di dividere il thread; il primo messaggio eredita le intestazioni del file
    const { text, attachments } = mimeText(top.headers, top.body);
    topAttachments = attachments;
    msgs = splitMessages(text).map((m) => ({ ...m, decoded: true }));
    if (!msgs.length || msgs[0].headers.from || msgs[0].headers.da) msgs.unshift({ headers: {}, body: [], decoded: true });
    msgs[0].headers = { ...top.headers, ...msgs[0].headers };
  } else msgs = splitMessages(raw);
  const doc = newDoc({ id, title, format: /\.eml$/i.test(source ?? "") ? "eml" : "txt", source, parser: "parse-email" });
  doc.meta.sha256 = sha256(Buffer.from(raw));
  doc.meta.kind_hint = "thread-email";
  msgs.forEach((m, i) => {
    const h = { "content-type": m.headers["content-type"], "content-transfer-encoding": m.headers["content-transfer-encoding"] };
    const dec = m.decoded ? { text: m.body.join("\n"), attachments: i === 0 ? topAttachments : [] } : mimeText(h, m.body.join("\n"));
    const { text, attachments } = dec;
    const body = cleanText(dropQuoted(text));
    const from = decodeWords(m.headers.from ?? m.headers.da ?? null);
    const date = m.headers.date ?? m.headers.data ?? m.headers.inviato ?? m.headers.sent ?? null;
    const subject = decodeWords(m.headers.subject ?? m.headers.oggetto ?? null);
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
  if (!title && msgs[0]) doc.title = oneLine(decodeWords(msgs[0].headers.subject ?? msgs[0].headers.oggetto ?? id));
  return finishDoc(doc);
}

export const parse = parseEmail;
runParserCli(import.meta.url, { name: "parse-email", ext: ".eml", parse: parseEmail });
