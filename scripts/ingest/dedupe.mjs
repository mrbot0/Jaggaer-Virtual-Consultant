// Deduplica dei campi (§19.6.4 passo 3, §19.12): lo stesso campo citato nel manuale
// d'uso e nella spec tecnica diventa UN campo con due fonti.
//
// Interfaccia:
//   normalizeLabel(s)          minuscole, senza accenti né punteggiatura, spazi compressi
//   normalizeTechnicalName(s)  maiuscole, separatori → "_"
//   levenshtein(a, b), labelDistance(a, b)  distanza di edit normalizzata sulle label normalizzate (0..1)
//   dedupe(rows, { threshold = 0.15 }) → { fields[], merge_candidates[], stats }
//     rows: righe grezze di scripts/ingest/field-table.mjs (anche di più documenti);
//     fields: { key, label, labels[], technical_name, section, sections[], type, mandatory_text,
//               allowed_values[], notes, sources[], conflicts[] }
//       - stesso technical_name (normalizzato) ⇒ stesso campo, qualunque sia la label; le fonti
//         si sommano (nessuna si perde); valori divergenti di tipo o testo di obbligatorietà
//         → conflicts[] (candidati CTR: manuale e spec divergono, §19.6.4 passo 5);
//     merge_candidates: { a, b, section, distance } — stessa sezione, distanza < threshold, non
//       entrambi con un nome tecnico (due nomi tecnici diversi sono due campi): mai fusi d'ufficio,
//       vanno al validatore (§19.12).
// Funzioni pure, nessun I/O.

export function normalizeLabel(s) {
  return String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function normalizeTechnicalName(s) {
  if (s === null || s === undefined) return null;
  const t = String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return t || null;
}

export function levenshtein(a, b) {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

export function labelDistance(a, b) {
  const x = normalizeLabel(a);
  const y = normalizeLabel(b);
  const m = Math.max(x.length, y.length);
  return m === 0 ? 0 : levenshtein(x, y) / m;
}

const normSection = (s) => String(s ?? "").trim().toLowerCase();
const normText = (s) => normalizeLabel(s ?? "");

function sourceOf(r) {
  return { document: r.document ?? null, section: r.section ?? null, source_unit: r.source_unit ?? null, row_ref: r.row_ref ?? null,
    genre: r.genre ?? null, label: r.label ?? null, type: r.type ?? null, mandatory_text: r.mandatory_text ?? "" };
}

function newField(r, key) {
  return { key, label: r.label, labels: [r.label], technical_name: normalizeTechnicalName(r.technical_name), section: r.section,
    sections: [r.section], type: r.type ?? null, mandatory_text: r.mandatory_text ?? "", allowed_values: [...(r.allowed_values ?? [])],
    notes: r.notes ?? null, sources: [sourceOf(r)], conflicts: [] };
}

function mergeInto(f, r) {
  f.sources.push(sourceOf(r));
  if (r.label && !f.labels.includes(r.label)) f.labels.push(r.label);
  if (r.section && !f.sections.includes(r.section)) f.sections.push(r.section);
  for (const v of r.allowed_values ?? []) if (!f.allowed_values.includes(v)) f.allowed_values.push(v);
  if (!f.notes && r.notes) f.notes = r.notes;
  if (!f.type && r.type) f.type = r.type;
  if (!f.mandatory_text && r.mandatory_text) f.mandatory_text = r.mandatory_text;
  for (const attribute of ["type", "mandatory_text"]) {
    const values = [...new Set(f.sources.map((s) => s[attribute]).filter((v) => v !== null && v !== "").map(String))];
    const distinct = new Set(values.map(normText));
    const existing = f.conflicts.find((c) => c.attribute === attribute);
    if (distinct.size > 1) {
      if (existing) existing.values = values; else f.conflicts.push({ attribute, values });
    }
  }
}

export function dedupe(rows, { threshold = 0.15 } = {}) {
  const fields = [];
  const byTech = new Map();
  let merged = 0;
  rows.forEach((r, i) => {
    const tech = normalizeTechnicalName(r.technical_name);
    if (tech && byTech.has(tech)) { mergeInto(byTech.get(tech), r); merged++; return; }
    const f = newField(r, tech ? `tech:${tech}` : `row:${normSection(r.section)}:${normalizeLabel(r.label)}:${i}`);
    fields.push(f);
    if (tech) byTech.set(tech, f);
  });
  const merge_candidates = [];
  const bySection = new Map();
  for (const f of fields) {
    const k = normSection(f.section);
    if (!bySection.has(k)) bySection.set(k, []);
    bySection.get(k).push(f);
  }
  for (const [, list] of bySection) {
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.technical_name && b.technical_name) continue;
        const d = labelDistance(a.label, b.label);
        if (d < threshold) merge_candidates.push({ a: a.key, b: b.key, labels: [a.label, b.label], section: a.section, distance: Math.round(d * 1e4) / 1e4 });
      }
    }
  }
  return { fields, merge_candidates, stats: { rows: rows.length, fields: fields.length, merged, merge_candidates: merge_candidates.length } };
}
