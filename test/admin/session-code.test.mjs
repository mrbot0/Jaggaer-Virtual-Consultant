// Giro di correzione 2 di WP04: il codice di sessione SES.<CLIENTE>.<AAAAMMGG>.<SEQ> (§5.3 "Run e sessioni")
// assegnato da session.mjs quando crea un session.json; le cartelle restano per sid di runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, realpathSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runSessionCli } from "../helpers/hook-env.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { parseLesson } from "../../scripts/kb/lesson.mjs";

const LEARN = fileURLToPath(new URL("../../scripts/digest/learn.mjs", import.meta.url));
const SES_RE = /^SES\.ACME\.(\d{8})\.(\d{3})$/;
const ws = () => realpathSync.native(mkdtempSync(join(tmpdir(), "jvc-ses-")));
const cli = (w, sid, args) => runSessionCli(["use", ...args, "--session", sid, "--workspace", w, "--json"]);
const sessionOf = (w, c, sid) => JSON.parse(readFileSync(join(w, "customers", c, ".sessions", sid, "session.json"), "utf8"));

test("fix2 use customer ACME --new scrive session_code SES.ACME.<AAAAMMGG>.001; una seconda sessione lo stesso giorno .002; use show lo mostra", () => {
  const w = ws();
  const a = cli(w, "sid-a", ["customer", "ACME", "--new"]);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  const ca = sessionOf(w, "ACME", "sid-a").session_code;
  const ma = SES_RE.exec(ca);
  assert.ok(ma, `session_code malformato: ${ca}`);
  assert.equal(ma[1], new Date().toISOString().slice(0, 10).replace(/-/g, ""));
  assert.equal(ma[2], "001");
  assert.equal(a.json.session.session_code, ca);
  const b = cli(w, "sid-b", ["customer", "ACME"]);
  assert.equal(b.status, 0, b.stdout + b.stderr);
  const cb = sessionOf(w, "ACME", "sid-b").session_code;
  assert.equal(SES_RE.exec(cb)[2], "002");
  assert.equal(SES_RE.exec(cb)[1], ma[1]);
  // riattivare la stessa sessione non cambia il codice
  assert.equal(cli(w, "sid-a", ["customer", "ACME"]).status, 0);
  assert.equal(sessionOf(w, "ACME", "sid-a").session_code, ca);
  const show = runSessionCli(["use", "show", "--session", "sid-b", "--workspace", w, "--json"]);
  assert.equal(show.json.session.session_code, cb);
  const text = runSessionCli(["use", "show", "--session", "sid-b", "--workspace", w]);
  assert.match(text.stdout, new RegExp(cb.replace(/\./g, "\\.")));
});

test("fix2 passare a un cliente dove questa sessione non ha session.json assegna il codice di quel cliente", () => {
  const w = ws();
  assert.equal(cli(w, "sid-a", ["customer", "ACME", "--new"]).status, 0);
  assert.equal(cli(w, "sid-a", ["customer", "BETA", "--new"]).status, 0);
  assert.match(sessionOf(w, "BETA", "sid-a").session_code, /^SES\.BETA\.\d{8}\.001$/);
});

test("fix2 un session.json preesistente senza session_code lo riceve al prossimo use customer, senza perdere dati", () => {
  const w = ws();
  assert.equal(cli(w, "sid-a", ["customer", "ACME", "--new"]).status, 0);
  const file = join(w, "customers", "ACME", ".sessions", "sid-a", "session.json");
  const s = JSON.parse(readFileSync(file, "utf8"));
  delete s.session_code;
  s.surprises = [{ at: "2026-09-22T10:41:00Z", item: "C.ACME.ADM.CFG.0019", obs: "L.ACME.ADM.OBS.0231" }];
  s.scope = "ADM";
  writeFileSync(file, JSON.stringify(s, null, 2));
  assert.equal(cli(w, "sid-a", ["customer", "ACME"]).status, 0);
  const after = sessionOf(w, "ACME", "sid-a");
  assert.match(after.session_code, SES_RE);
  assert.deepEqual(after.surprises, s.surprises);
  assert.equal(after.scope, "ADM");
});

const LESSON = (sesCode, s3) => `---
id: L.ACME.ADM.LSN.0001
agent: adm-expert
session: ${sesCode}
task: "impostare strict_import"
scope: ADM
mode: config
decision_refs: []
strategy: STR-DRY-RUN
epistemic_before: libresco
epistemic_after: libresco
surprises: 1
expected_outcomes: []
status: proposed
confidence: 0.8
portability_hypothesis: { class: specifica }
cluster_proposal: CL-CHK-002
---
## 1. Contesto
C.ACME.ADM.CFG.0019
## 2. Cosa ho tentato
dry-run
## 3. Cosa ho osservato
${s3}
## 4. Decisioni prese
nessuna DEC con effetti
## 5. Esito
ok
## 6. Lezione
il gap impacts è ricorrente: proporre un CHK
## 7. Cosa NON generalizzerei
dipende dalla versione del modulo catalogo ACME (F5)
## 8. Domande aperte
nessuna
`;

test("fix2 end-to-end: sessione creata dalla CLI reale, sorpresa in sessione; lezione muta → rejected: non fondata; lezione che cita la sorpresa → validated", () => {
  const w = ws();
  assert.equal(cli(w, "7f3c9a2e-runtime", ["customer", "ACME", "--new"]).status, 0);
  const root = join(w, "customers", "ACME");
  const file = join(root, ".sessions", "7f3c9a2e-runtime", "session.json");
  const s = JSON.parse(readFileSync(file, "utf8"));
  s.surprises.push({ at: "2026-09-22T10:41:00Z", item: "C.ACME.ADM.CFG.0019", obs: "L.ACME.ADM.OBS.0231" });   // come la scrive subagent-trace
  writeFileSync(file, JSON.stringify(s, null, 2));
  const code = s.session_code;
  assert.match(code, SES_RE);
  const db = openDb(join(root, "knowledge.db"));
  db.prepare("insert into items(code,level,customer,scope,type,title,summary,facets,status,path,hash,updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run("C.ACME.ADM.CFG.0019", "C", "ACME", "ADM", "CFG", "t", "s", "{}", "validato", "p", "h", "2026-09-22");
  db.prepare("insert into observations(code) values (?)").run("L.ACME.ADM.OBS.0231");
  db.close();
  mkdirSync(join(root, "lessons"), { recursive: true });
  const lessonFile = join(root, "lessons", "L.ACME.ADM.LSN.0001.md");
  const validate = () => {
    const r = spawnSync(process.execPath, [LEARN, "validate", "--root", root, "--db", join(root, "knowledge.db"), "--json"], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    return JSON.parse(r.stdout).results[0];
  };
  writeFileSync(lessonFile, LESSON(code, "tutto come previsto"));
  const mute = validate();
  assert.equal(mute.status, "rejected");
  assert.equal(mute.reason, "non fondata");
  assert.ok(!parseLesson(readFileSync(lessonFile, "utf8")).frontmatter.validation.reasons.some((x) => /non trovata/.test(x)), "la sessione è stata trovata");
  writeFileSync(lessonFile, LESSON(code, "strict_import diverso dall'atteso (L.ACME.ADM.OBS.0231)"));
  const cited = validate();
  assert.equal(cited.status, "validated", JSON.stringify(parseLesson(readFileSync(lessonFile, "utf8")).frontmatter.validation));
});
