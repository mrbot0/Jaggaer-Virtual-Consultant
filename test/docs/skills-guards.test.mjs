// WP10c giro 1 (I3, ruling del controllore): ogni riga di comando delle skill e dei corpi degli agenti passa i guard
// PreToolUse reali — le righe di agent-manager come SESSIONE PRINCIPALE (nessun agent_id), quelle delle 26 skill di
// metodo come i sub-agenti che le citano (scope-expert per quelle che nessun agente cita), quelle di agents/*.md come
// quell'agente — con i segnaposto riempiti dai VALORI REALI dei domini delle DT (ogni valore, uno alla volta): i valori
// con < > o apostrofo nella forma ASCII (asciiAlias di dt-eval), unica forma che i guard lasciano passare. Per gli script di
// decisione (dt-eval, strategy-select, depth) ogni resa è anche valutata: il valore deve stare nel dominio.
// Le righe devono dichiarare la forma ASCII (segnaposto `<…-ascii>`) dove il dominio ha valori con < > o apostrofo, e
// nessun testo di skill o agente scrive i valori canonici con < o > ("d'uso" resta parola della prosa).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkWs, seedSession, ROOT } from "../helpers/hook-env.mjs";
import { commandLines } from "../helpers/commands.mjs";
import { agentFiles, parseAgent } from "../helpers/agents-md.mjs";
import { MANAGER, allSkills, fullText, allSkillRefs } from "../helpers/skills-md.mjs";
import { simpleArgv } from "../../hooks/lib/exact-argv.mjs";
import { evaluate, loadTable, asciiAlias, parseKeyValues, ALIAS_UNSAFE } from "../../scripts/decide/dt-eval.mjs";
import { selectStrategy } from "../../scripts/decide/strategy-select.mjs";
import { deliberationDepth } from "../../scripts/decide/depth.mjs";

const GUARDS = ["scope", "customer", "budget", "destructive", "config-scope", "phrase", "control"];
const PLAN_FILE = "runs/RUN.ACME.20260929.1015.CAT/cases/NRT.ACME.CAT.NEG.0031/plan.json";
const SCOPE_OF = { "customer-profiler": "XSC", "process-mapper": "XSC", "analytics-learner": "ANL" };
const FIXED = { C: "ACME", sid: "sess-1", SES: "SES.ACME.20260929.001", task: "MSG.SES.ACME.20260929.001.0012", mese: "2026-09", piano: PLAN_FILE,
  RUN: "RUN.ACME.20260929.1015.CAT", "SES.C.AAAAMMGG.NNN": "SES.ACME.20260929.001", n: "1", LSN: "L.ACME.CAT.LSN.0090" };
const DT017 = loadTable("DT-017");
const DT023 = loadTable("DT-023");
const ANGLED = (d) => !!d?.enum && Object.keys(d.enum).some((k) => ALIAS_UNSAFE.test(k));
const valuesOf = (d) => (d.enum ? Object.keys(d.enum).map(asciiAlias) : d.boolean ? ["true", "false"] : [String(d.range[0])]);
const domainOf = (table, name) => table?.inputs.find((i) => i.name === name)?.domain ?? null;
// Opzioni degli script di decisione legate a un dominio di DT.
const OPTION_DOMAIN = { "--shape": ["shape"], "--risk": ["risk"], "--precedent": ["precedent"], "--depth": ["depth"] };
const OPTION_VALUES = { "--surprises": ["0", "1", "2"], "--mode": ["nrt", "config", "ops", "diag"], "--graph-radius": ["3", "7"], "--never-executed-here": ["true", "false"] };

// Segnaposto di una riga con il dominio di valori che li riempie: [{ ph, values, domain }]
function placeholders(line) {
  const table = /--table (DT-\d{3})/.exec(line)?.[1];
  const t = table ? loadTable(table) : /strategy-select\.mjs/.test(line) ? DT017 : /depth\.mjs/.test(line) ? DT023 : null;
  const out = [];
  for (const m of line.matchAll(/(\S+?)(=| )?<([^<>]*)>/g)) {
    const [, before, sep, ph] = m;
    let domain = null;
    let values = null;
    if (sep === "=" && t && table) domain = domainOf(t, before.replace(/^.*\s/, ""));
    else if (sep === " " && t && OPTION_DOMAIN[before]) domain = domainOf(t, OPTION_DOMAIN[before][0]);
    if (domain) values = valuesOf(domain);
    else if (sep === " " && t && OPTION_VALUES[before]) values = OPTION_VALUES[before];
    out.push({ ph, values, domain, arg: before });
  }
  return out;
}

function renderings(line, scope) {
  const phs = placeholders(line);
  const fill = (choice) => line.replaceAll("${CLAUDE_PLUGIN_ROOT}", ROOT.replace(/\\/g, "/")).replace(/<([^<>]*)>/g, (_m, k) => {
    if (choice.has(k)) return choice.get(k);
    if (k === "S") return scope;
    return FIXED[k] ?? "X1";
  });
  const base = new Map(phs.filter((p) => p.values).map((p) => [p.ph, p.values[0]]));
  const out = new Set([fill(base)]);
  for (const p of phs.filter((x) => x.values)) for (const v of p.values) out.add(fill(new Map([...base, [p.ph, v]])));
  return [...out];
}

// Il valore resta nel dominio? (solo gli script di decisione; nessuna scrittura: la valutazione è in processo)
function acceptance(command) {
  const argv = simpleArgv(command);
  if (!argv) return "riga non semplice";
  const script = argv[1] ?? "";
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  try {
    if (/dt-eval\.mjs$/.test(script)) {
      evaluate(loadTable(opt("--table")), parseKeyValues(argv.slice(2).filter((a) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(a))));
    } else if (/strategy-select\.mjs$/.test(script)) {
      selectStrategy({ shape: opt("--shape"), risk: opt("--risk"), precedent: opt("--precedent"), surprises: opt("--surprises") !== undefined ? Number(opt("--surprises")) : 0,
        mode: opt("--mode"), depth: opt("--depth"), divergence_unknown: argv.includes("--divergence-unknown"), has_hypotheses: argv.includes("--has-hypotheses") });
    } else if (/depth\.mjs$/.test(script)) {
      deliberationDepth({ risk: opt("--risk"), shape: opt("--shape"), precedent: opt("--precedent"), surprises: opt("--surprises") !== undefined ? Number(opt("--surprises")) : 0,
        graph_radius: opt("--graph-radius") !== undefined ? Number(opt("--graph-radius")) : undefined,
        never_executed_here: opt("--never-executed-here") === undefined ? undefined : opt("--never-executed-here") === "true" });
    }
  } catch (e) { return String(e.message ?? e); }
  return null;
}

async function probe() {
  const wsOf = {};
  for (const scope of ["CAT", "XSC", "ANL"]) {
    const ws = mkWs();
    seedSession(ws, { scope, extra: { session_code: "SES.ACME.20260929.001", active_plan: { plan_id: "PLAN.ACME.0001", file: PLAN_FILE, step: 1 } } });
    const env = { ...process.env, JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT };
    delete env.JVC_SESSION_ID;
    wsOf[scope] = { ws, env };
  }
  const mods = await Promise.all(GUARDS.map(async (g) => [g, (await import(`../../hooks/lib/guards/${g}.mjs`)).decide]));
  return { wsOf, mods };
}

// Le righe da provare: [chi, agente|null (sessione principale), riga]
function subjects() {
  const agents = Object.fromEntries(Object.entries(agentFiles()).map(([n, t]) => [n, parseAgent(t).body]));
  const citing = (skill) => Object.entries(agents).filter(([, b]) => allSkillRefs(b).includes(skill)).map(([n]) => n);
  const out = [];
  for (const s of allSkills()) {
    const lines = commandLines(fullText(s));
    if (s.name === MANAGER) { for (const l of lines) out.push({ who: `skill ${s.name} (sessione principale)`, agent: null, line: l }); continue; }
    const roles = citing(s.name);
    for (const l of lines) for (const a of roles.length ? roles : ["scope-expert"]) out.push({ who: `skill ${s.name} come ${a}`, agent: a, line: l });
  }
  for (const [n, b] of Object.entries(agents)) for (const l of commandLines(b)) out.push({ who: `agente ${n}`, agent: n, line: l });
  return out;
}

test("ogni riga di skill e agenti, con ogni valore reale dei domini DT (forma ASCII), passa i guard PreToolUse ed è accettata dagli script di decisione", async () => {
  const { wsOf, mods } = await probe();
  const bad = [];
  let n = 0;
  for (const { who, agent, line } of subjects()) {
    const scope = (agent && SCOPE_OF[agent]) ?? "CAT";
    const { ws, env } = wsOf[scope];
    for (const command of renderings(line, scope)) {
      n++;
      const input = { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command },
        ...(agent ? { agent_type: `jaggaer-virtual-consultant:${agent}`, agent_id: `a-${agent}` } : {}) };
      for (const [g, decide] of mods) {
        let r;
        try { r = await decide(input, env); } catch (err) { r = { thrown: String(err?.message ?? err) }; }
        const d = r?.hookSpecificOutput?.permissionDecision;
        if (r?.thrown || d === "deny" || d === "ask") bad.push(`${who} · guard-${g}: ${command}\n    → ${r?.thrown ?? r.hookSpecificOutput.permissionDecisionReason}`);
      }
      const a = acceptance(command.replaceAll("${CLAUDE_SESSION_ID}", "sess-1"));
      if (a) bad.push(`${who} · dominio: ${command}\n    → ${a}`);
    }
  }
  assert.ok(n >= 150, `rese provate: ${n}`);
  assert.deepEqual(bad, []);
});

test("i valori canonici con < o > sono negati dai guard in ogni forma (per questo le righe usano la forma ASCII)", async () => {
  const { wsOf, mods } = await probe();
  const { ws, env } = wsOf.CAT;
  const script = `${ROOT.replace(/\\/g, "/")}/scripts/decide/strategy-select.mjs`;
  for (const v of ["confermato-d<0.2", '"confermato-d<0.2"', "'confermato-d<0.2'"]) {
    for (const agent of [null, "scope-expert"]) {
      const input = { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash",
        tool_input: { command: `node "${script}" --shape consolidato --risk R0 --precedent ${v} --json` }, ...(agent ? { agent_type: `jaggaer-virtual-consultant:${agent}`, agent_id: "a-1" } : {}) };
      const decisions = [];
      for (const [, decide] of mods) { const r = await decide(input, env); decisions.push(r?.hookSpecificOutput?.permissionDecision); }
      assert.ok(decisions.includes("deny"), `${v} (${agent ?? "principale"}) non negato`);
    }
  }
});

test("dove il dominio ha valori con < > o apostrofo, la riga lo dichiara con un segnaposto <…-ascii>; nessun testo scrive i valori canonici da passare", () => {
  const canon = new Set();
  for (const t of [loadTable("DT-003"), DT017, DT023]) for (const i of t.inputs) for (const k of Object.keys(i.domain.enum ?? {})) if (/[<>]/.test(k)) canon.add(k);
  const bad = [];
  const texts = [...allSkills().map((s) => [`skill ${s.name}`, fullText(s)]), ...Object.entries(agentFiles()).map(([n, t]) => [`agente ${n}`, parseAgent(t).body])];
  for (const [who, text] of texts) {
    for (const line of commandLines(text)) for (const p of placeholders(line)) if (ANGLED(p.domain) && !/-ascii$/.test(p.ph)) bad.push(`${who}: <${p.ph}> di ${p.arg} senza forma ASCII: ${line}`);
    for (const k of canon) if (text.includes(k)) bad.push(`${who}: valore canonico ${k} (usa ${asciiAlias(k)})`);
  }
  assert.deepEqual(bad, []);
});
