// Rigenera i golden del workflow (test/golden/workflow/*.txt) dagli eventi dei test K6.5.
// Uso: node test/tools/gen-workflow-golden.mjs — poi rileggere i file: sono il contratto visivo di §29.5.
import { writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { render } from "../../scripts/admin/workflow.mjs";

const OUT = fileURLToPath(new URL("../golden/workflow/", import.meta.url));
export const EVENTS = [
  { seq: 1, ts: "2026-09-23T10:41:00.000Z", kind: "task_start", payload: { task: "RdA di prova", steps: [
    { n: 1, agent: "cat-expert", class: "ACT-OBS", desc: "ricerca \"sedie\" a catalogo" },
    { n: 2, agent: "p2p-expert", class: "ACT-CREATE", desc: "richiesta con 1 riga ×5, CdC IT-0442" },
    { n: 3, agent: "p2p-expert", class: "ACT-SUBMIT", desc: "invio all'approvazione" },
    { n: 4, agent: "p2p-expert", class: "ACT-READ", desc: "lettura catena di approvazione" },
  ] } },
  { seq: 2, ts: "2026-09-23T10:41:05.000Z", kind: "step_start", payload: { n: 1 } },
  { seq: 3, ts: "2026-09-23T10:41:30.000Z", kind: "step_end", payload: { n: 1, status: "ok", note: "3 articoli", evidence: ["EV-01"] } },
  { seq: 4, ts: "2026-09-23T10:41:31.000Z", kind: "step_start", payload: { n: 2 } },
  { seq: 5, ts: "2026-09-23T10:42:10.000Z", kind: "step_end", payload: { n: 2, status: "ok", note: "NRT-20260923-B2C1-REQ-001", evidence: ["EV-02", "EV-03"], compensation: "requisition.cancel" } },
  { seq: 6, ts: "2026-09-23T10:42:11.000Z", kind: "approval", payload: { n: 3, state: "pending", text: "Confermi l'invio all'approvazione della richiesta NRT-…-REQ-001 (importo 3.190 €, 2 livelli previsti)?  [sì / no / mostra piano]" } },
];
export const STOPPED = [...EVENTS.slice(0, 5),
  { seq: 6, ts: "2026-09-23T10:43:00.000Z", kind: "step_start", payload: { n: 3 } },
  { seq: 7, ts: "2026-09-23T10:43:20.000Z", kind: "surprise", payload: { n: 3, kind: "elemento-assente" } },
  { seq: 8, ts: "2026-09-23T10:43:21.000Z", kind: "step_end", payload: { n: 3, status: "stopped", reason: "pulsante Invia assente (C.ACME.P2P.SEL.0130)", resume: "step-check --resume 3 dopo aver verificato i permessi del ruolo", errors: 1 } },
  { seq: 9, ts: "2026-09-23T10:44:00.000Z", kind: "outcome", payload: { status: "ERROR-BLOCKING" } },
  { seq: 10, ts: "2026-09-23T10:44:01.000Z", kind: "report", payload: { code: "RPT.ACME.20260923.0004" } }];
const S = (env) => ({ session_id: "sess-1", session_code: "SES.ACME.20260923.004", customer: "ACME", scope: "P2P", mode: "ops", budget: { tokens: 200000, used: 23000 }, env });
const SBX = { id: "sandbox", type: "sandbox", label: "ACME Sandbox", verified: true };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(OUT, { recursive: true });
  writeFileSync(`${OUT}sandbox.txt`, render(EVENTS, S(SBX)));
  writeFileSync(`${OUT}stopped.txt`, render(STOPPED, S(SBX)));
  writeFileSync(`${OUT}prod-3a.txt`, render(EVENTS.slice(0, 1), S({ ...SBX, type: "prod" }), { threeA: { a1: { ts: "2026-09-23T10:02:00.000Z" }, a2: { ts: "2026-09-23T10:19:00.000Z", approver_declared: "M. Rossi" }, step: 4, of: 7, a3: false } }));
  console.log(`golden scritti in ${OUT}`);
}
