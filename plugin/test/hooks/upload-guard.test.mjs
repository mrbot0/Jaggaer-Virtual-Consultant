// Ops veloce (spec 2026-10-06 §3.8) — upload: si carica solo il file compilato del run attivo, con l'impronta dichiarata
// nel passo UPLOAD del piano (file { path, sha256, rows }); percorso confinato nel run (realpath), un solo file per
// chiamata, impronta ricalcolata al momento del caricamento; sotto un passo con altro verbo, o senza classificazione
// dei file, ogni upload resta negato.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join, dirname, sep } from "node:path";
import { createHash } from "node:crypto";
import { writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { envWs, patchSession, writePlan, writeSel, sealActivePlan, browserCall } from "../helpers/env-fixture.mjs";
import { decisionOf, reasonOf } from "../helpers/hook-env.mjs";
import { classify } from "../../hooks/lib/browser-tools.mjs";

const DT = "mcp__chrome-devtools__";
const RUN = "RUN.ACME.20261007.1000.ADM";
const SEL_UP = "C.ACME.ADM.SEL.0140";
const REL = `runs/${RUN}/import/de.xlsx`;
const PLAN = "PLAN.ACME.UP.0001";
const URL_ = "https://acme-sbx.jaggaer.com/setup/import-profiles";
const CB = "mcp__claude-in-chrome__file_upload";
const PW = "mcp__plugin_playwright_playwright__browser_file_upload";
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";
const sha = (buf) => createHash("sha256").update(buf).digest("hex");
const CONTENT = Buffer.from("PK\x03\x04 cliente;paese\nACME;DE\nACME;AT\n");

// ws sandbox ADM, autonomia alta; file compilato scritto nel run; piano con un solo passo, attivo e sigillato
function setup({ verb = "UPLOAD", cls = "ACT-BULK", file = undefined, tab = "1" } = {}) {
  const ws = envWs({ env: "sandbox", scope: "ADM", autonomy: "alto" });
  writeSel(ws, SEL_UP, { role: "button", effect: "write", label: "Carica file" });
  const abs = join(ws, "customers/ACME", REL);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, CONTENT);
  const step = { n: 1, verb, action_class: cls, target: SEL_UP, expect: { toast: "ok" } };
  if (verb === "UPLOAD") step.file = file ?? { path: REL, sha256: sha(CONTENT), rows: 2 };
  const planFile = writePlan(ws, {
    plan_id: PLAN, customer: "ACME", env: "sandbox", goal: "import di prova", steps: [step],
    repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [1] },
  }, RUN);
  patchSession(ws, (s) => { s.active_plan = { plan_id: PLAN, file: planFile, step: 1, run: RUN }; s.pending.compensations = [{ plan: PLAN, step: 1, kind: "cancel", entity: "import di prova" }]; });
  sealActivePlan(ws, { url: URL_, tab, refs: { "1_7": SEL_UP } });
  return { ws, abs, up: (ti) => browserCall("guard-config-scope", ws, DT + "upload_file", { uid: "1_7", pageId: 1, ...ti }) };
}

test("1. file del passo (percorso assoluto) con l'impronta del piano ⇒ consentito", () => {
  const { abs, up } = setup();
  const r = up({ filePath: abs });
  assert.ok(silent(r), r.stdout);
});

test("2. contenuto riscritto dopo il piano ⇒ deny (impronta)", () => {
  const { abs, up } = setup();
  writeFileSync(abs, Buffer.concat([CONTENT, Buffer.from("ACME;FR\n")]));
  const r = up({ filePath: abs });
  assert.ok(denied(r), r.stdout);
  assert.match(reasonOf(r), /impronta/);
});

test("3. percorso con .. che esce dal run (config/environments.yaml) ⇒ deny", () => {
  const { ws, up } = setup();
  const sneaky = `${join(ws, "customers/ACME", REL, "..")}/../../../config/environments.yaml`;
  const r = up({ filePath: sneaky });
  assert.ok(denied(r), r.stdout);
  assert.match(reasonOf(r), /si carica solo/);
  // un file qualunque dentro il run, ma diverso da quello del passo
  const { ws: w2, up: up2 } = setup();
  writeFileSync(join(w2, "customers/ACME", `runs/${RUN}/import/other.xlsx`), CONTENT);
  const o = up2({ filePath: join(w2, "customers/ACME", `runs/${RUN}/import/other.xlsx`) });
  assert.ok(denied(o), o.stdout);
});

test("4. file fuori dal workspace (tmpdir) ⇒ deny, anche se l'impronta coincide con quella dichiarata", () => {
  const out = join(mkdtempSync(join(tmpdir(), "up-")), "de.xlsx");
  writeFileSync(out, CONTENT);
  const { up } = setup();
  const r = up({ filePath: out });
  assert.ok(denied(r), r.stdout);
  assert.match(reasonOf(r), /si carica solo|fuori/);
});

test("5. upload sotto un passo SAVE ⇒ deny (UPLOAD)", () => {
  const { abs, up } = setup({ verb: "SAVE", cls: "ACT-CFG-CHANGE" });
  const r = up({ filePath: abs });
  assert.ok(denied(r), r.stdout);
  assert.match(reasonOf(r), /UPLOAD/);
});

test("6. stesso file raggiunto con segmenti ridondanti o maiuscole diverse (Windows) ⇒ consentito (realpath)", () => {
  const { abs, up } = setup();
  const redundant = [dirname(abs), "..", "import", ".", "de.xlsx"].join(sep);   // join() normalizzerebbe: si compone a mano
  const raw = `${dirname(abs)}/../import/./de.xlsx`;
  for (const v of [redundant, raw]) {
    assert.notEqual(v, abs, "il percorso equivalente deve differire testualmente");
    assert.ok(silent(up({ filePath: v })), v);
  }
  if (process.platform === "win32") {
    assert.notEqual(abs.toUpperCase(), abs);
    assert.ok(silent(up({ filePath: abs.toUpperCase() })), "maiuscole diverse");
  }
});

test("7. zero file, percorso vuoto, upload_image senza percorsi ⇒ deny con il motivo del conteggio/classificazione", () => {
  const { up } = setup();
  for (const ti of [{ filePath: undefined }, { filePath: "" }]) {
    const r = up(ti);
    assert.ok(denied(r), r.stdout);
    assert.match(reasonOf(r), /un caricamento alla volta/);
  }
  // upload_image del browser di Claude non porta percorsi (imageId): senza files ⇒ negato per lo stesso motivo
  const { ws } = setup({ tab: "101" });
  const img = browserCall("guard-config-scope", ws, "mcp__claude-in-chrome__upload_image", { imageId: "i1", ref: "1_7", tabId: 101 });
  assert.ok(denied(img), img.stdout);
  assert.match(reasonOf(img), /un caricamento alla volta/);
  // Playwright senza paths: negato (senza ref, il legame al SEL nega prima)
  const none = browserCall("guard-config-scope", setup().ws, PW, {});
  assert.ok(denied(none), none.stdout);
});

test("7b. due file nella stessa chiamata (Claude in Chrome, ref legato al SEL, sandbox) ⇒ deny per il conteggio; uno solo ⇒ consentito", () => {
  const { ws, abs } = setup({ tab: "101" });
  const cb = (paths) => browserCall("guard-config-scope", ws, CB, { paths, ref: "1_7", tabId: 101 });
  assert.ok(silent(cb([abs])), "controllo: un file solo è consentito");
  const two = cb([abs, abs]);
  assert.ok(denied(two), two.stdout);
  assert.match(reasonOf(two), /un caricamento alla volta/);
  const zero = cb([]);
  assert.ok(denied(zero), zero.stdout);
  assert.match(reasonOf(zero), /un caricamento alla volta/);
});

test("7c. percorso relativo ⇒ deny (il server MCP lo risolverebbe nella sua cartella), anche se nella cartella corrente c'è un file con la stessa impronta", () => {
  const { ws, abs, up } = setup();
  writeFileSync(join(ws, "de.xlsx"), CONTENT);
  for (const rel of ["de.xlsx", `customers/ACME/${REL}`, "./de.xlsx"]) {
    const r = up({ filePath: rel });
    assert.ok(denied(r), `${rel}: ${r.stdout}`);
    assert.match(reasonOf(r), /relativo/);
  }
  assert.ok(silent(up({ filePath: abs })), "controllo: l'assoluto resta consentito");
});

test("7d. più di un upload nella stessa chiamata (browser_batch) ⇒ deny; un upload solo nel batch ⇒ consentito", () => {
  const { ws, abs } = setup({ tab: "101" });
  const act = { name: "file_upload", input: { paths: [abs], ref: "1_7", tabId: 101 } };
  const batch = (actions) => browserCall("guard-config-scope", ws, "mcp__claude-in-chrome__browser_batch", { actions });
  const two = batch([act, act]);
  assert.ok(denied(two), two.stdout);
  assert.match(reasonOf(two), /più di un upload/);
  assert.ok(silent(batch([act])), "un upload solo nel batch");
});

test("8. classificazione: i percorsi finiscono in files (DevTools filePath, Playwright e Claude in Chrome paths); upload_image non ne porta", () => {
  assert.deepEqual(classify(DT + "upload_file", { uid: "1", filePath: "C:/a.xlsx" }).files, ["C:/a.xlsx"]);
  assert.deepEqual(classify(DT + "upload_file", { uid: "1" }).files, []);
  assert.deepEqual(classify("mcp__plugin_playwright_playwright__browser_file_upload", { paths: ["a", "b"] }).files, ["a", "b"]);
  assert.deepEqual(classify("mcp__plugin_playwright_playwright__browser_file_upload", { paths: "a" }).files, []);
  assert.deepEqual(classify("mcp__claude-in-chrome__file_upload", { paths: ["a"], ref: "r1", tabId: 1 }).files, ["a"]);
  assert.equal(classify("mcp__claude-in-chrome__upload_image", { imageId: "i" }).files, undefined);
});
