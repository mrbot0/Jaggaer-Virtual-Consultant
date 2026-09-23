import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate, loadTable, writeDecision } from "../../scripts/decide/dt-eval.mjs";
import { buildWhy, explain } from "../../scripts/decide/why.mjs";
import { validateWith } from "../../scripts/lib/schemas.mjs";
import { openDb } from "../../scripts/kb/db.mjs";

const CLI = fileURLToPath(new URL("../../scripts/decide/why.mjs", import.meta.url));
const DT002_181 = { risk: "R2", shape: "libresco", mandatory_missing: true, open_contradiction: false, novelty: false };

test("§17.5 why da un esito di dt-eval: i tre input che hanno pesato di più, l'alternativa scartata e lo scarto di punteggio", () => {
  const r = evaluate(loadTable("DT-002"), DT002_181, { priors: { disproved_procedi: 0.35 } });
  const why = buildWhy(r, {
    assumed: ["strict_import non influisce sui cataloghi già pubblicati (L.ACME.ADM.CFG.0044, testimoniale 0.85)"],
    would_change_my_mind: ["un avviso di riconvalida sulla schermata di salvataggio (S.STD.ADM.SEL.0122)"],
  });
  assert.equal(why.decision, "chiedi");
  assert.deepEqual(why.because, [
    "Rischio dell'azione R2 (0.25 × 0.7)",
    "Deficit epistemico (forma del soggetto) libresco (0.25 × 0.6)",
    "Dato obbligatorio mancante true (0.15 × 1)",
  ]);
  assert.equal(why.did_not_choose.length, 1);
  assert.equal(why.did_not_choose[0].option, "procedi-con-assunzione");
  assert.ok(Math.abs(why.did_not_choose[0].score_gap - 0.0275) < 1e-9);
  assert.match(why.did_not_choose[0].reason, /0\.5/);
  assert.ok(validateWith("why.schema.json", why).ok, validateWith("why.schema.json", why).errors.join("; "));
  // senza would_change_my_mind dichiarato: generato dall'input più pesante (falsificabilità sempre presente)
  const auto = buildWhy(r);
  assert.equal(auto.would_change_my_mind.length, 1);
  assert.match(auto.would_change_my_mind[0], /Rischio dell'azione/);
  // lo schema chiede almeno un would_change_my_mind e al più tre because
  assert.equal(validateWith("why.schema.json", { ...why, would_change_my_mind: [] }).ok, false);
  assert.equal(validateWith("why.schema.json", { ...why, because: ["a", "b", "c", "d"] }).ok, false);
});

test("§17.5 why su un override: l'alternativa è ciò che avrebbe dato il punteggio, lo scarto non è numerico", () => {
  const r = evaluate(loadTable("DT-002"), { risk: "R3", shape: "consolidato", mandatory_missing: false, open_contradiction: false, novelty: false });
  const why = buildWhy(r);
  assert.equal(why.decision, "fermati");
  assert.equal(why.did_not_choose[0].option, "procedi-con-assunzione");
  assert.equal(why.did_not_choose[0].score_gap, null);
  assert.match(why.did_not_choose[0].reason, /override/);
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "why-"));
  const dbFile = join(root, "knowledge.db");
  const db = openDb(dbFile);
  const r = evaluate(loadTable("DT-002"), DT002_181, { priors: { disproved_procedi: 0.35 } });
  const dec = writeDecision(db, { customer: "ACME", scope: "ADM", root, result: r, agent: "adm-expert", session: "SES.ACME.20260922.003",
    subject: "C.ACME.ADM.CFG.0019", strategy: "STR-DRY-RUN", at: "2026-09-22T10:40:00Z", context: { effects: true, confidence: 0.8 } });
  db.prepare("insert into outcomes(decision_code,verified_at,verified_by,result) values (?,?,?,?)").run(dec, "2026-09-22T11:42:10Z", "esecuzione", "confermata");
  mkdirSync(join(root, "kb", "scopes", "ADM", "configs"), { recursive: true });
  const itemPath = join(root, "kb", "scopes", "ADM", "configs", "C.ACME.ADM.CFG.0019.yaml");
  writeFileSync(itemPath, `id: C.ACME.ADM.CFG.0019
type: CFG
title: "Profilo di import catalogo"
summary: "strict_import del profilo di import"
facets: { F1: doc-cliente-tecnica, F12: validato, F14: 0.81 }
sources: [{ doc: "ACME_Configurazione_v2.docx", section: "4.1", kind: doc-cliente-tecnica, unit: C.ACME.ADM.UNT.0112 }]
provenance: { extraction: { agent: adm-extractor, tier: T0, at: "2026-09-01" }, digestion: { agent: adm-digester, tables: [DT-020, DT-021, DT-022] }, back_check: ok, validation: { table: DT-005 } }
`);
  db.prepare("insert into items(code,level,customer,scope,type,title,summary,facets,confidence,status,path,hash,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("C.ACME.ADM.CFG.0019", "C", "ACME", "ADM", "CFG", "Profilo di import catalogo", "strict_import del profilo di import", "{}", 0.81, "validato", itemPath, "h", "2026-09-01");
  return { root, dbFile, db, dec };
}

test("/vc why <DEC>: tabella, input, priori, strategia, esito della DT, esito verificato e blocco why", () => {
  const { root, db, dec } = workspace();
  const w = explain(db, dec, { root });
  assert.equal(w.kind, "DEC");
  assert.equal(w.table, "DT-002");
  assert.equal(w.outcome, "chiedi");
  assert.equal(w.strategy, "STR-DRY-RUN");
  assert.equal(w.verified.result, "confermata");
  assert.equal(w.why.decision, "chiedi");
  assert.equal(w.why.because.length, 3);
  assert.equal(w.priors[0].name, "disproved_procedi");
});

test("/vc why <item>: la catena di provenienza (§19) quando presente; codice ignoto → errore", () => {
  const { root, db } = workspace();
  const w = explain(db, "C.ACME.ADM.CFG.0019", { root });
  assert.equal(w.kind, "item");
  assert.equal(w.status, "validato");
  assert.equal(w.provenance.sources[0].unit, "C.ACME.ADM.UNT.0112");
  assert.equal(w.provenance.provenance.back_check, "ok");
  assert.throws(() => explain(db, "C.ACME.ADM.CFG.0999", { root }), /non trovato/);
});

test("CLI why <codice> --json (exit 0) e codice ignoto (exit 1)", () => {
  const { root, dbFile, db, dec } = workspace();
  db.close();
  const r = spawnSync(process.execPath, [CLI, dec, "--db", dbFile, "--root", root, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).why.decision, "chiedi");
  const text = spawnSync(process.execPath, [CLI, dec, "--db", dbFile, "--root", root], { encoding: "utf8" });
  assert.equal(text.status, 0);
  assert.match(text.stdout, /would_change_my_mind|cambierebbe/);
  const nf = spawnSync(process.execPath, [CLI, "L.ACME.ADM.DEC.9999", "--db", dbFile, "--root", root, "--json"], { encoding: "utf8" });
  assert.equal(nf.status, 1);
});
