// Helper dei test K6: Atlas (SEL) e piano del tenant demo (RdA di prova in bozza), snapshot golden.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeSel, ROOT } from "./env-fixture.mjs";

export const PLAN = "PLAN.ACME.K6.0001";
export const GOLD = join(ROOT, "test/golden/step-check");
export const snap = (fmt, name) => readFileSync(join(GOLD, fmt, `${name}.txt`), "utf8");

export function demoAtlas(ws) {
  for (const [code, role, label, effect] of [
    ["C.ACME.P2P.SEL.0010", "link", "Nuova richiesta", "read"], ["C.ACME.P2P.SEL.0048", "textbox", "Descrizione", "write"],
    ["C.ACME.P2P.SEL.0045", "spinbutton", "Quantità", "write"], ["C.ACME.P2P.SEL.0044", "textbox", "Centro di costo", "write"],
    ["C.ACME.P2P.SEL.0046", "combobox", "Categoria", "write"], ["C.ACME.P2P.SEL.0047", "checkbox", "Urgente", "write"],
    ["C.ACME.P2P.SEL.0120", "button", "Salva bozza", "write"], ["C.ACME.P2P.SEL.0121", "status", "Bozza salvata", "read"],
    ["C.ACME.P2P.SEL.0130", "button", "Invia in approvazione", "write"],
  ]) writeSel(ws, code, { role, label, effect });
}

export function demoPlan(extra = {}) {
  return {
    plan_id: PLAN, customer: "ACME", env: "sandbox", goal: "RdA di prova in bozza",
    steps: [
      { n: 1, verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "https://acme-sbx.jaggaer.com/p2p/requisition/new" }, expect: { page_sig: "p2p/requisition/new" } },
      { n: 2, verb: "FILL", action_class: "ACT-CREATE", target: "C.ACME.P2P.SEL.0044", data: "IT-0442", timeout_ms: 15000,
        expect: { page_sig: "p2p/requisition/edit", options: ["Arredi", "Informatica"],
          elements: ["C.ACME.P2P.SEL.0048", "C.ACME.P2P.SEL.0045", { sel: "C.ACME.P2P.SEL.0044", required: false, value: "IT-0442" }, { sel: "C.ACME.P2P.SEL.0047", value: false }] } },
      { n: 3, verb: "SAVE", action_class: "ACT-CREATE", target: "C.ACME.P2P.SEL.0120", expect: { toast: "C.ACME.P2P.SEL.0121" } },
      { n: 4, verb: "SUBMIT", action_class: "ACT-SUBMIT", risk: "R2", target: "C.ACME.P2P.SEL.0130", expect: { messages: [] } },
    ],
    compensations: [{ step: 3, kind: "cancel", entity: "requisition", action: "requisition.cancel" }, { step: 4, kind: "cancel", entity: "requisition", action: "requisition.cancel" }],
    repair_policy: { skip_allowed: [], substitute_allowed: [], abort_on: [4] },
    ...extra,
  };
}
