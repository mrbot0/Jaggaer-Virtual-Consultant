import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { evaluate, loadTable, validateTable, DtDomainError, DtNullError } from "../../scripts/decide/dt-eval.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { cleanEnv } from "../helpers/hook-env.mjs";

const CLI = fileURLToPath(new URL("../../scripts/decide/dt-eval.mjs", import.meta.url));
const approx = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`);
const tmp = () => mkdtempSync(join(tmpdir(), "dt-"));
// revisione finale: i file d'ingresso degli script stanno nel workspace degli hook (JVC_WORKSPACE): qui la cartella temporanea del sistema, dove i test scrivono gli input
const run = (args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: tmpdir() }) });

const DT002_181 = { risk: "R2", shape: "libresco", mandatory_missing: true, open_contradiction: false, novelty: false };

test("DT-002 è deterministica: stesso input → stesso esito, 100/100", () => {
  const t = loadTable("DT-002");
  const first = JSON.stringify(evaluate(t, DT002_181, { priors: { disproved_procedi: 0.35 } }));
  for (let i = 0; i < 100; i++) {
    assert.equal(JSON.stringify(evaluate(loadTable("DT-002"), { ...DT002_181 }, { priors: { disproved_procedi: 0.35 } })), first);
  }
});

test("DT-002 §18.1: R2 .7×.25 + libresco .6×.25 + obbligatorio mancante 1×.15 + 0 + 0 + prior .35×.15 → chiedi", () => {
  // La spec stampa ".58"; la somma dei componenti elencati è .175 + .15 + .15 + .0525 = .5275.
  // Lo scarto è aritmetico (nessun input elencato porta i .05 mancanti); la banda è la stessa
  // (0.50–0.80 → chiedi), quindi si asserisce l'esito e il punteggio ricalcolato.
  const r = evaluate(loadTable("DT-002"), DT002_181, { priors: { disproved_procedi: 0.35 } });
  assert.equal(r.outcome, "chiedi");
  approx(r.score, 0.5275);
  assert.equal(r.table_version, 1);
  assert.deepEqual(r.components.map((c) => c.name), ["risk", "shape", "mandatory_missing", "open_contradiction", "novelty", "disproved_procedi"]);
  approx(r.components.find((c) => c.name === "disproved_procedi").contribution, 0.0525);
  // gap chiuso dall'utente (§18.1, "DT-002 ricalcolata → .43 → procedi con assunzione"):
  // senza il dato mancante la somma è .3775 — stessa banda 0.25–0.50.
  const after = evaluate(loadTable("DT-002"), { ...DT002_181, mandatory_missing: false }, { priors: { disproved_procedi: 0.35 } });
  assert.equal(after.outcome, "procedi-con-assunzione");
  approx(after.score, 0.3775);
});

test("DT-002: R3 forza 'fermati' qualunque sia il punteggio (override)", () => {
  const r = evaluate(loadTable("DT-002"), { risk: "R3", shape: "consolidato", mandatory_missing: false, open_contradiction: false, novelty: false });
  assert.equal(r.outcome, "fermati");
  assert.equal(r.rule, "override[0]");
});

test("DT-017 §18.1: libresco .6×.35 + R2 .7×.30 + smentito d<0.3 .9×.20 + 0 sorprese = 0.60 → STR-DRY-RUN", () => {
  const r = evaluate(loadTable("DT-017"), { shape: "libresco", risk: "R2", precedent: "smentito-d<0.3", surprises: 0 });
  approx(r.score, 0.6);
  assert.equal(r.outcome, "STR-DRY-RUN");
});

test("DT-017 §18.3: ignoto .9×.35 + R1 .3×.30 + nessun precedente .5×.20 + 0 = .505 → STR-VERIFY-FIRST (selettore esplicito)", () => {
  const r = evaluate(loadTable("DT-017"), { shape: "ignoto", risk: "R1", precedent: "nessuno", surprises: 0 });
  approx(r.score, 0.505);
  assert.equal(r.outcome, "STR-VERIFY-FIRST");
  assert.match(r.rule, /^selector\[\d+\]$/);
  const t = loadTable("DT-017");
  const sel = t.outcome_selectors[Number(r.rule.match(/\d+/)[0])];
  assert.match(sel.source, /§18\.3/);
});

test("DT-017: diagnosi con divergenza ignota → STR-BISECT indipendente dal punteggio; combinazioni", () => {
  const r = evaluate(loadTable("DT-017"), { shape: "consolidato", risk: "R0", precedent: "confermato-d<0.2", surprises: 0, diagnosis_unknown_divergence: true });
  assert.equal(r.outcome, "STR-BISECT");
  const c = evaluate(loadTable("DT-017"), { shape: "libresco", risk: "R2", precedent: "nessuno", surprises: 1, config_hypothesis: true, depth: "profonda" });
  assert.deepEqual(c.combined, ["STR-MIN-CHANGE", "STR-PREMORTEM"]);
  const replay = evaluate(loadTable("DT-017"), { shape: "consolidato", risk: "R0", precedent: "confermato-d<0.2", surprises: 0 });
  assert.equal(replay.outcome, "STR-REPLAY");
  const noPrec = evaluate(loadTable("DT-017"), { shape: "consolidato", risk: "R0", precedent: "nessuno", surprises: 0 });
  assert.equal(noPrec.outcome, "nessuna");
});

test("DT-018 §18.2: d .12, confermata, età 2 release, stessa forma → replay", () => {
  // Spec: "d .12, confermata, età .67 → 0.11 → replay". Aritmetica con i pesi di §15.4:
  // 0.40×0.12 + 0.25×0 + 0.15×0 (CHK incorporato: sì) + 0.10×(2/3) + 0.10×0 = 0.048 + 0.0667 = 0.1147 ≈ 0.11.
  const r = evaluate(loadTable("DT-018"), { distance: 0.12, precedent_outcome: "confermata", chk_incorporated: true, age_releases: 2, same_shape: true });
  assert.equal(r.outcome, "replay");
  approx(r.score, 0.114667);
  // età oltre 3 release: satura (tre+), non è fuori dominio
  assert.equal(evaluate(loadTable("DT-018"), { distance: 0.12, precedent_outcome: "confermata", chk_incorporated: true, age_releases: 7, same_shape: true }).components[3].score, 1);
});

test("input fuori dominio → DtDomainError, mai un'approssimazione", () => {
  const t = loadTable("DT-002");
  assert.throws(() => evaluate(t, { ...DT002_181, risk: "R4" }), DtDomainError);
  assert.throws(() => evaluate(t, { ...DT002_181, mandatory_missing: "sì" }), DtDomainError);
  assert.throws(() => evaluate(loadTable("DT-018"), { distance: 1.2, precedent_outcome: "confermata" }), DtDomainError);
  assert.throws(() => evaluate(t, DT002_181, { priors: { disproved_procedi: 1.5 } }), DtDomainError);
});

test("null policy: error, default, worst; prior mancante → neutral", () => {
  const t = loadTable("DT-002");
  const { risk, ...noRisk } = DT002_181;
  assert.throws(() => evaluate(t, noRisk), DtNullError);
  const { novelty, ...noNovelty } = DT002_181;
  const r = evaluate(t, noNovelty);
  const nov = r.components.find((c) => c.name === "novelty");
  assert.equal(nov.value, true);                  // default:true
  assert.equal(nov.null_policy, "default:true");
  const { shape, ...noShape } = DT002_181;
  const w = evaluate(t, noShape);
  assert.equal(w.components.find((c) => c.name === "shape").score, 1); // worst = ignoto/contraddittorio
  assert.equal(r.prior_used[0].applied, "neutral");
  assert.equal(r.prior_used[0].value, 0);
  const insufficient = evaluate(t, DT002_181, { priors: { disproved_procedi: { value: 0.9, n: 12, sufficient: false } } });
  assert.equal(insufficient.prior_used[0].applied, "neutral");
});

test("chiavi non dichiarate rifiutate: un refuso non cade nella null_policy", () => {
  const t = loadTable("DT-002");
  const { novelty, ...rest } = DT002_181;
  assert.throws(() => evaluate(t, { ...rest, novelity: false }), (e) => e instanceof DtDomainError && /novelity/.test(e.message));
  assert.throws(() => evaluate(t, DT002_181, { priors: { disproved_procedii: 0.2 } }), (e) => e instanceof DtDomainError && /disproved_procedii/.test(e.message));
  const d = tmp();
  const f = join(d, "in.json");
  writeFileSync(f, JSON.stringify({ ...rest, novelity: false }));
  assert.equal(run(["--table", "DT-002", "--inputs", f, "--json"]).status, 1);
});

test("CLI: file dei priori inesistente → exit 1", () => {
  const d = tmp();
  const f = join(d, "in.json");
  writeFileSync(f, JSON.stringify(DT002_181));
  const r = run(["--table", "DT-002", "--inputs", f, "--priors", join(d, "manca.json"), "--json"]);
  assert.equal(r.status, 1, r.stdout);
});

test("neutral = valore che non sposta il punteggio: per un prior invertito vale 1", () => {
  const t = structuredClone(loadTable("DT-013"));
  assert.equal(t.priors[0].invert, true);
  assert.equal(t.priors[0].neutral, 1);
  t.priors[0].neutral = 0;
  assert.match(validateTable(t).errors.join(" "), /neutral/);
  const d = structuredClone(loadTable("DT-002"));
  d.priors[0].neutral = 0.3;
  assert.match(validateTable(d).errors.join(" "), /neutral/);
});

test("validazione della tabella: somma dei pesi, bande contigue, esiti dichiarati", () => {
  const t = structuredClone(loadTable("DT-002"));
  assert.equal(validateTable(t).ok, true);
  t.inputs[0].weight = 0.30;
  const v = validateTable(t);
  assert.equal(v.ok, false);
  assert.match(v.errors.join(" "), /pesi/);
  const g = structuredClone(loadTable("DT-002"));
  g.thresholds[1].from = 0.3;
  assert.match(validateTable(g).errors.join(" "), /contigue/);
  const o = structuredClone(loadTable("DT-002"));
  o.overrides[0].outcome = "boh";
  assert.match(validateTable(o).errors.join(" "), /boh/);
});

test("CLI: esito JSON; fuori dominio → exit 1; tabella sconosciuta → exit 1", () => {
  const d = tmp();
  const f = join(d, "in.json");
  writeFileSync(f, JSON.stringify(DT002_181));
  const pf = join(d, "priors.json");
  writeFileSync(pf, JSON.stringify({ disproved_procedi: 0.35 }));
  const r = run(["--table", "DT-002", "--inputs", f, "--priors", pf, "--json"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const j = JSON.parse(r.stdout);
  assert.equal(j.outcome, "chiedi");
  assert.equal(j.dec_code, null);
  writeFileSync(f, JSON.stringify({ ...DT002_181, risk: "R9" }));
  assert.equal(run(["--table", "DT-002", "--inputs", f, "--json"]).status, 1);
  assert.equal(run(["--table", "DT-999", "--inputs", f, "--json"]).status, 1);
  assert.equal(run(["--help"]).status, 0);
});

test("CLI --write-dec: DEC scritta in DB e YAML prima dell'esito; --priors auto usa il neutral sotto 30 DEC", () => {
  const d = tmp();
  const db = join(d, "k.db");
  openDb(db).close();
  const f = join(d, "in.json");
  writeFileSync(f, JSON.stringify(DT002_181));
  const args = ["--table", "DT-002", "--inputs", f, "--priors", "auto", "--customer", "ACME", "--scope", "ADM", "--db", db,
    "--root", d, "--session", "SES.ACME.20260923.001", "--agent", "adm-expert", "--subject", "C.ACME.ADM.CFG.0019", "--write-dec", "--json"];
  const r1 = run(args);
  assert.equal(r1.status, 0, r1.stderr + r1.stdout);
  const j1 = JSON.parse(r1.stdout);
  assert.equal(j1.dec_code, "L.ACME.ADM.DEC.0001");
  assert.equal(j1.prior_used[0].applied, "neutral");
  approx(j1.score, 0.475);  // senza prior: .175 + .15 + .15
  const r2 = run(args);
  assert.equal(JSON.parse(r2.stdout).dec_code, "L.ACME.ADM.DEC.0002");
  const yml = join(d, "decisions", "L.ACME.ADM.DEC.0001.yaml");
  assert.ok(existsSync(yml));
  const doc = YAML.parse(readFileSync(yml, "utf8"));
  assert.equal(doc.table, "DT-002");
  assert.equal(doc.outcome, "procedi-con-assunzione");
  const row = openDb(db).prepare("select * from decisions where code='L.ACME.ADM.DEC.0001'").get();
  assert.equal(row.table_code, "DT-002");
  assert.equal(row.subject_code, "C.ACME.ADM.CFG.0019");
  assert.equal(JSON.parse(row.inputs).shape, "libresco");
  // write-dec senza --customer → exit 1
  assert.equal(run(["--table", "DT-002", "--inputs", f, "--db", db, "--root", d, "--write-dec", "--json"]).status, 1);
});

test("--priors auto con ≥ 30 DEC verificate usa il tasso reale", () => {
  const d = tmp();
  const dbPath = join(d, "k.db");
  const db = openDb(dbPath);
  const dec = db.prepare("insert into decisions(code,table_code,inputs,outcome,score) values (?,?,?,?,?)");
  const out = db.prepare("insert into outcomes(decision_code,result) values (?,?)");
  for (let i = 1; i <= 40; i++) {
    const code = `L.ACME.ADM.DEC.${String(i).padStart(4, "0")}`;
    dec.run(code, "DT-002", JSON.stringify({ shape: "libresco" }), "procedi", 0.2);
    out.run(code, i <= 14 ? "smentita" : "confermata");
  }
  db.close();
  const f = join(d, "in.json");
  writeFileSync(f, JSON.stringify(DT002_181));
  const r = run(["--table", "DT-002", "--inputs", f, "--priors", "auto", "--customer", "ACME", "--db", dbPath, "--json"]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const j = JSON.parse(r.stdout);
  assert.equal(j.prior_used[0].applied, "auto");
  assert.equal(j.prior_used[0].value, 0.35);   // 14/40
  approx(j.score, 0.5275);
  assert.equal(j.outcome, "chiedi");
});

// WP10b (ruling 6): gli agenti T0 con i soli Read e Bash (failure-triage, config-auditor, defect-reporter) non scrivono
// file: gli input della tabella si passano anche come argomenti `nome=valore` (booleani, numeri e null riconosciuti),
// mai come JSON in linea; con --inputs i nome=valore sovrascrivono le chiavi del file.
test("CLI: input nome=valore senza file, stesso esito di --inputs; chiave ignota o forma errata → exit 1", () => {
  const byArgs = run(["--table", "DT-002", "risk=R2", "shape=libresco", "mandatory_missing=true", "open_contradiction=false", "novelty=false", "--priors", "auto", "--json"]);
  assert.notEqual(byArgs.status, 0, "--priors auto senza --db resta un errore");
  const d = tmp();
  const pf = join(d, "p.json");
  writeFileSync(pf, JSON.stringify({ disproved_procedi: 0.35 }));
  const a = run(["--table", "DT-002", "risk=R2", "shape=libresco", "mandatory_missing=true", "open_contradiction=false", "novelty=false", "--priors", pf, "--json"]);
  assert.equal(a.status, 0, a.stderr + a.stdout);
  const f = join(d, "in.json");
  writeFileSync(f, JSON.stringify(DT002_181));
  const b = run(["--table", "DT-002", "--inputs", f, "--priors", pf, "--json"]);
  const ja = JSON.parse(a.stdout); const jb = JSON.parse(b.stdout);
  assert.equal(ja.outcome, "chiedi"); approx(ja.score, jb.score);
  const over = JSON.parse(run(["--table", "DT-002", "--inputs", f, "mandatory_missing=false", "--priors", pf, "--json"]).stdout);
  assert.equal(over.outcome, "procedi-con-assunzione");
  assert.equal(run(["--table", "DT-002", "risk=R2", "novelity=false", "--json"]).status, 1);
  assert.equal(run(["--table", "DT-002", "risk", "--json"]).status, 1);
  assert.equal(run(["--table", "DT-002", "--json"]).status, 1, "senza input");
});
