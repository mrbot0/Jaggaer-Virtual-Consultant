// 18/11/2026 (ciclo di bug fixing 4: conoscenza, digestione T1/T2 e decisioni): un test per ogni bug trovato percorrendo i
// flussi degli agenti sulle copie dei DB e della conoscenza reali (ENEL, AVVA). Ogni test riproduce il sintomo osservato.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { openDb } from "../../scripts/kb/db.mjs";
import { reindex } from "../../scripts/kb/reindex.mjs";
import { writeDraft } from "../../scripts/kb/atlas-write.mjs";
import { atlasBuild, buildIndex } from "../../scripts/kb/atlas-build.mjs";
import { fields } from "../../scripts/kb/fields.mjs";
import { admit, quarantine, AdmissionError } from "../../scripts/kb/cluster.mjs";
import { backcheck, dbLookup } from "../../scripts/kb/backcheck.mjs";
import { upsertUnits } from "../../scripts/kb/units.mjs";
import { selectStrategy } from "../../scripts/decide/strategy-select.mjs";
import { resolve } from "../../scripts/kb/resolve.mjs";
import { recordAnswers } from "../../scripts/kb/digest-plan.mjs";
import { cleanEnv } from "../helpers/hook-env.mjs";

const PLUGIN = fileURLToPath(new URL("../../", import.meta.url));
const KB_CLI = join(PLUGIN, "scripts", "kb", "kb.mjs");
const SELF_CHECK = join(PLUGIN, "scripts", "decide", "self-check.mjs");
const ws0 = (c = "ACME") => { const ws = mkdtempSync(join(tmpdir(), "c4kb-")); mkdirSync(join(ws, "customers", c), { recursive: true }); return ws; };
const FACETS = { F1: "doc-cliente-utente", F4: "struttura-dati", F5: "saas-core", F6: [], F7: "sap-ecc", F8: "specifica", F9: "ripetitiva", F10: "R1",
  F11: "deterministico", F12: "digerito", F13: { verified_at: "2026-11-18", release: "ignota" }, F15: "d'uso" };
const UNIT = { id: "U.DOC0013.0039", doc: "C.ACME.XSC.DOC.0013", type: "regola", hash: "h39", lang: "it",
  context: { section: "2. CASISTICHE DI CHECK BASELINE (Check.xlsx)", section_path: "2", chapter: "2" },
  text: "2) le colonne di country e anno/mese sono valorizzate correttamente | (automatizzato) | verificare che ROW_TYPE sia uguale tra PPR e Collaboration." };
const fldDraft = (over = {}) => ({ id: "C.ACME.XSC.FLD.0001", type: "FLD", title: "Colonna country del file Check Item vs PPR",
  summary: "Colonna country del file di check baseline: deve essere valorizzata correttamente.", document: "Check Item vs PPR", label: { it: "country" },
  section: "casistiche di check baseline", field_type: "text",
  mandatory: { kind: "always", source: { doc: "C.ACME.XSC.DOC.0013", section: "2. CASISTICHE DI CHECK BASELINE", genre: "d'uso" } }, custom: false,
  facets: { ...FACETS }, sources: [{ unit: "U.DOC0013.0039", attributes: ["document", "section", "mandatory", "custom"] }], ...over });

// ——— 1. atlas-build: l'Atlas si legge una volta, non una per pagina (AVVA: 230 pagine × 9860 SEL, non finiva mai) ———
test("writeDraft con l'indice di atlas-build: i doppioni si vedono dall'indice (nessuna rilettura), gli item scritti vi si aggiungono", () => {
  const ws = ws0();
  const index = buildIndex(ws, "ACME", "P2P");
  const draft = { page: { signature: "p2p/po/new#testata", title: "Nuovo ordine" }, items: [{ type: "SEL", label: "Salva bozza", role: "button", effect: "write" }, { type: "FLD", label: "Descrizione", document: "Nuovo ordine", field_type: "text" }] };
  const a = writeDraft({ ws, customer: "ACME", scope: "P2P", draft, tolerant: true, index });
  assert.equal(a.written.length, 2);
  assert.equal(index.atlas.length, 1);
  assert.equal(index.fields.length, 1);
  // i file spariti dal disco non contano: l'indice è la memoria della costruzione (prova che non si rilegge la cartella)
  rmSync(join(ws, "customers", "ACME", "kb"), { recursive: true, force: true });
  const b = writeDraft({ ws, customer: "ACME", scope: "P2P", draft, tolerant: true, index });
  assert.equal(b.written.length, 0, JSON.stringify(b));
  assert.deepEqual(b.skipped.map((s) => s.type).sort(), ["FLD", "SEL"]);
});

test("atlas-build: una pagina con più di 300 elementi si memorizza a lotti (prima: «al più 300 item per bozza» a ogni esecuzione)", () => {
  const ws = ws0();
  const dir = join(ws, "customers", "ACME", ".sessions", "s1", "atlas");
  mkdirSync(dir, { recursive: true });
  const els = [{ i: 0, parent: null, role: "heading", name: "Ricerca moduli", level: 1 }];
  for (let k = 1; k <= 302; k++) els.push({ i: k, parent: null, role: "link", name: `Modulo ${k}` });
  writeFileSync(join(dir, "pages.jsonl"), `${JSON.stringify({ kind: "page", page_sig: "apps/router/formsearch#filter-forms", title: "Ricerca", url_path: "/apps/router/formsearch", elements: els })}\n`);
  const r = atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "s1" });
  assert.deepEqual(r.errors, []);
  assert.equal(r.written.filter((w) => w.type === "SEL").length, 302);
  const again = atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "s1" });
  assert.equal(again.written.length, 0, "seconda esecuzione: nessun doppione");
});

// ——— 2. indexItemFile alimenta il modello dei campi (AVVA: 820 FLD, tabella fields vuota, kb fields → 0) ———
test("un FLD scritto da atlas-write entra subito in `kb fields` (fields), senza reindex", () => {
  const ws = ws0();
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page: { signature: "p2p/po/new#t", title: "Nuovo ordine" }, items: [{ type: "FLD", label: "Centro di costo", document: "Nuovo ordine", field_type: "lookup", mandatory: "always" }] } });
  const db = openDb(join(ws, "customers", "ACME", "knowledge.db"));
  try {
    const r = fields(db, { top: 10 });
    assert.equal(r.total, 1);
    assert.equal(r.items[0].mandatory.kind, "always");
  } finally { db.close(); }
});

// ——— 3. catalogo dei cluster in un DB mai reindicizzato (ENEL, AVVA, prodotto: clusters 0) ———
test("DB mai reindicizzato: `kb clusters` carica il catalogo del plugin e admit trova il cluster (prima: elenco vuoto, «cluster inesistente»)", () => {
  const ws = ws0();
  const root = join(ws, "customers", "ACME");
  const dbFile = join(root, "knowledge.db");
  openDb(dbFile).close();
  const r = spawnSync(process.execPath, [KB_CLI, "clusters", "--family", "CL-FLD-MAND", "--db", dbFile, "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: ws }) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).items.length, 7);
  rmSync(dbFile); rmSync(`${dbFile}-wal`, { force: true }); rmSync(`${dbFile}-shm`, { force: true });
  const db = openDb(dbFile);
  try {
    mkdirSync(join(root, "_inbox", "XSC", "digested"), { recursive: true });
    writeFileSync(join(root, "_inbox", "XSC", "digested", "C.ACME.XSC.FLD.0001.yaml"), YAML.stringify(fldDraft()));
    assert.equal(admit(db, "CL-FLD-MAND-001", "C.ACME.XSC.FLD.0001", { root }).verdict, "ammesso");
  } finally { db.close(); }
});

// ——— 4. la bozza del digester arriva in kb/ con l'ammissione (prima: «item inesistente», nessun item clusterizzato) ———
test("admit di una bozza in _inbox/<S>/digested: ammessa ⇒ in kb/ con F12 clusterizzato, indicizzata (find, fields); rifiutata ⇒ resta in _inbox", () => {
  const ws = ws0();
  const root = join(ws, "customers", "ACME");
  const dig = join(root, "_inbox", "XSC", "digested");
  mkdirSync(dig, { recursive: true });
  writeFileSync(join(dig, "C.ACME.XSC.FLD.0001.yaml"), YAML.stringify(fldDraft()));
  writeFileSync(join(dig, "C.ACME.XSC.FLD.0002.yaml"), YAML.stringify(fldDraft({ id: "C.ACME.XSC.FLD.0002", mandatory: { kind: "never" } })));
  const db = openDb(join(root, "knowledge.db"));
  try {
    const r = admit(db, "CL-FLD-MAND-001", "C.ACME.XSC.FLD.0001", { root });
    assert.equal(r.status, "clusterizzato");
    assert.equal(r.materialized, "kb/scopes/XSC/fields/C.ACME.XSC.FLD.0001.yaml");
    const file = join(root, r.materialized);
    assert.equal(YAML.parse(readFileSync(file, "utf8")).facets.F12, "clusterizzato");
    assert.equal(db.prepare("select status from items where code='C.ACME.XSC.FLD.0001'").get().status, "clusterizzato");
    assert.equal(fields(db, {}).total, 1);
    assert.ok(existsSync(join(dig, "C.ACME.XSC.FLD.0001.yaml")), "la bozza non si cancella mai");
    assert.throws(() => admit(db, "CL-FLD-MAND-001", "C.ACME.XSC.FLD.0002", { root }), AdmissionError);
    assert.equal(existsSync(join(root, "kb", "scopes", "XSC", "fields", "C.ACME.XSC.FLD.0002.yaml")), false);
    const q = quarantine(db, "C.ACME.XSC.FLD.0002", "criterio indeterminato", { root });
    assert.equal(q.draft, true);
    assert.equal(YAML.parse(readFileSync(join(dig, "C.ACME.XSC.FLD.0002.yaml"), "utf8")).facets.F12, "quarantena");
  } finally { db.close(); }
  // il reindex successivo non duplica e non depreca: l'item ammesso resta clusterizzato
  const st = reindex(root, join(root, "knowledge.db"), { clustersDir: null });
  assert.deepEqual([st.unchanged, st.deprecated, st.invalid], [1, 0, 0]);
});

test("admit di una bozza non valida per lo schema: rifiuto di policy con i motivi, niente DEC né file", () => {
  const ws = ws0();
  const root = join(ws, "customers", "ACME");
  const dig = join(root, "_inbox", "XSC", "digested");
  mkdirSync(dig, { recursive: true });
  const bad = fldDraft(); delete bad.facets.F10;
  writeFileSync(join(dig, "C.ACME.XSC.FLD.0001.yaml"), YAML.stringify(bad));
  const db = openDb(join(root, "knowledge.db"));
  try {
    assert.throws(() => admit(db, "CL-FLD-MAND-001", "C.ACME.XSC.FLD.0001", { root }), /bozza C\.ACME\.XSC\.FLD\.0001 non valida/);
    assert.equal(db.prepare("select count(*) n from decisions").get().n, 0);
  } finally { db.close(); }
});

// ——— 5. back-check: provenienza e vocabolario non sono affermazioni della fonte (FLD reale ENEL bloccato a torto) ———
test("back-check: obbligo citato con source (codice DOC) e kind del vocabolario non è bloccato; la sezione dell'unità vale; un numero sbagliato blocca ancora", () => {
  const db = openDb(":memory:");
  try {
    upsertUnits(db, [UNIT]);
    const r = backcheck(fldDraft(), dbLookup(db));
    const v = Object.fromEntries(r.results.map((x) => [x.attribute, x.verdict]));
    assert.equal(r.blocked, false, JSON.stringify(r.results));
    assert.equal(v.section, "supportata", "l'intestazione della sezione dell'unità è testo citato");
    assert.equal(v.mandatory, "parziale", "solo vocabolario: da rivedere, non smentito");
    assert.ok(r.review.includes("mandatory"), "revisione di sicurezza: non passa in silenzio, va alla revisione umana");
    const wrong = backcheck(fldDraft({ mandatory: { kind: "conditional", when: "anno 2019" } }), dbLookup(db));
    assert.equal(wrong.blocked, true, "un numero che il testo non dice resta non supportato");
    const uncited = backcheck(fldDraft({ sources: [{ unit: "U.DOC0013.0039", attributes: ["document", "section", "mandatory"] }] }), dbLookup(db));
    assert.equal(uncited.results.find((x) => x.attribute === "custom").verdict, "non-supportata", "senza unità citata resta bloccato");
  } finally { db.close(); }
});

// ——— 6. strategy-select accetta la modalità di sessione esplorazione ———
test("strategy-select: --mode esplorazione (modalità di sessione) è ammessa come nrt (prima: exit 1 «modalità sconosciuta»)", () => {
  const a = selectStrategy({ shape: "libresco", risk: "R1", precedent: "nessuno", mode: "esplorazione" });
  const b = selectStrategy({ shape: "libresco", risk: "R1", precedent: "nessuno", mode: "nrt" });
  assert.equal(a.strategy, b.strategy);
  assert.throws(() => selectStrategy({ shape: "libresco", risk: "R1", mode: "boh" }), /sconosciuta/);
});

// ——— 7. resolve: una domanda in linguaggio naturale trova gli item (AVVA: «come creo un contratto?» → 0) ———
test("kb resolve: tutte le parole se trova qualcosa, altrimenti le parole significative (domanda dell'utente in testo libero)", () => {
  const db = openDb(":memory:");
  try {
    const ins = db.prepare("insert into items(code,level,customer,scope,type,title,summary,facets,status,path,hash,updated_at,weight) values (?,?,?,?,?,?,?,?,?,?,?,?,?)");
    ins.run("C.ACME.CON.FLW.0001", "C", "ACME", "CON", "FLW", "Creazione del contratto", "Procedura per creare un contratto dal modulo Contratti.", "{}", "digerito", "p", "h", "now", 0.5);
    db.prepare("insert into items_fts(code,title,summary) values (?,?,?)").run("C.ACME.CON.FLW.0001", "Creazione del contratto", "Procedura per creare un contratto dal modulo Contratti.");
    assert.equal(resolve(db, "come creo un contratto?", { top: 5 })[0]?.code, "C.ACME.CON.FLW.0001");
    assert.equal(resolve(db, "contratto", { top: 5 }).length, 1);
    assert.deepEqual(resolve(db, "  ?? ", { top: 5 }), []);
  } finally { db.close(); }
});

// ——— 8. self-check #1: codici esistenti (DOC profilati, bozza del compito, lezione) non sono «inesistenti» ———
test("self-check controllo 1: DOC in doc_profiles, bozza in _inbox/<S>/digested e lezione in lessons/ esistono; un codice inventato no", () => {
  const ws = ws0("ENEL");
  const root = join(ws, "customers", "ENEL");
  const dbFile = join(root, "knowledge.db");
  const db = openDb(dbFile);
  db.prepare("insert into doc_profiles(code, doc_key, doc_id) values ('C.ENEL.XSC.DOC.0152','k','d')").run();
  db.close();
  mkdirSync(join(root, "_inbox", "XSC", "digested"), { recursive: true });
  writeFileSync(join(root, "_inbox", "XSC", "digested", "C.ENEL.XSC.PRF.0001.yaml"), "id: C.ENEL.XSC.PRF.0001\n");
  mkdirSync(join(root, "lessons"), { recursive: true });
  writeFileSync(join(root, "lessons", "L.ENEL.XSC.LSN.0001.md"), "# lezione\n");
  const sdir = join(root, ".sessions", "s1");
  mkdirSync(sdir, { recursive: true });
  writeFileSync(join(sdir, "session.json"), JSON.stringify({ customer: "ENEL", allowed_paths: [] }));
  writeFileSync(join(sdir, "audit.jsonl"), "");
  const rep = (extra) => YAML.stringify({ task_id: "T1", status: "ok", output: { profile: "C.ENEL.XSC.PRF.0001", summary: "ok" },
    cognitive_trace: { depth: "rapida", recalled: { semantic: ["C.ENEL.XSC.DOC.0152", ...extra] }, epistemic: { subject: "C.ENEL.XSC.PRF.0001", shape_before: "ignoto", shape_after: "libresco" }, decisions: [], surprises: [] },
    lesson: "L.ENEL.XSC.LSN.0001", open_questions: [] });
  const run = (extra) => {
    writeFileSync(join(sdir, "report.yaml"), rep(extra));
    const r = spawnSync(process.execPath, [SELF_CHECK, "--report", join(sdir, "report.yaml"), "--session", join(sdir, "session.json"), "--audit", join(sdir, "audit.jsonl"), "--db", dbFile, "--depth", "rapida", "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: ws }) });
    return JSON.parse(r.stdout);
  };
  assert.ok(!run([]).failed.some((f) => f.n === 1), JSON.stringify(run([]).failed));
  const bad = run(["C.ENEL.XSC.CFG.0999"]).failed.find((f) => f.n === 1);
  assert.match(bad?.reason ?? "", /C\.ENEL\.XSC\.CFG\.0999/);
  assert.doesNotMatch(bad.reason, /DOC\.0152|PRF\.0001|LSN\.0001/);
});

// ——— 9. reindex non si ferma al primo file illeggibile e non depreca l'item il cui file c'è ancora ———
test("reindex: un YAML illeggibile o un item non valido è tracciato in errors, gli altri si indicizzano, l'item già indicizzato non si depreca", () => {
  const ws = ws0();
  const root = join(ws, "customers", "ACME");
  const dir = join(root, "kb", "scopes", "XSC", "fields");
  mkdirSync(dir, { recursive: true });
  const put = (o) => writeFileSync(join(dir, `${o.id}.yaml`), YAML.stringify(o));
  put(fldDraft()); put(fldDraft({ id: "C.ACME.XSC.FLD.0002" }));
  const dbFile = join(root, "knowledge.db");
  assert.equal(reindex(root, dbFile, { clustersDir: null }).upserted, 2);
  writeFileSync(join(dir, "C.ACME.XSC.FLD.0001.yaml"), "id: C.ACME.XSC.FLD.0001\ntitle: [non chiuso\n");
  put(fldDraft({ id: "C.ACME.XSC.FLD.0002", facets: { ...FACETS, F10: "R9" } }));
  put(fldDraft({ id: "C.ACME.XSC.FLD.0003" }));
  const st = reindex(root, dbFile, { clustersDir: null });
  assert.equal(st.upserted, 1, JSON.stringify(st));
  assert.equal(st.invalid, 2);
  assert.equal(st.deprecated, 0, "i file ci sono ancora: si correggono, non si deprecano");
  assert.deepEqual(st.errors.map((e) => e.code).sort(), ["C.ACME.XSC.FLD.0001", "C.ACME.XSC.FLD.0002"]);
  assert.match(st.errors.find((e) => e.code === "C.ACME.XSC.FLD.0001").error, /illeggibile/);
  const db = openDb(dbFile);
  try { assert.deepEqual(db.prepare("select code, status from items order by code").all().map((r) => r.status), ["digerito", "digerito", "digerito"]); } finally { db.close(); }
});

// ——— 10. record-answers: un attributo sconosciuto non butta via le risposte valide ———
test("digest-plan record-answers: attributo fuori registro tracciato in errors, le risposte valide registrate e la completezza calcolata", () => {
  const db = openDb(":memory:");
  try {
    upsertUnits(db, [UNIT]);
    const r = recordAnswers(db, { subject: "C.ACME.XSC.FLD.0001", type: "FLD", answers: [{ attribute: "mandatory", units: ["U.DOC0013.0039"] }, { attribute: "obbligatorieta", units: ["U.DOC0013.0039"] }] });
    assert.equal(r.attrs.mandatory, "tecnica");
    assert.equal(r.errors.length, 1);
    assert.match(r.errors[0].error, /non atteso/);
    assert.ok(r.completeness.outcome);
    assert.throws(() => recordAnswers(db, { subject: "C.ACME.XSC.FLD.0001", type: "FLD", answers: [{ attribute: "boh", units: [] }] }), /non attesi/);
  } finally { db.close(); }
});

// ——— 11. kb next-code: il codice della bozza dal DB, oltre le bozze già scritte (prima: nessun comando, codici inventati) ———
test("kb next-code: prossimi codici liberi oltre il DB, le bozze in _inbox e i file di kb/ non indicizzati", () => {
  const ws = ws0();
  const root = join(ws, "customers", "ACME");
  const dbFile = join(root, "knowledge.db");
  openDb(dbFile).close();
  mkdirSync(join(root, "_inbox", "XSC", "digested"), { recursive: true });
  writeFileSync(join(root, "_inbox", "XSC", "digested", "C.ACME.XSC.FLD.0004.yaml"), "id: x\n");
  mkdirSync(join(root, "kb", "scopes", "XSC", "fields"), { recursive: true });
  writeFileSync(join(root, "kb", "scopes", "XSC", "fields", "C.ACME.XSC.FLD.0006.yaml"), "id: x\n");
  const cli = (...a) => spawnSync(process.execPath, [KB_CLI, "next-code", ...a, "--db", dbFile, "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: ws }) });
  const r = cli("--scope", "XSC", "--type", "FLD", "--customer", "ACME", "--count", "2");
  assert.equal(r.status, 0, r.stdout);
  assert.deepEqual(JSON.parse(r.stdout).codes, ["C.ACME.XSC.FLD.0007", "C.ACME.XSC.FLD.0008"]);
  assert.equal(JSON.parse(cli("--scope", "XSC", "--type", "CFG", "--customer", "ACME").stdout).next, "C.ACME.XSC.CFG.0001");
  assert.equal(cli("--scope", "ZZZ", "--type", "FLD", "--customer", "ACME").status, 1);
  assert.equal(cli("--scope", "XSC", "--type", "FLD").status, 1, "senza cliente");
  assert.ok(!readdirSync(join(root, "_inbox", "XSC", "digested")).includes("C.ACME.XSC.FLD.0007.yaml"), "non prenota nulla");
});

// ——— 13. node:sqlite: scrittori in parallelo (hook, agenti, script) non perdono DEC per «database is locked» ———
test("tre processi che scrivono DEC insieme sullo stesso DB: nessun «database is locked», codici tutti distinti", async () => {
  const { spawn } = await import("node:child_process");
  const ws = ws0();
  const root = join(ws, "customers", "ACME");
  const dbFile = join(root, "knowledge.db");
  openDb(dbFile).close();
  const url = (p) => new URL(p, import.meta.url).href;
  const code = `const { openDb } = await import(${JSON.stringify(url("../../scripts/kb/db.mjs"))});
    const { writeDecision, evaluate, loadTable } = await import(${JSON.stringify(url("../../scripts/decide/dt-eval.mjs"))});
    const result = evaluate(loadTable("DT-022"), { coverage_deficit: 0.4, critical_missing: false, r2_critical_missing: true, below_type_threshold: true });
    let fail = 0;
    for (let i = 0; i < 15; i++) { let db; try { db = openDb(process.argv[1]); writeDecision(db, { customer: "ACME", scope: "XSC", root: process.argv[2], result, at: new Date().toISOString() }); } catch (e) { fail++; console.error(e.message); } finally { db?.close(); } }
    process.exitCode = fail ? 4 : 0;`;
  const one = () => new Promise((res) => { const p = spawn(process.execPath, ["--input-type=module", "-e", code, dbFile, root], { stdio: ["ignore", "ignore", "pipe"] }); let err = ""; p.stderr.on("data", (d) => { err += d; }); p.on("close", (c) => res({ c, err })); });
  const rs = await Promise.all([one(), one(), one()]);
  assert.deepEqual(rs.map((r) => r.c), [0, 0, 0], rs.map((r) => r.err).join("\n"));
  const db = openDb(dbFile);
  try { assert.deepEqual(db.prepare("select count(*) n, count(distinct code) d from decisions").get(), { n: 45, d: 45 }); } finally { db.close(); }
});

// ——— 14. compose-plan: i SEL si leggono solo quando servono (AVVA: 484 s per rispondere «no-form») ———
test("compose-plan: senza modulo di creazione la mancanza no-form arriva senza leggere i SEL; con il modulo il piano usa la lettura leggera", async () => {
  const { composePlan } = await import("../../scripts/decide/compose-plan.mjs");
  const ws = ws0();
  const sel = join(ws, "customers", "ACME", "kb", "scopes", "P2P", "selectors");
  mkdirSync(join(ws, "customers", "ACME", "kb", "scopes", "P2P"), { recursive: true });
  writeFileSync(sel, "non una cartella");   // se compose-plan la leggesse, readdirSync fallirebbe (ENOTDIR)
  const r = composePlan({ ws, customer: "ACME", scope: "P2P", env: { id: "sbx", type: "sandbox" }, goal: "crea contratto", data: {}, planId: "PLAN.ACME.T.0001" });
  assert.equal(r.gaps?.[0]?.kind, "no-form");
  rmSync(sel);
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page: { signature: "p2p/po/new#t", title: "Nuovo ordine" }, items: [{ type: "FLD", label: "Descrizione", document: "Nuovo ordine", field_type: "text" }] } });
  const fld = readdirSync(join(ws, "customers", "ACME", "kb", "scopes", "P2P", "fields"))[0].slice(0, -5);
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page: { signature: "p2p/po/new#t", title: "Nuovo ordine" }, items: [{ type: "SEL", label: "Descrizione", role: "textbox", field: fld }, { type: "SEL", label: "Salva bozza", role: "button", effect: "write" }] } });
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { items: [{ type: "FLW", title: "Percorso: Nuovo ordine", trigger: "navigazione", steps: [{ verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "/p2p/po/new" }, expect: { page_sig: "p2p/po/new" } }] }] } });
  const p = composePlan({ ws, customer: "ACME", scope: "P2P", env: { id: "sbx", type: "sandbox" }, goal: "crea ordine", data: { Descrizione: "Sedie" }, planId: "PLAN.ACME.T.0002" });
  assert.ok(p.plan, JSON.stringify(p.gaps));
  assert.deepEqual(p.plan.steps.map((s) => s.verb), ["NAVIGATE", "FILL", "SAVE"]);
});

// ——— 15. reindex: le unità invariate non si rileggono (ENEL: 17578 file riletti a ogni reindex) ———
test("reindex: un file di unità non più recente della sua riga non si rilegge; uno più recente sì", async () => {
  const { utimesSync } = await import("node:fs");
  const { writeUnits } = await import("../../scripts/kb/units.mjs");
  const ws = ws0();
  const root = join(ws, "customers", "ACME");
  const unitsDir = join(root, "sources", "units");
  writeUnits(unitsDir, [UNIT, { ...UNIT, id: "U.DOC0013.0040", hash: "h40", text: "seconda unità del documento" }]);
  const dbFile = join(root, "knowledge.db");
  assert.equal(reindex(root, dbFile, { clustersDir: null }).units_upserted, 2);
  const f39 = join(unitsDir, "DOC0013", "U.DOC0013.0039.yaml");
  // contenuto illeggibile ma data vecchia: invariato per data ⇒ non si rilegge (nessun errore, la riga resta)
  writeFileSync(f39, "id: [rotto\n");
  utimesSync(f39, new Date("2020-01-01"), new Date("2020-01-01"));
  const st = reindex(root, dbFile, { clustersDir: null });
  assert.deepEqual([st.units_scanned, st.units_unchanged, st.units_upserted], [2, 2, 0]);
  // file più recente con testo nuovo ⇒ riletto e aggiornato
  writeFileSync(f39, YAML.stringify({ ...UNIT, hash: "h39b", text: "testo cambiato" }));
  utimesSync(f39, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
  assert.equal(reindex(root, dbFile, { clustersDir: null }).units_upserted, 1);
  const db = openDb(dbFile);
  try { assert.equal(db.prepare("select text from units where code='U.DOC0013.0039'").get().text, "testo cambiato"); } finally { db.close(); }
});

// ——— 16. openDb non chiede il blocco di scrittura se lo schema c'è: le letture passano durante uno scrittore lungo ———
test("kb find mentre un'altra connessione tiene una transazione di scrittura: nessun «database is locked»", () => {
  const ws = ws0();
  const dbFile = join(ws, "customers", "ACME", "knowledge.db");
  const writer = openDb(dbFile);
  try {
    writer.exec("BEGIN IMMEDIATE");
    writer.prepare("insert into meta(key, value) values ('prova', '1')").run();
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [KB_CLI, "find", "--scope", "XSC", "--db", dbFile, "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: ws }) });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(Date.now() - t0 < 4500, "nessuna attesa del busy_timeout");
    writer.exec("ROLLBACK");
  } finally { writer.close(); }
});

// ——— 17. lezioni: la bozza del compito e il DOC profilato non rendono la lezione «forma: codici inesistenti» ———
test("validazione delle lezioni: codici della bozza in _inbox e del DOC profilato esistono (L.ENEL.XSC.LSN.0001 rifiutata a torto)", async () => {
  const { kbExistsFromDb } = await import("../../scripts/kb/lesson.mjs");
  const ws = ws0("ENEL");
  const root = join(ws, "customers", "ENEL");
  const db = openDb(join(root, "knowledge.db"));
  try {
    db.prepare("insert into doc_profiles(code, doc_key, doc_id) values ('C.ENEL.XSC.DOC.0152','k','d')").run();
    mkdirSync(join(root, "_inbox", "XSC", "digested"), { recursive: true });
    writeFileSync(join(root, "_inbox", "XSC", "digested", "C.ENEL.XSC.PRF.0001.yaml"), "id: C.ENEL.XSC.PRF.0001\n");
    const exists = kbExistsFromDb(db, root);
    assert.equal(exists("C.ENEL.XSC.PRF.0001"), true);
    assert.equal(exists("C.ENEL.XSC.DOC.0152"), true);
    assert.equal(exists("C.ENEL.XSC.CFG.0001"), false);
    assert.equal(kbExistsFromDb(db)("C.ENEL.XSC.PRF.0001"), false, "senza cartella del cliente solo il DB");
  } finally { db.close(); }
});

// ——— 18. (ciclo 5) lezioni: i codici S stanno nel kb di prodotto, non nel DB del cliente ———
test("validazione delle lezioni: un codice S del kb di prodotto del plugin o dell'indice del prodotto esiste (L.AVVA.ADM.LSN.0001 → S.STD.ADM.CHK.0019)", async () => {
  const { kbExistsFromDb } = await import("../../scripts/kb/lesson.mjs");
  const ws = ws0("AVVA");
  const root = join(ws, "customers", "AVVA");
  mkdirSync(join(ws, "product"), { recursive: true });
  const pdb = openDb(join(ws, "product", "knowledge.db"));
  pdb.prepare("insert into items(code,level,customer,scope,type,title,summary,facets,status,path,hash,updated_at) values ('S.STD.SRC.FLW.0007','S','STD','SRC','FLW','t','s','{}','validato','p','h','now')").run();
  pdb.close();
  const db = openDb(join(root, "knowledge.db"));
  try {
    const exists = kbExistsFromDb(db, root);
    assert.equal(exists("S.STD.ADM.CHK.0019"), true, "nel product/kb del plugin");
    assert.equal(exists("S.STD.SRC.FLW.0007"), true, "nell'indice del prodotto del workspace");
    assert.equal(exists("S.STD.ADM.CHK.0999"), false);
    exists.close();
  } finally { db.close(); }
});

// ——— 19. (ciclo 5) lezioni con `code:` al posto di `id:`: mai il percorso del file come codice ———
test("validazione delle lezioni: `code` vale come `id`; la riga della tabella lessons ha il codice della lezione, non il percorso", async () => {
  const { validateLessons } = await import("../../scripts/kb/lesson.mjs");
  const ws = ws0("AVVA");
  const root = join(ws, "customers", "AVVA");
  mkdirSync(join(root, "lessons"), { recursive: true });
  writeFileSync(join(root, "lessons", "L.AVVA.ANL.LSN.0001.md"), "---\ncode: L.AVVA.ANL.LSN.0001\nstatus: proposed\nscope: ANL\ntask: TSK.AVVA.ANL.20261026.003\n---\n# Lezione\n\n1. Contesto: prova.\n");
  const db = openDb(join(root, "knowledge.db"));
  try {
    const r = validateLessons(db, root, {});
    assert.equal(r[0].code, "L.AVVA.ANL.LSN.0001");
    assert.equal(r[0].status, "rejected", "forma incompleta: rifiutata con il motivo");
    assert.deepEqual(db.prepare("select code from lessons").all().map((x) => x.code), ["L.AVVA.ANL.LSN.0001"]);
    const text = readFileSync(join(root, "lessons", "L.AVVA.ANL.LSN.0001.md"), "utf8");
    assert.match(text, /\nid: L\.AVVA\.ANL\.LSN\.0001\n/);
    assert.doesNotMatch(text, /\ncode: /);
  } finally { db.close(); }
});

// ——— 20. (ciclo 5) reindex incrementale: un item invariato (stesso percorso e data) non si rilegge ———
test("reindex incrementale: file invariato per percorso e data ⇒ non riletto; data cambiata ⇒ riletto (e la data si allinea)", async () => {
  const { utimesSync, statSync } = await import("node:fs");
  const ws = ws0();
  const root = join(ws, "customers", "ACME");
  const dir = join(root, "kb", "scopes", "XSC", "fields");
  mkdirSync(dir, { recursive: true });
  const f1 = join(dir, "C.ACME.XSC.FLD.0001.yaml");
  writeFileSync(f1, YAML.stringify(fldDraft()));
  writeFileSync(join(dir, "C.ACME.XSC.FLD.0002.yaml"), YAML.stringify(fldDraft({ id: "C.ACME.XSC.FLD.0002" })));
  const dbFile = join(root, "knowledge.db");
  // una data a secondi interi (rappresentabile esattamente: utimes con i millesimi può arrotondare di 1 ms)
  const T = new Date("2026-01-01T00:00:00Z");
  utimesSync(f1, T, T);
  assert.equal(reindex(root, dbFile, { clustersDir: null }).upserted, 2);
  assert.equal(statSync(f1).mtime.getTime(), T.getTime());
  writeFileSync(f1, "id: [rotto\n");
  utimesSync(f1, T, T);   // stessa data: il contenuto non si guarda
  const st = reindex(root, dbFile, { clustersDir: null });
  assert.deepEqual([st.unchanged, st.invalid, st.errors.length], [2, 0, 0], JSON.stringify(st));
  utimesSync(f1, new Date(Date.now() + 60000), new Date(Date.now() + 60000));
  const st2 = reindex(root, dbFile, { clustersDir: null });
  assert.equal(st2.invalid, 1, "data cambiata: riletto, l'errore si vede");
  writeFileSync(f1, YAML.stringify(fldDraft()));
  const st3 = reindex(root, dbFile, { clustersDir: null });
  assert.deepEqual([st3.unchanged, st3.upserted], [2, 0], "contenuto uguale: invariato, la data della riga si allinea");
  assert.equal(reindex(root, dbFile, { clustersDir: null, recompute: true }).rescored, 2, "--recompute rilegge tutto");
});

// ——— 21. kb epistemic <soggetto> di una bozza con la copertura registrata (prima: «soggetto non trovato») ———
test("kb epistemic su un soggetto in digestione: forma e gap dalla copertura di record-answers; senza copertura resta non trovato", async () => {
  const { subjectProfile } = await import("../../scripts/kb/coverage-report.mjs");
  const db = openDb(":memory:");
  try {
    upsertUnits(db, [UNIT]);
    recordAnswers(db, { subject: "C.ACME.XSC.FLD.0001", type: "FLD", answers: [{ attribute: "mandatory", units: ["U.DOC0013.0039"], genre: "d'uso" }, { attribute: "document", units: ["U.DOC0013.0039"], genre: "d'uso" }] });
    const p = subjectProfile(db, "C.ACME.XSC.FLD.0001");
    assert.equal(p.status, "in digestione");
    assert.equal(p.source, "digestione");
    assert.ok(!p.gaps.includes("mandatory") && p.gaps.includes("lineage"));
    assert.throws(() => subjectProfile(db, "C.ACME.XSC.FLD.0002"), /non trovato/);
  } finally { db.close(); }
});

// ——— 22. lezioni: contano le sorprese dei compiti dell'agente della lezione, non di tutta la sessione ———
test("fondatezza delle lezioni: 16 sorprese di un altro compito non rendono «non fondata» la lezione del customer-profiler", async () => {
  const { lessonSurpriseCount } = await import("../../scripts/kb/lesson.mjs");
  const list = [...Array(16)].map(() => ({ task: "TSK.ENEL.XSC.DIG.0001", item: "x" })).concat([{ task: "TSK.ENEL.XSC.PRF.0001", item: "y" }, { item: "senza compito" }]);
  const tasks = new Map([["customer-profiler", new Set(["TSK.ENEL.XSC.PRF.0001"])], ["scope-digester", new Set(["TSK.ENEL.XSC.DIG.0001", "TSK.ENEL.XSC.DIG.0002"])]]);
  const ctx = { surprises: list.length, surprise_list: list, tasks_by_agent: tasks };
  assert.equal(lessonSurpriseCount(ctx, { agent: "customer-profiler" }), 2, "la sua e quella senza compito");
  assert.equal(lessonSurpriseCount(ctx, { agent: "scope-digester" }), 17);
  assert.equal(lessonSurpriseCount(ctx, { agent: "scope-digester" }, "compito TSK.ENEL.XSC.DIG.0002"), 1, "il compito citato restringe");
  assert.equal(lessonSurpriseCount({ ...ctx, tasks_by_agent: new Map() }, { agent: "customer-profiler" }), 18, "senza registro degli agenti: tutte");
});

// ——— 23. lezioni delle esplorazioni: mode esplorazione è una modalità di sessione valida (L.AVVA.SRC.LSN.0001) ———
test("schema della lezione: mode esplorazione ammessa (prima «forma: /mode must be equal to one of the allowed values»)", async () => {
  const { validateWith } = await import("../../scripts/lib/schemas.mjs");
  const fm = { id: "L.AVVA.SRC.LSN.0001", agent: "scope-expert", session: "SES.AVVA.20261029.001", task: "esplorazione", scope: "SRC", mode: "esplorazione",
    decision_refs: [], strategy: "STR-EXPLORE-BUDGET", epistemic_before: "ignoto", epistemic_after: "empirico", surprises: 0, expected_outcomes: [], status: "proposed",
    confidence: 0.6, portability_hypothesis: { class: "ignota" }, cluster_proposal: null };
  assert.deepEqual(validateWith("lesson.schema.json", fm).errors, []);
  assert.equal(validateWith("lesson.schema.json", { ...fm, mode: "boh" }).ok, false);
});

// ——— 24. validate-schema su più bozze: un file malformato non ferma gli altri e non è un «errore di sistema» ———
test("validate-schema: bozza malformata ⇒ non valida (exit 1) con il motivo; le altre bozze hanno il loro esito", () => {
  const ws = ws0();
  const dig = join(ws, "customers", "ACME", "_inbox", "XSC", "digested");
  mkdirSync(dig, { recursive: true });
  writeFileSync(join(dig, "rotta.yaml"), "id: [non chiuso\n");
  writeFileSync(join(dig, "C.ACME.XSC.FLD.0001.yaml"), YAML.stringify(fldDraft()));
  const r = spawnSync(process.execPath, [join(PLUGIN, "scripts", "kb", "validate-schema.mjs"), join(dig, "rotta.yaml"), join(dig, "C.ACME.XSC.FLD.0001.yaml"), "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: ws }) });
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.results.map((x) => x.ok), [false, true]);
  assert.match(out.results[0].errors[0], /illeggibile/);
});

// ——— 12. graph: il DOC profilato e la DEC citati da un item non sono riferimenti pendenti (ENEL: exit 3 a ogni digerito) ———
test("kb graph: riferimenti a DOC profilati (doc_profiles) e DEC esistono; un codice inventato resta pendente", async () => {
  const { graph } = await import("../../scripts/kb/registries.mjs");
  const ws = ws0();
  const root = join(ws, "customers", "ACME");
  const dir = join(root, "kb", "scopes", "XSC", "fields");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "C.ACME.XSC.FLD.0001.yaml"), YAML.stringify(fldDraft({ notes: "deciso in L.ACME.XSC.DEC.0001" })));
  const dbFile = join(root, "knowledge.db");
  reindex(root, dbFile, { clustersDir: null });
  const db = openDb(dbFile);
  try {
    db.prepare("insert into doc_profiles(code, doc_key, doc_id) values ('C.ACME.XSC.DOC.0013','k','d')").run();
    db.prepare("insert into decisions(code, table_code) values ('L.ACME.XSC.DEC.0001','DT-020')").run();
    assert.deepEqual(graph(db, { root, scope: "XSC" }).dangling, []);
    writeFileSync(join(dir, "C.ACME.XSC.FLD.0001.yaml"), YAML.stringify(fldDraft({ notes: "vedi C.ACME.XSC.CFG.0999" })));
    assert.deepEqual(graph(db, { root, scope: "XSC" }).dangling.map((d) => d.to), ["C.ACME.XSC.CFG.0999"]);
  } finally { db.close(); }
});
