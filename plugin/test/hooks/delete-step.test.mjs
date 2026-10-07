// Ops veloce (spec 2026-10-06 §3.7) — cancellazioni dentro un passo DELETE: un click su un'etichetta di cancellazione
// vale SOLO dentro un passo DELETE (ACT-DELETE) del piano attivo e solo sull'elemento del SEL di quel passo; il passo
// parte solo con la lettura completa dell'oggetto salvata nel run (compensazione restore con ref); senza piano,
// negli altri passi, in esplorazione e in produzione ogni cancellazione resta negata (guard-config-scope e
// guard-destructive/DR-BROWSER-002).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdtempSync, appendFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { envWs, writePlan, patchSession, browserCall, writeSel } from "../helpers/env-fixture.mjs";
import { runHook, runSessionCli, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";
import { check } from "../../scripts/decide/step-check.mjs";
import { demoAtlas, PLAN } from "../helpers/k6-fixture.mjs";

const DT = "mcp__chrome-devtools__";
const RUN = "RUN.ACME.20261007.1000.ADM";
const EVIDENCE = `runs/${RUN}/evidence/before.json`;
const URL = "https://acme-pre.jaggaer.com/p2p/requisition/edit/10045";
const SEL_DEL = "C.ACME.P2P.SEL.0200";
const SEL_SAVE = "C.ACME.P2P.SEL.0120";
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";

const say = (ws, tr, prompt) => {
  appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: prompt }, timestamp: new Date().toISOString() })}\n`);
  return runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt, transcript_path: tr }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
};
const activate = (ws, file, step = 1) => check({ ws, customer: "ACME", sid: "sess-1", planFile: file, step, snapshot: null });
// attivazione dopo APPROVO PIANO (alto: A1 per ACT-DELETE): la prima chiamata apre la richiesta, la frase la chiude
async function approvedActivate(ctx) {
  const a0 = await activate(ctx.ws, ctx.file);
  if (a0.status !== "approval_required") return a0;
  say(ctx.ws, ctx.tr, `APPROVO PIANO ${PLAN}`);
  return activate(ctx.ws, ctx.file);
}
const deleteStep = (extra = {}) => ({ n: 1, verb: "DELETE", action_class: "ACT-DELETE", target: SEL_DEL, expect: { elements: [] }, ...extra });
const restore = (extra = {}) => ({ step: 1, kind: "restore", ref: EVIDENCE, ...extra });
const plan = (step, compensations) => ({
  plan_id: PLAN, customer: "ACME", env: "preprod", goal: "cancellazione di prova", steps: [step], ...(compensations ? { compensations } : {}),
  repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [1] },
});

// ws preprod, autonomia alta, Atlas con il pulsante "Elimina"; evidenza salvata nel run (a meno di withEvidence: false)
function setup(p, { withEvidence = true } = {}) {
  const ws = envWs({ env: "preprod", scope: "P2P", autonomy: "alto" });
  demoAtlas(ws);
  writeSel(ws, SEL_DEL, { role: "button", effect: "write", label: "Elimina" });
  if (withEvidence) {
    mkdirSync(join(ws, "customers/ACME", dirOf(EVIDENCE)), { recursive: true });
    writeFileSync(join(ws, "customers/ACME", EVIDENCE), JSON.stringify({ requisition: { id: 10045, items: [{ n: 1 }] } }));
  }
  const file = writePlan(ws, p, RUN);
  const tr = join(mkdtempSync(join(tmpdir(), "ds-")), "t.jsonl"); writeFileSync(tr, "");
  return { ws, file, tr };
}
const dirOf = (p) => p.slice(0, p.lastIndexOf("/"));

// snapshot osservato: uid → SEL (refs) e uid → nome (names)
function seeSnapshot(ws, refs, names) {
  patchSession(ws, (s) => { s.browser = { ...(s.browser ?? {}), current_url: URL, tab: "1", snapshot: { obs: "L.ACME.ADM.OBS.0001", url: URL, tab: null, ts: new Date().toISOString(), refs, names } }; });
}
const both = (ws, tr, tool, ti) => ({
  scope: browserCall("guard-config-scope", ws, tool, ti, { transcript_path: tr }),
  destructive: browserCall("guard-destructive", ws, tool, ti, { transcript_path: tr }),
});

// passo DELETE pronto: piano attivato (A1 data), snapshot con il pulsante Elimina legato al SEL del passo
async function readyDelete() {
  const ctx = setup(plan(deleteStep(), [restore()]));
  const a0 = await activate(ctx.ws, ctx.file);
  assert.equal(a0.status, "approval_required", JSON.stringify(a0));
  assert.match(a0.ask, /APPROVO PIANO/);
  say(ctx.ws, ctx.tr, `APPROVO PIANO ${PLAN}`);
  const a1 = await activate(ctx.ws, ctx.file);
  assert.equal(a1.status, "ok", JSON.stringify(a1));
  seeSnapshot(ctx.ws, { "1_7": SEL_DEL, "1_8": null }, { "1_7": "Elimina", "1_8": "Elimina" });
  return ctx;
}

test("1. passo DELETE senza compensazione restore con ref ⇒ step-check nega all'attivazione (restore)", async () => {
  const first = setup(plan(deleteStep()));
  const r = await approvedActivate(first);
  assert.equal(r.status, "denied", JSON.stringify(r));
  assert.match(r.reason, /restore/);
  // compensazione di un altro tipo, senza ref, con ref fuori da evidence/ o con il file assente ⇒ stesso esito
  for (const comp of [restore({ kind: "close" }), restore({ ref: undefined }), restore({ ref: `runs/${RUN}/other/before.json` }), restore({ ref: `runs/${RUN}/evidence/../plan.json` })]) {
    const c = setup(plan(deleteStep(), [comp]));
    const x = await approvedActivate(c);
    assert.equal(x.status, "denied", JSON.stringify([comp, x]));
    assert.match(x.reason, /restore/);
  }
  const noFile = setup(plan(deleteStep(), [restore()]), { withEvidence: false });
  const nf = await approvedActivate(noFile);
  assert.equal(nf.status, "denied", JSON.stringify(nf));
  assert.match(nf.reason, /restore/);
});

test("2. DELETE con restore + file + APPROVO PIANO ⇒ il click sull'uid del SEL è consentito da tutti i guard del browser", async () => {
  const { ws, tr } = await readyDelete();
  const r = both(ws, tr, DT + "click", { uid: "1_7" });
  assert.ok(silent(r.scope), `config-scope: ${r.scope.stdout}`);
  assert.ok(silent(r.destructive), `destructive: ${r.destructive.stdout}`);
});

test("2b. senza APPROVO PIANO (alto: A1 per ACT-DELETE) il passo DELETE non parte", async () => {
  const { ws, file } = setup(plan(deleteStep(), [restore()]));
  const r = await activate(ws, file);
  assert.equal(r.status, "approval_required", JSON.stringify(r));
});

test("3. passo SAVE (ACT-CREATE) attivo: click su un uid il cui nome è 'Elimina riga' ⇒ deny (cancellazione)", async () => {
  const p = plan({ n: 1, verb: "SAVE", action_class: "ACT-CREATE", target: SEL_SAVE, expect: { messages: [] } }, [{ step: 1, kind: "cancel", entity: "requisition", action: "requisition.cancel" }]);
  const { ws, file, tr } = setup(p);
  const a = await activate(ws, file);
  assert.equal(a.status, "ok", JSON.stringify(a));
  // l'uid è davvero il SEL del passo (il legame passa), ma il suo nome è una cancellazione
  seeSnapshot(ws, { "1_3": SEL_SAVE, "1_9": SEL_SAVE }, { "1_3": "Salva bozza", "1_9": "Elimina riga" });
  const ok = both(ws, tr, DT + "click", { uid: "1_3" });
  assert.ok(silent(ok.scope), `controllo: ${ok.scope.stdout}`);
  const r = both(ws, tr, DT + "click", { uid: "1_9" });
  assert.ok(denied(r.scope), r.scope.stdout);
  assert.match(reasonOf(r.scope), /cancellazione/);
  assert.ok(denied(r.destructive), r.destructive.stdout);
});

test("4. passo DELETE attivo: click su un uid diverso dal SEL del passo, anche chiamato 'Elimina' ⇒ deny", async () => {
  const { ws, tr } = await readyDelete();
  const r = both(ws, tr, DT + "click", { uid: "1_8" });
  assert.ok(denied(r.scope), r.scope.stdout);
  assert.ok(denied(r.destructive), r.destructive.stdout);
  assert.match(reasonOf(r.destructive), /DR-BROWSER-002/);
  // uid assente dallo snapshot ⇒ nessun legame con il SEL del passo ⇒ deny di config-scope
  assert.ok(denied(browserCall("guard-config-scope", ws, DT + "click", { uid: "9_9" }, { transcript_path: tr })));
  // click senza uid (solo l'etichetta del modello) ⇒ deny
  const y = both(ws, tr, DT + "click", { element: "Elimina" });
  assert.ok(denied(y.scope) || denied(y.destructive), "senza uid");
});

test("5. click su 'Elimina' senza piano ⇒ deny (config-scope e guard-destructive)", () => {
  const ws = envWs({ env: "preprod", scope: "P2P", autonomy: "alto" });
  const tr = join(mkdtempSync(join(tmpdir(), "ds-")), "t.jsonl"); writeFileSync(tr, "");
  seeSnapshot(ws, { "1_7": SEL_DEL }, { "1_7": "Elimina" });
  const r = both(ws, tr, DT + "click", { uid: "1_7" });
  assert.ok(denied(r.scope), r.scope.stdout);
  assert.ok(denied(r.destructive), r.destructive.stdout);
  assert.match(reasonOf(r.destructive), /DR-BROWSER-002/);
});

test("6. esplorazione completa: ogni cancellazione resta negata", () => {
  const ws = envWs({ env: "preprod", scope: "P2P", autonomy: "alto" });
  const tr = join(mkdtempSync(join(tmpdir(), "ds-")), "t.jsonl"); writeFileSync(tr, "");
  say(ws, tr, "ESPLORA PREPROD COMPLETA");
  const m = runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: ws });
  assert.equal(m.status, 0, m.stderr + m.stdout);
  seeSnapshot(ws, { "1_3": null, "1_7": null }, { "1_3": "Salva", "1_7": "Elimina bozza" });
  assert.ok(silent(browserCall("guard-config-scope", ws, DT + "click", { uid: "1_3" }, { transcript_path: tr })), "controllo: Salva è consentito");
  const r = both(ws, tr, DT + "click", { uid: "1_7" });
  assert.ok(denied(r.scope), r.scope.stdout);
  assert.ok(denied(r.destructive), r.destructive.stdout);
});

test("7. in produzione l'eccezione non esiste: stesso click su SEL del passo DELETE ⇒ deny di guard-destructive", async () => {
  const { ws, tr } = await readyDelete();
  patchSession(ws, (s) => { s.env.type = "prod"; });
  const r = browserCall("guard-destructive", ws, DT + "click", { uid: "1_7" }, { transcript_path: tr });
  assert.ok(denied(r), r.stdout);
  assert.match(reasonOf(r), /DR-BROWSER-002/);
});

test("8. un passo CLICK di classe ACT-DELETE (non DELETE) non apre l'eccezione di guard-destructive", async () => {
  const p = plan({ n: 1, verb: "CLICK", action_class: "ACT-DELETE", target: SEL_DEL, expect: { elements: [] } }, [restore()]);
  const { ws, file, tr } = setup(p);
  say(ws, tr, `APPROVO PIANO ${PLAN}`);
  await activate(ws, file);
  say(ws, tr, `APPROVO PIANO ${PLAN}`);
  const a = await activate(ws, file);
  assert.equal(a.status, "ok", JSON.stringify(a));
  seeSnapshot(ws, { "1_7": SEL_DEL }, { "1_7": "Elimina" });
  const r = both(ws, tr, DT + "click", { uid: "1_7" });
  assert.ok(denied(r.destructive), r.destructive.stdout);
  assert.ok(denied(r.scope), r.scope.stdout);
});
