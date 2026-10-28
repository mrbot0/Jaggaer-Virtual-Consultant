// WP10b — struttura delle 15 definizioni foglia (§44.2, brief wp10b-agents, ruling del controller 1–6): file esatti,
// nessun agents/agent-manager.md, frontmatter (name, description, model e strumenti per la tabella), mai Agent,
// AskUserQuestion, WebFetch; strumenti MCP solo del browser (famiglie di hooks/lib/browser-tools.mjs, mai Playwright)
// per scope-expert e analytics-learner e solo ALM per defect-reporter; corpo con Cella ("l'hook nega: non provare"),
// Il ciclo (sei passi, tier e forma di §26.3), Precedenza fra fonti (ruoli che leggono kb), Cosa non fai mai, Rapporto
// finale in un blocco ```yaml; skill citate = le 26 di WP10c; script citati esistenti, nel perimetro del ruolo, righe
// di comando semplici (tokenizzatore dei guard, niente JSON in linea) e rispondono a --help.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ROOT, cleanEnv } from "../helpers/hook-env.mjs";
import { simpleArgv } from "../../hooks/lib/exact-argv.mjs";
import { classify } from "../../hooks/lib/browser-tools.mjs";
import { commandLines, renderLine } from "../helpers/commands.mjs";
import { MAINTENANCE_AGENTS, LEAF_AGENTS, AGENTS_DIR, EXPECT, KB_READERS, ALM_PATTERN, WP10C_SKILLS, agentFiles, parseAgent, toolList, section, skillRefs, scriptRefs } from "../helpers/agents-md.mjs";

const FORBIDDEN = ["Agent", "Task", "AskUserQuestion", "WebFetch", "WebSearch"];
const agents = () => Object.entries(agentFiles()).map(([name, text]) => ({ name, text, ...parseAgent(text) }));
// Il markdown va a capo dove capita: i controlli di contenuto si fanno sul testo con gli spazi normalizzati.
const flat = (s) => (s == null ? s : s.replace(/\s+/g, " "));

test("agents/: esattamente le 15 definizioni foglia, nessun agents/agent-manager.md (il manager è la skill agent-manager, M1)", () => {
  assert.ok(existsSync(AGENTS_DIR), "manca agents/");
  const files = readdirSync(AGENTS_DIR).sort();
  assert.deepEqual(files, [...LEAF_AGENTS, ...MAINTENANCE_AGENTS].map((a) => `${a}.md`).sort());   // 28/10/2026: più i due agenti di manutenzione
  assert.ok(!existsSync(join(AGENTS_DIR, "agent-manager.md")));
});

test("frontmatter: name = file, description, model e strumenti esattamente per la tabella di §44.2; mai Agent/AskUserQuestion/WebFetch", () => {
  for (const { name, fm } of agents()) {
    assert.ok(fm, `${name}: frontmatter YAML`);
    assert.equal(fm.name, name, `${name}: name`);
    assert.ok(typeof fm.description === "string" && fm.description.trim().length >= 40 && fm.description.length <= 600, `${name}: description`);
    assert.equal(fm.model, EXPECT[name].model, `${name}: model`);
    const tools = toolList(fm.tools);
    for (const f of FORBIDDEN) assert.ok(!tools.some((t) => t === f || t.startsWith(`${f}(`)), `${name}: ${f} vietato (§44.2)`);
    assert.deepEqual(tools.filter((t) => !t.startsWith("mcp__")), EXPECT[name].tools, `${name}: strumenti di base`);
    for (const k of Object.keys(fm)) assert.ok(["name", "description", "model", "tools", "color"].includes(k), `${name}: chiave di frontmatter inattesa ${k}`);
  }
});

test("strumenti MCP: browser (Chrome DevTools e Claude browser, mai Playwright) solo per scope-expert e analytics-learner; ALM solo per defect-reporter", () => {
  for (const { name, fm } of agents()) {
    const mcp = toolList(fm.tools).filter((t) => t.startsWith("mcp__"));
    const kind = EXPECT[name].mcp;
    if (!kind) { assert.deepEqual(mcp, [], `${name}: nessuno strumento MCP`); continue; }
    if (kind === "alm") { assert.deepEqual(mcp, [ALM_PATTERN], name); continue; }
    assert.ok(mcp.length >= 2, `${name}: strumenti del browser`);
    const families = new Set();
    for (const p of mcp) {
      assert.match(p, /^mcp__[A-Za-z0-9_-]+__\*$/, `${name}: ${p} è un server intero (mcp__<server>__*)`);
      const fam = classify(p.replace(/\*$/, "list_pages"), {}).family;
      assert.ok(["chrome-devtools", "claude-browser"].includes(fam), `${name}: ${p} → famiglia ${fam} (browser-tools.mjs)`);
      families.add(fam);
    }
    assert.deepEqual([...families].sort(), ["chrome-devtools", "claude-browser"], `${name}: entrambe le famiglie`);
    assert.ok(!mcp.some((p) => /alm|playwright/i.test(p)), name);
  }
});

test("corpo: Cella con «L'hook nega: non provare», Il ciclo a sei passi con tier e forma di §26.3, Precedenza fra fonti, Cosa non fai mai, Rapporto finale", () => {
  for (const { name, body } of agents()) {
    const cella = flat(section(body, "Cella"));
    assert.ok(cella, `${name}: sezione Cella`);
    assert.match(cella, /L'hook nega: non provare\./, `${name}: la cella la applicano gli hook`);
    const ciclo = section(body, "Il ciclo");
    assert.ok(ciclo, `${name}: sezione Il ciclo`);
    assert.match(ciclo, /skill `reasoning-cycle`/, name);
    for (const s of ["SITUARE", "RICHIAMARE", "VALUTARE", "DECIDERE", "AGIRE", "RIFLETTERE"]) assert.match(ciclo, new RegExp(`\\b${s}\\b`), `${name}: passo ${s}`);
    const m = /^Tier \(§26\.3\): (.+?) · ciclo cognitivo: (.+)$/m.exec(ciclo);
    assert.ok(m, `${name}: riga "Tier (§26.3): … · ciclo cognitivo: …"`);
    assert.equal(m[1], EXPECT[name].tier, `${name}: tier`);
    assert.equal(m[2], EXPECT[name].cycle, `${name}: forma del ciclo`);
    if (KB_READERS.includes(name)) {
      const p = section(body, "Precedenza fra fonti");
      assert.ok(p, `${name}: Precedenza fra fonti`);
      assert.match(p, /skill `epistemic-awareness`/, name);
    }
    const mai = flat(section(body, "Cosa non fai mai"));
    assert.ok(mai, `${name}: Cosa non fai mai`);
    for (const re of [/[Cc]ancell/, /fuori confine/, /altri scope/, /analysis\//, /[Ii]ndebolire/, /R3/, /traccia cognitiva/]) assert.match(mai, re, `${name}: ${re}`);
    const rap = section(body, "Rapporto finale");
    assert.ok(rap, `${name}: Rapporto finale`);
    assert.match(rap, /unico blocco ```yaml/, name);
    assert.match(rap, /agent-report\.schema\.json/, name);
    assert.ok(body.trimEnd().endsWith("```"), `${name}: il blocco yaml del rapporto chiude il corpo`);
  }
});

test("skill citate: solo le 26 di WP10c (nomi esatti)", () => {
  for (const { name, body } of agents()) {
    const refs = skillRefs(body);
    assert.ok(refs.length >= 3, `${name}: skill citate`);
    for (const s of refs) assert.ok(WP10C_SKILLS.includes(s), `${name}: skill sconosciuta ${s}`);
  }
});

test("script citati: esistono, sono nel perimetro del ruolo, righe semplici senza JSON in linea (ruling 6)", () => {
  const bad = [];
  for (const { name, body } of agents()) {
    const refs = scriptRefs(body);
    assert.ok(refs.length >= 2, `${name}: script citati`);
    for (const s of refs) {
      if (!existsSync(join(ROOT, s))) bad.push(`${name}: ${s} inesistente`);
      const per = EXPECT[name].perimeter;
      if (per && !per.some((p) => (p.endsWith("/") ? s.startsWith(p) : s === p))) bad.push(`${name}: ${s} fuori perimetro (${per.join(", ")})`);
    }
    const lines = commandLines(body);
    assert.ok(lines.length >= 2, `${name}: righe di comando`);
    for (const line of lines) {
      if (!simpleArgv(renderLine(line, "C:/plugin"))) bad.push(`${name}: riga non semplice: ${line}`);
      if (/['"]\{|\{"|--inputs\s+['"{]/.test(line)) bad.push(`${name}: JSON in linea: ${line}`);
    }
  }
  assert.deepEqual(bad, []);
});

test("ogni script citato dagli agenti risponde a --help (exit 0)", () => {
  const scripts = new Set();
  for (const { body } of agents()) for (const s of scriptRefs(body)) scripts.add(s);
  const failed = [];
  for (const s of scripts) {
    const r = spawnSync(process.execPath, [join(ROOT, s), "--help"], { env: cleanEnv(), encoding: "utf8", timeout: 30000 });
    if (r.status !== 0) failed.push(`${s}: exit ${r.status}`);
  }
  assert.deepEqual(failed, []);
});

test("regole dei ruoli: browser di scope-expert (ruling 3), lettura trasversale, escalation, Defect mai Incident, libresco→R0, PR del test-mechanic", () => {
  const A = Object.fromEntries(agents().map((a) => [a.name, flat(a.body)]));
  const se = A["scope-expert"];
  assert.match(se, /Chrome DevTools/);
  assert.match(se, /sola lettura e navigazione/, "fuori sandbox il Claude browser solo legge e naviga");
  assert.match(se, /script nella pagina[^.]*negat/i, "script nella pagina negati ovunque");
  // ruling WP10b parte 2 (blocco B): niente frasi dell'utente nel corpo; l'approvazione si chiede con approval_request
  assert.match(se, /solo l'utente\*\* con la sua frase di esplorazione/);
  assert.match(se, /approval_request: \{ kind: A1 \| A2 \| A3, plan: <PLAN>, step: <n> \}/);
  assert.match(se, /step-check\.mjs/);
  for (const a of ["process-mapper", "weekly-digest"]) {
    assert.match(A[a], new RegExp(`use paths --agent ${a} --grant`), `${a}: il manager concede`);
    assert.match(A[a], /--restore/, `${a}: il manager ripristina`);
    assert.match(A[a], /session\.json/, a);
  }
  assert.match(A["process-mapper"], /epistemic_by_stage/);
  assert.match(A["customer-profiler"], /documentation_inventory/);
  assert.match(A["customer-profiler"], /epistemic_summary/);
  assert.match(A["failure-triage"], /status: escalate/);
  assert.match(A["failure-triage"], /root-cause-analyst/);
  assert.match(A["failure-triage"], /fixed/);
  assert.match(A["defect-reporter"], /mai un Incident/i);
  assert.match(A["defect-reporter"], /alm_create_defect/);
  assert.match(A["config-designer"], /libresco/);
  assert.match(A["config-designer"], /R0/);
  assert.match(A["config-designer"], /DT-007/);
  assert.match(A["test-mechanic"], /\bPR\b/);
  assert.match(A["test-mechanic"], /lint-spec\.mjs[^\n]*--against/);
  assert.match(A["root-cause-analyst"], /STR-BISECT/);
  assert.match(A["root-cause-analyst"], /falsificabil/);
  assert.match(A["cluster-validator"], /CL-EPI/);
  assert.match(A["cluster-validator"], /CL-STR/);
  assert.match(A["lesson-validator"], /DT-004/);
  assert.match(A["weekly-digest"], /knowledge\.lock/);
  assert.match(A["analytics-learner"], /LIMIT/);
  assert.match(A["scope-digester"], /passata epistemica/i);
  assert.match(A["scope-extractor"], /Non interpret/);
  // giro 1 (minori 1–2): testo non fidato mai nella riga di comando; analytics come lo scope-expert fuori sandbox
  assert.match(A["scope-extractor"], /deontic\.mjs" --text-file /);
  assert.doesNotMatch(A["scope-extractor"], /deontic\.mjs" --text /);
  assert.doesNotMatch(A["defect-reporter"], /"summary=/);
  assert.match(A["defect-reporter"], /--summary-file /);
  assert.match(A["analytics-learner"], /fuori sandbox solo con Chrome DevTools MCP/);
  assert.match(A["analytics-learner"], /ti \*\*fermi\*\*/);
});
