import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { openDb } from "../../scripts/kb/db.mjs";
import { record, pending, expire, declareExpected, OutcomePolicyError, OutcomeInputError } from "../../scripts/digest/outcomes.mjs";

const LEARN = fileURLToPath(new URL("../../scripts/digest/learn.mjs", import.meta.url));

function setup() {
  const root = mkdtempSync(join(tmpdir(), "out-"));
  const dbFile = join(root, "knowledge.db");
  const db = openDb(dbFile);
  const dec = db.prepare("insert into decisions(code,table_code,agent,session,subject_code,inputs,outcome,at) values (?,?,?,?,?,?,?,?)");
  dec.run("L.ACME.ADM.DEC.0518", "DT-007", "adm-expert", "SES.ACME.20260922.003", "C.ACME.ADM.CFG.0019", "{}", "R2", "2026-09-22T11:00:00Z");
  dec.run("L.ACME.ADM.DEC.0519", "DT-002", "jaggaer-virtual-consultant:adm-expert", "SES.ACME.20260922.003", "C.ACME.ADM.CFG.0019", "{}", "procedi", "2026-09-22T11:05:00Z");
  dec.run("L.ACME.ADM.DEC.0520", "DT-002", "adm-expert", "SES.ACME.20260923.001", "C.ACME.ADM.CFG.0019", "{}", "procedi", "2026-09-23T09:00:00Z");
  declareExpected(db, { dec: "L.ACME.ADM.DEC.0518", expect: "NRT.ACME.ADM.CFG.0014 verde entro la stessa sessione", session: "SES.ACME.20260922.003", release: "R25.2", lesson: "L.ACME.ADM.LSN.0104" });
  declareExpected(db, { dec: "L.ACME.ADM.DEC.0519", expect: "nessun avviso di riconvalida", session: "SES.ACME.20260922.003", release: "R25.3" });
  declareExpected(db, { dec: "L.ACME.ADM.DEC.0520", expect: "CFG verde", session: "SES.ACME.20260923.001", release: "R25.3" });
  return { root, dbFile, db };
}

test("§12.1 record: esito confermato → outcomes/<DEC>.out.yaml con i campi di §12.1 e riga nel DB", () => {
  const { root, db } = setup();
  const r = record(db, root, { dec: "L.ACME.ADM.DEC.0518", result: "confermata", verified_by: "esecuzione", evidence: "RUN.ACME.20260922.1130.ADM", at: "2026-09-22T11:42:10Z" });
  const file = join(root, "outcomes", "L.ACME.ADM.DEC.0518.out.yaml");
  assert.equal(r.file, file);
  const doc = YAML.parse(readFileSync(file, "utf8"));
  assert.deepEqual(doc, {
    decision: "L.ACME.ADM.DEC.0518", expected: "NRT.ACME.ADM.CFG.0014 verde entro la stessa sessione",
    verified_at: "2026-09-22T11:42:10Z", verified_by: "esecuzione", result: "confermata", evidence: "RUN.ACME.20260922.1130.ADM",
  });
  const row = db.prepare("select * from outcomes where decision_code=?").get("L.ACME.ADM.DEC.0518");
  assert.equal(row.result, "confermata");
  assert.equal(row.verified_by, "esecuzione");
  assert.equal(row.evidence_code, "RUN.ACME.20260922.1130.ADM");
  // idempotente: lo stesso esito non cambia nulla; un esito diverso è rifiutato
  assert.equal(record(db, root, { dec: "L.ACME.ADM.DEC.0518", result: "confermata", verified_by: "esecuzione", evidence: "RUN.ACME.20260922.1130.ADM", at: "2026-09-22T11:42:10Z" }).unchanged, true);
  assert.throws(() => record(db, root, { dec: "L.ACME.ADM.DEC.0518", result: "smentita", verified_by: "umano" }), OutcomePolicyError);
});

test("§12.1 record: esito smentito con nota; risultato fuori vocabolario o DEC inesistente → errore d'uso", () => {
  const { root, db } = setup();
  record(db, root, { dec: "L.ACME.ADM.DEC.0520", result: "smentita", verified_by: "umano", note: "lo snapshot non copriva il profilo" });
  const doc = YAML.parse(readFileSync(join(root, "outcomes", "L.ACME.ADM.DEC.0520.out.yaml"), "utf8"));
  assert.equal(doc.result, "smentita");
  assert.equal(doc.note, "lo snapshot non copriva il profilo");
  assert.throws(() => record(db, root, { dec: "L.ACME.ADM.DEC.0518", result: "forse", verified_by: "umano" }), OutcomeInputError);
  assert.throws(() => record(db, root, { dec: "L.ACME.ADM.DEC.9999", result: "confermata", verified_by: "umano" }), OutcomeInputError);
});

test("§29.6 record: mai dall'agente che ha deciso (anche con prefisso del plugin)", () => {
  const { root, db } = setup();
  assert.throws(() => record(db, root, { dec: "L.ACME.ADM.DEC.0518", result: "confermata", verified_by: "adm-expert" }), OutcomePolicyError);
  assert.throws(() => record(db, root, { dec: "L.ACME.ADM.DEC.0519", result: "confermata", verified_by: "adm-expert" }), OutcomePolicyError);
  assert.throws(() => record(db, root, { dec: "L.ACME.ADM.DEC.0518", result: "confermata", verified_by: "jaggaer-virtual-consultant:adm-expert" }), OutcomePolicyError);
  assert.equal(existsSync(join(root, "outcomes", "L.ACME.ADM.DEC.0518.out.yaml")), false);
});

test("pending: DEC con esito atteso e senza esito, filtrabili per sessione", () => {
  const { root, db } = setup();
  assert.deepEqual(pending(db, {}).map((p) => p.dec), ["L.ACME.ADM.DEC.0518", "L.ACME.ADM.DEC.0519", "L.ACME.ADM.DEC.0520"]);
  record(db, root, { dec: "L.ACME.ADM.DEC.0518", result: "confermata", verified_by: "esecuzione" });
  const p = pending(db, { session: "SES.ACME.20260922.003" });
  assert.deepEqual(p.map((x) => x.dec), ["L.ACME.ADM.DEC.0519"]);
  assert.equal(p[0].expect, "nessun avviso di riconvalida");
});

test("§12.1 expire: nessuna verifica entro 2 release → non-verificabile (esclusa dai tassi)", () => {
  const { root, db } = setup();
  const releases = ["R25.1", "R25.2", "R25.3", "R25.4"];
  const r = expire(db, releases, { root, at: "2026-12-01T00:00:00Z" });
  assert.deepEqual(r.map((x) => x.dec), ["L.ACME.ADM.DEC.0518"]);   // dichiarata in R25.2, ora R25.4: due release
  assert.equal(db.prepare("select result from outcomes where decision_code=?").get("L.ACME.ADM.DEC.0518").result, "non-verificabile");
  assert.equal(YAML.parse(readFileSync(join(root, "outcomes", "L.ACME.ADM.DEC.0518.out.yaml"), "utf8")).verified_by, "tempo");
  assert.deepEqual(expire(db, releases, { root }).map((x) => x.dec), []);
});

test("CLI learn outcomes: --confirm / --disprove con --by; l'autore della DEC è rifiutato (exit 3); elenco --session", () => {
  const { root, dbFile, db } = setup();
  db.close();
  const run = (args) => spawnSync(process.execPath, [LEARN, "outcomes", ...args, "--db", dbFile, "--root", root, "--json"], { encoding: "utf8" });
  const ok = run(["--confirm", "L.ACME.ADM.DEC.0518", "--by", "umano", "--evidence", "RUN.ACME.20260922.1130.ADM"]);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.equal(JSON.parse(ok.stdout).result, "confermata");
  const self = run(["--disprove", "L.ACME.ADM.DEC.0520", "--by", "adm-expert"]);
  assert.equal(self.status, 3);
  assert.match(JSON.parse(self.stdout).error, /agente che ha deciso/);
  const dis = run(["--disprove", "L.ACME.ADM.DEC.0520", "--by", "umano", "--note", "il profilo era un altro"]);
  assert.equal(dis.status, 0);
  const list = run(["--session", "SES.ACME.20260922.003"]);
  assert.equal(list.status, 0);
  const out = JSON.parse(list.stdout);
  assert.deepEqual(out.pending.map((p) => p.dec), ["L.ACME.ADM.DEC.0519"]);
  assert.deepEqual(out.outcomes.map((o) => o.dec), ["L.ACME.ADM.DEC.0518"]);
  const help = spawnSync(process.execPath, [LEARN, "--help"], { encoding: "utf8" });
  assert.equal(help.status, 0);
});
