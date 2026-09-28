// Segmentazione (§19.6.4 passo 1, §19.9): dal documento normalizzato
// (schemas/parsed-doc.schema.json) alle unità di lavoro.
//
// Interfaccia di K4 (tabelle di campi):
//   recognizeFieldTable(headers) → { label, type?, mandatory, notes?, technical_name?, allowed_values? } | null
//       indici delle colonne di una tabella "campo | tipo | obbligatorio | note" (sinonimi it/en);
//       null se non è una tabella di campi (servono campo + obbligatorio + tipo o nome tecnico).
//   segmentFieldTables(doc, { max = 50 }) → unità [{ id: "<sezione>#part-n", document, section,
//       section_title, page, part, parts, rows: [{ table, row, cells, columns }] }]
//       le righe di tutte le tabelle di campi di una sezione, in parti uguali ≤ max righe:
//       nessun passaggio a valle vede più di 50 campi (§19.6.4).
//
// Spazio per WP09a: il segmentatore generale delle unità di significato (§19.9: procedura,
// passo, tabella, nota, regola, definizione, figura, esempio, riferimento, tracciato,
// decisione) va accanto a segmentFieldTables in questo modulo, sullo stesso documento
// normalizzato; le tabelle di campi restano unità `riga-tabella-campi`.
import { createHash as _createHash } from "node:crypto";
import { validateWith } from "../lib/schemas.mjs";
import { parseRule as _parseRule } from "./deontic.mjs";

export const MAX_ROWS_PER_UNIT = 50;

export class InvalidDocError extends Error { constructor(m) { super(m); this.name = "InvalidDocError"; } }

export function normalizeHeader(h) {
  return String(h ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

// Sinonimi delle intestazioni, per ruolo di colonna (match esatto sull'intestazione normalizzata).
const HEADER_SYNONYMS = {
  technical_name: ["nome tecnico", "technical name", "technical id", "id", "codice campo", "field id", "field code", "api name", "nome campo tecnico", "db column",
    // WP09a: tracciati dei development kit dei web service (elemento/attributo XML o JSON = nome tecnico)
    "attribute", "attribute name", "attributo", "element", "element name", "elemento", "xml element", "xml tag", "tag", "json attribute", "parameter name", "property", "property name"],
  label: ["campo", "field", "nome", "name", "etichetta", "label", "nome campo", "field name", "descrizione campo"],
  type: ["tipo", "type", "tipo campo", "field type", "tipo dato", "data type", "formato", "format"],
  mandatory: ["obbligatorio", "obbligatorieta", "mandatory", "required", "obbl", "richiesto", "obbligatorio s n", "mandatory y n", "required y n",
    "mandatory optional", "m o", "obbligatorio facoltativo", "is required", "required field"],
  notes: ["note", "notes", "descrizione", "description", "commenti", "comments", "osservazioni", "remarks"],
  allowed_values: ["valori ammessi", "allowed values", "valori", "values", "opzioni", "options", "dominio", "domain", "valori possibili", "possible values"],
};
const LOOKUP = new Map(Object.entries(HEADER_SYNONYMS).flatMap(([role, list]) => list.map((s) => [s, role])));

export function recognizeFieldTable(headers) {
  if (!Array.isArray(headers)) return null;
  const cols = {};
  headers.forEach((h, i) => {
    const role = LOOKUP.get(normalizeHeader(h));
    if (role && cols[role] === undefined) cols[role] = i;
  });
  // WP09a: nei tracciati il nome tecnico fa anche da label (nessuna colonna "campo" separata)
  if (cols.label === undefined && cols.technical_name !== undefined) cols.label = cols.technical_name;
  if (cols.label === undefined || cols.mandatory === undefined) return null;
  if (cols.type === undefined && cols.technical_name === undefined) return null;
  return cols;
}

const isEmptyRow = (cells) => !cells.some((c) => c !== null && c !== undefined && String(c).trim() !== "");
const isHeaderRepeat = (cells, headers) => cells.length === headers.length && cells.every((c, i) => normalizeHeader(c) === normalizeHeader(headers[i]));

export function assertParsedDoc(doc) {
  const v = validateWith("parsed-doc.schema.json", doc);
  if (!v.ok) throw new InvalidDocError(`documento non conforme a parsed-doc.schema.json: ${v.errors.slice(0, 5).join("; ")}`);
}

// Divide n righe in parti uguali ≤ max (120 → 40/40/40, non 50/50/20).
export function chunkEven(list, max = MAX_ROWS_PER_UNIT) {
  if (!list.length) return [];
  const parts = Math.ceil(list.length / max);
  const size = Math.ceil(list.length / parts);
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function segmentFieldTables(doc, { max = MAX_ROWS_PER_UNIT } = {}) {
  assertParsedDoc(doc);
  if (!(max >= 1 && max <= MAX_ROWS_PER_UNIT)) throw new RangeError(`max deve essere fra 1 e ${MAX_ROWS_PER_UNIT}`);
  const units = [];
  for (const s of doc.sections) {
    const rows = [];
    s.tables.forEach((t, ti) => {
      const columns = recognizeFieldTable(t.headers);
      if (!columns) return;
      t.rows.forEach((cells, ri) => {
        if (isEmptyRow(cells) || isHeaderRepeat(cells, t.headers)) return;
        rows.push({ table: ti, row: ri, cells, columns });
      });
    });
    const parts = chunkEven(rows, max);
    parts.forEach((chunk, i) => units.push({ id: `${s.path}#part-${i + 1}`, document: doc.id, section: s.path, section_title: s.title,
      page: s.page ?? null, part: i + 1, parts: parts.length, rows: chunk }));
  }
  for (const u of units) if (u.rows.length > MAX_ROWS_PER_UNIT) throw new Error(`unità ${u.id} con ${u.rows.length} righe (> ${MAX_ROWS_PER_UNIT})`);
  return units;
}

// ============================================================================================================
// WP09a-B — Segmentazione in unità di significato (§19.9)
//
//   segmentUnits(doc, { docCode?, previous?, maxWords = 300 }) → { units[], overflow[] }
//     doc: documento normalizzato; docCode: codice DOC (S.STD.XSC.DOC.0007 → DOCID "DOC0007"), altrimenti
//     DOCID dall'id del documento; previous: unità della versione precedente [{ id, hash }] → il codice
//     U.<DOCID>.<nnnn> è CONSERVATO quando l'hash non cambia (§19.16), le nuove prendono i numeri liberi.
//     Tipi (UNIT_TYPES): procedura (≤ 15 passi; oltre si spezza, il passo di confine appartiene a entrambe
//     e ogni passo diventa anche un'unità `passo`), passo, riga-tabella-campi (1 riga), tabella (≤ 40 righe,
//     a blocchi), nota (riquadri, Nota/Attenzione, commenti e revisioni DOCX), regola (frase deontica + la
//     precedente se pronominale), definizione ("X è …", glossari), figura, esempio, riferimento, tracciato
//     (1 elemento formale), decisione (e-mail, verbali), schermata; `testo` per la prosa descrittiva che
//     non è nessuno dei tipi di §19.9 (il profilo DOC la conta come "altro").
//     Ogni unità ≤ maxWords parole (oltre si spezza sul confine di frase), con intestazione di contesto
//     { doc, chapter, section, section_path, page, lang, prev, next }, hash "sha256:<hex>" del testo
//     normalizzato, lingua it/en da parole vuote, refs_out verso le sezioni citate ("vedi §2.1").
//     overflow: righe di tabelle-dataset oltre il campione (tabelle non di campi con > DATASET_ROWS righe:
//     un'unità `tabella` di campione, il resto elencato qui → residuo irrelevant nel report).
//   unitHash(text), detectUnitLang(text), splitSentences(text), docIdToken(docCodeOrId), describeRecord(r)
// ============================================================================================================

export const UNIT_TYPES = ["procedura", "passo", "riga-tabella-campi", "tabella", "nota", "regola", "definizione", "figura", "esempio",
  "riferimento", "tracciato", "decisione", "schermata", "testo"];
export const MAX_UNIT_WORDS = 300;
export const MAX_PROCEDURE_STEPS = 15;
export const MAX_TABLE_ROWS = 40;
export const DATASET_ROWS = 400;

const wordsOf = (s) => String(s ?? "").trim().split(/\s+/).filter(Boolean);
const wc = (s) => wordsOf(s).length;
const normText = (s) => String(s ?? "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
export const unitHash = (text) => `sha256:${_createHash("sha256").update(normText(text)).digest("hex")}`;

const IT_SW = new Set(["il", "lo", "la", "gli", "le", "di", "del", "della", "dei", "delle", "che", "è", "sono", "per", "con", "non", "una", "uno", "nel", "nella", "questo", "deve", "campo", "viene", "come", "anche", "dal", "alla", "ai", "si"]);
const EN_SW = new Set(["the", "is", "are", "of", "to", "and", "in", "for", "with", "this", "that", "be", "must", "field", "on", "by", "from", "as", "an", "it", "you", "can", "will", "or", "your", "which", "when", "if", "not", "a"]);
export function detectUnitLang(text, fallback = null) {
  let it = 0, en = 0;
  for (const x of wordsOf(String(text).toLowerCase().replace(/[^\p{L}\s']/gu, " "))) { if (IT_SW.has(x)) it++; if (EN_SW.has(x)) en++; }
  if (it === en) return /[àèéìòù]/i.test(text) ? "it" : fallback ?? (it > 0 ? "it" : "en");
  return it > en ? "it" : "en";
}

const ABBR = /\b(?:es|ecc|etc|e\.g|i\.e|p\.es|n|nr|art|pag|pagg|cfr|vs|fig|tab|sez|cap|ing|dott|sig|min|max|approx|no|incl|ref)\.$/i;
export function splitSentences(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t) return [];
  const out = [];
  let start = 0;
  const re = /[.!?;](?=\s+[\p{Lu}\d"«(“'])/gu;
  let m;
  while ((m = re.exec(t))) {
    const piece = t.slice(start, m.index + 1);
    if (ABBR.test(piece)) continue;
    out.push(piece.trim());
    start = m.index + 1;
  }
  const rest = t.slice(start).trim();
  if (rest) out.push(rest);
  return out;
}

export function docIdToken(codeOrId) {
  const m = /\.DOC\.(\d{4})(?:\.v\d+)?$/.exec(String(codeOrId ?? ""));
  if (m) return `DOC${m[1]}`;
  const t = String(codeOrId ?? "DOC").toUpperCase().replace(/[^A-Z0-9]+/g, "");
  return (t || "DOC").slice(0, 32);
}

const STEP_RE = /^\s*(?:(\d{1,2})[.)]|([a-z])[.)]|(?:step|passo|fase)\s+(\d{1,2})[:.)-]?)\s+(.+)$/iu;
const BULLET_RE = /^\s*[-•*▪►‣◦]\s+(.+)$/u;
const IMPERATIVE_RE = /^(?:(?:fare|fai) clic|clicca(?:re)?|seleziona(?:re)?|inserisci|inserire|apri(?:re)?|salva(?:re)?|compila(?:re)?|vai|andare|scegli(?:ere)?|premi|premere|digita(?:re)?|imposta(?:re)?|aggiungi|aggiungere|crea(?:re)?|conferma(?:re)?|verifica(?:re)?|controlla(?:re)?|accedi|accedere|carica(?:re)?|scarica(?:re)?|invia(?:re)?|click|select|enter|open|go to|navigate|choose|type|save|submit|add|create|set|check|review|log in|login|upload|download|search|expand|complete|fill|press|specify|assign|update|edit|drag|mark|close|return|confirm|define|configure|enable|disable|copy|paste|attach|approve|reject)\b/i;
const NOTE_RE = /^(?:nota(?: bene)?|n\.b\.|attenzione|importante|avvertenza|suggerimento|note|notes|warning|caution|important|tip|hint|remember)\b\s*[:\-–!]/i;
const EXAMPLE_RE = /^(?:ad esempio|per esempio|esempio|es\.|ad es\.|for example|for instance|example|e\.g\.)(?=[\s:,])/i;
const EXAMPLE_ANY = /\b(ad esempio|per esempio|for example|for instance|e\.g\.)/i;
const REF_RE = /\b(?:vedi|vedere|si veda|cfr\.?|consultare|see|refer to|as described in)\s+(?:(?:il |la |lo |the )?(?:§|sezione|section|capitolo|chapter|paragrafo|paragraph|par\.|appendice|appendix|pag(?:ina)?\.?|page|figura|figure|tabella|table)\s*)?(?:§\s*)?([0-9]+(?:\.[0-9]+)*|[A-Z][\w-]*)/i;
const SECTION_REF = /(?:§\s*|(?:sezione|section|capitolo|chapter|paragrafo|paragraph)\s+)([0-9]+(?:\.[0-9]+)*)/gi;
const URL_RE = /\bhttps?:\/\/\S+/i;
const DEF_RE = /^(?:(?:il|lo|la|l'|i|gli|le|un|una|the|a|an)\s+)?([\p{L}][\p{L}\p{N}\s'’_/-]{1,60}?)\s+(?:è|sono|indica|rappresenta|si intende|significa|identifica|is|are|means|refers to|represents|denotes|identifies)\s+(?:il|lo|la|l'|i|gli|le|un|una|uno|un'|the|a|an|any|each)\b/iu;
const DECISION_RE2 = /\b(abbiamo deciso|abbiamo concordato|si è deciso|è stato deciso|concordiamo che|resta inteso che|we (?:have )?decided|it was agreed|we agreed)\b/i;
const PRONOMINAL = /^(?:esso|essa|essi|esse|questo|questa|questi|queste|tale|tali|ciò|lo stesso|la stessa|in tal caso|in questo caso|it|this|that|these|those|they|such|in this case|in that case)\b/i;
const GLOSSARY_HEADERS = /^(termine|term|voce|glossario|acronimo|acronym|abbreviation|abbreviazione|parola|word)$/i;
const GLOSSARY_DEF = /^(definizione|definition|descrizione|description|significato|meaning)$/i;
const TACIT_ANY = /\b(di solito|solitamente|facciamo così|facciamo cosi|noi facciamo|in genere facciamo|abitualmente|per prassi|usually|we always|we normally|normally we|the way we do)\b/i;
const STRONG_OPTIONAL = /facoltativ|opzional|optional|not required|not mandatory|non (?:è|sono) (?:obbligatori|richiest|necessari)|non occorre|no need|does not need|doesn't need|non serve/i;

// Frase deontica? Una facoltà solo lessicale ("può", "can") non basta: servirebbe una regola per ogni "può".
export function deonticRule(sentence, lang) {
  const r = _parseRule(sentence, { lang });
  if (r.modality === "ambiguo") return r.signals.every((s) => s === "nessun segnale deontico" || s === "testo vuoto") ? null : r;
  if (r.modality === "facolta" && !STRONG_OPTIONAL.test(r.text)) return null;
  return r;
}

export function segmentUnits(doc, { docCode = null, previous = [], maxWords = MAX_UNIT_WORDS } = {}) {
  assertParsedDoc(doc);
  const docRef = docCode ?? doc.id;
  const token = docIdToken(docCode ?? doc.id);
  const raw = [];
  const overflow = [];
  let chapter = null;
  const push = (sec, u) => {
    const text = String(u.text ?? "").trim();
    if (text) raw.push({ ...u, text, section: sec });
  };
  for (const s of doc.sections) {
    if (s.level === 1) chapter = s.title || chapter;
    const sec = { path: s.path, title: s.title, page: s.page ?? null, chapter: s.level === 1 ? s.title : chapter };
    if (s.kind === "tracciato") {
      for (const r of s.records ?? []) push(sec, { type: "tracciato", text: describeRecord(r), record: r });
      for (const p of s.paragraphs) push(sec, { type: "tracciato", text: p });
      continue;
    }
    if (s.kind === "schermata") {
      push(sec, { type: "schermata", text: [s.title, ...s.paragraphs].join("\n"), record: { image: s.meta?.image ?? null, elements: (s.records ?? []).filter((r) => r.kind !== "message") } });
      for (const m of (s.records ?? []).filter((r) => r.kind === "message")) push(sec, { type: "regola", text: m.name, system_message: true, severity: m.severity ?? null });
    } else segmentProse(s, sec, push);
    for (const r of s.records ?? []) {
      if (r.kind === "decision") push(sec, { type: "decisione", text: r.text, decision: { author: r.author ?? s.meta?.from ?? null, date: r.date ?? s.meta?.date ?? null } });
    }
    // figura = immagine + didascalia (§19.9): senza didascalia non c'è testo da citare; resta nel conteggio
    // structure.figures del profilo DOC (le etichette delle schermate arrivano dai sidecar OCR, non da qui)
    for (const f of s.figures) {
      const fig = typeof f === "string" ? { ref: f } : f;
      if (fig.caption) push(sec, { type: "figura", text: fig.caption, figure: { ref: fig.ref ?? null, caption: fig.caption, page: fig.page ?? s.page ?? null } });
    }
    s.tables.forEach((t, ti) => segmentTable(s, sec, t, ti, push, overflow));
    for (const c of s.comments ?? []) push(sec, { type: "nota", text: `Commento${c.author ? ` di ${c.author}` : ""}${c.date ? ` (${String(c.date).slice(0, 10)})` : ""}: ${c.text}`, source_kind: "commento", comment: { author: c.author ?? null, date: c.date ?? null } });
    for (const r of s.revisions ?? []) push(sec, { type: "nota", text: `Revisione (${r.kind === "insert" ? "inserito" : "cancellato"}${r.author ? ` da ${r.author}` : ""}${r.date ? `, ${String(r.date).slice(0, 10)}` : ""}): ${r.text}`, source_kind: "revisione", revision: { kind: r.kind, author: r.author ?? null, date: r.date ?? null } });
  }
  // limite di parole: si spezza sul confine di frase
  const sized = [];
  for (const u of raw) {
    if (wc(u.text) <= maxWords) { sized.push(u); continue; }
    const parts = splitByWords(u.text, maxWords);
    parts.forEach((t, i) => sized.push({ ...u, text: t, part: { n: i + 1, of: parts.length } }));
  }
  // codici stabili fra versioni (§19.16): stesso hash ⇒ stesso codice
  const prevByHash = new Map();
  let maxSeq = 0;
  for (const p of previous ?? []) {
    const m = /\.(\d{4,})$/.exec(p.id ?? "");
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]));
    if (!prevByHash.has(p.hash)) prevByHash.set(p.hash, []);
    prevByHash.get(p.hash).push(p.id);
  }
  const coded = sized.map((u) => {
    const hash = unitHash(u.text);
    const q = prevByHash.get(hash);
    return { u, hash, id: q?.length ? q.shift() : null };
  });
  for (const x of coded) if (!x.id) x.id = `U.${token}.${String(++maxSeq).padStart(4, "0")}`;
  const firstOfSection = new Map();
  const docLang = doc.lang ?? detectUnitLang(coded.slice(0, 200).map((x) => x.u.text).join(" "));
  const out = coded.map(({ u, hash, id }, i) => {
    const lang = detectUnitLang(u.text, docLang);
    const { section, text, type, ...rest } = u;
    if (!firstOfSection.has(section.path)) firstOfSection.set(section.path, id);
    return {
      id, doc: docRef, doc_id: doc.id, type, text, hash, words: wc(text), lang,
      context: { doc: docRef, chapter: section.chapter ?? null, section: section.title || null, section_path: section.path, page: section.page, lang,
        prev: i > 0 ? coded[i - 1].id : null, next: i < coded.length - 1 ? coded[i + 1].id : null },
      ...rest,
    };
  });
  // riferimenti fra unità: "vedi §2.1" → prima unità della sezione 2.1
  for (const u of out) {
    const refs = new Set();
    for (const m of u.text.matchAll(SECTION_REF)) { const target = firstOfSection.get(m[1]); if (target && target !== u.id) refs.add(target); }
    if (refs.size) u.refs_out = [...refs];
  }
  return { units: out, overflow };
}

function splitByWords(text, max) {
  const parts = [];
  let cur = [];
  let n = 0;
  for (const s of splitSentences(text)) {
    const k = wc(s);
    if (k > max) {
      if (cur.length) { parts.push(cur.join(" ")); cur = []; n = 0; }
      const ws = wordsOf(s);
      for (let i = 0; i < ws.length; i += max) parts.push(ws.slice(i, i + max).join(" "));
      continue;
    }
    if (n + k > max && cur.length) { parts.push(cur.join(" ")); cur = []; n = 0; }
    cur.push(s); n += k;
  }
  if (cur.length) parts.push(cur.join(" "));
  return parts;
}

export function describeRecord(r) {
  const label = { attribute: "Attributo", operation: "Operazione", endpoint: "Endpoint", property: "Proprietà" }[r.kind] ?? "Elemento";
  const bits = [`${label} ${r.name}`];
  if (r.path && r.kind !== "operation") bits.push(`percorso ${r.path}`);
  if (r.type) bits.push(`tipo ${r.type}`);
  if (r.required !== undefined && r.required !== null) bits.push(r.required ? "obbligatorio" : "facoltativo");
  if (r.min_occurs !== undefined) bits.push(`occorrenze ${r.min_occurs}..${r.max_occurs ?? "1"}`);
  if (r.length !== undefined) bits.push(`lunghezza ${r.length}`);
  if (r.max_length !== undefined) bits.push(`lunghezza massima ${r.max_length}`);
  if (r.pattern) bits.push(`pattern ${r.pattern}`);
  if (r.enumeration?.length) bits.push(`valori ${r.enumeration.join(", ")}`);
  if (r.method) bits.push(`${r.method} ${r.path ?? ""}`.trim());
  if (r.input) bits.push(`input ${r.input}`);
  if (r.output) bits.push(`output ${r.output}`);
  if (r.address) bits.push(`indirizzo ${r.address}`);
  if (r.parameters?.length) bits.push(`parametri ${r.parameters.map((p) => `${p.name}${p.required ? "*" : ""}`).join(", ")}`);
  if (r.documentation) bits.push(r.documentation);
  if (r.summary) bits.push(r.summary);
  return bits.join("; ");
}

export function tableRowText(headers, cells) {
  return headers.map((h, i) => {
    const v = cells[i];
    if (v === null || v === undefined || String(v).trim() === "") return null;
    return h ? `${h}: ${v}` : String(v);
  }).concat(cells.slice(headers.length).filter((v) => v !== null && v !== undefined && String(v).trim() !== "").map(String)).filter(Boolean).join(" | ");
}

function segmentTable(s, sec, t, ti, push, overflow) {
  const headers = t.headers ?? [];
  const rows = (t.rows ?? []).filter((r) => r && r.some((c) => c !== null && c !== undefined && String(c).trim() !== ""));
  const cols = recognizeFieldTable(headers);
  if (cols) {
    rows.forEach((cells, ri) => {
      if (isHeaderRepeat(cells, headers)) return;
      push(sec, { type: "riga-tabella-campi", text: tableRowText(headers, cells), row: { table: ti, row: ri, headers, cells, columns: cols } });
    });
    return;
  }
  const hi = headers.findIndex((h) => GLOSSARY_HEADERS.test(String(h).trim()));
  const di = headers.findIndex((h) => GLOSSARY_DEF.test(String(h).trim()));
  if (hi >= 0 && di >= 0) {
    rows.forEach((cells) => { if (cells[hi] && cells[di]) push(sec, { type: "definizione", text: `${cells[hi]}: ${cells[di]}`, term: String(cells[hi]).trim() }); });
    return;
  }
  let body = rows;
  if (rows.length > DATASET_ROWS) {
    body = rows.slice(0, MAX_TABLE_ROWS);
    overflow.push({ section: s.path, table: ti, rows_total: rows.length, rows_sampled: body.length,
      reason: `tabella-dataset di ${rows.length} righe: campione di ${body.length} righe, il resto (vocabolario/dati) resta nel documento normalizzato` });
  }
  const blocks = chunkEven(body, MAX_TABLE_ROWS);
  blocks.forEach((b, bi) => {
    const text = [t.caption ? `Tabella: ${t.caption}` : null, headers.some((h) => String(h).trim()) ? `Colonne: ${headers.join(" | ")}` : null, ...b.map((r) => tableRowText(headers, r))].filter(Boolean).join("\n");
    push(sec, { type: "tabella", text, table: { table: ti, headers, rows: b, block: bi + 1, blocks: blocks.length, ...(body !== rows ? { sample: true, rows_total: rows.length } : {}) } });
  });
  if (!blocks.length && headers.some((h) => String(h).trim())) push(sec, { type: "tabella", text: `Colonne: ${headers.join(" | ")}`, table: { table: ti, headers, rows: [], block: 1, blocks: 1 } });
}

const stepText = (p) => { const m = STEP_RE.exec(p); if (m) return m[4].trim(); const b = BULLET_RE.exec(p); return b ? b[1].trim() : p.trim(); };
const isStep = (x) => STEP_RE.test(x) || (BULLET_RE.test(x) && IMPERATIVE_RE.test(BULLET_RE.exec(x)[1].trim()));

function segmentProse(s, sec, push) {
  const paras = s.paragraphs ?? [];
  const lang = detectUnitLang(paras.slice(0, 20).join(" "));
  const decisions = new Set((s.records ?? []).filter((r) => r.kind === "decision").map((r) => r.text));
  // prosa descrittiva: un paragrafo = un'unità (stabilità fra versioni: una modifica tocca solo il suo paragrafo);
  // solo i frammenti consecutivi senza punto finale e < 12 parole (punti elenco delle diapositive) sono fusi, ≤ 120 parole
  let buffer = [];
  const fragment = (t) => wc(t) < 12 && !/[.!?:;]$/.test(t);
  const flushText = () => {
    let cur = [], n = 0, frag = false;
    for (const t of buffer) {
      const k = wc(t);
      if (cur.length && (!frag || !fragment(t) || n + k > 120)) { push(sec, { type: "testo", text: cur.join(" ") }); cur = []; n = 0; }
      cur.push(t); n += k; frag = fragment(t);
    }
    if (cur.length) push(sec, { type: "testo", text: cur.join(" ") });
    buffer = [];
  };
  for (let i = 0; i < paras.length; i++) {
    const p = paras[i];
    if (isStep(p) && i + 1 < paras.length && isStep(paras[i + 1])) {
      flushText();
      const steps = [];
      let j = i;
      while (j < paras.length && isStep(paras[j])) { steps.push(stepText(paras[j])); j++; }
      const prev = i > 0 ? paras[i - 1] : null;
      emitProcedure(sec, push, prev && /:\s*$/.test(prev) ? prev.replace(/:\s*$/, "") : s.title || null, steps);
      i = j - 1;
      continue;
    }
    const stamp = /^\[(\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d+)?)\]/.exec(p)?.[1] ?? null;
    const body = stamp ? p.replace(/^\[[^\]]+\]\s*/, "") : p;
    const extra = stamp ? { timestamp: stamp } : {};
    if (NOTE_RE.test(body)) { flushText(); push(sec, { type: "nota", text: body, ...(TACIT_ANY.test(body) ? { tacit: true } : {}), ...extra }); continue; }
    const sentences = splitSentences(body);
    let plain = [];
    const flushPlain = () => { if (plain.length) { buffer.push(plain.join(" ")); plain = []; } };
    const special = (u) => { flushPlain(); flushText(); push(sec, { ...u, ...extra }); };
    sentences.forEach((sent, k) => {
      if (decisions.has(sent)) return;                                   // già unità `decisione` dai record
      if (DECISION_RE2.test(sent)) return special({ type: "decisione", text: sent, decision: { author: s.meta?.from ?? null, date: s.meta?.date ?? null } });
      if (EXAMPLE_RE.test(sent) || (EXAMPLE_ANY.test(sent) && wc(sent) < 60)) return special({ type: "esempio", text: sent });
      const tacit = TACIT_ANY.test(sent);
      const rule = deonticRule(sent, lang);
      if (rule) {
        const prevSent = k > 0 ? sentences[k - 1] : null;
        if (PRONOMINAL.test(sent) && prevSent && plain[plain.length - 1] === prevSent) plain.pop();
        return special({ type: "regola", text: PRONOMINAL.test(sent) && prevSent ? `${prevSent} ${sent}` : sent, ...(tacit ? { tacit: true } : {}) });
      }
      if (tacit) return special({ type: "nota", text: sent, tacit: true });
      if ((REF_RE.test(sent) && wc(sent) <= 40) || (URL_RE.test(sent) && wc(sent) <= 25)) return special({ type: "riferimento", text: sent });
      const d = DEF_RE.exec(sent);
      if (d && k === 0 && wc(sent) <= 60 && !/\?$/.test(sent)) return special({ type: "definizione", text: sent, term: d[1].trim() });
      plain.push(sent);
    });
    flushPlain();
  }
  flushText();
}

function emitProcedure(sec, push, title, steps) {
  if (steps.length <= MAX_PROCEDURE_STEPS) {
    push(sec, { type: "procedura", text: `${title ? `${title}\n` : ""}${steps.map((x, k) => `${k + 1}. ${x}`).join("\n")}`, steps, procedure: { title } });
    return;
  }
  // spezzata in blocchi di ≤ 15 passi; il passo di confine appartiene a entrambe le parti
  const parts = [];
  for (let a = 0; a < steps.length - 1; a += MAX_PROCEDURE_STEPS - 1) parts.push({ from: a, list: steps.slice(a, a + MAX_PROCEDURE_STEPS) });
  parts.forEach((p, k) => push(sec, { type: "procedura", text: `${title ? `${title} (parte ${k + 1}/${parts.length})\n` : ""}${p.list.map((x, n) => `${p.from + n + 1}. ${x}`).join("\n")}`,
    steps: p.list, procedure: { title, part: k + 1, parts: parts.length, first_step: p.from + 1 } }));
  steps.forEach((x, n) => push(sec, { type: "passo", text: `${n + 1}. ${x}`, step: { n: n + 1, of: steps.length, procedure: title } }));
}
