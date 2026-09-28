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
import { validateWith } from "../lib/schemas.mjs";

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
