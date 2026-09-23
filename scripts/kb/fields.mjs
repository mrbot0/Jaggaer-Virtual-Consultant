// Recupero dei campi in pochi token (§19.6.5): mai 800 campi in un contesto.
//
//   fields(db, { doc, mandatoryIn, company, chain, custom, reason, section, top = 50 })
//     → { items: [{ code, summary, document, section, technical_name, mandatory{kind,in_states,when,by_role},
//                   reason_kind, custom, transform? }], truncated, total }
//     doc          "requisition" o "document.requisition"
//     mandatoryIn  stato: kind always, oppure conditional/undocumented senza stati o con quello stato (never esclusi)
//     company      FLD il cui `when` cita la società, o senza condizione di società
//     chain        membri di un CL-FLD-CHAIN (cluster_members o cluster[] del file), in ordine di processo
//     custom       solo campi aggiunti dal cliente
//     reason       reason.kind; `ui` = obbligatori solo per la UI e SENZA ragione a valle (ADR-77: le domande)
//     section      sezione o sue sottosezioni
//   indexFieldModel(db, item)   (reindex) riga di `fields` per un FLD + archi lineage di FLD/INT/LCY
//                               in relations e field_lineage, sostituendo quelli della stessa fonte.
import { lineageRelations, writeRelations } from "./chains.mjs";
import { REASON_KINDS } from "./validate-fld.mjs";

export class InvalidInputError extends Error { constructor(m) { super(m); this.name = "InvalidInputError"; } }
export class NotFoundError extends Error { constructor(m) { super(m); this.name = "NotFoundError"; } }

const STATE_RE = /^[A-Z][A-Z0-9_]{0,63}$/;
const CODE_RE = /^[A-Za-z0-9_.-]{1,80}$/;
const COMPANY_COND = /\bcompany\b|societ/i;
const json = (v) => (v === undefined || v === null ? null : JSON.stringify(v));
const parse = (s) => (s === null || s === undefined ? null : JSON.parse(s));

// ——— indicizzazione (reindex) ———
export function indexFieldModel(db, obj) {
  if (obj.type === "FLD") {
    const m = obj.mandatory && typeof obj.mandatory === "object" ? obj.mandatory : {};
    const byRole = m.by_role === null || m.by_role === undefined ? null : Array.isArray(m.by_role) ? m.by_role : [m.by_role];
    db.prepare(`insert into fields(code,document,section,technical_name,label_it,label_en,field_type,mandatory_kind,in_states,when_cond,by_role,unless_cond,
      reason_kind,reason_ref,custom,key_ref,clusters,integration_relevance,identity,identity_quality)
      values (@code,@document,@section,@technical_name,@label_it,@label_en,@field_type,@mandatory_kind,@in_states,@when_cond,@by_role,@unless_cond,
      @reason_kind,@reason_ref,@custom,@key_ref,@clusters,@integration_relevance,@identity,@identity_quality)
      on conflict(code) do update set document=excluded.document, section=excluded.section, technical_name=excluded.technical_name,
      label_it=excluded.label_it, label_en=excluded.label_en, field_type=excluded.field_type, mandatory_kind=excluded.mandatory_kind,
      in_states=excluded.in_states, when_cond=excluded.when_cond, by_role=excluded.by_role, unless_cond=excluded.unless_cond,
      reason_kind=excluded.reason_kind, reason_ref=excluded.reason_ref, custom=excluded.custom, key_ref=excluded.key_ref,
      clusters=excluded.clusters, integration_relevance=excluded.integration_relevance, identity=excluded.identity, identity_quality=excluded.identity_quality`)
      .run({ code: obj.id, document: obj.document ?? null, section: obj.section ?? null, technical_name: obj.technical_name ?? null,
        label_it: obj.label?.it ?? null, label_en: obj.label?.en ?? null, field_type: obj.field_type ?? null, mandatory_kind: m.kind ?? null,
        in_states: json(m.in_states?.length ? m.in_states : null), when_cond: m.when ?? null, by_role: json(byRole), unless_cond: m.unless ?? null,
        reason_kind: m.reason?.kind ?? null, reason_ref: m.reason?.ref ?? null, custom: obj.custom ? 1 : 0, key_ref: obj.key_ref ?? null,
        clusters: json(obj.cluster ?? []), integration_relevance: obj.integration_relevance ?? null, identity: json(obj.identity ?? null),
        identity_quality: json(obj.identity_quality ?? null) });
  }
  replaceLineage(db, obj.id, lineageRelations(obj));
}

// Gli archi dichiarati da una fonte si sostituiscono in blocco; un arco resta in relations
// finché almeno una fonte lo dichiara.
export function replaceLineage(db, source, relations) {
  const old = db.prepare("select from_code, to_code, kind from field_lineage where source_code = ?").all(source);
  db.prepare("delete from field_lineage where source_code = ?").run(source);
  const still = db.prepare("select 1 from field_lineage where from_code = ? and to_code = ? and kind = ? limit 1");
  const del = db.prepare("delete from relations where from_code = ? and to_code = ? and kind = ?");
  for (const o of old) if (!still.get(o.from_code, o.to_code, o.kind)) del.run(o.from_code, o.to_code, o.kind);
  if (relations.length) writeRelations(db, relations.map((r) => ({ ...r, detail: { ...r.detail, source } })));
}

export function needsFieldIndex(db, obj) {
  if (obj.type === "FLD" && !db.prepare("select 1 from fields where code = ?").get(obj.id)) return true;
  return lineageRelations(obj).length > 0 && !db.prepare("select 1 from field_lineage where source_code = ? limit 1").get(obj.id);
}

// ——— recupero ———
function processOrder(db, codes) {
  if (codes.length < 2) return { order: codes, transform: new Map() };
  const set = new Set(codes);
  const ph = codes.map(() => "?").join(",");
  const edges = db.prepare(`select r.from_code, r.to_code, r.kind, (select transform from field_lineage l where l.from_code = r.from_code and l.to_code = r.to_code
    and l.kind = r.kind limit 1) as transform from relations r where r.kind in ('propagates_to','derived_from') and r.from_code in (${ph}) and r.to_code in (${ph})`)
    .all(...codes, ...codes);
  const dir = [];
  const transform = new Map();
  for (const e of edges) {
    if (e.kind === "propagates_to") { dir.push([e.from_code, e.to_code]); if (e.transform) transform.set(e.to_code, e.transform); }
    else dir.push([e.to_code, e.from_code]);
  }
  const indeg = new Map(codes.map((c) => [c, 0]));
  const next = new Map(codes.map((c) => [c, []]));
  const seen = new Set();
  for (const [a, b] of dir) {
    const k = `${a}>${b}`;
    if (seen.has(k) || !set.has(a) || !set.has(b) || a === b) continue;
    seen.add(k); next.get(a).push(b); indeg.set(b, indeg.get(b) + 1);
  }
  const q = codes.filter((c) => indeg.get(c) === 0).sort();
  const order = [];
  while (q.length) {
    const n = q.shift(); order.push(n);
    for (const m of next.get(n)) { indeg.set(m, indeg.get(m) - 1); if (!indeg.get(m)) { q.push(m); q.sort(); } }
  }
  for (const c of [...codes].sort()) if (!order.includes(c)) order.push(c);
  return { order, transform };
}

export function fields(db, { doc, mandatoryIn, company, chain, custom, reason, section, top = 50 } = {}) {
  const n = Number(top);
  if (!Number.isInteger(n) || n < 1 || n > 1000) throw new InvalidInputError(`--top: intero fra 1 e 1000 (${top})`);
  if (mandatoryIn !== undefined && !STATE_RE.test(String(mandatoryIn))) throw new InvalidInputError(`--mandatory-in: stato non valido (${mandatoryIn})`);
  if (reason !== undefined && !REASON_KINDS.includes(reason)) throw new InvalidInputError(`--reason: una di ${REASON_KINDS.join(", ")}`);
  if (company !== undefined && !/^[A-Za-z0-9_-]{1,20}$/.test(String(company))) throw new InvalidInputError(`--company: codice società non valido (${company})`);
  for (const [k, v] of [["doc", doc], ["chain", chain], ["section", section]]) if (v !== undefined && !CODE_RE.test(String(v))) throw new InvalidInputError(`--${k}: valore non valido (${v})`);
  const where = ["i.status <> 'deprecato'"];
  const args = [];
  if (doc) { where.push("(f.document = ? or f.document = 'document.' || ?)"); args.push(doc, doc); }
  if (section) { where.push("(f.section = ? or f.section like ? || '.%')"); args.push(section, section); }
  if (mandatoryIn) {
    where.push(`(f.mandatory_kind = 'always' or (f.mandatory_kind in ('conditional','undocumented') and (f.in_states is null
      or exists (select 1 from json_each(f.in_states) s where s.value = ?))))`);
    args.push(mandatoryIn);
  }
  if (custom) where.push("f.custom = 1");
  if (reason) {
    where.push("f.reason_kind = ?"); args.push(reason);
    if (reason === "ui") where.push("not exists (select 1 from relations r where r.from_code = f.code and r.kind in ('required_by','propagates_to'))");
  }
  if (chain) {
    where.push("(f.code in (select item_code from cluster_members where cluster_code = ?) or exists (select 1 from json_each(f.clusters) c where c.value = ?))");
    args.push(chain, chain);
  }
  let rows = db.prepare(`select f.code, i.summary, f.document, f.section, f.technical_name, f.mandatory_kind, f.in_states, f.when_cond, f.by_role, f.unless_cond,
    f.reason_kind, f.custom from fields f join items i on i.code = f.code where ${where.join(" and ")} order by f.document, f.section, f.code`).all(...args);
  if (company) {
    const re = new RegExp(`(^|[^A-Za-z0-9_])${company.replace(/[-]/g, "\\-")}([^A-Za-z0-9_]|$)`);
    rows = rows.filter((r) => !r.when_cond || !COMPANY_COND.test(r.when_cond) || re.test(r.when_cond));
  }
  let transform = new Map();
  if (chain) {
    const po = processOrder(db, rows.map((r) => r.code));
    const pos = new Map(po.order.map((c, i) => [c, i]));
    rows.sort((a, b) => pos.get(a.code) - pos.get(b.code));
    transform = po.transform;
  }
  const total = rows.length;
  const items = rows.slice(0, n).map((r) => {
    const mandatory = { kind: r.mandatory_kind };
    if (r.in_states) mandatory.in_states = parse(r.in_states);
    if (r.when_cond) mandatory.when = r.when_cond;
    if (r.by_role) mandatory.by_role = parse(r.by_role);
    if (r.unless_cond) mandatory.unless = r.unless_cond;
    const out = { code: r.code, summary: r.summary, document: r.document, section: r.section, technical_name: r.technical_name, mandatory,
      reason_kind: r.reason_kind, custom: !!r.custom };
    if (chain) out.transform = transform.get(r.code) ?? null;
    return out;
  });
  return { items, truncated: total > n, total };
}
