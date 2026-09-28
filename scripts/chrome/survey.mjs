// Il tenant come documento (§19.17): la schermata di JAGGAER è la fonte a peso più alto ed è anch'essa un documento,
// con la stessa pipeline. Dai risultati MCP salvati (snapshot degli strumenti del browser, parseSnapshot di K6):
//   pagina (page_signature)            → sezione `schermata` → unità `schermata`
//   campo con attributi                 → riga-tabella-campi → candidato FLD livello L con mandatory.kind OSSERVATO
//                                         (solo se il formato espone `required`: altrimenti ignoto, mai "falso")
//   messaggio di validazione (alert…)   → regola a modalità sistema: validation { message esatto, on_fail block/warn osservato }
//   pagina di setup con valori          → CFG.current_state a 0.85 (1.00 dopo 3 ricognizioni, §19.17)
//   la ricognizione                     → DOC di kind tenant-survey con la data
// I valori passano dalla redazione (§54.2, profilo strict fuori dalla sandbox) prima di essere scritti.
//
//   surveyDoc(snapshots: [{ name, text }], { id, date, env? }) → documento normalizzato (parsed-doc) di tipo schermata
//   surveyCandidates(doc, { date }) → { fld[], cfg[], validations[] }
//   survey(dir, { root, customer, scope, date?, env? }) → scrive _inbox/<scope>/survey/<data>/{parsed.json, units.json,
//       candidates.yaml, profile.yaml} e il profilo DOC (tenant-survey) nel DB del cliente
// CLI: node scripts/chrome/survey.mjs --snapshots <cartella di *.snapshot.txt> --root <workspace> --customer ACME [--scope ADM] [--env sandbox] [--json]
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, basename } from "node:path";
import YAML from "yaml";
import { parseSnapshot, pageSignature, mainHeading, FIELD_ROLES, normLabel } from "./snapshot-parse.mjs";
import { redact, profileFor } from "./redact.mjs";
import { newDoc, newSection, finishDoc } from "../ingest/lib/parsed.mjs";
import { segmentUnits } from "../ingest/segment.mjs";
import { profileDoc, assignDocCode, recordProfile, writeProfile, validateProfile } from "../ingest/profile-doc.mjs";
import { workspacePaths, ensureWorkspace } from "../ingest/lib/paths.mjs";
import { openDb } from "../kb/db.mjs";
import { SCOPES } from "../kb/codes.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";

export const SETUP_RE = /admin|setup|settings|configur|impostazion|parametri|preferen/i;
const TYPE_OF_ROLE = { textbox: "text", searchbox: "text", textarea: "text", spinbutton: "number", combobox: "list", listbox: "list", checkbox: "flag", switch: "flag", radio: "list", slider: "number" };
const WARN_ROLES = new Set(["status", "log", "marquee"]);

export function surveyDoc(snapshots, { id = "tenant-survey", date = new Date().toISOString().slice(0, 10), env = "sandbox" } = {}) {
  const profile = profileFor({ envType: env });
  const doc = newDoc({ id, title: `Ricognizione del tenant ${date}`, format: "other", source: null, parser: "survey" });
  doc.meta.kind_hint = "tenant-survey";
  doc.meta.dated = date;
  snapshots.forEach((s, i) => {
    const page = parseSnapshot(s.text);
    const sig = pageSignature(page, { profile }) ?? `pagina-${i + 1}`;
    const title = redact(mainHeading(page) ?? page.title ?? sig, { profile });
    const sec = newSection({ path: `s${i + 1}`, title, level: 1 });
    sec.kind = "schermata";
    sec.meta = { page_signature: sig, url: page.url ? redact(page.url, { profile }) : null, format: page.format, exposes: page.exposes, snapshot: s.name };
    const labelOf = (e) => String(e.name ?? "").replace(/[\s:*]+$/, "").trim();
    const fields = page.elements.filter((e) => FIELD_ROLES.has(e.role) && labelOf(e));
    const exposesRequired = page.exposes.includes("required");
    sec.records = [
      ...fields.map((e) => ({ kind: "field", name: labelOf(e), type: TYPE_OF_ROLE[e.role] ?? e.role, role: e.role,
        required: exposesRequired ? e.required === true : null, value: e.value !== undefined ? redact(String(e.value), { profile }) : undefined,
        checked: e.checked, disabled: e.disabled })),
      ...page.elements.filter((e) => e.role === "button" && e.name).map((e) => ({ kind: "button", name: e.name })),
      ...page.elements.filter((e) => e.role === "tab" && e.name).map((e, k) => ({ kind: "tab", name: e.name, order: k + 1 })),
      ...page.messages.map((m) => ({ kind: "message", name: redact(m.text, { profile }), severity: WARN_ROLES.has(m.role) ? "warning" : "error", role: m.role })),
    ].map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)));
    sec.paragraphs = [title, ...page.texts.map((t) => redact(t, { profile })).filter((t) => t && t !== title)].slice(0, 60);
    if (fields.length) sec.tables.push({ caption: "campi osservati", headers: ["Campo", "Tipo", "Obbligatorio", "Valore osservato", "Note"],
      rows: fields.map((e) => [labelOf(e), TYPE_OF_ROLE[e.role] ?? e.role, exposesRequired ? (e.required ? "Sì" : "No") : "", e.value !== undefined ? redact(String(e.value), { profile }) : e.checked !== undefined ? String(e.checked) : "", exposesRequired ? "osservato" : `required non esposto dal formato ${page.format}`]) });
    doc.sections.push(sec);
  });
  return finishDoc(doc);
}

export function surveyCandidates(doc, { date = doc.meta?.dated ?? new Date().toISOString().slice(0, 10), level = "L" } = {}) {
  const fld = [], cfg = [], validations = [];
  for (const s of doc.sections) {
    const sig = s.meta?.page_signature ?? s.path;
    const setup = SETUP_RE.test(`${s.meta?.url ?? ""} ${s.title}`);
    for (const r of s.records ?? []) {
      if (r.kind === "field") {
        const c = { level, candidate: "FLD", label: r.name, label_norm: normLabel(r.name), page_signature: sig, observed_type: r.type, source: "osservazione-chrome", observed_at: date,
          mandatory: r.required === null ? { kind: null, observed: false, note: "il formato dello snapshot non espone required: obbligatorietà ignota" } : { kind: r.required ? "always" : "never", observed: true } };
        if (r.disabled !== undefined) c.editable_observed = !r.disabled;
        fld.push(c);
        if (setup && (r.value !== undefined || r.checked !== undefined)) {
          cfg.push({ candidate: "CFG", parameter: r.name, page_signature: sig, current_state: { value: r.value ?? r.checked, observed_at: date, source: "osservazione-chrome" }, confidence: 0.85, confirmations: 1,
            note: "0.85 alla prima ricognizione; 1.00 dopo 3 ricognizioni concordi (§19.17)" });
        }
      } else if (r.kind === "message") {
        validations.push({ candidate: "FLD.validation", message: r.name, on_fail: r.severity === "warning" ? "warn" : "block", observed: true, page_signature: sig, observed_at: date });
      }
    }
  }
  return { fld, cfg, validations };
}

export function survey(dir, { root, customer, scope = "ADM", date = new Date().toISOString().slice(0, 10), env = "sandbox" } = {}) {
  if (!SCOPES.has(scope)) throw new Error(`scope sconosciuto: ${scope}`);
  const files = readdirSync(dir).filter((f) => /\.(snapshot\.)?txt$/.test(f)).sort();
  if (!files.length) throw new Error(`nessuno snapshot (*.snapshot.txt) in ${dir}`);
  const snaps = files.map((f) => ({ name: f, text: readFileSync(join(dir, f), "utf8") }));
  const paths = ensureWorkspace(workspacePaths({ root, customer }));
  const db = openDb(paths.db);
  try {
    const { code } = assignDocCode(db, { level: paths.level === "S" ? "S" : "C", customer: paths.customer, source: `tenant-survey-${date}`, sha256: `survey:${date}:${files.join(",")}` });
    const doc = surveyDoc(snaps, { id: `tenant-survey-${date}`, date, env });
    doc.meta.source = `tenant-survey-${date}`;
    const { units } = segmentUnits(doc, { docCode: code });
    const profile = profileDoc(doc, units, { code, origin: "cliente", kind: "tenant-survey", today: date });
    const v = validateProfile(profile);
    if (!v.ok) throw new Error(`profilo non valido: ${v.errors.join("; ")}`);
    const cands = surveyCandidates(doc, { date });
    const out = join(paths.inbox(scope), "survey", date);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, "parsed.json"), JSON.stringify(doc, null, 1));
    writeFileSync(join(out, "units.json"), JSON.stringify(units, null, 1));
    writeFileSync(join(out, "candidates.yaml"), YAML.stringify({ doc: code, date, ...cands }, { lineWidth: 0 }));
    const pfile = writeProfile(paths.inbox(scope), profile);
    recordProfile(db, profile, { path: pfile });
    return { code, dir: out, pages: doc.sections.length, units: units.length, fld: cands.fld.length, cfg: cands.cfg.length, validations: cands.validations.length, profile: pfile };
  } finally { db.close(); }
}

const HELP = `uso: node scripts/chrome/survey.mjs --snapshots <cartella> --root <workspace> --customer <C> [--scope ADM] [--env sandbox|dev|preprod|prod] [--date AAAA-MM-GG] [--json] [--help]

Ricognizione del tenant come documento (§19.17): dagli snapshot MCP salvati (Chrome DevTools take_snapshot, Claude
read_page, Playwright browser_snapshot) produce unità schermata, candidati FLD livello L con obbligatorietà osservata,
messaggi di validazione come regole di sistema, CFG.current_state a 0.85 dalle pagine di setup e un DOC tenant-survey
datato → <workspace>/customers/<C>/_inbox/<scope>/survey/<data>/. Valori redatti (§54.2).

Exit code: 0 ok · 1 errore utente (argomenti, cartella senza snapshot) · 2 errore di sistema.`;

function main(argv) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.snapshots || !opts.root || !opts.customer) return fail(asJson, 1, "richiesti --snapshots, --root e --customer");
  if (!existsSync(opts.snapshots)) return fail(asJson, 1, `cartella assente: ${opts.snapshots}`);
  try {
    const r = survey(opts.snapshots, { root: opts.root, customer: opts.customer, scope: opts.scope ?? "ADM", env: opts.env ?? "sandbox", ...(opts.date ? { date: opts.date } : {}) });
    console.log(JSON.stringify({ ok: true, ...r }));
    return 0;
  } catch (e) {
    if (/scope sconosciuto|nessuno snapshot|cliente non valido/.test(e.message)) return fail(asJson, 1, e.message);
    return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`);
  }
}

if (isMain(import.meta.url)) process.exit(main(process.argv.slice(2)));
