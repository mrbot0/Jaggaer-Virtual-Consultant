// Parser degli export di configurazione JAGGAER (XML/JSON) → documento normalizzato, §19.8 e §19.17.
// Un export è lo STATO REALE del tenant alla data dell'export: ogni parametro diventa una riga di una
// tabella (→ unità `tabella`/`riga-tabella-campi`), ogni elemento un record (sections[].records[]).
//
//   parseConfigExport(buffer, { id, title?, source?, exportedAt? }) → parsed-doc (meta.kind_hint)
//     radice XML riconosciuta:
//       ProcessDefinition          workflow-definition: impostazioni, passi (Step), attività (Activity: tipo,
//                                  passo, cartelle, regola), transizioni (ActivityRelationship) → candidati FLW
//       WorkflowFolderMessage      workflow-folders: cartelle (nome, tipo, robot) → candidati CFG/FLW
//       *Config (ReqConfig, POConfig, InvoiceConfig, …) e FormConfig
//                                  document-config / form-config: impostazioni del documento (parametro →
//                                  valore) → candidati CFG; elementi (campi) con gruppo, obbligatorietà dalle
//                                  convalide (Empty → Error) o IsRequired, sola lettura, lunghezza → candidati FLD;
//                                  liste (List/ListValue) → vocabolari chiusi
//       FormRequestTemplate        form-request-template: impostazioni e domande (etichetta, tipo, risposta
//                                  obbligatoria) → candidati FLD
//       altro XML o JSON           config-export generico: tabella percorso → valore delle foglie
// Le tabelle dei campi hanno intestazioni riconosciute da recognizeFieldTable (segment.mjs).
// CLI: node scripts/ingest/parse-config-export.mjs --in <file.xml|json> [--id <id>] [--out <file.json>] [--json]
import { parseXml, local, kids, kid, textOf, attr, XmlError } from "./lib/xml.mjs";
import { newDoc, newSection, finishDoc, oneLine, ParseError, sha256 } from "./lib/parsed.mjs";
import { runParserCli } from "./lib/cli.mjs";

const FIELD_HEADERS = ["Nome tecnico", "Campo", "Tipo", "Obbligatorio", "Gruppo", "Sola lettura", "Lunghezza massima", "Convalide", "Note"];
const PARAM_HEADERS = ["Parametro", "Valore"];

const isLeaf = (n) => kids(n).length === 0;
const val = (n, name) => { const k = kid(n, name); return k ? oneLine(textOf(k)) : null; };
const truthy = (v) => /^(true|yes|y|1|s[iì])$/i.test(String(v ?? "").trim());

// Impostazioni = figli foglia della radice (o di un nodo), nome → valore.
const STRUCTURAL = new Set(["Step", "Activity", "ActivityRelationship", "Element", "Group", "Section", "List", "Folder", "Question"]);
function settings(node) {
  const rows = [];
  for (const c of kids(node)) if (isLeaf(c) && !STRUCTURAL.has(local(c.name))) {
    const v = oneLine(textOf(c));
    const a = Object.entries(c.attrs).map(([k, x]) => `${k}=${x}`).join(" ");
    rows.push([local(c.name), v || a || ""]);
  }
  return rows;
}

function titleOf(n) {
  const th = kid(n, "TitleAndHelp");
  return th ? { title: val(th, "Title"), help: val(th, "HelpText") } : { title: null, help: null };
}

function workflowDefinition(root, doc) {
  const head = newSection({ path: "impostazioni", title: "Impostazioni del workflow", level: 1 });
  head.kind = "config-export";
  head.tables.push({ caption: "impostazioni", headers: PARAM_HEADERS, rows: settings(root) });
  const steps = newSection({ path: "passi", title: "Passi (Step)", level: 1 });
  steps.kind = "config-export";
  const stepRows = [];
  steps.records = [];
  for (const s of kids(root, "Step")) {
    const attrs = Object.fromEntries(kids(s, "Attribute").map((a) => [attr(a, "name") ?? "", oneLine(textOf(a))]));
    stepRows.push([attr(s, "name") ?? "", Object.entries(attrs).map(([k, v]) => `${k}: ${v}`).join("; ")]);
    steps.records.push({ kind: "step", name: attr(s, "name") ?? "", attributes: attrs });
  }
  steps.tables.push({ caption: "passi", headers: ["Passo", "Attributi"], rows: stepRows });
  const acts = newSection({ path: "attivita", title: "Attività (Activity)", level: 1 });
  acts.kind = "config-export";
  acts.records = [];
  const actRows = [];
  for (const a of kids(root, "Activity")) {
    const rec = {
      kind: "activity", name: attr(a, "name") ?? "", type: val(a, "ActivityType"),
      step: attr(kid(a, "StepRef"), "name") ?? null, folders: kids(a, "FolderRef").map((f) => attr(f, "name")).filter(Boolean),
      rule: oneLine(textOf(kid(a, "Rule"))) || null, folder_selection_rule: val(a, "FolderSelectionRule"),
      attributes: Object.fromEntries(kids(a, "Attribute").map((x) => [attr(x, "name") ?? "", oneLine(textOf(x))])),
    };
    acts.records.push(rec);
    actRows.push([rec.name, rec.type ?? "", rec.step ?? "", rec.folders.join(", "), rec.rule ?? "", rec.folder_selection_rule ?? ""]);
  }
  acts.tables.push({ caption: "attività", headers: ["Attività", "Tipo", "Passo", "Cartelle", "Regola", "Selezione cartella"], rows: actRows });
  const rel = newSection({ path: "transizioni", title: "Transizioni (ActivityRelationship)", level: 1 });
  rel.kind = "config-export";
  const relRows = kids(root, "ActivityRelationship").map((r) => [attr(r, "previous") ?? "", attr(r, "next") ?? "", Object.entries(r.attrs).filter(([k]) => !["previous", "next"].includes(k)).map(([k, v]) => `${k}=${v}`).join(" ")]);
  rel.records = relRows.map(([from, to]) => ({ kind: "transition", name: `${from} → ${to}`, from, to }));
  rel.tables.push({ caption: "transizioni", headers: ["Da", "A", "Condizione"], rows: relRows });
  doc.sections.push(head, steps, acts, rel);
  return "workflow-definition";
}

function workflowFolders(root, doc) {
  const sec = newSection({ path: "cartelle", title: "Cartelle del workflow", level: 1 });
  sec.kind = "config-export";
  const rows = kids(root, "Folder").map((f) => [attr(f, "name") ?? "", attr(f, "folderType") ?? "", val(f, "WorkflowType") ?? "", kids(f, "FolderRobot").map((r) => oneLine(textOf(r))).join(", ")]);
  sec.records = rows.map(([name, type, wf, robot]) => ({ kind: "folder", name, folder_type: type, workflow_type: wf, robot: robot || null }));
  sec.tables.push({ caption: "cartelle", headers: ["Cartella", "Tipo", "Workflow", "Robot"], rows });
  doc.sections.push(sec);
  return "workflow-folders";
}

function documentConfig(root, doc, kind) {
  const head = newSection({ path: "impostazioni", title: `Impostazioni (${local(root.name)})`, level: 1 });
  head.kind = "config-export";
  head.tables.push({ caption: "impostazioni", headers: PARAM_HEADERS, rows: settings(root) });
  doc.sections.push(head);
  const groups = new Map();
  for (const g of kids(root, "Group")) groups.set(attr(g, "id"), { name: val(g, "Name") ?? attr(g, "id"), title: titleOf(g).title, section: attr(kid(g, "SectionRef"), "id") ?? null });
  const sections = new Map();
  for (const s of kids(root, "Section")) sections.set(attr(s, "id"), { name: val(s, "Name") ?? attr(s, "id"), title: titleOf(s).title });
  if (groups.size || sections.size) {
    const lay = newSection({ path: "struttura", title: "Sezioni e gruppi del form", level: 1 });
    lay.kind = "config-export";
    lay.tables.push({ caption: "gruppi", headers: ["Gruppo", "Titolo", "Sezione"], rows: [...groups.entries()].map(([id, g]) => [g.name ?? id, g.title ?? "", sections.get(g.section)?.title ?? sections.get(g.section)?.name ?? g.section ?? ""]) });
    doc.sections.push(lay);
  }
  // campi per sezione del form (l'unità di segmentazione resta la sezione: ≤ 50 righe per lotto)
  const bySection = new Map();
  for (const e of kids(root, "Element")) {
    const id = attr(e, "id") ?? "";
    const g = groups.get(attr(kid(e, "GroupRef"), "id"));
    const secKey = g?.section ?? "senza-sezione";
    const vals = kids(e, "ElementValidation").map((v) => ({ event: attr(v, "event") ?? "", handling: kids(v, "ValidationEventHandling").map((h) => `${attr(h, "type") ?? ""}=${oneLine(textOf(h))}`) }));
    const empty = vals.find((v) => v.event === "Empty");
    const emptyError = empty?.handling.filter((h) => /=Error$/i.test(h)).map((h) => h.split("=")[0]) ?? [];
    const isReq = val(e, "IsRequired");
    let mandatory = "";
    if (isReq !== null) mandatory = truthy(isReq) ? "Sì" : "No";
    else if (emptyError.length) mandatory = `Obbligatorio in ${emptyError.join(", ")}`;
    else if (empty) mandatory = "No";
    const { title, help } = titleOf(e);
    const params = kids(kid(e, "UserDefinedFieldConfiguration"), "ConfigParam").map((p) => `${attr(p, "name")}=${oneLine(textOf(p))}`).filter((x) => !x.endsWith("="));
    const row = [
      val(e, "InternalName") ?? id, title ?? val(e, "InternalName") ?? id, val(e, "FieldType") ?? attr(e, "type") ?? "", mandatory,
      g?.title ?? g?.name ?? "", val(e, "IsReadOnly") ?? "", val(e, "MaxLength") ?? "",
      vals.filter((v) => v.handling.length).map((v) => `${v.event}: ${v.handling.join(", ")}`).join("; "),
      [help, params.join("; "), `id=${id}`, `tipo=${attr(e, "type") ?? ""}`].filter(Boolean).join(" · "),
    ];
    if (!bySection.has(secKey)) bySection.set(secKey, []);
    bySection.get(secKey).push({ row, record: { kind: "element", name: id, internal_name: val(e, "InternalName"), title, group: g?.name ?? null, element_type: attr(e, "type") ?? null, field_type: val(e, "FieldType"), mandatory, read_only: val(e, "IsReadOnly"), max_length: val(e, "MaxLength"), validations: vals } });
  }
  let n = 0;
  for (const [key, list] of bySection) {
    const sInfo = sections.get(key);
    const sec = newSection({ path: `campi-${++n}`, title: `Campi — ${sInfo?.title ?? sInfo?.name ?? key}`, level: 1 });
    sec.kind = "config-export";
    sec.tables.push({ caption: "campi", headers: FIELD_HEADERS, rows: list.map((x) => x.row) });
    sec.records = list.map((x) => x.record);
    doc.sections.push(sec);
  }
  const lists = kids(root, "List");
  if (lists.length) {
    const sec = newSection({ path: "liste", title: "Liste di valori", level: 1 });
    sec.kind = "config-export";
    sec.records = [];
    for (const l of lists) {
      const values = kids(l, "ListValue").map((v) => val(v, "InternalName") ?? val(v, "Description") ?? oneLine(textOf(v))).filter(Boolean);
      sec.records.push({ kind: "list", name: val(l, "InternalName") ?? attr(l, "id") ?? "", values });
      sec.tables.push({ caption: `lista ${val(l, "InternalName") ?? attr(l, "id")}`, headers: ["Lista", "Valori ammessi"], rows: [[val(l, "InternalName") ?? attr(l, "id") ?? "", values.join("; ")]] });
    }
    doc.sections.push(sec);
  }
  return kind;
}

function formRequestTemplate(root, doc) {
  const setup = kid(root, "Setup");
  const head = newSection({ path: "impostazioni", title: "Impostazioni del modello di richiesta", level: 1 });
  head.kind = "config-export";
  head.tables.push({ caption: "impostazioni", headers: PARAM_HEADERS, rows: [...(setup ? settings(setup) : []), ...Object.entries(setup?.attrs ?? {}).map(([k, v]) => [k, v])] });
  const instr = oneLine(textOf(kid(root, "Instructions")));
  if (instr) head.paragraphs.push(instr);
  doc.sections.push(head);
  let n = 0;
  const walk = (node, trail) => {
    for (const c of kids(node)) {
      const name = local(c.name);
      if (name === "QuestionPage" || name === "QuestionGroup") walk(c, [...trail, attr(c, "name") ?? name]);
      else if (name === "Questions" || name === "RequestContent") walk(c, trail);
    }
    const qs = kids(node, "Question");
    if (!qs.length) return;
    const sec = newSection({ path: `domande-${++n}`, title: `Domande — ${trail.join(" / ") || "modulo"}`, level: 1 });
    sec.kind = "config-export";
    const rows = qs.map((q) => [attr(q, "id") ?? "", val(q, "QuestionLabel") ?? val(q, "QuestionText") ?? "", val(q, "ResponseType") ?? "",
      val(q, "IsReponseRequired") ?? val(q, "IsResponseRequired") ?? "No", trail.join(" / "), "", "", "", val(q, "QuestionText") ?? ""]);
    sec.tables.push({ caption: "domande", headers: FIELD_HEADERS, rows: rows.map((r) => [r[0], r[1], r[2], truthy(r[3]) ? "Sì" : "No", r[4], r[5], r[6], r[7], r[8]]) });
    sec.records = rows.map((r) => ({ kind: "question", name: r[0], label: r[1], response_type: r[2], required: truthy(r[3]) }));
    doc.sections.push(sec);
  };
  walk(kid(root, "RequestContent") ?? root, []);
  return "form-request-template";
}

function genericXml(root, doc) {
  const rows = [];
  const walk = (n, path) => {
    const p = `${path}/${local(n.name)}${attr(n, "id") ? `[${attr(n, "id")}]` : attr(n, "name") ? `[${attr(n, "name")}]` : ""}`;
    if (isLeaf(n)) { rows.push([p, oneLine(textOf(n)) || Object.entries(n.attrs).map(([k, v]) => `${k}=${v}`).join(" ")]); return; }
    for (const c of kids(n)) walk(c, p);
  };
  walk(root, "");
  const sec = newSection({ path: "parametri", title: `Parametri (${local(root.name)})`, level: 1 });
  sec.kind = "config-export";
  sec.tables.push({ caption: "parametri", headers: PARAM_HEADERS, rows });
  doc.sections.push(sec);
  return "config-export";
}

function genericJson(obj, doc) {
  const rows = [];
  const walk = (v, p) => {
    if (v !== null && typeof v === "object") { for (const [k, x] of Object.entries(v)) walk(x, Array.isArray(v) ? `${p}[${k}]` : `${p}/${k}`); return; }
    rows.push([p || "/", v === null ? "" : String(v)]);
  };
  walk(obj, "");
  const sec = newSection({ path: "parametri", title: "Parametri (JSON)", level: 1 });
  sec.kind = "config-export";
  sec.tables.push({ caption: "parametri", headers: PARAM_HEADERS, rows });
  doc.sections.push(sec);
  return "config-export";
}

export function detectExportKind(rootName) {
  const n = local(rootName);
  if (n === "ProcessDefinition") return "workflow-definition";
  if (n === "WorkflowFolderMessage") return "workflow-folders";
  if (n === "FormConfig") return "form-config";
  if (n === "FormRequestTemplate") return "form-request-template";
  if (/Config$/.test(n)) return "document-config";
  return "config-export";
}

// Giro 1 (M9): la data dell'export (§19.8: "dopo un mese vale meno di un'osservazione") dall'XML/JSON se c'è
// (ExportDate, exportedAt, GeneratedOn, CreationDate… con una data ISO), altrimenti quella dichiarata dal chiamante,
// altrimenti la data del file (mtime) — la fonte è sempre dichiarata in meta.date_source.
const EXPORT_DATE_RE = /(?:export|generat|creat)\w*["']?\s*(?:=\s*["']|>|:\s*["'])\s*(\d{4}-\d{2}-\d{2})/i;
export function exportDate(text, { exportedAt = null, mtime = null } = {}) {
  const m = EXPORT_DATE_RE.exec(String(text).slice(0, 200000));
  if (m) return { date: m[1], source: "xml" };
  if (exportedAt) return { date: String(exportedAt).slice(0, 10), source: "dichiarata" };
  if (mtime) return { date: new Date(mtime).toISOString().slice(0, 10), source: "mtime" };
  return { date: null, source: null };
}

export function parseConfigExport(buffer, { id, title, source = null, exportedAt = null, mtime = null } = {}) {
  const text = Buffer.isBuffer(buffer) ? buffer.toString("utf8") : String(buffer);
  const trimmed = text.replace(/^[^<{[]*/, "");
  const isJson = /^[{[]/.test(trimmed);
  const doc = newDoc({ id, title, format: isJson ? "json" : "xml", source, parser: "parse-config-export" });
  doc.meta.sha256 = sha256(Buffer.from(text));
  doc.meta.size = Buffer.byteLength(text);
  const ed = exportDate(text, { exportedAt, mtime });
  doc.meta.exported_at = ed.date;
  doc.meta.dated = ed.date;
  doc.meta.date_source = ed.source;
  let kind;
  if (isJson) {
    let obj;
    try { obj = JSON.parse(trimmed); } catch (e) { throw new ParseError(`JSON non valido: ${e.message}`, { residue: "unsupported" }); }
    kind = genericJson(obj, doc);
  } else {
    let root;
    try { root = parseXml(text); } catch (e) { throw new ParseError(`XML non leggibile: ${e.message}`, { residue: "unsupported" }); }
    const k = detectExportKind(root.name);
    if (k === "workflow-definition") kind = workflowDefinition(root, doc);
    else if (k === "workflow-folders") kind = workflowFolders(root, doc);
    else if (k === "document-config" || k === "form-config") kind = documentConfig(root, doc, k);
    else if (k === "form-request-template") kind = formRequestTemplate(root, doc);
    else kind = genericXml(root, doc);
    const vd = val(root, "VersionDescription") ?? val(kid(root, "Setup"), "Title");
    if (!title && vd) doc.title = vd;
  }
  doc.meta.kind_hint = kind;
  return finishDoc(doc);
}

export const parse = parseConfigExport;
runParserCli(import.meta.url, { name: "parse-config-export", ext: ".xml", parse: parseConfigExport, errors: [XmlError] });
