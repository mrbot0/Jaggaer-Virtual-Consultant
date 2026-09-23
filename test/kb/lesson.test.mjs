import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseLesson, validateLesson, sectionEmpty } from "../../scripts/kb/lesson.mjs";
import { validateWith } from "../../scripts/lib/schemas.mjs";
import { openDb } from "../../scripts/kb/db.mjs";

const LEARN = fileURLToPath(new URL("../../scripts/digest/learn.mjs", import.meta.url));
const TEMPLATE = fileURLToPath(new URL("../../templates/lesson.md", import.meta.url));

// §21.1, con il frontmatter compatto della spec (più chiavi per riga separate da " · ").
const LESSON = `---
id: L.ACME.P2P.LSN.0088
agent: p2p-expert · session: SES.ACME.20260922.003 · task: "Eseguire NRT.ACME.P2P.NEG.0031"
scope: P2P · mode: NRT
decision_refs: [L.ACME.P2P.DEC.0412, L.ACME.P2P.DEC.0413]
strategy: STR-REPLAY
epistemic_before: consolidato · epistemic_after: consolidato · surprises: 0
expected_outcomes: [{ decision: L.ACME.P2P.DEC.0412, expect: "Defect accettato come regressione" }, { decision: L.ACME.P2P.DEC.0413, expect: "NRT.ACME.P2P.NEG.0031 verde dopo il fix" }]
status: proposed · confidence: 0.85
portability_hypothesis: { class: condizionata, condition: "CL-CFG-005 form con CdC a testo libero" }
cluster_proposal: CL-CHK-002
---
## 1. Contesto
Fallimento di NRT.ACME.P2P.NEG.0031 al passo 4 su L.ACME.P2P.OBS.0240.
## 2. Cosa ho tentato
Classificazione con DT-001 e precedente L.ACME.P2P.DEC.0290.
## 3. Cosa ho osservato
Ordine SENT con errore 51 (L.ACME.P2P.OBS.0240).
## 4. Decisioni prese
DT-018 → replay; DT-001 → product-defect (L.ACME.P2P.DEC.0412), strategia STR-REPLAY.
## 5. Esito
Defect aperto come regressione.
## 6. Lezione
Un Defect chiuso come fixed e ricomparso è una regressione: proposta di regola per defect-reporter.
## 7. Cosa NON generalizzerei
Il titolo del Defect dipende dal form CL-CFG-005 con CdC a testo libero (F6).
## 8. Domande aperte
Nessuna.
`;

const KNOWN = new Set(["L.ACME.P2P.DEC.0412", "L.ACME.P2P.DEC.0413", "L.ACME.P2P.DEC.0290", "L.ACME.P2P.OBS.0240", "L.ACME.P2P.OBS.0241"]);
const kbExists = (c) => KNOWN.has(c);
const opts = (extra = {}) => ({ kbExists, sessionSurprises: 0, hypotheses: null, validatedLessons: [], ...extra });
const edit = (md, from, to) => { assert.ok(md.includes(from), `testo da sostituire assente: ${from}`); return md.replace(from, to); };

test("§21.1 parseLesson: frontmatter (anche compatto con ' · ') e otto sezioni", () => {
  const l = parseLesson(LESSON);
  assert.deepEqual(l.errors, []);
  assert.equal(l.frontmatter.id, "L.ACME.P2P.LSN.0088");
  assert.equal(l.frontmatter.agent, "p2p-expert");
  assert.equal(l.frontmatter.session, "SES.ACME.20260922.003");
  assert.equal(l.frontmatter.task, "Eseguire NRT.ACME.P2P.NEG.0031");
  assert.equal(l.frontmatter.surprises, 0);
  assert.equal(l.frontmatter.confidence, 0.85);
  assert.deepEqual(Object.keys(l.sections), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  assert.match(l.sections[7], /CL-CFG-005/);
  assert.ok(validateWith("lesson.schema.json", l.frontmatter).ok);
  assert.equal(sectionEmpty("<!-- da compilare -->\n  "), true);
  assert.equal(sectionEmpty("nessuna."), true);
});

test("§21.2 caso felice → validated", () => {
  const r = validateLesson(parseLesson(LESSON), opts());
  assert.equal(r.status, "validated", JSON.stringify(r.reasons));
  assert.equal(r.inert, false);
  assert.deepEqual(r.reasons, []);
  assert.equal(r.dt.table, "DT-004");
});

test("§21.2 §7 vuota → rejected", () => {
  const md = edit(LESSON, "Il titolo del Defect dipende dal form CL-CFG-005 con CdC a testo libero (F6).", "<!-- nulla -->");
  const r = validateLesson(parseLesson(md), opts());
  assert.equal(r.status, "rejected");
  assert.equal(r.reason, "§7 vuota");
});

test("§21.2 esiti attesi mancanti per una DEC con effetti → rejected: non verificabile", () => {
  const md = edit(LESSON, `, { decision: L.ACME.P2P.DEC.0413, expect: "NRT.ACME.P2P.NEG.0031 verde dopo il fix" }`, "");
  const r = validateLesson(parseLesson(md), opts());
  assert.equal(r.status, "rejected");
  assert.equal(r.reason, "non verificabile");
  // una DEC dichiaratamente senza effetti non richiede l'esito atteso
  const ok = validateLesson(parseLesson(md), opts({ hasEffects: (d) => d !== "L.ACME.P2P.DEC.0413" }));
  assert.equal(ok.status, "validated");
});

test("§21.2 forma: frontmatter incompleto, sezione mancante o codice inesistente → rejected: forma", () => {
  assert.equal(validateLesson(parseLesson(edit(LESSON, "strategy: STR-REPLAY\n", "")), opts()).reason, "forma");
  assert.equal(validateLesson(parseLesson(edit(LESSON, "## 8. Domande aperte\nNessuna.\n", "")), opts()).reason, "forma");
  const r = validateLesson(parseLesson(edit(LESSON, "(L.ACME.P2P.OBS.0240).", "(L.ACME.P2P.OBS.0999).")), opts());
  assert.equal(r.reason, "forma");
  assert.ok(r.reasons.some((x) => /L\.ACME\.P2P\.OBS\.0999/.test(x.detail)));
});

test("§21.2 confini: analysis/, un altro cliente o un altro scope senza handoff → rejected: confine", () => {
  const known = (c) => kbExists(c) || /^(L|C)\.(BETA|ACME)\./.test(c) || c.startsWith("S.STD.");
  const a = validateLesson(parseLesson(edit(LESSON, "Nessuna.", "Vedi customers/ACME/analysis/briefs.")), opts({ kbExists: known }));
  assert.equal(a.reason, "confine");
  const b = validateLesson(parseLesson(edit(LESSON, "Nessuna.", "Su BETA vale L.BETA.P2P.DEC.0119?")), opts({ kbExists: known }));
  assert.equal(b.reason, "confine");
  const c = validateLesson(parseLesson(edit(LESSON, "Nessuna.", "Tocca anche C.ACME.ADM.CFG.0019?")), opts({ kbExists: known }));
  assert.equal(c.reason, "confine");
  const withHnd = validateLesson(parseLesson(edit(LESSON, "Nessuna.", "Tocca anche C.ACME.ADM.CFG.0019 via C.ACME.XSC.HND.0004?")), opts({ kbExists: known }));
  assert.equal(withHnd.status, "validated");
});

test("§17.3 narrazione a posteriori: sorprese o ipotesi rifiutate in sessione ma §3 non ne cita → rejected: non fondata", () => {
  const r = validateLesson(parseLesson(edit(LESSON, "Ordine SENT con errore 51 (L.ACME.P2P.OBS.0240).", "Tutto come previsto.")), opts({ sessionSurprises: 1 }));
  assert.equal(r.status, "rejected");
  assert.equal(r.reason, "non fondata");
  const hyp = { hypotheses: [{ id: "H2", claim: "rielaborato", prior: 0.3, evidence_for: [], evidence_against: ["OBS.0241"], status: "refuted" }] };
  assert.equal(validateLesson(parseLesson(LESSON), opts({ hypotheses: hyp })).reason, "non fondata");
  const cited = edit(LESSON, "Ordine SENT con errore 51 (L.ACME.P2P.OBS.0240).", "Ordine SENT con errore 51 (L.ACME.P2P.OBS.0240); H2 esclusa (L.ACME.P2P.OBS.0241).");
  assert.equal(validateLesson(parseLesson(cited), opts({ hypotheses: hyp })).status, "validated");
});

test("§21.2 duplicato di una lezione validata → merged; nessun artefatto candidato → validated: inerte", () => {
  const prior = parseLesson(edit(LESSON, "L.ACME.P2P.LSN.0088", "L.ACME.P2P.LSN.0071"));
  prior.frontmatter.status = "validated";
  const r = validateLesson(parseLesson(LESSON), opts({ validatedLessons: [prior] }));
  assert.equal(r.status, "merged");
  assert.equal(r.merged_into, "L.ACME.P2P.LSN.0071");
  const inert = edit(edit(LESSON, "cluster_proposal: CL-CHK-002\n", "cluster_proposal: null\n"),
    "Un Defect chiuso come fixed e ricomparso è una regressione: proposta di regola per defect-reporter.", "Un Defect chiuso come fixed e ricomparso è una regressione.");
  const ri = validateLesson(parseLesson(inert), opts());
  assert.equal(ri.status, "validated");
  assert.equal(ri.inert, true);
  assert.equal(ri.reason, "inerte");
});

test("templates/lesson.md: lo scheletro di §21.1 con il frontmatter completo e le otto sezioni", () => {
  const t = parseLesson(readFileSync(TEMPLATE, "utf8"));
  assert.deepEqual(t.errors, []);
  assert.deepEqual(Object.keys(t.sections), ["1", "2", "3", "4", "5", "6", "7", "8"]);
  const schema = JSON.parse(readFileSync(new URL("../../schemas/lesson.schema.json", import.meta.url), "utf8"));
  for (const k of schema.required) assert.ok(k in t.frontmatter, `il template non ha ${k}`);
  assert.equal(sectionEmpty(t.sections[7]), true, "nel template la §7 è da compilare");
});

test("CLI learn validate --session: aggiorna lo stato nei file e nel DB, registra gli esiti attesi e la DEC di DT-004", () => {
  const root = mkdtempSync(join(tmpdir(), "lsn-"));
  mkdirSync(join(root, "lessons"), { recursive: true });
  const dbFile = join(root, "knowledge.db");
  const db = openDb(dbFile);
  const dec = db.prepare("insert into decisions(code,table_code,agent,session,inputs,outcome,at) values (?,?,?,?,?,?,?)");
  for (const c of ["L.ACME.P2P.DEC.0412", "L.ACME.P2P.DEC.0413", "L.ACME.P2P.DEC.0290"]) dec.run(c, "DT-001", "p2p-expert", "SES.ACME.20260922.003", "{}", "product-defect", "2026-09-22");
  db.prepare("insert into observations(code, session) values (?,?)").run("L.ACME.P2P.OBS.0240", "SES.ACME.20260922.003");
  db.close();
  writeFileSync(join(root, "lessons", "L.ACME.P2P.LSN.0088.md"), LESSON);
  writeFileSync(join(root, "lessons", "L.ACME.P2P.LSN.0089.md"),
    edit(edit(LESSON, "L.ACME.P2P.LSN.0088", "L.ACME.P2P.LSN.0089"), "Il titolo del Defect dipende dal form CL-CFG-005 con CdC a testo libero (F6).", ""));
  writeFileSync(join(root, "lessons", "L.ACME.P2P.LSN.0090.md"),
    edit(edit(LESSON, "L.ACME.P2P.LSN.0088", "L.ACME.P2P.LSN.0090"), "SES.ACME.20260922.003", "SES.ACME.20260923.001"));
  const r = spawnSync(process.execPath, [LEARN, "validate", "--session", "SES.ACME.20260922.003", "--root", root, "--db", dbFile, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.deepEqual(out.results.map((x) => [x.code, x.status]), [["L.ACME.P2P.LSN.0088", "validated"], ["L.ACME.P2P.LSN.0089", "rejected"]]);
  const f88 = parseLesson(readFileSync(join(root, "lessons", "L.ACME.P2P.LSN.0088.md"), "utf8"));
  assert.equal(f88.frontmatter.status, "validated");
  assert.equal(f88.frontmatter.validation.table, "DT-004");
  assert.match(f88.frontmatter.validation.decision, /^L\.ACME\.P2P\.DEC\.\d{4}$/);
  assert.match(f88.sections[6], /regressione/, "il corpo della lezione resta intatto");
  assert.equal(parseLesson(readFileSync(join(root, "lessons", "L.ACME.P2P.LSN.0089.md"), "utf8")).frontmatter.validation.reason, "§7 vuota");
  assert.equal(parseLesson(readFileSync(join(root, "lessons", "L.ACME.P2P.LSN.0090.md"), "utf8")).frontmatter.status, "proposed", "altra sessione: non toccata");
  const check = openDb(dbFile);
  assert.equal(check.prepare("select status from lessons where code=?").get("L.ACME.P2P.LSN.0088").status, "validated");
  assert.equal(check.prepare("select status from lessons where code=?").get("L.ACME.P2P.LSN.0089").status, "rejected");
  assert.deepEqual(check.prepare("select decision_code, lesson_code from expected_outcomes order by decision_code").all(),
    [{ decision_code: "L.ACME.P2P.DEC.0412", lesson_code: "L.ACME.P2P.LSN.0088" }, { decision_code: "L.ACME.P2P.DEC.0413", lesson_code: "L.ACME.P2P.LSN.0088" }]);
  assert.equal(check.prepare("select count(*) as n from decisions where table_code='DT-004'").get().n, 2);
});
