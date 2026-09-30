// WP10b — le righe di comando scritte nei corpi degli agenti sono eseguibili sotto i guard: rese con valori d'esempio
// (cliente ACME, scope CAT, sessione sess-1) e valutate IN PROCESSO dai guard FAIL-CLOSED che vedono la shell
// (guard-scope, guard-customer, guard-budget, guard-destructive, guard-config-scope, guard-phrase) come se le lanciasse
// quel sub-agente (agent_type, agent_id). Un deny qui significa che l'istruzione del corpo sbatterebbe contro un hook.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkWs, seedSession, ROOT } from "../helpers/hook-env.mjs";
import { commandLines } from "../helpers/commands.mjs";
import { agentFiles, parseAgent } from "../helpers/agents-md.mjs";

const GUARDS = ["scope", "customer", "budget", "destructive", "config-scope", "phrase"];
// <piano>: il piano ATTIVO (session.active_plan.file, relativo alla cartella del cliente): un sub-agente esegue step-check
// solo su quello o su un piano approvato dall'utente (guard-config-scope, WP07 giro 1).
const PLAN_FILE = "runs/RUN.ACME.20260929.1015.CAT/cases/NRT.ACME.CAT.NEG.0031/plan.json";
// Scope di sessione del dispatch: i trasversali di onboarding lavorano su XSC (profilo e mappe dei processi),
// analytics-learner su ANL; gli altri sullo scope del compito (qui CAT).
const SCOPE_OF = { "customer-profiler": "XSC", "process-mapper": "XSC", "analytics-learner": "ANL" };
const VALUES = { C: "ACME", sid: "sess-1", SES: "SES.ACME.20260929.001", task: "MSG.SES.ACME.20260929.001.0012", mese: "2026-09", piano: PLAN_FILE };

function renderForGuards(line, scope) {
  return line.replaceAll("${CLAUDE_PLUGIN_ROOT}", ROOT.replace(/\\/g, "/"))
    .replace(/<([^<>]*)>/g, (_m, k) => (k === "S" ? scope : VALUES[k] ?? "X1"));
}

test("ogni riga di comando degli agenti passa i guard della shell come quel sub-agente (nessun deny)", async () => {
  const wsOf = {};
  for (const scope of ["CAT", "XSC", "ANL"]) {
    const ws = mkWs();
    seedSession(ws, { scope, extra: { active_plan: { plan_id: "PLAN.ACME.0001", file: PLAN_FILE, step: 1 } } });
    const env = { ...process.env, JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT };
    delete env.JVC_SESSION_ID;
    wsOf[scope] = { ws, env };
  }
  const mods = await Promise.all(GUARDS.map(async (g) => [g, (await import(`../../hooks/lib/guards/${g}.mjs`)).decide]));
  const denied = [];
  let n = 0;
  for (const [name, text] of Object.entries(agentFiles())) {
    const { body } = parseAgent(text);
    const scope = SCOPE_OF[name] ?? "CAT";
    const { ws, env } = wsOf[scope];
    for (const line of commandLines(body)) {
      n++;
      const command = renderForGuards(line, scope);
      const input = { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command }, agent_type: `jaggaer-virtual-consultant:${name}`, agent_id: `a-${name}` };
      for (const [g, decide] of mods) {
        let r;
        try { r = await decide(input, env); } catch (err) { r = { thrown: String(err?.message ?? err) }; }
        const d = r?.hookSpecificOutput?.permissionDecision;
        if (r?.thrown || d === "deny" || d === "ask") denied.push(`${name} · guard-${g}: ${line}\n    → ${r?.thrown ?? r.hookSpecificOutput.permissionDecisionReason}`);
      }
    }
  }
  assert.ok(n >= 15, `righe: ${n}`);
  assert.deepEqual(denied, []);
});
