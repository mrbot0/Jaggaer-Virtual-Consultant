// Revisione finale — guard-config-scope: Ruling F5 (I7) frase d'autonomia che alza il livello solo se confermata nel
// transcript; Ruling F6 (I8) write_data false nega ACT-BULK e ACT-DELETE in ogni ambiente; minore: handle_dialog accept
// in un passo non ACT-DELETE con testo o domanda di cancellazione ⇒ negato (anche in produzione); Ruling F1 al click:
// in produzione un passo ACT-BULK d'import di configurazione vuole la compensazione restore registrata.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdtempSync, appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { envWs, writePlan, patchSession, browserCall, writeSel } from "../helpers/env-fixture.mjs";
import { runHook, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";
import { check } from "../../scripts/decide/step-check.mjs";
import { appendApproval, approvalsFile, sha256 } from "../../scripts/admin/approvals.mjs";
import { confirmedAutonomyLevel } from "../../hooks/lib/autonomy.mjs";

const DT = "mcp__chrome-devtools__";
const RUN = "RUN.ACME.20261007.1000.ADM";
const PLAN = "PLAN.ACME.20261007.1000";
const URL = "https://acme-pre.jaggaer.com/p2p/import";
const SEL_IMP = "C.ACME.P2P.SEL.0400";
const SEL_SAVE = "C.ACME.P2P.SEL.0401";
const SEL_DEL = "C.ACME.P2P.SEL.0402";
const EV = `runs/${RUN}/evidence/before.json`;
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";

const say = (ws, tr, prompt) => {
  appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: prompt }, timestamp: new Date().toISOString() })}\n`);
  return runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt, transcript_path: tr }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
};
// record d'autonomia scritto nel registro SENZA che l'utente l'abbia detto (falsificato: non è nel transcript)
const forge = (ws, level) => appendApproval(approvalsFile(ws, "ACME", "sess-1"), { kind: "autonomy", level, prompt_sha256: sha256(`AUTONOMIA ${level === "alto" ? "ALTA" : level === "medio" ? "MEDIA" : "BASSA"}`), session: "sess-1" });
const activate = (ws, file, step = 1) => check({ ws, customer: "ACME", sid: "sess-1", planFile: file, step, snapshot: null });
const seeSnapshot = (ws, refs, names, url = URL) => patchSession(ws, (s) => { s.browser = { ...(s.browser ?? {}), current_url: url, tab: "1", snapshot: { obs: "L.ACME.ADM.OBS.0001", url, tab: null, ts: new Date().toISOString(), refs, names } }; });
const plan = (steps, compensations, extra = {}) => ({ plan_id: PLAN, customer: "ACME", env: "preprod", goal: "prova", steps, compensations, repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] }, ...extra });
const bulkStep = { n: 1, verb: "SUBMIT", action_class: "ACT-BULK", target: SEL_IMP, expect: { page_sig: "p2p/import" } };

function setup(p, { autonomy, env = "preprod" } = {}) {
  const ws = envWs({ env, scope: "P2P", autonomy });
  writeSel(ws, SEL_IMP, { role: "button", effect: "write", label: "Importa" });
  writeSel(ws, SEL_SAVE, { role: "button", effect: "write", label: "Salva" });
  writeSel(ws, SEL_DEL, { role: "button", effect: "write", label: "Elimina" });
  mkdirSync(join(ws, "customers/ACME/runs", RUN, "evidence"), { recursive: true });
  writeFileSync(join(ws, "customers/ACME", EV), "{\"prima\":true}");
  const file = writePlan(ws, p, RUN);
  const tr = join(mkdtempSync(join(tmpdir(), "frg-")), "t.jsonl"); writeFileSync(tr, "");
  return { ws, file, tr };
}
const click = (ws, tr, uid = "1_5") => browserCall("guard-config-scope", ws, DT + "click", { uid }, { transcript_path: tr });

// ---- Ruling F5 ----
test("F5: AUTONOMIA ALTA falsificata (non nel transcript) sopra autonomy.yaml basso ⇒ le approvazioni restano richieste", async () => {
  const { ws, file, tr } = setup(plan([bulkStep], [{ step: 1, kind: "deactivate", entity: "fornitore" }]), { autonomy: "basso" });
  forge(ws, "alto");
  const a = await activate(ws, file);
  assert.equal(a.status, "ok", JSON.stringify(a));   // step-check non ha transcript: il controllo è il guard, al click
  seeSnapshot(ws, { "1_5": SEL_IMP }, { "1_5": "Importa" });
  const r = click(ws, tr);
  assert.ok(denied(r), `atteso deny: ${r.stdout}`);
  assert.match(reasonOf(r), /manca A1/);
});

test("F5: AUTONOMIA ALTA detta davvero dall'utente (nel transcript) ⇒ il livello alto vale", async () => {
  const { ws, file, tr } = setup(plan([bulkStep], [{ step: 1, kind: "deactivate", entity: "fornitore" }]), { autonomy: "basso" });
  say(ws, tr, "AUTONOMIA ALTA");
  const a = await activate(ws, file);
  assert.equal(a.status, "ok", JSON.stringify(a));
  seeSnapshot(ws, { "1_5": SEL_IMP }, { "1_5": "Importa" });
  const r = click(ws, tr);
  assert.ok(silent(r), `atteso consentito: ${r.stdout}`);
});

test("F5: una frase che ABBASSA il livello vale anche senza conferma (fail-closed); helper puro", async () => {
  const { ws, file, tr } = setup(plan([bulkStep], [{ step: 1, kind: "deactivate", entity: "fornitore" }]), { autonomy: "alto" });
  forge(ws, "basso");
  await activate(ws, file);   // apre la richiesta APPROVO PIANO (livello basso)
  say(ws, tr, `APPROVO PIANO ${PLAN}`);
  await activate(ws, file);
  seeSnapshot(ws, { "1_5": SEL_IMP }, { "1_5": "Importa" });
  const r = click(ws, tr);
  assert.ok(denied(r), r.stdout);
  assert.match(reasonOf(r), /APPROVO PASSO 1/);
  // helper: alza solo con conferma; abbassa sempre; nessuna frase ⇒ cliente/predefinito
  const rec = (level) => ({ kind: "autonomy", level });
  const lvl = (records, yaml, confirm) => { const w = mkdtempSync(join(tmpdir(), "cal-")); if (yaml) { mkdirSync(join(w, "customers/ACME/config"), { recursive: true }); writeFileSync(join(w, "customers/ACME/config/autonomy.yaml"), `default: ${yaml}\n`); } return confirmedAutonomyLevel({ ws: w, customer: "ACME", records, envType: "preprod", confirm }); };
  assert.equal(lvl([rec("alto")], "basso", () => false).level, "basso");
  assert.equal(lvl([rec("alto")], "basso", () => true).level, "alto");
  assert.equal(lvl([rec("medio")], null, () => false).level, "medio", "senza file vale alto: medio abbassa");
  assert.equal(lvl([rec("basso")], "alto", () => false).level, "basso");
  assert.equal(lvl([], "medio", () => false).level, "medio");
  const u = lvl([rec("alto")], "basso", () => false);
  assert.equal(u.unconfirmed, "alto");
  // in produzione il tetto è medio: ALTA su un cliente medio non alza nulla ⇒ nessuna conferma richiesta
  const w = mkdtempSync(join(tmpdir(), "cal-")); mkdirSync(join(w, "customers/ACME/config"), { recursive: true }); writeFileSync(join(w, "customers/ACME/config/autonomy.yaml"), "default: medio\n");
  let asked = false;
  assert.equal(confirmedAutonomyLevel({ ws: w, customer: "ACME", records: [rec("alto")], envType: "prod", confirm: () => { asked = true; return false; } }).level, "medio");
  assert.equal(asked, false);
});

// ---- Ruling F6 ----
test("F6: write_data false (pre-produzione, sessione) ⇒ click del passo ACT-BULK e del passo DELETE negati", async () => {
  const { ws, file, tr } = setup(plan([bulkStep], [{ step: 1, kind: "deactivate", entity: "fornitore" }]), { autonomy: "alto" });
  const a = await activate(ws, file);
  assert.equal(a.status, "ok", JSON.stringify(a));
  seeSnapshot(ws, { "1_5": SEL_IMP }, { "1_5": "Importa" });
  assert.ok(silent(click(ws, tr)), "controllo: con write_data true il click passa");
  patchSession(ws, (s) => { s.env.policy.write_data = false; });
  const r = click(ws, tr);
  assert.ok(denied(r), r.stdout);
  assert.match(reasonOf(r), /write_data/);

  const d = setup(plan([{ n: 1, verb: "DELETE", action_class: "ACT-DELETE", target: SEL_DEL, expect: { elements: [] } }], [{ step: 1, kind: "restore", ref: EV }]), { autonomy: "alto" });
  await activate(d.ws, d.file);   // alto: A1 per ACT-DELETE
  say(d.ws, d.tr, `APPROVO PIANO ${PLAN}`);
  const ad = await activate(d.ws, d.file);
  assert.equal(ad.status, "ok", JSON.stringify(ad));
  seeSnapshot(d.ws, { "1_5": SEL_DEL }, { "1_5": "Elimina" });
  patchSession(d.ws, (s) => { s.env.policy.write_data = false; });
  const rd = click(d.ws, d.tr);
  assert.ok(denied(rd), rd.stdout);
  assert.match(reasonOf(rd), /write_data/);
});

// ---- minore: handle_dialog accept in un passo non ACT-DELETE ----
test("dialog: accept in un passo SAVE (non ACT-DELETE) con testo o domanda di cancellazione ⇒ negato; dialog normale ⇒ consentito", async () => {
  const { ws, file, tr } = setup(plan([{ n: 1, verb: "SAVE", action_class: "ACT-CREATE", target: SEL_SAVE, expect: { page_sig: "x" } }], [{ step: 1, kind: "cancel", entity: "rda", action: "rda.cancel" }]), { autonomy: "alto" });
  const a = await activate(ws, file);
  assert.equal(a.status, "ok", JSON.stringify(a));
  seeSnapshot(ws, { "1_5": SEL_SAVE }, { "1_5": "Salva" });
  assert.ok(silent(browserCall("guard-config-scope", ws, `${DT}handle_dialog`, { action: "accept", pageId: 1 }, { transcript_path: tr })), "controllo: dialog qualunque");
  const p = browserCall("guard-config-scope", ws, `${DT}handle_dialog`, { action: "accept", promptText: "ELIMINA", pageId: 1 }, { transcript_path: tr });
  assert.ok(denied(p), p.stdout); assert.match(reasonOf(p), /cancellazione/);
  seeSnapshot(ws, { "1_5": SEL_SAVE }, { "1_5": "Salva", "1_6": "Vuoi eliminare le righe selezionate?" });
  const q = browserCall("guard-config-scope", ws, `${DT}handle_dialog`, { action: "accept", pageId: 1 }, { transcript_path: tr });
  assert.ok(denied(q), q.stdout); assert.match(reasonOf(q), /cancellazione/);
  // dismiss resta libero
  assert.ok(silent(browserCall("guard-config-scope", ws, `${DT}handle_dialog`, { action: "dismiss", pageId: 1 }, { transcript_path: tr })));
});

test("dialog in produzione (write_data true): accept con domanda di cancellazione in un passo UPDATE ⇒ negato per la cancellazione", async () => {
  const p = { ...plan([{ n: 1, verb: "SAVE", action_class: "ACT-UPDATE", target: SEL_SAVE, expect: { page_sig: "x" } }], [{ step: 1, kind: "cancel", entity: "rda", action: "rda.cancel" }]), env: "prod" };
  const { ws, file, tr } = setup(p, { autonomy: "medio", env: "prod" });
  const text = readFileSync(join(ws, "customers/ACME", file), "utf8");
  patchSession(ws, (s) => { s.env.policy.write_data = true; s.active_plan = { plan_id: PLAN, file, step: 1, run: RUN, plan_sha256: createHash("sha256").update(text).digest("hex") }; });
  seeSnapshot(ws, { "1_5": SEL_SAVE }, { "1_5": "Salva", "1_6": "Confermi l'eliminazione del fornitore?" }, "https://acme.jaggaer.com/vendors/1");
  const r = browserCall("guard-config-scope", ws, `${DT}handle_dialog`, { action: "accept", pageId: 1 }, { transcript_path: tr });
  assert.ok(denied(r), r.stdout);
  assert.match(reasonOf(r), /cancellazione/);
});

// ---- Ruling F1 al click (difesa in profondità) ----
test("F1 al click: in produzione un passo ACT-BULK d'import di configurazione senza compensazione restore registrata ⇒ negato", async () => {
  const p = { ...plan([bulkStep], [{ step: 1, kind: "deactivate", entity: "data element" }]), env: "prod" };
  const { ws, file, tr } = setup(p, { autonomy: "medio", env: "prod" });
  const text = readFileSync(join(ws, "customers/ACME", file), "utf8");
  patchSession(ws, (s) => {
    s.env.policy.write_data = true;
    s.active_plan = { plan_id: PLAN, file, step: 1, run: RUN, plan_sha256: createHash("sha256").update(text).digest("hex") };
    s.pending.compensations = [{ plan: PLAN, step: 1, kind: "deactivate", entity: "data element", status: "pending" }];
  });
  seeSnapshot(ws, { "1_5": SEL_IMP }, { "1_5": "Importa" }, "https://acme.jaggaer.com/adm/import");
  const r = click(ws, tr);
  assert.ok(denied(r), r.stdout);
  assert.match(reasonOf(r), /istantanea/);
});

// ---- minori di approval-capture ----
const ctxOf = (r) => { try { return JSON.parse(r.stdout).hookSpecificOutput?.additionalContext ?? ""; } catch { return ""; } };
test("approval-capture: «autonomia bassa» in minuscolo o misto ⇒ risposta con la frase esatta, anche senza piano in attesa; nessun record", () => {
  const ws = envWs({ env: "preprod", scope: "P2P", autonomy: null });
  const tr = join(mkdtempSync(join(tmpdir(), "frg-")), "t.jsonl"); writeFileSync(tr, "");
  const a = say(ws, tr, "autonomia bassa");
  assert.match(ctxOf(a), /`AUTONOMIA BASSA`/, a.stdout);
  assert.doesNotMatch(ctxOf(a), /APPROVO/);
  assert.match(ctxOf(say(ws, tr, "Autonomia Alta per favore")), /`AUTONOMIA ALTA`/);
  const any = ctxOf(say(ws, tr, "metti l'autonomia"));
  for (const w of ["ALTA", "MEDIA", "BASSA"]) assert.match(any, new RegExp(`\`AUTONOMIA ${w}\``));
  // con un piano in attesa la risposta resta sulla frase d'autonomia
  patchSession(ws, (s) => { s.pending.approvals = [{ kind: "A1", plan: PLAN, file: `runs/${RUN}/plan.json` }]; });
  const b = ctxOf(say(ws, tr, "autonomia media"));
  assert.match(b, /`AUTONOMIA MEDIA`/); assert.doesNotMatch(b, /APPROVO PIANO/);
  let recs = "";
  try { recs = readFileSync(approvalsFile(ws, "ACME", "sess-1"), "utf8"); } catch { /* nessun registro */ }
  assert.ok(!/"kind":"autonomy"/.test(recs), "nessun record d'autonomia da una frase in minuscolo");
});

test("approval-capture: «sì» in produzione ⇒ il motivo indica APPROVO PASSO (non il vecchio «non si scrivono dati»)", () => {
  const ws = envWs({ env: "prod", scope: "P2P", autonomy: null });
  const tr = join(mkdtempSync(join(tmpdir(), "frg-")), "t.jsonl"); writeFileSync(tr, "");
  patchSession(ws, (s) => { s.pending.approvals = [{ kind: "action", plan: PLAN, step: 2 }]; });
  const r = say(ws, tr, "sì");
  const out = r.stdout;
  assert.match(out, /APPROVO PASSO/, out);
  assert.doesNotMatch(out, /non si scrivono dati/);
});
