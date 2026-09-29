// WP10c — copertura fra agenti e skill (brief wp10c-skills): ogni skill citata nel corpo di un agente (WP10b) esiste
// come cartella in skills/ (una skill rinominata in un solo posto rompe il test); ogni skill di metodo è citata da almeno
// un agente, tranne jaggaer-domain (mappa di orientamento attivata dalla sola description); nessun agente carica
// agent-manager (M1: il manager è la sessione principale, i sub-agenti sono foglie).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { agentFiles, parseAgent, skillRefs } from "../helpers/agents-md.mjs";
import { SKILLS_DIR, MANAGER, WP10C_SKILLS, allSkills } from "../helpers/skills-md.mjs";

const BY_DESCRIPTION_ONLY = ["jaggaer-domain"];

function usage() {
  const used = new Map();
  for (const [agent, text] of Object.entries(agentFiles())) {
    const { body, fm } = parseAgent(text);
    for (const s of new Set([...skillRefs(body), ...(Array.isArray(fm?.skills) ? fm.skills : [])])) {
      if (!used.has(s)) used.set(s, new Set());
      used.get(s).add(agent);
    }
  }
  return used;
}

test("ogni skill citata dagli agenti (corpo o frontmatter skills) esiste in skills/", () => {
  const missing = [];
  for (const [s, agents] of usage()) if (!existsSync(join(SKILLS_DIR, s, "SKILL.md"))) missing.push(`${s} (citata da ${[...agents].join(", ")})`);
  assert.deepEqual(missing, []);
});

test("ogni skill di metodo è usata da almeno un agente (salvo quelle attivate solo dalla description)", () => {
  const used = usage();
  const orphan = WP10C_SKILLS.filter((s) => !BY_DESCRIPTION_ONLY.includes(s) && !used.has(s));
  assert.deepEqual(orphan, []);
  for (const s of BY_DESCRIPTION_ONLY) assert.ok(WP10C_SKILLS.includes(s), s);
});

test("nessun agente usa agent-manager (M1): la skill è della sola sessione principale e lo dichiara", () => {
  assert.ok(!usage().has(MANAGER), "un agente cita la skill agent-manager");
  const m = allSkills().find((s) => s.name === MANAGER);
  assert.match(m.fm.description, /sessione principale/);
  assert.match(m.fm.description, /mai dentro un sub-agente/);
});

test("la description di ogni skill di metodo cita il lavoro dei ruoli che la usano (parole del compito)", () => {
  // Parole del compito per skill: devono comparire nella description, così l'attivazione automatica corrisponde ai
  // compiti degli agenti che la citano (brief: "author skill description fields so they actually match the tasks").
  const EXPECT = {
    "reasoning-cycle": ["SITUARE", "RIFLETTERE", "cognitive_trace"], "epistemic-awareness": ["forma", "gaps", "progetti", "esegui"],
    precedents: ["kb precedents", "regressione", "DT-018"], "belief-revision": ["sorpresa", "DT-016", "ipotesi"],
    strategies: ["DT-017", "strategy-select"], "decision-tables": ["dt-eval", "--write-dec"], "asking-the-user": ["gaps", "needs-input"],
    "self-check-and-lesson": ["self-check", "otto sezioni", "lesson_draft"], "field-modeling": ["FLD", "kb fields", "kb impact"],
    "coding-system": ["SEQ", "CFP", "CHK"], "faceting-and-weights": ["faccette", "portabilità"], "clustering-rules": ["RC-01", "DT-005", "quarantena"],
    "token-economy": ["DT-003", "80%", "budget"], "jaggaer-domain": ["scope", "handoff"], "identity-and-keys": ["KEY", "LCY", "system_of_record"],
    "integration-testing": ["INT", "HND", "/nrt integration"], "nrt-authoring": ["NEG", "/nrt author", "epistemic_at_generation"],
    "selector-strategy": ["DT-008", "/nrt heal"], "evidence-and-xray": ["DT-009", "Defect", "Xray"], "data-safety": ["redazione", "aggregati"],
    "doc-ingestion": ["/kb ingest", "DT-020/021/022", "back-check"], "failure-forensics": ["DT-001", "STR-BISECT", "/nrt triage"],
    "jaggaer-configuration": ["DT-007", "/cfg design", "/cfg apply", "3A"], "domain-boundary": ["analysis/", "PAT", "RUL"],
    "scope-discipline": ["allowed_paths", "handoff", "guard-scope"], "customer-isolation": ["process-mapper", "weekly-digest"],
  };
  for (const s of allSkills().filter((x) => x.name !== MANAGER)) {
    for (const w of EXPECT[s.name]) assert.ok(s.fm.description.includes(w), `${s.name}: la description non cita "${w}"`);
  }
  assert.deepEqual(Object.keys(EXPECT).sort(), [...WP10C_SKILLS].sort());
});
