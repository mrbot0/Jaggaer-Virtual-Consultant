// WP10b — helper dei test delle 15 definizioni foglia (agents/*.md, §44.2): lettura, frontmatter YAML, sezioni del
// corpo, riferimenti a script e skill, attese per ruolo dalla tabella del brief (modello, strumenti, tier e forma del
// ciclo di §26.3, perimetro della shell).
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { ROOT } from "./hook-env.mjs";
import { LEAF_AGENTS } from "./commands.mjs";

export { LEAF_AGENTS };
export const AGENTS_DIR = join(ROOT, "agents");
const lf = (s) => s.replace(/\r\n/g, "\n");

const BASE = ["Read", "Write", "Glob", "Grep", "Bash"];
const MIN = ["Read", "Bash"];
// perimeter: prefissi degli script che il corpo può citare (null = tutto scripts/). La shell non si restringe nel
// frontmatter (plugin-format-facts): il perimetro della tabella è nel corpo e lo verifica questo test.
export const EXPECT = {
  "scope-expert": { model: "sonnet", tools: BASE, mcp: "browser", tier: "per compito (haiku T0 · sonnet T1 · opus T2)", cycle: "completo", perimeter: null },
  "scope-extractor": { model: "haiku", tools: BASE, mcp: null, tier: "T0/T1", cycle: "ridotto (1-2-6)", perimeter: ["scripts/ingest/", "scripts/decide/self-check.mjs"] },
  "scope-digester": { model: "opus", tools: BASE, mcp: null, tier: "T2", cycle: "completo + passata epistemica", perimeter: ["scripts/kb/", "scripts/decide/"] },
  "customer-profiler": { model: "opus", tools: BASE, mcp: null, tier: "T2", cycle: "completo", perimeter: null },
  "process-mapper": { model: "opus", tools: BASE, mcp: null, tier: "T2", cycle: "completo, lettura trasversale", perimeter: null },
  "cluster-validator": { model: "opus", tools: BASE, mcp: null, tier: "T2", cycle: "2-4-6", perimeter: null },
  "weekly-digest": { model: "opus", tools: BASE, mcp: null, tier: "T2", cycle: "completo", perimeter: null },
  "root-cause-analyst": { model: "opus", tools: BASE, mcp: null, tier: "T2", cycle: "completo, STR-BISECT", perimeter: null },
  "config-designer": { model: "opus", tools: BASE, mcp: null, tier: "T2", cycle: "completo, gaps → domande", perimeter: null },
  "lesson-validator": { model: "sonnet", tools: BASE, mcp: null, tier: "T1", cycle: "2-4-6", perimeter: null },
  "analytics-learner": { model: "sonnet", tools: BASE, mcp: "browser", tier: "T1/T2", cycle: "completo", perimeter: null },
  "test-mechanic": { model: "sonnet", tools: BASE, mcp: null, tier: "T1", cycle: "completo", perimeter: null },
  "failure-triage": { model: "haiku", tools: MIN, mcp: null, tier: "T0→T1", cycle: "completo, con precedenti", perimeter: null },
  "config-auditor": { model: "haiku", tools: MIN, mcp: null, tier: "T0", cycle: "ridotto", perimeter: null },
  "defect-reporter": { model: "haiku", tools: MIN, mcp: "alm", tier: "T0", cycle: "ridotto, con precedenti", perimeter: null },
};
// Ruoli che leggono kb (ruling 4: sezione "Precedenza fra fonti"); l'extractor legge le fonti, non pesa i generi.
export const KB_READERS = LEAF_AGENTS.filter((a) => a !== "scope-extractor");
// Ruoli T0 con i soli Read e Bash: la bozza di lezione va nel rapporto (output.lesson_draft).
export const READ_ONLY = LEAF_AGENTS.filter((a) => EXPECT[a].tools === MIN);
export const ALM_PATTERN = "mcp__plugin_jaggaer-virtual-consultant_alm__*";

// Le 26 skill di WP10c (.superpowers/sdd/briefs/wp10c-skills.md) più agent-manager.
export const WP10C_SKILLS = ["reasoning-cycle", "epistemic-awareness", "precedents", "belief-revision", "strategies", "decision-tables", "asking-the-user",
  "self-check-and-lesson", "field-modeling", "coding-system", "faceting-and-weights", "clustering-rules", "token-economy", "jaggaer-domain", "identity-and-keys",
  "integration-testing", "nrt-authoring", "selector-strategy", "evidence-and-xray", "data-safety", "doc-ingestion", "failure-forensics", "jaggaer-configuration",
  "domain-boundary", "scope-discipline", "customer-isolation"];

// 28/10/2026: agenti di manutenzione del workspace e della KB (decisione dell'utente). Non sono foglie di dominio: niente
// ciclo a sei passi, cella, evals né traccia cognitiva; li verifica test/docs/agents-maintenance.test.mjs.
export const MAINTENANCE_AGENTS = ["health-keeper", "workspace-manager"];

export function agentFiles() {
  const out = {};
  if (!existsSync(AGENTS_DIR)) return out;
  for (const f of readdirSync(AGENTS_DIR).filter((x) => x.endsWith(".md") && !MAINTENANCE_AGENTS.includes(x.slice(0, -3))).sort()) out[f.slice(0, -3)] = lf(readFileSync(join(AGENTS_DIR, f), "utf8"));
  return out;
}

export function parseAgent(text) {
  const m = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(lf(text));
  if (!m) return { fm: null, body: lf(text) };
  return { fm: YAML.parse(m[1]), body: m[2] };
}

export const toolList = (tools) => (Array.isArray(tools) ? tools : String(tools ?? "").split(",")).map((t) => String(t).trim()).filter(Boolean);

// Sezione "## <titolo>" fino alla successiva "## ".
export function section(body, title) {
  const re = new RegExp(`^## ${title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m");
  return re.exec(body)?.[1] ?? null;
}

export const skillRefs = (body) => [...body.matchAll(/skill `([a-z0-9-]+)`/g)].map((m) => m[1]);
export const scriptRefs = (body) => [...new Set([...body.matchAll(/scripts\/[a-z-]+\/[a-z0-9-]+\.mjs/g)].map((m) => m[0]))];
export const lastYamlFence = (body) => {
  const blocks = [...lf(body).matchAll(/```ya?ml[ \t]*\n([\s\S]*?)\n?```/g)];
  return blocks.length ? blocks[blocks.length - 1][1] : null;
};
