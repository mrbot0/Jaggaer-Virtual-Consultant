// WP10c giro 1 (I1, ruling del controllore): i valori di dominio delle DT che contengono < o > (DT-003 volume, classi
// di precedente di DT-017 e DT-023) sono negati da guard-config-scope in ogni forma di quoting e, senza virgolette, `>`
// è una redirezione. Regola unica di alias ASCII (`<` → `-lt-`, `>` → `-gt-`, trattini doppi e ai bordi tolti),
// ricavata dai file delle DT e non scritta a mano: dt-eval, strategy-select e depth accettano l'alias e lo riportano al
// valore canonico, con uscita identica; depth accetta anche gli input da file (--input, --precedents).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { ROOT, cleanEnv } from "../helpers/hook-env.mjs";
import { evaluate, loadTable, asciiAlias, canonicalValue, ALIAS_UNSAFE } from "../../scripts/decide/dt-eval.mjs";
import { selectStrategy, precedentClass } from "../../scripts/decide/strategy-select.mjs";
import { deliberationDepth } from "../../scripts/decide/depth.mjs";

const tables = () => readdirSync(join(ROOT, "decision-tables")).filter((f) => /^DT-\d{3}\.yaml$/.test(f)).map((f) => loadTable(f.slice(0, -5)));
// Valori con caratteri negati dai guard (< > ') di ogni input enum di ogni DT, dai file.
function angled() {
  const out = [];
  for (const t of tables()) for (const i of t.inputs) for (const k of Object.keys(i.domain.enum ?? {})) if (ALIAS_UNSAFE.test(k)) out.push({ table: t, input: i.name, value: k });
  return out;
}
// Un valore valido per ogni input (il primo del dominio), per valutare la tabella intera.
const baseOf = (t) => Object.fromEntries(t.inputs.map((i) => [i.name, i.domain.enum ? Object.keys(i.domain.enum)[0] : i.domain.boolean ? false : i.domain.range[0]]));
// revisione finale: i file d'ingresso degli script stanno nel workspace degli hook (JVC_WORKSPACE): qui la cartella temporanea del sistema
const run = (script, args) => spawnSync(process.execPath, [join(ROOT, "scripts/decide", script), ...args, "--json"], { env: cleanEnv({ JVC_WORKSPACE: tmpdir() }), encoding: "utf8" });
const out = (r) => { assert.equal(r.status, 0, r.stdout + r.stderr); return JSON.parse(r.stdout); };

test("la regola degli alias: < → -lt-, > → -gt-, senza trattini doppi o ai bordi; solo ASCII sicuro per i guard", () => {
  assert.equal(asciiAlias("<5k"), "lt-5k");
  assert.equal(asciiAlias(">30k"), "gt-30k");
  assert.equal(asciiAlias("confermato-d<0.2"), "confermato-d-lt-0.2");
  assert.equal(asciiAlias("smentito-d<0.3"), "smentito-d-lt-0.3");
  assert.equal(asciiAlias("d'uso"), "d-uso", "l'apostrofo (DT-011, DT-019) è negato come < e >");
  assert.equal(asciiAlias("nessuno"), "nessuno", "un valore senza caratteri negati non cambia");
  const found = angled();
  assert.deepEqual([...new Set(found.map((x) => `${x.table.id}.${x.input}`))].sort(), ["DT-003.volume", "DT-011.winner_genre", "DT-017.precedent", "DT-019.preferred_genre", "DT-023.precedent"]);
  for (const { value } of found) assert.match(asciiAlias(value), /^[A-Za-z0-9._-]+$/, value);
});

test("ogni alias è unico nel suo dominio e torna al valore canonico; valore canonico e sconosciuto restano come sono", () => {
  for (const t of tables()) for (const i of t.inputs) {
    const keys = Object.keys(i.domain.enum ?? {});
    const aliases = keys.map(asciiAlias);
    assert.equal(new Set([...keys, ...aliases.filter((a, n) => a !== keys[n])]).size, keys.length + aliases.filter((a, n) => a !== keys[n]).length, `${t.id}.${i.name}: alias in collisione`);
    for (const k of keys) { assert.equal(canonicalValue(i.domain, asciiAlias(k)), k); assert.equal(canonicalValue(i.domain, k), k); }
  }
  assert.equal(canonicalValue(loadTable("DT-003").inputs.find((i) => i.name === "volume").domain, "enorme"), "enorme");
});

test("dt-eval: con l'alias ASCII l'uscita è identica a quella con il valore canonico (in processo e da riga di comando)", () => {
  for (const { table, input, value } of angled()) {
    const a = evaluate(table, { ...baseOf(table), [input]: value });
    const b = evaluate(table, { ...baseOf(table), [input]: asciiAlias(value) });
    assert.deepEqual(b, a, `${table.id}.${input}=${value}`);
    assert.equal(b.inputs[input], value, "registrato il valore canonico");
  }
  const canon = out(run("dt-eval.mjs", ["--table", "DT-003", "risk=R1", "task_novelty=mai", "shape=libresco", "synthesis=artefatto", "volume=gt-30k"]));
  const ref = evaluate(loadTable("DT-003"), { risk: "R1", task_novelty: "mai", shape: "libresco", synthesis: "artefatto", volume: ">30k" });
  assert.equal(canon.outcome, ref.outcome);
  assert.equal(canon.score, ref.score);
  assert.deepEqual(canon.components, ref.components);
  const bad = run("dt-eval.mjs", ["--table", "DT-003", "risk=R1", "volume=lt-99k"]);
  assert.equal(bad.status, 1, "un alias inesistente resta fuori dominio");
});

test("chiavi numeriche con zeri (DT-007 area): nome=valore le tipizza come numero, che torna alla chiave", () => {
  const t = loadTable("DT-007");
  const base = Object.fromEntries(t.inputs.map((i) => [i.name, i.domain.enum ? Object.keys(i.domain.enum)[0] : i.domain.boolean ? false : i.domain.range[0]]));
  for (const k of Object.keys(t.inputs.find((i) => i.name === "area").domain.enum)) assert.deepEqual(evaluate(t, { ...base, area: Number(k) }), evaluate(t, { ...base, area: k }), k);
  const cli = out(run("dt-eval.mjs", ["--table", "DT-007", "area=005", "rollback_exists=true", "graph_radius_gt5=false", "in_window=true", "mature=true", "shape=consolidato"]));
  assert.equal(cli.components.find((c) => c.name === "area").value, "005");
});

test("strategy-select: classi di precedente in forma ASCII = canoniche (DT-017), anche da riga di comando", () => {
  for (const k of Object.keys(loadTable("DT-017").inputs.find((i) => i.name === "precedent").domain.enum)) {
    assert.equal(precedentClass(asciiAlias(k)), k);
    const base = { shape: "consolidato", risk: "R0", surprises: 0, mode: "nrt" };
    assert.deepEqual(selectStrategy({ ...base, precedent: asciiAlias(k) }), selectStrategy({ ...base, precedent: k }), k);
  }
  const cli = out(run("strategy-select.mjs", ["--shape", "consolidato", "--risk", "R0", "--precedent", "confermato-d-lt-0.2", "--mode", "nrt"]));
  assert.equal(cli.strategy, "STR-REPLAY");
  assert.equal(cli.inputs.precedent, "confermato-d<0.2");
  assert.throws(() => precedentClass("confermato-d-lt-0.9"), /fuori dominio/);
});

test("depth: classi di precedente ASCII = canoniche (DT-023); --input <file> e --precedents <file> come per strategy-select", () => {
  for (const k of Object.keys(loadTable("DT-023").inputs.find((i) => i.name === "precedent").domain.enum)) {
    const base = { risk: "R1", shape: "consolidato", surprises: 0, graph_radius: 2, never_executed_here: false };
    assert.deepEqual(deliberationDepth({ ...base, precedent: asciiAlias(k) }), deliberationDepth({ ...base, precedent: k }), k);
  }
  const cli = out(run("depth.mjs", ["--risk", "R0", "--shape", "consolidato", "--precedent", "confermato-d-lt-0.2", "--graph-radius", "1", "--never-executed-here", "false"]));
  assert.equal(cli.depth, "rapida");
  const dir = mkdtempSync(join(tmpdir(), "jvc-depth-"));
  const f = join(dir, "depth.json");
  writeFileSync(f, JSON.stringify({ risk: "R0", shape: "consolidato", surprises: 0, precedent: "confermato-d<0.2", graph_radius: 1, never_executed_here: false }));
  const viaFile = out(run("depth.mjs", ["--input", f]));
  assert.equal(viaFile.depth, "rapida");
  assert.deepEqual(viaFile.inputs, cli.inputs);
  const p = join(dir, "prec.json");
  writeFileSync(p, JSON.stringify({ items: [{ code: "L.XXXX.CAT.DEC.0001", d: 0.1, result: "confermata" }] }));
  const viaPrec = out(run("depth.mjs", ["--risk", "R0", "--shape", "consolidato", "--precedents", p, "--graph-radius", "1", "--never-executed-here", "false"]));
  assert.equal(viaPrec.inputs.precedent, "confermato-d<0.2");
  assert.equal(viaPrec.depth, "rapida");
  const override = out(run("depth.mjs", ["--input", f, "--risk", "R2"]));
  assert.equal(override.inputs.risk, "R2", "le opzioni prevalgono sul file");
});

test("gli help documentano le forme ASCII (mai < o > da passare sulla riga di comando)", () => {
  for (const s of ["strategy-select.mjs", "depth.mjs", "dt-eval.mjs"]) {
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/decide", s), "--help"], { env: cleanEnv(), encoding: "utf8" });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /-lt-/, s);
  }
});

// WP10c giro 2 (Importante 1): i priori automatici filtrano le DEC sul valore di un input (DT-019 preferred_genre, DT-011
// winner_genre); le DEC sono registrate con il valore canonico ("d'uso"), quindi l'alias va riportato al canonico PRIMA
// del calcolo dei priori, in un solo punto condiviso (canonicalInputs), anche da riga di comando.
test("priori automatici: alias e valore canonico danno lo stesso prior e lo stesso punteggio (≥ 30 DEC verificate)", async () => {
  const { openDb } = await import("../../scripts/kb/db.mjs");
  const { autoPriors, canonicalInputs } = await import("../../scripts/decide/dt-eval.mjs");
  const dir = mkdtempSync(join(tmpdir(), "jvc-prior-"));
  const file = join(dir, "knowledge.db");
  const db = openDb(file);
  const dec = db.prepare("insert into decisions(code,table_code,subject_cluster,inputs,outcome) values (?,?,?,?,?)");
  const res = db.prepare("insert into outcomes(decision_code,result) values (?,?)");
  for (let i = 1; i <= 40; i++) {
    const c19 = `L.XXXX.XSC.DEC.${String(i).padStart(4, "0")}`;
    dec.run(c19, "DT-019", "CL-CFG-005", JSON.stringify({ preferred_genre: "d'uso", preferred_available: true, observable_r0: true }), "d'uso");
    res.run(c19, i <= 20 ? "smentita" : "confermata");
    const c11 = `L.XXXX.XSC.DEC.${String(100 + i).padStart(4, "0")}`;
    dec.run(c11, "DT-011", "CL-CFG-005", JSON.stringify({ winner_genre: "d'uso", candidate_winner: "vince-L" }), "vince-L");
    res.run(c11, i <= 10 ? "smentita" : "confermata");
  }
  const t19 = loadTable("DT-019");
  const base19 = { preferred_available: true, observable_r0: true };
  const canon = autoPriors(db, t19, { ...base19, preferred_genre: "d'uso" }, { cluster: "CL-CFG-005" });
  const alias = autoPriors(db, t19, { ...base19, preferred_genre: "d-uso" }, { cluster: "CL-CFG-005" });
  assert.equal(canon.gap_unresolved_rate.n, 40);
  assert.equal(canon.gap_unresolved_rate.value, 0.5);
  assert.deepEqual(alias, canon);
  assert.deepEqual(canonicalInputs(t19, { ...base19, preferred_genre: "d-uso" }), { ...base19, preferred_genre: "d'uso" });
  const t11 = loadTable("DT-011");
  const in11 = { candidate_winner: "vince-L", winner_evidence: "dichiarazione", genre_fit: true, confidence_gap: 0.2, user_answer: "nessuna" };
  const p11 = autoPriors(db, t11, { ...in11, winner_genre: "d'uso" }, { cluster: "CL-CFG-005" });
  assert.equal(p11.winner_genre_disproved.n, 40);
  assert.deepEqual(autoPriors(db, t11, { ...in11, winner_genre: "d-uso" }, { cluster: "CL-CFG-005" }), p11);
  db.close();
  const cli = (g) => out(run("dt-eval.mjs", ["--table", "DT-019", `preferred_genre=${g}`, "preferred_available=true", "observable_r0=true", "--priors", "auto", "--cluster", "CL-CFG-005", "--db", file]));
  const a = cli("d-uso");
  const b = cli("d'uso");
  assert.equal(b.prior_used[0].n, 40);
  assert.equal(b.prior_used[0].applied, "auto");
  assert.deepEqual(a.prior_used, b.prior_used);
  assert.equal(a.score, b.score);
  assert.equal(a.outcome, b.outcome);
});

test("depth: --precedents e --precedent insieme sono un errore; chiavi sconosciute nel file di --input sono un errore", () => {
  const dir = mkdtempSync(join(tmpdir(), "jvc-depth2-"));
  const p = join(dir, "prec.json");
  writeFileSync(p, JSON.stringify({ items: [{ code: "L.XXXX.CAT.DEC.0001", d: 0.1, result: "confermata" }] }));
  const both = run("depth.mjs", ["--risk", "R0", "--shape", "consolidato", "--precedents", p, "--precedent", "nessuno"]);
  assert.equal(both.status, 1, both.stdout);
  assert.match(both.stdout, /--precedent/);
  const f = join(dir, "in.json");
  writeFileSync(f, JSON.stringify({ risk: "R0", shape: "consolidato", precedente: "nessuno" }));
  const bad = run("depth.mjs", ["--input", f]);
  assert.equal(bad.status, 1, bad.stdout);
  assert.match(bad.stdout, /precedente/);
  const withPrec = join(dir, "in2.json");
  writeFileSync(withPrec, JSON.stringify({ risk: "R0", shape: "consolidato", precedent: "nessuno" }));
  assert.equal(run("depth.mjs", ["--input", withPrec, "--precedents", p]).status, 1, "precedente nel file e --precedents insieme");
});
