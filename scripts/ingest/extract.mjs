// Pre-estrazione deterministica T0 (§19.10): l'extractor non riassume, INTERROGA le unità con uno schema fisso per
// tipo (schemas/unit-extraction/<tipo>.schema.json). Ciò che si estrae con regole lessicali è estratto qui; ciò
// che non si può è marcato `needs_llm: true` (con i campi mancanti) per lo scope-extractor (T1).
//
//   extractUnit(unit, { genre, f1, origin }) → item grezzo | null
//     procedura → passi (verbo, oggetto, valore), attore/risultato se espliciti          candidato FLW
//     riga-tabella-campi → riga grezza di field-table (testo di obbligatorietà verbatim)  candidato FLD
//     regola → uscita di deontic.parseRule + soggetto                                      KEY/LCY/INV/FLD (consequence)
//     nota → tipo, regole contenute, soggetto                                              CFG/INV/FLD
//     definizione → termine, definizione, alias                                            GLS
//     tracciato → elemento formale (obbligatorietà tecnica)                                INT/FLD di integrazione
//     decisione → decisione, data, autore                                                  L (dichiarazione-utente)
//     schermata → campi osservati (etichette, required, opzioni)                           FLD (L) / CFG.current_state
//     i tipi di contesto (testo, esempio, riferimento, figura, passo, tabella generica) NON diventano item grezzi:
//     restano fonti per la digestione guidata (kb units --query, §19.11)
//   documentCandidates(doc, units, raw, { profile }) → candidati di documento:
//     export di configurazione: FLW dal workflow_definition (attività in ordine di transizione), CFG per parametro
//       (current_state = valore all'export, confidenza 0.95), CFG per cartella del workflow;
//     spec di integrazione (dev kit, XSD/WSDL/OpenAPI): INT con protocollo, endpoint, operazioni, mapping
//       { field_ref, target, mandatory } verso i FLD di integrazione (che ricevono lineage.required_by → INT),
//       catalogo degli errori dalle tabelle codice/descrizione. Forma provvisoria per chains.mjs: vedi docs/phase-reports/F1-tooling.md.
//   typeHint(unit, raw) → { candidates[], dt020 } (DT-020 valutata a T0 con i segnali deterministici)
//   extractDocument(doc, units, { profile, scope }) → { items[], stats, llm_plan }
//   planLlm(items, { budget = 80000, unitBudget = 3000, batchMax = 20 }) → sessioni di lotti ≤ budget (§29.10)
//   writeRaw(inboxScopeDir, docCode, result) → _inbox/<scope>/raw/<DOCID>.yaml (solo _inbox, §29.6)
// CLI: node scripts/ingest/extract.mjs --units <units.json> --doc <parsed.json> --profile <DOC.yaml> --root <ws> [--scope S] [--customer C] [--json]
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { parseRule } from "./deontic.mjs";
import { extractFieldRows } from "./field-table.mjs";
import { docIdToken, recognizeFieldTable } from "./segment.mjs";
import { estimateTokens } from "./lib/parsed.mjs";
import { evaluate, loadTable } from "../decide/dt-eval.mjs";
import { validateWith } from "../lib/schemas.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { SCOPES } from "../kb/codes.mjs";
import { workspacePaths } from "./lib/paths.mjs";

export const EXTRACTABLE = new Set(["procedura", "riga-tabella-campi", "regola", "nota", "definizione", "tracciato", "decisione", "schermata"]);
export const CONTEXT_TYPES = new Set(["testo", "esempio", "riferimento", "figura", "passo", "tabella"]);
export const DOC_BUDGET = 80000;
export const UNIT_BUDGET = 3000;
export const LLM_OVERHEAD = 350;   // istruzioni + schema per unità nel lotto dello scope-extractor

let DT020 = null;
const dt020 = () => (DT020 ??= loadTable("DT-020"));

// ---------------------------------------------------------------- soggetto di una regola
const ARTICLE = /^(?:il|lo|la|l'|i|gli|le|un|una|uno|the|a|an)\s+/i;
const SUBJECT_PATTERNS = [
  /\b(?:il|lo|la|l')?\s*campo\s+[«"“']?([^»"”',.;:]{2,60}?)[»"”']?\s+(?:deve|devono|non|va|vanno|è|sono|può|possono|viene|risulta|diventa)\b/i,
  /\bthe\s+[«"“']?([\w][\w /-]{1,50}?)[»"”']?\s+field\b/i,
  /\bfield\s+[«"“']([^"”'»]{2,60})[»"”']/i,
  /\bcampo\s+[«"“']([^"”'»]{2,60})[»"”']/i,
];
const MODAL = /\s+(?:non\s+)?(?:deve|devono|dovrebbe|dovrebbero|può|possono|va|vanno|è|sono|viene|vengono|risulta)\b|\s+(?:must|should|shall|cannot|can|may|is|are|will|has to|have to|needs? to)\b/i;
export function ruleSubject(text) {
  for (const re of SUBJECT_PATTERNS) { const m = re.exec(text); if (m) return m[1].trim(); }
  const main = String(text).replace(/^(?:se|qualora|quando|nel caso in cui|in caso di|if|when|once|unless|salvo)\b[^,]*,\s*/i, "");
  const m = MODAL.exec(main);
  if (!m || m.index < 2) return null;
  const subj = main.slice(0, m.index).replace(ARTICLE, "").replace(/[,:;]+$/, "").trim();
  const n = subj.split(/\s+/).length;
  return n >= 1 && n <= 8 ? subj : null;
}

// ---------------------------------------------------------------- procedura
const ACTOR_RE = /\b(l'amministratore|l'amministratore di sistema|il buyer|l'acquirente|il richiedente|l'approvatore|il fornitore|l'utente|the (?:system )?administrator|the buyer|the requester|the requestor|the approver|the supplier|the user|admin(?:istrator)?s?|buyers?|requesters?|approvers?)\b/i;
const RESULT_RE = /\b(viene (?:creat|salvat|inviat|mostrat|visualizzat)\w*|compare|appare|risulta|si apre|is (?:created|saved|sent|displayed|shown)|appears|opens|will be)\b/i;
const QUOTED = /[«"“']([^"”»']{1,80})[»"”']/;
export function stepParts(step, n) {
  const s = String(step).trim().replace(/[.;]+$/, "");
  const click = /^(fare clic su|fai clic su|cliccare su|clicca su|click on|click)\s+(.+)$/i.exec(s);
  if (click) return { n, verbo: "clic", oggetto: click[2].trim(), valore: QUOTED.exec(s)?.[1] ?? null };
  const [verbo, ...rest] = s.split(/\s+/);
  return { n, verbo: verbo.toLowerCase(), oggetto: rest.join(" ") || s, valore: QUOTED.exec(s)?.[1] ?? (/:\s*(.+)$/.exec(s)?.[1] ?? null) };
}

// ---------------------------------------------------------------- estrazione per unità
const NOTE_KIND = (t) => /^(attenzione|warning|caution)/i.test(t) ? "attenzione" : /^(importante|important)/i.test(t) ? "importante" : /^(suggerimento|tip|hint)/i.test(t) ? "suggerimento" : "nota";
const splitSent = (t) => String(t).split(/(?<=[.!?;])\s+/).filter(Boolean);

function rawBase(unit, ctx) {
  return { raw_id: unit.id.replace(/^U\./, "R."), source_unit: unit.id, unit_type: unit.type, doc: unit.doc, section: unit.context?.section ?? null,
    page: unit.context?.page ?? null, lang: unit.lang, facets: { F1: ctx.f1 ?? null, F15: ctx.genre ?? null } };
}

export function extractUnit(unit, ctx = {}) {
  if (!EXTRACTABLE.has(unit.type)) return null;
  const b = rawBase(unit, ctx);
  const missing = [];
  let extraction;
  let candidates;
  switch (unit.type) {
    case "procedura": {
      const passi = (unit.steps ?? []).map((s, i) => stepParts(s, (unit.procedure?.first_step ?? 1) + i));
      const attore = ACTOR_RE.exec(unit.text)?.[1] ?? null;
      const lastRes = (unit.steps ?? []).map((s) => (RESULT_RE.test(s) ? s : null)).filter(Boolean).pop() ?? null;
      extraction = { attore, trigger: null, precondizioni: [], passi, risultato_atteso: lastRes, eccezioni: [], figure: [], oggetti_toccati: [], source_unit: unit.id };
      if (!attore) missing.push("attore");
      missing.push("trigger");
      if (!lastRes) missing.push("risultato_atteso");
      candidates = passi.some((p) => /^(configurare|impostare|abilitare|disabilitare|attivare|configure|enable|disable|set)$/.test(p.verbo)) ? ["CFP", "FLW"] : ["FLW"];
      break;
    }
    case "riga-tabella-campi": {
      const r = unit.row;
      const [row] = extractFieldRows({ id: unit.id, document: unit.doc, section: unit.context?.section_path ?? null, rows: [{ table: r.table, row: r.row, cells: r.cells, columns: r.columns }] }, { genre: ctx.genre ?? null });
      if (!row) return null;
      extraction = { ...row, source_unit: unit.id };
      candidates = ["FLD"];
      break;
    }
    case "regola": {
      const p = parseRule(unit.text, { lang: unit.lang });
      const subject = ruleSubject(unit.text);
      extraction = { subject, modality: p.modality, condition: p.condition ?? null, exception: p.exception ?? null, scope_qualifiers: p.scope_qualifiers,
        consequence: p.consequence, confidence: p.confidence, signals: p.signals, source_unit: unit.id };
      if (p.mandatory) extraction.mandatory = p.mandatory;
      if (p.validation) extraction.validation = p.validation;
      if (p.reason) extraction.reason = p.reason;
      if (!subject) missing.push("subject");
      if (p.modality === "ambiguo") b.residue = { class: "ambiguous", reason: `modalità deontica non determinata (${p.signals.join(", ")})` };
      if (unit.system_message) extraction.validation = { on_fail: unit.severity === "warning" ? "warn" : "block", message: unit.text, observed: true };
      candidates = ({ "FLD.mandatory": ["FLD"], "FLD.validation": ["FLD", "ERR"], INV: ["INV"], "LCY.immutable_fields_after": ["LCY"], "KEY.cross_system": ["KEY"], "FLD.notes": ["FLD"], residue: [] })[p.consequence] ?? ["INV"];
      break;
    }
    case "nota": {
      const rules = splitSent(unit.text).map((s) => parseRule(s, { lang: unit.lang })).filter((r) => r.modality !== "ambiguo" || !r.signals.every((x) => x === "nessun segnale deontico"))
        .map((r) => ({ text: r.text, modality: r.modality, consequence: r.consequence, ...(r.mandatory ? { mandatory: r.mandatory } : {}) }));
      const kind = unit.tacit ? "tacita" : unit.source_kind ?? NOTE_KIND(unit.text);
      extraction = { kind, text: unit.text, subject: ruleSubject(unit.text), rules, author: unit.comment?.author ?? unit.revision?.author ?? null, date: unit.comment?.date ?? unit.revision?.date ?? null, source_unit: unit.id };
      if (!extraction.subject) missing.push("subject");
      if (unit.tacit) b.residue = { class: "tacit", reason: "conoscenza tacita (\"di solito facciamo così\"): candidato L a 0.60 e domanda di apprendimento" };
      candidates = rules.length ? ["INV", "CFG", "FLD"] : ["CFG", "FLD"];
      break;
    }
    case "definizione": {
      const m = /^(.{1,80}?)\s*(?::|\s(?:è|sono|indica|rappresenta|si intende|significa|identifica|is|are|means|refers to|represents|denotes|identifies))\s+(.+)$/i.exec(unit.text);
      const term = unit.term ?? m?.[1]?.replace(/^(?:il|lo|la|l'|i|gli|le|un|una|the|a|an)\s+/i, "").trim() ?? null;
      const definition = m?.[2]?.trim() ?? unit.text;
      extraction = { term: term ?? unit.text.slice(0, 40), definition, aliases: [], lang: unit.lang, source_unit: unit.id };
      const acr = /\(([A-Z][A-Za-z0-9]{1,8})\)/.exec(unit.text);
      if (acr) extraction.aliases.push(acr[1]);
      if (!term) missing.push("term");
      candidates = ["GLS"];
      break;
    }
    case "tracciato": {
      const r = unit.record ?? {};
      extraction = { element: r.name ?? unit.text.slice(0, 60), kind: r.kind ?? "element", path: r.path ?? null, type: r.type ?? null, required: r.required ?? null,
        min_occurs: typeof r.min_occurs === "number" ? r.min_occurs : null, max_occurs: r.max_occurs ?? null, length: r.length ?? null, min_length: r.min_length ?? null,
        max_length: r.max_length ?? null, pattern: r.pattern ?? null, enumeration: r.enumeration ?? [], operation: r.kind === "operation" ? r.name : null, documentation: r.documentation ?? null, source_unit: unit.id };
      candidates = ["operation", "endpoint"].includes(r.kind) ? ["INT"] : ["FLD"];
      break;
    }
    case "decisione": {
      extraction = { decision: unit.text, date: unit.decision?.date ?? null, author: unit.decision?.author ?? null, subject: ruleSubject(unit.text), source_unit: unit.id };
      if (!extraction.subject) missing.push("subject");
      candidates = ["CFG", "FLD", "CTR"];
      break;
    }
    case "schermata": {
      const els = unit.record?.elements ?? [];
      extraction = { page: unit.context?.section ?? null, fields: els.filter((e) => e.kind === "field").map((e) => ({ label: e.name, type: e.type ?? null, required: e.required ?? null, options: e.options ?? [], section: e.section ?? null })),
        buttons: els.filter((e) => e.kind === "button").map((e) => e.name), tabs: els.filter((e) => e.kind === "tab").map((e) => e.name), image: unit.record?.image ?? null, source_unit: unit.id };
      candidates = ["FLD", "CFG"];
      break;
    }
    default: return null;
  }
  const schemaName = unit.type === "schermata" ? null : `unit-extraction/${unit.type}.schema.json`;
  if (schemaName) {
    const v = validateWith(schemaName, extraction);
    if (!v.ok) { missing.push(...v.errors.map((e) => `schema: ${e}`)); }
  }
  const hint = typeHint(unit, candidates);
  return { ...b, candidates, type_hint: hint, extraction, needs_llm: missing.length > 0, ...(missing.length ? { missing } : {}), tokens: estimateTokens(unit.text) };
}

// DT-020 a T0: segnali deterministici (posizione, forma, lessico, nome tecnico, sistema esterno) per il primo candidato.
const SETUP_SEC = /setup|impostazion|configur|admin|parametr|settings/i;
const PROC_SEC = /procedur|come |how to|creare|creating|steps?/i;
const CONFIG_VERBS = /\b(configur|impost|abilit|disabilit|attiv|parametr|enable|disable|configure|set up|setting)/i;
const EXT_RE = /\b(sap|erp|oracle|dynamics|middleware|web service|api|ftp|interfacc|integration|integrazion)\b/i;
export function typeHint(unit, candidates) {
  const cand = candidates?.[0];
  if (!cand) return { candidates: [], outcome: null, score: null };
  const sec = `${unit.context?.chapter ?? ""} ${unit.context?.section ?? ""}`;
  const inputs = {
    candidate_type: cand,
    position: (cand === "CFG" && SETUP_SEC.test(sec)) || (cand === "FLW" && PROC_SEC.test(sec)) || (cand === "FLD" && unit.type === "riga-tabella-campi") || (cand === "INT" && unit.type === "tracciato"),
    unit_form: (cand === "FLW" && unit.type === "procedura") || (["KEY", "LCY", "INV", "FLD"].includes(cand) && unit.type === "regola") || (["INT", "FLD"].includes(cand) && unit.type === "tracciato") || (cand === "FLD" && unit.type === "riga-tabella-campi") || (cand === "GLS" && unit.type === "definizione"),
    lexicon: cand === "CFG" ? CONFIG_VERBS.test(unit.text) : cand === "FLW" ? !CONFIG_VERBS.test(unit.text) : unit.type !== "testo",
    technical_name: /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b|\b[a-z]+[A-Z]\w+\b/.test(unit.text) || !!unit.row?.columns?.technical_name,
    external_ref: cand === "INT" || cand === "KEY" ? EXT_RE.test(unit.text) : !EXT_RE.test(unit.text),
  };
  try { const r = evaluate(dt020(), inputs); return { candidates, outcome: r.outcome, score: r.score }; }
  catch { return { candidates, outcome: null, score: null }; }
}

// ---------------------------------------------------------------- candidati di documento
const PROTOCOL_RE = [["REST", /\bREST(?:ful)?\b|\/api\/|\bGET\b|\bPOST\b/], ["SOAP", /\bSOAP\b|\bWSDL\b/], ["JSON", /\bJSON\b/], ["XML", /\bXML\b/], ["FTP", /\bS?FTP\b/], ["cXML", /\bcXML\b/]];
const URL_RE = /(?:https?:\/\/[^\s"'<>|]+|\/[a-z0-9_-]+\/(?:[a-z0-9_{}.-]+\/)*[a-z0-9_{}.-]+)/gi;
export function documentCandidates(doc, units, raw, { profile = null } = {}) {
  const out = [];
  const docCode = profile?.id ?? units[0]?.doc ?? doc.id;
  const token = docIdToken(docCode);
  const hint = doc.meta?.kind_hint ?? "";
  const kind = profile?.kind ?? null;
  const exportedAt = doc.meta?.exported_at ?? doc.meta?.dated ?? null;
  const facets = { F1: profile?.facets?.F1 ?? null, F15: profile?.genre ?? null };
  let n = 0;
  const id = (t) => `R.${token}.${t}${String(++n).padStart(3, "0")}`;
  const unitsBySection = new Map();
  for (const u of units) { if (!unitsBySection.has(u.context.section_path)) unitsBySection.set(u.context.section_path, []); unitsBySection.get(u.context.section_path).push(u); }
  if (kind === "config-export" || /^(workflow|document|form)/.test(hint)) {
    // CFG per parametro (tabelle "Parametro | Valore"), current_state all'export
    for (const s of doc.sections) {
      for (const t of s.tables ?? []) {
        if (!(t.headers?.[0] === "Parametro" && t.headers?.[1] === "Valore")) continue;
        const tu = (unitsBySection.get(s.path) ?? []).filter((u) => u.type === "tabella");
        t.rows.forEach((r, ri) => {
          if (!r[0]) return;
          const src = tu.find((u) => (u.table?.rows ?? []).some((x) => x[0] === r[0] && x[1] === r[1]))?.id ?? tu[0]?.id ?? null;
          out.push({ raw_id: id("C"), candidates: ["CFG"], doc: docCode, section: s.title, source_unit: src, facets, extraction: { parameter: String(r[0]), current_state: { value: r[1] ?? null, observed_at: exportedAt, source: "config-export" }, export_kind: hint || null }, confidence: 0.95, needs_llm: true, missing: ["location", "options", "dependencies", "impacts", "risk", "rollback"] });
        });
      }
      if (s.path === "cartelle") for (const f of s.records ?? []) out.push({ raw_id: id("C"), candidates: ["CFG"], doc: docCode, section: s.title, source_unit: (unitsBySection.get(s.path) ?? [])[0]?.id ?? null, facets, extraction: { parameter: `workflow folder ${f.name}`, current_state: { value: { type: f.folder_type, workflow: f.workflow_type, robot: f.robot }, observed_at: exportedAt, source: "config-export" } }, confidence: 0.95, needs_llm: true, missing: ["impacts", "risk", "rollback"] });
    }
    if (hint === "workflow-definition") {
      const acts = doc.sections.find((s) => s.path === "attivita")?.records ?? [];
      const rels = doc.sections.find((s) => s.path === "transizioni")?.records ?? [];
      const next = new Map(rels.map((r) => [r.from, r.to]));
      const targets = new Set(rels.map((r) => r.to));
      const order = [];
      let cur = acts.find((a) => !targets.has(a.name))?.name ?? acts[0]?.name;
      const seen = new Set();
      while (cur && !seen.has(cur)) { seen.add(cur); order.push(cur); cur = next.get(cur); }
      for (const a of acts) if (!seen.has(a.name)) order.push(a.name);
      const byName = new Map(acts.map((a) => [a.name, a]));
      const steps = order.map((nm, i) => { const a = byName.get(nm) ?? { name: nm }; return { n: i + 1, attivita: nm, tipo: a.type ?? null, passo: a.step ?? null, cartelle: a.folders ?? [], condizione: a.rule ?? null }; });
      const wt = doc.sections[0]?.tables?.[0]?.rows?.find((r) => r[0] === "WorkflowType")?.[1] ?? null;
      out.push({ raw_id: id("F"), candidates: ["FLW"], doc: docCode, section: "attività", source_unit: (unitsBySection.get("attivita") ?? [])[0]?.id ?? null, facets,
        extraction: { workflow_type: wt, steps, transitions: rels.map((r) => ({ from: r.from, to: r.to })), exported_at: exportedAt }, confidence: 0.95, needs_llm: true, missing: ["actor", "trigger", "postconditions", "compensation", "evidence"] });
    }
  }
  if (kind === "spec-integrazione") {
    const text = units.map((u) => u.text).join("\n");
    const protocol = [...new Set([...(doc.format === "wsdl" ? ["SOAP"] : doc.format === "openapi" ? ["REST"] : []), ...PROTOCOL_RE.filter(([, re]) => re.test(text)).map(([p]) => p)])];
    const endpoints = [...new Set((text.match(URL_RE) ?? []).filter((u) => /api|ws|service|jint|esop|\/v\d/i.test(u)).map((u) => u.replace(/[).,;]+$/, "")))].slice(0, 50);
    const operations = raw.filter((r) => r.unit_type === "tracciato" && ["operation", "endpoint"].includes(r.extraction?.kind)).map((r) => r.extraction.element);
    const fldRaw = raw.filter((r) => (r.unit_type === "riga-tabella-campi") || (r.unit_type === "tracciato" && !["operation", "endpoint"].includes(r.extraction?.kind)));
    const intId = id("I");
    const mappings = fldRaw.map((r) => {
      const e = r.extraction;
      const target = e.technical_name ?? e.path ?? e.element ?? e.label;
      const mand = r.unit_type === "tracciato" ? e.required === true : /^(s[iì]|y|yes|x|true|m|mandatory|required|obbligatorio)$/i.test(String(e.mandatory_text ?? "").trim());
      return { field_ref: r.raw_id, target, mandatory: mand };
    });
    for (const r of fldRaw) (r.lineage ??= { required_by: [] }).required_by.push({ ref: intId, mandatory_there: mappings.find((m) => m.field_ref === r.raw_id)?.mandatory ?? null });
    const errors = [];
    for (const u of units.filter((x) => x.type === "tabella" && /error|errore|code|codice|status/i.test(`${x.context.section} ${x.table?.headers?.join(" ")}`))) {
      const h = u.table?.headers ?? [];
      const ci = h.findIndex((x) => /^(code|codice|error code|status|http status)$/i.test(String(x).trim()));
      const di = h.findIndex((x) => /^(description|descrizione|message|messaggio|meaning)$/i.test(String(x).trim()));
      if (ci >= 0 && di >= 0) for (const row of u.table.rows) if (row[ci]) errors.push({ code: String(row[ci]), description: String(row[di] ?? ""), source_unit: u.id });
    }
    out.push({ raw_id: intId, candidates: ["INT"], doc: docCode, section: null, source_unit: units[0]?.id ?? null, facets,
      extraction: { title: doc.title, protocol, endpoints, operations, mappings, error_catalog: errors.slice(0, 200) },
      confidence: ["xsd", "wsdl", "openapi"].includes(doc.format) ? 0.95 : 0.8,
      needs_llm: true, missing: ["trigger", "mode_latency", "observability", "silence_semantics", "counterpart_owner", "test_strategy", ...(errors.length ? [] : ["error_catalog"])] });
  }
  return out;
}

// ---------------------------------------------------------------- piano per lo scope-extractor (budget §29.10)
export function planLlm(items, { budget = DOC_BUDGET, unitBudget = UNIT_BUDGET, batchMax = 20, batchTokens = 8000 } = {}) {
  const sessions = [];
  const overBudget = [];
  let session = { n: 1, tokens: 0, batches: [] };
  let batch = { items: [], tokens: 0 };
  const closeBatch = () => { if (batch.items.length) { session.batches.push(batch); session.tokens += batch.tokens; } batch = { items: [], tokens: 0 }; };
  for (const it of items.filter((x) => x.needs_llm)) {
    const t = (it.tokens ?? estimateTokens(it.extraction)) + LLM_OVERHEAD;
    if (t > unitBudget) { overBudget.push({ raw_id: it.raw_id, tokens: t }); continue; }
    if (batch.items.length >= batchMax || batch.tokens + t > batchTokens) closeBatch();
    if (session.tokens + batch.tokens + t > budget) { closeBatch(); sessions.push(session); session = { n: sessions.length + 1, tokens: 0, batches: [] }; }
    batch.items.push(it.raw_id);
    batch.tokens += t;
  }
  closeBatch();
  if (session.batches.length) sessions.push(session);
  const total = sessions.reduce((a, s) => a + s.tokens, 0);
  return { budget, unit_budget: unitBudget, estimated_tokens: total, sessions: sessions.map((s) => ({ n: s.n, tokens: s.tokens, batches: s.batches.length, items: s.batches.reduce((a, b) => a + b.items.length, 0), batch_items: s.batches.map((b) => b.items) })), over_unit_budget: overBudget };
}

export function extractDocument(doc, units, { profile = null } = {}) {
  const ctx = { genre: profile?.genre ?? null, f1: profile?.facets?.F1 ?? null, origin: profile?.origin ?? null };
  const items = [];
  for (const u of units) { const r = extractUnit(u, ctx); if (r) items.push(r); }
  const docItems = documentCandidates(doc, units, items, { profile });
  // Candidati di documento: lo scope-extractor non rilegge l'estrazione intera (mapping, passi): per ogni attributo
  // mancante pone la domanda della banca a ≤ 5 unità (§19.11). Costo = attributi mancanti × 5 unità × ~120 token,
  // entro il budget per unità (3k).
  for (const c of docItems) c.tokens = Math.min(UNIT_BUDGET - LLM_OVERHEAD, Math.max(200, (c.missing?.length ?? 1) * 5 * 120));
  const all = [...items, ...docItems];
  const byCandidate = {};
  for (const r of all) byCandidate[r.candidates?.[0] ?? "?"] = (byCandidate[r.candidates?.[0] ?? "?"] ?? 0) + 1;
  const stats = { units: units.length, extracted_units: items.length, document_candidates: docItems.length, needs_llm: all.filter((r) => r.needs_llm).length,
    t0_complete: all.filter((r) => !r.needs_llm).length, by_candidate: byCandidate, residue_marked: items.filter((r) => r.residue).length };
  return { items: all, stats, llm_plan: planLlm(all) };
}

export function writeRaw(inboxScopeDir, docCode, result, { scope } = {}) {
  const dir = join(inboxScopeDir, "raw");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${docIdToken(docCode)}.yaml`);
  writeFileSync(file, YAML.stringify({ doc: docCode, scope: scope ?? null, extracted_at: new Date().toISOString(), tier: "T0", stats: result.stats, llm_plan: { ...result.llm_plan, sessions: result.llm_plan.sessions.map(({ batch_items, ...s }) => ({ ...s, batch_items })) }, items: result.items }, { lineWidth: 0 }));
  return file;
}

const HELP = `uso: node scripts/ingest/extract.mjs --units <units.json> --doc <parsed.json> --root <workspace> [--profile <DOC.yaml>] [--scope XSC] [--customer C] [--json] [--help]

Pre-estrazione deterministica T0 (§19.10) con gli schemi schemas/unit-extraction/<tipo>.schema.json: item grezzi in
<workspace>/_inbox/<scope>/raw/<DOCID>.yaml con F1/F15 del profilo; needs_llm: true (con i campi mancanti) per ciò
che serve allo scope-extractor, piano a lotti per sessione entro 80k token per documento e 3k per unità (§29.10).

Exit code: 0 ok · 1 errore utente (argomenti, file illeggibili) · 2 errore di sistema.`;

function main(argv) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.units || !opts.doc || !opts.root) return fail(asJson, 1, "richiesti --units, --doc e --root");
  const scope = opts.scope ?? "XSC";
  if (!SCOPES.has(scope)) return fail(asJson, 1, `scope sconosciuto: ${scope}`);
  let units, doc, profile = null;
  try {
    units = JSON.parse(readFileSync(opts.units, "utf8"));
    doc = JSON.parse(readFileSync(opts.doc, "utf8"));
    if (opts.profile) profile = YAML.parse(readFileSync(opts.profile, "utf8"));
  } catch (e) { return fail(asJson, 1, `file illeggibile: ${e.message}`); }
  try {
    const paths = workspacePaths({ root: opts.root, customer: opts.customer ?? null });
    const r = extractDocument(doc, Array.isArray(units) ? units : units.units ?? [], { profile });
    const file = writeRaw(paths.inbox(scope), profile?.id ?? doc.id, r, { scope });
    console.log(JSON.stringify(asJson ? { ok: true, file, stats: r.stats, llm_plan: { estimated_tokens: r.llm_plan.estimated_tokens, sessions: r.llm_plan.sessions.length } } : { ok: true, file, ...r.stats }));
    return 0;
  } catch (e) { return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`); }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
