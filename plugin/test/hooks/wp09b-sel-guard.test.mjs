// WP09b carry 5: una voce SEL valida per schemas/sel.schema.json (scritta come la scrive la digestione: YAML dell'oggetto
// validato) è letta da guard-production (role search_box, effect read: readSel) e dal legame uid↔SEL di observe-append
// (scripts/chrome/atlas.mjs: ruolo, etichetta, effetto) esattamente come i valori dello schema.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import YAML from "yaml";
import { decisionOf } from "../helpers/hook-env.mjs";
import { envWs, browserCall, patchSession, writePlan, sealActivePlan } from "../helpers/env-fixture.mjs";
import { validateItem } from "../../scripts/kb/validate-schema.mjs";
import { resolveSel, atlasIndex, atlasMatch } from "../../scripts/chrome/atlas.mjs";
import { readSel } from "../../hooks/lib/guards/plan-step.mjs";

const DT = "mcp__chrome-devtools__";
const fixture = YAML.parse(readFileSync(new URL("../fixtures/wp09b/sel.valid.yaml", import.meta.url), "utf8"));

function writeValidSel(ws, code, patch) {
  const item = { ...structuredClone(fixture), id: code, ...patch };
  const r = validateItem(item);
  assert.equal(r.ok, true, r.errors.join("; "));
  const dir = join(ws, "customers/ACME/kb/scopes/ADM/selectors");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${code}.yaml`), YAML.stringify(item));
  return item;
}

test("SEL valido per lo schema: guard-production consente fill sul search_box e click su effect read in produzione; la voce in scrittura resta negata", async () => {
  const ws = envWs({ env: "prod" });
  writeValidSel(ws, "C.ACME.ADM.SEL.0130", {});
  writeValidSel(ws, "C.ACME.ADM.SEL.0131", { role: "tab", effect: "read", label: "Scheda Righe", concept: "scheda righe",
    strategies: [{ kind: "role", value: "tab", name: "Scheda Righe" }, { kind: "text", value: "Righe" }] });
  writeValidSel(ws, "C.ACME.ADM.SEL.0120", { role: "button", effect: "write", label: "Salva", concept: "salva",
    strategies: [{ kind: "testid", value: "save" }, { kind: "role", value: "button", name: "Salva" }] });
  // la lettura dei guard (fast path senza yaml) restituisce proprio i valori dello schema
  const ctx = { ws, customer: "ACME" };
  assert.deepEqual(await readSel(ctx, "C.ACME.ADM.SEL.0130"), { code: "C.ACME.ADM.SEL.0130", role: "search_box", effect: "read" });
  assert.deepEqual(await readSel(ctx, "C.ACME.ADM.SEL.0120"), { code: "C.ACME.ADM.SEL.0120", role: "button", effect: "write" });
  const plan = (s) => ({ plan_id: "PLAN.0099", customer: "ACME", env: "prod", goal: "ricerca", steps: [s], repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [] } });
  const set = (s) => { patchSession(ws, (x) => { x.active_plan = { plan_id: "PLAN.0099", file: writePlan(ws, plan(s)), step: 1 }; }); sealActivePlan(ws); };
  set({ n: 1, verb: "FILL", action_class: "ACT-READ", target: "C.ACME.ADM.SEL.0130", data: "4500012345", expect: { page_sig: "x" } });
  assert.notEqual(decisionOf(browserCall("guard-production", ws, `${DT}fill`, { uid: "1_5", value: "4500012345" })), "deny");
  set({ n: 1, verb: "CLICK", action_class: "ACT-OBS", target: "C.ACME.ADM.SEL.0131", expect: { page_sig: "x" } });
  assert.notEqual(decisionOf(browserCall("guard-production", ws, `${DT}click`, { uid: "1_9" })), "deny");
  set({ n: 1, verb: "CLICK", action_class: "ACT-OBS", target: "C.ACME.ADM.SEL.0120", expect: { page_sig: "x" } });
  assert.equal(decisionOf(browserCall("guard-production", ws, `${DT}click`, { uid: "1_9" })), "deny");
});

test("SEL valido per lo schema: l'Atlas di observe-append lo lega all'elemento osservato (ruolo compatibile, etichetta) con effetto e strategie", () => {
  const ws = envWs({ env: "sandbox" });
  writeValidSel(ws, "C.ACME.ADM.SEL.0130", {});
  const e = resolveSel(ws, "C.ACME.ADM.SEL.0130", "ACME");
  assert.equal(e.role, "search_box"); assert.equal(e.effect, "read"); assert.equal(e.label, "Cerca fornitore"); assert.equal(e.stability, "stable");
  assert.deepEqual(e.strategies.map((s) => s.kind), ["testid", "role", "label"]);
  const atlas = atlasIndex(ws, "ACME", "ADM");
  assert.equal(atlasMatch(atlas, { name: "Cerca fornitore", role: "searchbox" })?.code, "C.ACME.ADM.SEL.0130");
  assert.equal(atlasMatch(atlas, { name: "Cerca fornitore", role: "button" }), null, "ruolo incompatibile: nessun legame");
});
