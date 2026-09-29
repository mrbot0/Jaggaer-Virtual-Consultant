// WP09a-E — digestione guidata (§19.11–19.19): registro completo degli attributi attesi e banche di domande, unità
// nel DB (kb units), piano di digestione e copertura, back-check T0, alias, diff di versione, report di ingestion,
// revisione stratificata, backlog DT-025.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { openDb } from "../../scripts/kb/db.mjs";
import { segmentUnits } from "../../scripts/ingest/segment.mjs";
import { parseDocx } from "../../scripts/ingest/parse-docx.mjs";
import { upsertUnits, units, questionFor, writeUnits, indexUnits, linkSubjectUnits, ftsQuery } from "../../scripts/kb/units.mjs";
import { planSubject, recordAnswers, completeness } from "../../scripts/kb/digest-plan.mjs";
import { backcheck, supportOf, dbLookup } from "../../scripts/kb/backcheck.mjs";
import { resolve as resolveAlias, addAlias, learn, emptyRegistry, validateRegistry, saveRegistry, loadRegistry } from "../../scripts/ingest/aliases.mjs";
import { diffUnits, impact } from "../../scripts/ingest/doc-diff.mjs";
import { extractDocument } from "../../scripts/ingest/extract.mjs";
import { buildReport, renderReport } from "../../scripts/ingest/ingestion-report.mjs";
import { buildQueue, record, stats, parseVerb, ReviewError } from "../../scripts/kb/review.mjs";
import { backlog } from "../../scripts/kb/ingest-backlog.mjs";
import { recordProfile } from "../../scripts/ingest/profile-doc.mjs";
import { reindex } from "../../scripts/kb/reindex.mjs";
import { cleanEnv } from "../helpers/hook-env.mjs";

const ROOT = new URL("../../", import.meta.url);
const EXPECTED = YAML.parse(readFileSync(new URL("schemas/expected-attributes.yaml", ROOT), "utf8"));
const BANKS = new URL("product/question-banks/", ROOT);
const KB = new URL("scripts/kb/kb.mjs", ROOT).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const docx = parseDocx(readFileSync(new URL("test/fixtures/docs/sample.docx", ROOT)), { id: "demo-docx", source: "sample.docx" });

function dbWithDoc(code = "C.ACME.XSC.DOC.0007") {
  const db = openDb(":memory:");
  const { units: us } = segmentUnits(docx, { docCode: code });
  upsertUnits(db, us);
  recordProfile(db, { id: code, source: { doc_key: "demo", doc_id: docx.id, path: "sample.docx", sha256: "x" }, kind: "doc-configurazione-cliente", genre: "tecnica", origin: "cliente", scopes: ["P2P"], version: null, dated: null, covers_release: null, reliability: { score: 0.78 }, ingestion: { status: "segmented" }, units: { total: us.length } });
  return { db, us };
}

test("expected-attributes: registro completo di §64 nel formato di K0 (liste), critical ⊆ attesi, banca di domande per OGNI tipo con una domanda per attributo; profile.yaml = §63", () => {
  const types = ["CFG", "CFP", "FLW", "KEY", "LCY", "FLD", "INT", "SEL", "HND", "CHK", "PMP", "PRF", "TBL", "QRY", "ERR", "DIN", "DOC", "ENV", "ACT", "STR", "DT"];
  for (const t of types) {
    assert.ok(Array.isArray(EXPECTED[t]) && EXPECTED[t].length, t);
    for (const c of [...EXPECTED.critical[t], ...EXPECTED.always_critical[t]]) assert.ok(EXPECTED[t].includes(c), `${t}: ${c} critico ma non atteso`);
    const bank = YAML.parse(readFileSync(new URL(`${t}.yaml`, BANKS), "utf8"));
    assert.deepEqual(bank.questions.map((q) => q.attribute), EXPECTED[t], `${t}: una domanda per attributo`);
    for (const q of bank.questions) { assert.match(q.question, /\?$/); assert.equal(q.critical_for_r2, EXPECTED.critical[t].includes(q.attribute)); }
  }
  assert.equal(EXPECTED.CFG.length, 7);
  assert.deepEqual(EXPECTED.critical.CFG, ["impacts", "rollback", "current_state"]);
  assert.deepEqual(EXPECTED.always_critical.CFG, ["location", "options"]);
  assert.equal(YAML.parse(readFileSync(new URL("FLD.yaml", BANKS), "utf8")).identity_blocks.length, 12);
  assert.equal(EXPECTED.INT.length, 9);
  const prof = YAML.parse(readFileSync(new URL("profile.yaml", BANKS), "utf8"));
  assert.equal(prof.questions.length, 23);
  assert.ok(prof.questions.every((q) => q.area && q.question && q.feeds));
  assert.equal(readdirSync(BANKS).length, types.length + 1);
});

test("kb units: FTS (bm25) su units_fts, filtro per documento e tipo, prossimità di sezione del soggetto (--near); --question dalla banca", () => {
  const { db, us } = dbWithDoc();
  const hits = units(db, { doc: "C.ACME.XSC.DOC.0007", query: "centro di costo obbligatorio" });
  assert.ok(hits.length > 0 && hits.length <= 5);
  assert.ok(hits.every((h) => h.doc === "C.ACME.XSC.DOC.0007"));
  const s12 = us.filter((u) => u.context.section_path === "1.2");
  linkSubjectUnits(db, "C.ACME.P2P.FLW.0001", [s12[0].id]);
  const near = units(db, { near: "C.ACME.P2P.FLW.0001", query: "centro di costo", top: 10 });
  assert.equal(near[0].near, "sezione", "le unità della sezione sorgente del soggetto salgono in cima");
  assert.ok(units(db, { doc: "C.ACME.XSC.DOC.0007", type: "regola", top: 50 }).every((h) => h.type === "regola"));
  assert.equal(questionFor("CFG.impacts").question, "Cosa cambia, a valle, se questo oggetto viene modificato?");
  assert.match(ftsQuery("Cosa cambia a valle?"), /cambia/);
  // CLI: kb units --question (nessun testo libero con virgole sulla riga di comando: i guard lo negherebbero)
  const dir = mkdtempSync(join(tmpdir(), "kb-units-"));
  const dbFile = join(dir, "k.db");
  const d2 = openDb(dbFile); upsertUnits(d2, us); d2.close();
  const r = spawnSync(process.execPath, [KB, "units", "--db", dbFile, "--question", "FLD.mandatory", "--top", "3"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const out = JSON.parse(r.stdout);
  assert.equal(out.question.attribute, "mandatory");
  assert.ok(out.items.length <= 3);
});

test("unità su disco nella posizione canonica e reindex le indicizza (sources/units/<DOCID>/<codice>.yaml)", () => {
  const root = mkdtempSync(join(tmpdir(), "kb-units-root-"));
  const { units: us } = segmentUnits(docx, { docCode: "C.ACME.XSC.DOC.0007" });
  const w = writeUnits(join(root, "sources", "units"), us);
  assert.equal(w.files, us.length);
  assert.ok(existsSync(join(root, "sources", "units", "DOC0007", `${us[0].id}.yaml`)));
  mkdirSync(join(root, "kb"), { recursive: true });
  const st = reindex(root, join(root, "k.db"), { clustersDir: null });
  assert.equal(st.units_upserted, us.length);
  const again = indexUnits(openDb(join(root, "k.db")), join(root, "sources", "units"), { root });
  assert.equal(again.units_unchanged, us.length, "hash invariato ⇒ nessuna scrittura");
});

test("digestione guidata: un CFG con 5/7 attributi coperti → digerito con gaps (impacts, rollback) e non in uso per R ≥ R2; senza location → quarantena", () => {
  const { db, us } = dbWithDoc();
  const plan = planSubject(db, { subject: "C.ACME.ADM.CFG.0019", type: "CFG", label: "strict_import" });
  assert.equal(plan.questions.length, 7);
  assert.ok(plan.questions.every((q) => q.units.length <= 5));
  assert.ok(plan.questions[0].units.some((u) => /strict_import/.test(u.text)), "le unità candidate nominano il soggetto");
  const u = us.find((x) => /strict_import/.test(x.text)).id;
  const answers = ["location", "options", "dependencies", "current_state", "risk"].map((a) => ({ attribute: a, units: [u] }));
  const r = recordAnswers(db, { subject: "C.ACME.ADM.CFG.0019", type: "CFG", answers });
  assert.deepEqual(r.gaps, ["impacts", "rollback"]);
  assert.equal(r.attrs.location, "tecnica", "il genere viene dal DOC dell'unità");
  assert.equal(r.completeness.outcome, "digerito");
  assert.ok(r.completeness.combinations.includes("non-in-uso-R2+") && r.completeness.combinations.includes("gaps-dichiarati"));
  assert.equal(db.prepare("select count(*) as n from attribute_coverage where subject_code='C.ACME.ADM.CFG.0019' and answered=1").get().n, 5);
  assert.equal(completeness("CFG", { options: "tecnica", impacts: "tecnica" }).outcome, "quarantena");
  assert.deepEqual(completeness("CFG", { options: "tecnica" }).missing_critical, ["location"]);
});

test("back-check T0: supportata / parziale / non-supportata / derived; numeri e codici esatti; una non supportata blocca (exit 3)", () => {
  const { db, us } = dbWithDoc();
  const unit = us.find((x) => /strict_import/.test(x.text)).id;
  const item = { id: "C.ACME.ADM.CFG.0019", type: "CFG", location: "Amministrazione", current_state: "strict_import impostato a false dal go-live", options: "true false",
    risk: "alto", sources: [{ unit, attributes: ["current_state", "options"] }], attribute_sources: { location: [unit] }, derived: { risk: { rule: "CL-CFG-010" } } };
  const r = backcheck(item, dbLookup(db));
  const v = Object.fromEntries(r.results.map((x) => [x.attribute, x.verdict]));
  assert.equal(v.current_state, "supportata");
  assert.equal(v.risk, "derived");
  assert.equal(v.location, "non-supportata", "il testo citato non dice dove si trova");
  assert.equal(r.blocked, true);
  assert.equal(supportOf("tolleranza del 2%", ["la tolleranza è dello 0%"]).verdict, "non-supportata", "i numeri devono corrispondere esattamente");
  assert.equal(supportOf("codice REQ_HDR_COST_CENTER obbligatorio", ["Il campo REQ_HDR_COST_CENTER è obbligatorio"]).verdict, "supportata");
  const dir = mkdtempSync(join(tmpdir(), "bc-"));
  const dbFile = join(dir, "k.db"); const d2 = openDb(dbFile); upsertUnits(d2, us); d2.close();
  writeFileSync(join(dir, "item.yaml"), YAML.stringify(item));
  const cli = spawnSync(process.execPath, [new URL("scripts/kb/backcheck.mjs", ROOT).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "--item", join(dir, "item.yaml"), "--db", dbFile, "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: dir }) });
  assert.equal(cli.status, 3);
  writeFileSync(join(dir, "ok.yaml"), YAML.stringify({ ...item, location: undefined, attribute_sources: {} }));
  assert.equal(spawnSync(process.execPath, [new URL("scripts/kb/backcheck.mjs", ROOT).pathname.replace(/^\/([A-Za-z]:)/, "$1"), "--item", join(dir, "ok.yaml"), "--db", dbFile], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: dir }) }).status, 0);
});

test("alias: nome tecnico chiave forte, alias verificato, alias unverified solo candidato, merge-candidate < 0.15 nella stessa sezione, registro validato prima di scrivere", () => {
  const reg = emptyRegistry();
  addAlias(reg, "Centro di costo", { technical_name: "REQ_HDR_COST_CENTER", section: "testata" });
  addAlias(reg, "Centro di costo", { text: "CdC", doc: "DOC0007", lang: "it" });
  addAlias(reg, "Centro di costo", { text: "Cost Center", lang: "en", unverified: true });
  assert.deepEqual(resolveAlias(reg, { label: "Qualunque", technical_name: "req-hdr-cost-center" }).by, "technical_name");
  assert.equal(resolveAlias(reg, { label: "cdc" }).match, "Centro di costo");
  const unv = resolveAlias(reg, { label: "Cost Center" });
  assert.equal(unv.match, null);
  assert.equal(unv.candidates[0].by, "alias-unverified");
  const mc = resolveAlias(reg, { label: "Centri di costo", section: "testata" });
  assert.equal(mc.match, null);
  assert.equal(mc.candidates[0].by, "merge-candidate");
  assert.equal(resolveAlias(reg, { label: "Centri di costo", section: "righe" }).candidates.length, 0, "altra sezione: nessun candidato");
  const st = learn(reg, [{ label: "Codice progetto", technical_name: "REQ_HDR_PROJECT", section: "testata", document: "d1" }, { label: "Project code", technical_name: "REQ_HDR_PROJECT", section: "header", document: "d2" }], { docLang: { d1: "it", d2: "en" } });
  assert.equal(st.terms_created, 1);
  assert.equal(resolveAlias(reg, { label: "Project code" }).match, "Codice progetto");
  assert.ok(validateRegistry(reg).ok);
  const f = join(mkdtempSync(join(tmpdir(), "al-")), "kb", "aliases.yaml");
  saveRegistry(f, reg);
  assert.equal(loadRegistry(f).terms.length, 2);
  assert.throws(() => saveRegistry(f, { terms: [{ term: "x" }, { term: "X", aliases: [] }] }), /non valido/);
});

test("diff di versione v2→v3: solo le unità cambiate si ridigeriscono; valore cambiato ⇒ item versionato + CTR 'cambio documentale'; sparite ⇒ source-removed; release notes come indizio", () => {
  const mk = (paras) => ({ id: "d", title: "D", format: "docx", sections: [{ path: "1", title: "Parametri", level: 1, page: 1, paragraphs: paras, tables: [], figures: [] }] });
  const v2 = segmentUnits(mk(["La tolleranza quantità è del 2% per tutte le fatture.", "Il fornitore deve essere censito in SAP prima dell'invio.", "La sezione allegati accetta file PDF e immagini di qualunque dimensione."]), { docCode: "C.ACME.XSC.DOC.0007" }).units;
  const v3 = segmentUnits(mk(["La tolleranza quantità è del 0% per tutte le fatture.", "Il fornitore deve essere censito in SAP prima dell'invio.", "Nuovo paragrafo sulle note di credito in valuta estera."]), { docCode: "C.ACME.XSC.DOC.0007", previous: v2 }).units;
  const d = diffUnits(v2, v3);
  assert.deepEqual([d.invariate.length, d.modificate.length, d.nuove.length, d.sparite.length], [1, 2, 0, 0]);
  const tol = d.modificate.find((m) => /tolleranza/.test(m.old.text));
  const items = [
    { id: "C.ACME.INV.CFG.0004", sources: [{ unit: tol.old.id }] },
    { id: "C.ACME.VEN.KEY.0002", sources: [{ unit: v2[1].id }] },
    { id: "C.ACME.INV.FLD.0009", sources: [{ unit: v2[2].id }] },
  ];
  const r = impact(d, items, { releaseNotes: [{ kind: "changed", text: "Allegati: nuove regole per le note di credito" }] });
  assert.equal(r.counts.da_ridigerire, 2, "costo proporzionale alle unità toccate, non a tutte");
  assert.ok(!r.proposals.some((p) => p.item === "C.ACME.VEN.KEY.0002"), "l'item con fonte invariata non si tocca");
  assert.ok(r.proposals.some((p) => p.action === "version" && p.item === "C.ACME.INV.CFG.0004" && p.new_code === "C.ACME.INV.CFG.0004.v2"));
  assert.ok(r.proposals.some((p) => p.action === "ctr" && p.kind === "cambio documentale" && p.expected === false));
  const onlyGone = impact({ invariate: [], modificate: [], nuove: [], sparite: [v2[2]] }, items);
  assert.deepEqual(onlyGone.proposals.map((p) => [p.action, p.item]), [["source-removed", "C.ACME.INV.FLD.0009"]]);
  assert.equal(v3.find((u) => /censito/.test(u.text)).id, v2[1].id, "codice conservato per l'unità invariata");
});

test("report di ingestion (§19.15): unità = fonti (estratte + contesto) + residuo; layout del template", () => {
  const { units: us } = segmentUnits(docx, { docCode: "C.ACME.XSC.DOC.0007" });
  const extraction = extractDocument(docx, us, { profile: { id: "C.ACME.XSC.DOC.0007", genre: "tecnica", facets: { F1: "doc-cliente-tecnica" } } });
  const d = buildReport({ profile: { id: "C.ACME.XSC.DOC.0007", title: "ACME_Configurazione_v2.docx" }, units: us, extraction, date: "2026-09-28" });
  assert.equal(d.units, d.sourced + d.residue_total);
  assert.equal(d.sourced, d.extracted_units + d.context);
  const text = renderReport(d);
  assert.match(text, /^INGESTION — C\.ACME\.XSC\.DOC\.0007 — ACME_Configurazione_v2\.docx — 2026-09-28/);
  for (const line of ["Unità ", "Residuo ", "Back-check:", "DT-021:", "Copertura epistemica prodotta:", "Gap più frequenti:", "Contraddizioni aperte:", "Costo: T0", "Da fare:"]) assert.ok(text.includes(line), line);
  assert.ok(!/\{\{/.test(text), "nessun segnaposto rimasto");
  const amb = segmentUnits({ id: "a", title: "A", format: "docx", sections: [{ path: "1", title: "Regole", level: 1, page: null, paragraphs: ["Il campo dovrebbe essere obbligatorio salvo eccezioni del buyer.", "Indice"], tables: [], figures: [] }] }).units;
  const d2 = buildReport({ profile: { id: "S.STD.XSC.DOC.0001" }, units: amb, extraction: extractDocument({ sections: [] }, amb) });
  assert.equal(d2.residue.ambiguous, 1);
  assert.equal(d2.units, d2.sourced + d2.residue_total);
});

test("revisione stratificata: ordine degli strati, deontiche a lotti da 10, campione 5 % per tipo con seme deterministico; verbi registrati e tasso al primo passaggio", () => {
  const ws = mkdtempSync(join(tmpdir(), "rev-"));
  const dig = join(ws, "customers", "ACME", "_inbox", "P2P", "digested");
  mkdirSync(dig, { recursive: true });
  const w = (id, facets, extra = {}) => writeFileSync(join(dig, `${id}.yaml`), YAML.stringify({ id, type: id.split(".")[3], facets, ...extra }));
  w("C.ACME.P2P.CFG.0001", { F12: "quarantena", F10: "R1" }, { missing_critical: ["location"] });
  w("C.ACME.P2P.FLD.0002", { F12: "digerito", F10: "R1" }, { dt021: "ambiguo" });
  w("C.ACME.P2P.CFG.0003", { F12: "digerito", F10: "R3" });
  for (let i = 10; i < 50; i++) w(`C.ACME.P2P.FLD.00${i}`, { F12: "digerito", F10: "R1" });
  const res = join(ws, "customers", "ACME", "_inbox", "P2P", "residue");
  mkdirSync(res, { recursive: true });
  writeFileSync(join(res, "DOC0007.yaml"), YAML.stringify({ doc: "C.ACME.XSC.DOC.0007", entries: Array.from({ length: 23 }, (_, i) => ({ class: "ambiguous", reason: "doppia negazione", unit: `U.DOC0007.${String(i + 1).padStart(4, "0")}` })) }));
  const q = buildQueue({ inboxRoot: join(ws, "customers", "ACME"), seed: "s1" });
  assert.deepEqual(q.strata.map((s) => s.stratum), ["quarantena", "dt021", "r3", "ctr", "deontiche", "campione"]);
  assert.deepEqual(q.strata[0].items.map((x) => x.code), ["C.ACME.P2P.CFG.0001"]);
  assert.deepEqual(q.strata[1].items.map((x) => x.code), ["C.ACME.P2P.FLD.0002"]);
  assert.deepEqual(q.strata[2].items.map((x) => x.code), ["C.ACME.P2P.CFG.0003"]);
  assert.deepEqual(q.strata[4].batches.map((b) => b.length), [10, 10, 3]);
  assert.equal(q.strata[5].items.length, 2, "5 % di 40 FLD = 2");
  assert.deepEqual(buildQueue({ inboxRoot: join(ws, "customers", "ACME"), seed: "s1" }).strata[5].items, q.strata[5].items, "stesso seme, stesso campione");
  const reviews = join(ws, "customers", "ACME", "reviews");
  record(reviews, { ...parseVerb(["accept", "C.ACME.P2P.FLD.0010"]), at: "2026-09-28T10:00:00Z" });
  record(reviews, { ...parseVerb(["correct", "C.ACME.P2P.FLD.0011", "mandatory.kind=conditional"]), at: "2026-09-28T10:01:00Z" });
  record(reviews, { ...parseVerb(["accept", "C.ACME.P2P.FLD.0011"]), at: "2026-09-28T10:02:00Z" });
  record(reviews, { ...parseVerb(["reject", "C.ACME.P2P.CFG.0003", "CL-CFG-010"]), at: "2026-09-28T10:03:00Z" });
  const s = stats(reviews);
  assert.deepEqual([s.by_type.FLD.reviewed, s.by_type.FLD.first_pass_accepted, s.by_type.FLD.first_pass_rate], [2, 1, 0.5]);
  assert.equal(s.by_type.CFG.rejected, 1);
  assert.ok(existsSync(join(reviews, "2026-09.jsonl")));
  assert.throws(() => parseVerb(["reject", "C.ACME.P2P.CFG.0003"]), ReviewError);
  assert.throws(() => parseVerb(["correct", "C.ACME.P2P.CFG.0003", "senza-uguale"]), ReviewError);
  const cli = spawnSync(process.execPath, [KB, "review", "stats", "--root", ws, "--customer", "ACME"], { encoding: "utf8" });
  assert.equal(cli.status, 0, cli.stderr);
});

test("backlog DT-025: una spec di integrazione breve su soggetti con gap batte un manuale lungo su soggetti già consolidati", () => {
  const db = openDb(":memory:");
  const add = (code, kind, genre, units, rel, scopes) => recordProfile(db, { id: code, source: { doc_key: code, doc_id: code, path: code, sha256: code }, kind, genre, origin: "vendor", scopes, version: null, dated: null, covers_release: null, reliability: { score: rel }, ingestion: { status: "segmented" }, units: { total: units } });
  add("S.STD.XSC.DOC.0001", "manuale-utente", "d'uso", 3000, 0.7, ["P2P"]);
  add("S.STD.XSC.DOC.0002", "spec-integrazione", "tecnica", 200, 0.9, ["XSC"]);
  const item = (code, scope, type) => db.prepare("insert into items(code, level, customer, scope, type, title, summary, facets, status, path, hash, updated_at) values (?, 'S', 'STD', ?, ?, 't', 's', '{}', 'digerito', 'p', 'h', 'now')").run(code, scope, type);
  for (let i = 1; i <= 5; i++) { item(`S.STD.P2P.FLW.000${i}`, "P2P", "FLW"); db.prepare("insert into epistemic(subject_code, k_tech, k_use) values (?, 0.9, 0.95)").run(`S.STD.P2P.FLW.000${i}`); }
  for (let i = 1; i <= 3; i++) { item(`S.STD.XSC.INT.000${i}`, "XSC", "INT"); db.prepare("insert into epistemic(subject_code, k_tech, k_use) values (?, 0.1, 0.1)").run(`S.STD.XSC.INT.000${i}`); }
  const b = backlog(db);
  assert.deepEqual(b.map((x) => x.code), ["S.STD.XSC.DOC.0002", "S.STD.XSC.DOC.0001"]);
  assert.equal(b[0].gain_normalized, 1);
  assert.ok(b[0].priority > b[1].priority);
});
