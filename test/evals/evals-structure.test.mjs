// Validatore strutturale della suite evals/ (WP10b parte 2, §49.1 "Eval degli agenti"). La CLI `claude` non è
// disponibile nell'ambiente di sviluppo: i casi si validano qui con le regole del formato di `claude plugin eval`
// (plugin-format-facts.md, docs code.claude.com "Test plugins with evals"); l'esecuzione e la pass rate restano un passo
// dell'utente (docs/MANUAL.md, docs/phase-reports/WP10b.md). Si applica a OGNI caso sotto evals/ (tutti i blocchi):
//   - prompt.md: chiavi del frontmatter solo dall'insieme ammesso (sconosciuta ⇒ errore), richieste presenti, tipi;
//   - case.yaml: schema_version "1.1", name, chiavi note, file referenziati esistenti nella cartella del caso;
//   - graders/*.md: `type` ammesso, campi richiesti e ammessi per tipo, target validi, regex compilabili;
//   - i quattro criteri di §49.1 per caso (traccia, strategia se determinata, cella, domanda con §16) + dispatch;
//   - mocks: server dichiarati in .mcp.json, chiavi del frontmatter, fixture = risultati pre-registrati del tenant demo;
//   - header del dispatch valido (agent-prompt.schema.json), coerente con la sessione, senza frasi dell'utente;
//   - scaffold identico in ogni caso; ogni scenario costruisce il workspace e ne derivano forma, precedente e strategia;
//   - 20 casi per ruolo (ruoli non ancora scritti: TODO), categorie obbligatorie per ruolo (tag), nomi unici, nessun
//     contenuto del cliente o proprietario;
//   - ruling approval_request (blocco B): nessun deny di guard-phrase nella trascrizione, nessuna frase dell'utente nel
//     rapporto, approval_request atteso dove il caso lo determina.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, statSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname, resolve, relative, extname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { parsePromptHeader, validatePrompt } from "../../scripts/admin/agent-prompt.mjs";
import { BOUNDARY_RULES } from "../../scripts/kb/validate-boundary.mjs";
import { PHRASES, CONTROL_PHRASES } from "../../hooks/lib/guards/phrase.mjs";
import { selectStrategy, precedentClass } from "../../scripts/decide/strategy-select.mjs";
import { PHRASE_DENY_PATTERN, USER_PHRASE_PATTERN, approvalRegex, CROSS_READ_ROLES } from "../../evals/_support/generate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const EVALS = join(ROOT, "evals");
const AGENTS = readdirSync(join(ROOT, "agents")).filter((f) => f.endsWith(".md")).map((f) => f.slice(0, -3)).sort();
// Blocchi della parte 2 (dispatch separati): A e B scritti, C segue. Un ruolo presente deve avere 20 casi.
const BLOCK_A = ["scope-expert", "scope-extractor", "scope-digester", "customer-profiler", "process-mapper"];
const BLOCK_B = ["cluster-validator", "weekly-digest", "root-cause-analyst", "config-designer", "lesson-validator"];
// Categorie di §49.1 che ogni ruolo copre (almeno un caso con uno dei tag): percorso felice, budget, confine (tentativi
// fuori cella), mai/dati non fidati, sorpresa o contraddizione, forma ignoto o libresco.
const REQUIRED_CATEGORIES = {
  "percorso felice": ["happy-path"],
  budget: ["budget"],
  confine: ["confine"],
  "mai o dati non fidati": ["mai", "sicurezza"],
  "sorpresa o contraddizione": ["sorpresa", "sorprese", "contraddizione"],
  "ignoto o libresco": ["ignoto", "libresco"],
};
const CASES_PER_ROLE = 20;
const NON_CASE_DIRS = new Set(["_support", "mocks", "results"]);

const PROMPT_KEYS = new Set(["schema_version", "name", "description", "tags", "plugins", "runs", "expected_outcome", "model", "max_turns",
  "timeout_seconds", "allowed_tools", "append_system_prompt", "env"]);
const PROMPT_REQUIRED = ["name", "description", "tags", "plugins", "runs", "max_turns", "timeout_seconds", "allowed_tools"];
const CASE_KEYS = new Set(["schema_version", "name", "description", "tags", "plugins", "runs", "expected_outcome", "context", "execution", "graders"]);
const CONTEXT_KEYS = new Set(["scaffold_script", "history_file", "add_dirs"]);
const EXECUTION_KEYS = new Set(["model", "max_turns", "timeout_seconds", "allowed_tools", "append_system_prompt", "env", "prompt"]);
const COMMON_GRADER_KEYS = ["type", "weight", "arm"];
const GRADER_TYPES = {
  regex: { required: ["pattern"], allowed: ["pattern", "flags", "match", "target"] },
  tool_used: { required: ["tool"], allowed: ["tool", "input_match", "min", "max"] },
  tool_order: { required: ["before", "after"], allowed: ["before", "after"] },
  file_exists: { required: ["path"], allowed: ["path", "exists"] },
  llm: { required: [], allowed: ["criteria", "focus"] },
  baseline: { required: ["baseline_file"], allowed: ["baseline_file", "criteria"] },
};
const TARGETS = new Set(["last_message", "trace", "files", "mock_calls"]);
const MOCK_KEYS = new Set(["type", "expect", "error", "abort_when", "tools"]);
const MCP_SERVERS = Object.keys(JSON.parse(readFileSync(join(ROOT, ".mcp.json"), "utf8")).mcpServers);
const MODEL_TIER = { haiku: "T0", sonnet: "T1", opus: "T2" };
const FICTIONAL = new Set(["ACME", "BETA", "STD"]);
const CELL_GUARDS = ["guard-scope", "guard-customer", "guard-domain-boundary"];
// Risultati MCP pre-registrati ammessi come fixture dei mock (§49.1: mai un tenant live).
const RECORDED = [join(ROOT, "test/fixtures/demo-tenant/mcp"), join(ROOT, "test/fixtures/env/pages")];

// ---------- lettura ----------

function frontmatter(file) {
  const text = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(text);
  if (!m) return { data: null, body: text, error: "frontmatter assente" };
  try { return { data: YAML.parse(m[1]) ?? {}, body: m[2] }; } catch (e) { return { data: null, body: m[2], error: `YAML non valido: ${e.message}` }; }
}

function discover() {
  const cases = [];
  const walk = (dir, depth) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (!e.isDirectory() || (depth === 0 && NON_CASE_DIRS.has(e.name))) continue;
      const p = join(dir, e.name);
      if (existsSync(join(p, "prompt.md")) || existsSync(join(p, "case.yaml"))) cases.push(p);
      else walk(p, depth + 1);
    }
  };
  if (existsSync(EVALS)) walk(EVALS, 0);
  return cases;
}

const CASES = discover();
const rel = (p) => relative(ROOT, p).replaceAll("\\", "/");
const readCase = (dir) => {
  const prompt = existsSync(join(dir, "prompt.md")) ? frontmatter(join(dir, "prompt.md")) : null;
  const caseYaml = existsSync(join(dir, "case.yaml")) ? YAML.parse(readFileSync(join(dir, "case.yaml"), "utf8")) : null;
  const scenario = existsSync(join(dir, "scenario.yaml")) ? YAML.parse(readFileSync(join(dir, "scenario.yaml"), "utf8")) : null;
  const gdir = join(dir, "graders");
  const graders = existsSync(gdir) ? Object.fromEntries(readdirSync(gdir).filter((f) => f.endsWith(".md")).map((f) => [f.slice(0, -3), frontmatter(join(gdir, f))])) : {};
  return { dir, prompt, caseYaml, scenario, graders };
};
const ALL = CASES.map(readCase);
const roleOf = (dir) => relative(EVALS, dir).split(/[\\/]/)[0];

function checkRegex(src, flags, where, errs) {
  if (typeof src !== "string" || !src) { errs.push(`${where}: regex vuota`); return null; }
  if (/\(\?[imsx]+\)/.test(src)) errs.push(`${where}: flag in linea (?i) non supportati (usa flags)`);
  try { return new RegExp(src, flags ?? ""); } catch (e) { errs.push(`${where}: regex non compilabile (${e.message})`); return null; }
}

function checkTarget(t, where, errs) {
  if (t === undefined) return;
  if (typeof t === "string") { if (!TARGETS.has(t)) errs.push(`${where}: target sconosciuto ${t}`); return; }
  if (!t || typeof t !== "object" || t.source !== "file" || typeof t.path !== "string" || Object.keys(t).some((k) => !["source", "path"].includes(k))) {
    errs.push(`${where}: target non valido ${JSON.stringify(t)} (last_message | trace | files | mock_calls | { source: file, path })`);
  }
}

// Regole di un grader (in graders/*.md o inline in case.yaml). Restituisce gli errori.
function graderErrors(g, body, where, caseDir) {
  const errs = [];
  if (!g || typeof g !== "object") return [`${where}: frontmatter assente o non valido`];
  const spec = GRADER_TYPES[g.type];
  if (!spec) return [`${where}: type '${g.type}' non ammesso (${Object.keys(GRADER_TYPES).join(" | ")})`];
  const allowed = new Set([...COMMON_GRADER_KEYS, ...spec.allowed, ...(where.includes("case.yaml") ? ["name"] : [])]);
  for (const k of Object.keys(g)) if (!allowed.has(k)) errs.push(`${where}: chiave '${k}' non ammessa per ${g.type}`);
  for (const k of spec.required) if (g[k] === undefined || g[k] === null || g[k] === "") errs.push(`${where}: manca '${k}'`);
  if (g.weight !== undefined && !(typeof g.weight === "number" && g.weight > 0)) errs.push(`${where}: weight deve essere un numero positivo`);
  if (g.arm !== undefined && !["with-only", "both"].includes(g.arm)) errs.push(`${where}: arm '${g.arm}' non valido`);
  if (g.type === "regex") {
    checkRegex(g.pattern, g.flags, where, errs);
    if (g.flags !== undefined && !/^[dgimsuvy]*$/.test(String(g.flags))) errs.push(`${where}: flags non validi`);
    if (g.match !== undefined && !(g.match === "not_contains" || /^count:\d+$/.test(String(g.match)))) errs.push(`${where}: match '${g.match}' (not_contains | count:N)`);
    checkTarget(g.target, where, errs);
  }
  if (g.type === "tool_used") {
    if (typeof g.tool !== "string") errs.push(`${where}: tool deve essere una stringa`);
    if (g.input_match !== undefined) checkRegex(g.input_match, "", `${where} input_match`, errs);
    for (const k of ["min", "max"]) if (g[k] !== undefined && !(Number.isInteger(g[k]) && g[k] >= 0)) errs.push(`${where}: ${k} intero ≥ 0`);
    if (Number.isInteger(g.min) && Number.isInteger(g.max) && g.min > g.max) errs.push(`${where}: min > max`);
  }
  if (g.type === "tool_order") {
    for (const k of ["before", "after"]) {
      const v = g[k];
      const ok = typeof v === "string" || (v && typeof v === "object" && typeof v.tool === "string" && Object.keys(v).every((x) => ["tool", "input_match"].includes(x)));
      if (!ok) errs.push(`${where}: ${k} deve essere un nome di strumento o { tool, input_match }`);
    }
  }
  if (g.type === "file_exists" && g.exists !== undefined && typeof g.exists !== "boolean") errs.push(`${where}: exists booleano`);
  if (g.type === "llm") {
    const criteria = g.criteria ?? body;
    if (typeof criteria !== "string" || !criteria.trim()) errs.push(`${where}: llm senza criteri (corpo del file o criteria)`);
    checkTarget(g.focus, `${where} focus`, errs);
  }
  if (g.type === "baseline" && typeof g.baseline_file === "string" && !existsSync(join(caseDir, g.baseline_file))) errs.push(`${where}: baseline_file inesistente`);
  return errs;
}

// ---------- layout ----------

test("evals/: ogni caso sta in evals/<ruolo>/<caso>/ con un ruolo fra i 15 agenti; nomi unici; .gitignore esclude evals/results/", () => {
  assert.ok(CASES.length > 0, "nessun caso sotto evals/");
  const errs = [];
  const names = new Map();
  for (const c of ALL) {
    const parts = relative(EVALS, c.dir).split(/[\\/]/);
    if (parts.length !== 2) errs.push(`${rel(c.dir)}: profondità attesa evals/<ruolo>/<caso>`);
    if (!AGENTS.includes(parts[0])) errs.push(`${rel(c.dir)}: ruolo '${parts[0]}' non è un agente di agents/`);
    const name = c.prompt?.data?.name ?? c.caseYaml?.name ?? parts.at(-1);
    if (names.has(name)) errs.push(`nome duplicato '${name}': ${rel(names.get(name))} e ${rel(c.dir)}`);
    names.set(name, c.dir);
    if (name !== `${parts[0]}--${parts[1]}`) errs.push(`${rel(c.dir)}: name '${name}' ≠ '${parts[0]}--${parts[1]}'`);
  }
  assert.deepEqual(errs, []);
  const gi = readFileSync(join(ROOT, ".gitignore"), "utf8").split(/\r?\n/).map((l) => l.trim());
  assert.ok(gi.includes("evals/results/"), ".gitignore deve contenere evals/results/");
});

test(`evals/: ${CASES_PER_ROLE} casi per ruolo — i ruoli dei blocchi A e B sono completi, un ruolo presente è completo`, () => {
  const count = (r) => ALL.filter((c) => roleOf(c.dir) === r).length;
  for (const r of [...BLOCK_A, ...BLOCK_B]) assert.equal(count(r), CASES_PER_ROLE, `${r}: ${count(r)} casi`);
  for (const r of AGENTS) if (count(r) > 0) assert.equal(count(r), CASES_PER_ROLE, `${r}: ${count(r)} casi (un ruolo iniziato va completato a ${CASES_PER_ROLE})`);
});

test("evals/: ogni ruolo presente copre le categorie obbligatorie (tag dei casi)", () => {
  const errs = [];
  for (const r of AGENTS) {
    const cases = ALL.filter((c) => roleOf(c.dir) === r);
    if (!cases.length) continue;
    const tags = new Set(cases.flatMap((c) => c.prompt?.data?.tags ?? []));
    for (const [cat, any] of Object.entries(REQUIRED_CATEGORIES)) if (!any.some((x) => tags.has(x))) errs.push(`${r}: nessun caso di categoria "${cat}" (tag ${any.join(" | ")})`);
  }
  assert.deepEqual(errs, []);
});

const TODO_ROLES = AGENTS.filter((r) => !ALL.some((c) => roleOf(c.dir) === r));
// TODO esplicito: i ruoli senza casi sono saltati qui e restano da scrivere nei blocchi successivi.
for (const r of TODO_ROLES) test(`evals/${r}: ${CASES_PER_ROLE} casi da scrivere (blocchi B/C della parte 2)`, { todo: "ruolo non ancora scritto" }, () => {});

test("grader del ruling approval_request: deny di guard-phrase, frasi dell'utente nel rapporto, campo strutturato", () => {
  const deny = new RegExp(PHRASE_DENY_PATTERN);
  assert.ok(deny.test("[guard-phrase] l'input dello strumento contiene una frase"));
  assert.ok(deny.test(String.raw`{\"guard\":\"guard-phrase\",\"tool\":\"Write\"}`));
  assert.ok(!deny.test("guard-phrase è l'hook delle frasi"));
  const phrase = new RegExp(USER_PHRASE_PATTERN);
  for (const s of ["APPROVO PIANO PLAN.ACME.P2P.0007", "APPROVO PROMOZIONE C.ACME.ADM.CHK.0051", "ESPLORA SANDBOX", "FERMA AGENTE x", "PASSO PASSO"]) assert.ok(phrase.test(s), s);
  for (const s of ["approval_request: { kind: A1, plan: PLAN.ACME.P2P.0007 }", "verifica passo passo", "promozione in attesa"]) assert.ok(!phrase.test(s), s);
  const a1 = new RegExp(approvalRegex({ kind: "A1", plan: "PLAN.ACME.P2P.0007" }));
  assert.ok(a1.test("approval_request: { kind: A1, plan: PLAN.ACME.P2P.0007 }"));
  assert.ok(a1.test('approval_request:\n  plan: "PLAN.ACME.P2P.0007"\n  kind: A1\n'));
  assert.ok(!a1.test("approval_request: { kind: A2, plan: PLAN.ACME.P2P.0007 }"));
  assert.ok(!a1.test("approval_request: { kind: A1, plan: PLAN.ACME.P2P.00070 }"));
  assert.ok(!a1.test("approval_request: null"));
});

test("validatore: rifiuta chiavi sconosciute, tipi e target non ammessi, regex non compilabili", () => {
  const dir = join(EVALS, "_support");
  assert.deepEqual(graderErrors({ type: "regex", pattern: "a", target: "trace" }, "", "g", dir), []);
  assert.match(graderErrors({ type: "regex", pattern: "a", colour: "x" }, "", "g", dir).join(), /chiave 'colour' non ammessa/);
  assert.match(graderErrors({ type: "script", pattern: "a" }, "", "g", dir).join(), /type 'script' non ammesso/);
  assert.match(graderErrors({ type: "regex", pattern: "a", target: "stdout" }, "", "g", dir).join(), /target sconosciuto/);
  assert.match(graderErrors({ type: "regex", pattern: "a", target: { source: "file" } }, "", "g", dir).join(), /target non valido/);
  assert.match(graderErrors({ type: "regex", pattern: "(" }, "", "g", dir).join(), /non compilabile/);
  assert.match(graderErrors({ type: "regex", pattern: "(?i)a" }, "", "g", dir).join(), /flag in linea/);
  assert.match(graderErrors({ type: "regex", pattern: "a", match: "contains-all" }, "", "g", dir).join(), /match/);
  assert.match(graderErrors({ type: "tool_used", tool: "Agent", min: 2, max: 1 }, "", "g", dir).join(), /min > max/);
  assert.match(graderErrors({ type: "tool_order", before: "Read" }, "", "g", dir).join(), /manca 'after'/);
  assert.match(graderErrors({ type: "llm" }, "  ", "g", dir).join(), /llm senza criteri/);
  assert.match(graderErrors({ type: "llm", focus: "files" }, "PASS se", "g", dir).join(), /^$/);
  assert.match(graderErrors({ type: "file_exists", path: "a", exists: "no" }, "", "g", dir).join(), /exists booleano/);
  assert.match(graderErrors({ type: "baseline", baseline_file: "manca.jsonl" }, "", "g", dir).join(), /baseline_file inesistente/);
  assert.match(graderErrors({ type: "regex", pattern: "a", weight: 0 }, "", "g", dir).join(), /weight/);
  assert.match(graderErrors({ type: "regex", pattern: "a", arm: "without" }, "", "g", dir).join(), /arm/);
  assert.deepEqual(promptKeyErrors({ name: "x", max_turn: 3 }), ["chiave sconosciuta 'max_turn'"]);
});

// ---------- prompt.md e case.yaml ----------

const promptKeyErrors = (d) => Object.keys(d).filter((k) => !PROMPT_KEYS.has(k)).map((k) => `chiave sconosciuta '${k}'`);

test("prompt.md: frontmatter solo con chiavi ammesse (sconosciuta ⇒ errore), richieste presenti, tipi validi, prompt non vuoto", () => {
  const errs = [];
  for (const c of ALL) {
    const where = rel(join(c.dir, "prompt.md"));
    if (!c.prompt) { if (!c.caseYaml?.execution?.prompt) errs.push(`${rel(c.dir)}: né prompt.md né execution.prompt`); continue; }
    const d = c.prompt.data;
    if (!d) { errs.push(`${where}: ${c.prompt.error}`); continue; }
    errs.push(...promptKeyErrors(d).map((x) => `${where}: ${x}`));
    for (const k of PROMPT_REQUIRED) if (d[k] === undefined) errs.push(`${where}: manca '${k}'`);
    if (d.schema_version !== undefined && String(d.schema_version) !== "1.1") errs.push(`${where}: schema_version ${d.schema_version}`);
    if (d.runs !== undefined && !(Number.isInteger(d.runs) && d.runs >= 1 && d.runs <= 50)) errs.push(`${where}: runs 1..50`);
    if (d.max_turns !== undefined && !(Number.isInteger(d.max_turns) && d.max_turns >= 1 && d.max_turns <= 200)) errs.push(`${where}: max_turns 1..200`);
    if (d.timeout_seconds !== undefined && !(Number.isInteger(d.timeout_seconds) && d.timeout_seconds >= 1 && d.timeout_seconds <= 3600)) errs.push(`${where}: timeout_seconds 1..3600`);
    for (const k of ["tags", "allowed_tools", "plugins"]) if (d[k] !== undefined && !(Array.isArray(d[k]) && d[k].every((x) => typeof x === "string" && x))) errs.push(`${where}: ${k} lista di stringhe`);
    if (d.env !== undefined) for (const k of Object.keys(d.env ?? {})) if (!/^EVAL_[A-Z0-9_]*$/.test(k)) errs.push(`${where}: env '${k}' (solo EVAL_*)`);
    for (const p of d.plugins ?? []) if (!existsSync(join(resolve(c.dir, p), ".claude-plugin", "plugin.json"))) errs.push(`${where}: plugins '${p}' non porta al plugin`);
    if (!c.prompt.body.trim()) errs.push(`${where}: prompt vuoto`);
    if (!(d.allowed_tools ?? []).includes("Agent")) errs.push(`${where}: allowed_tools senza Agent (il caso invoca il sub-agente)`);
  }
  assert.deepEqual(errs, []);
});

test("case.yaml: schema_version \"1.1\", name, chiavi note (context/execution), file referenziati nella cartella del caso", () => {
  const errs = [];
  for (const c of ALL) {
    const y = c.caseYaml;
    if (!y) continue;
    const where = rel(join(c.dir, "case.yaml"));
    if (String(y.schema_version) !== "1.1") errs.push(`${where}: schema_version deve essere "1.1"`);
    if (typeof y.name !== "string" || !y.name) errs.push(`${where}: manca name`);
    if (c.prompt?.data?.name && y.name !== c.prompt.data.name) errs.push(`${where}: name diverso da prompt.md`);
    for (const k of Object.keys(y)) if (!CASE_KEYS.has(k)) errs.push(`${where}: chiave sconosciuta '${k}'`);
    for (const k of Object.keys(y.context ?? {})) if (!CONTEXT_KEYS.has(k)) errs.push(`${where}: context.${k} sconosciuta`);
    for (const k of Object.keys(y.execution ?? {})) if (!EXECUTION_KEYS.has(k)) errs.push(`${where}: execution.${k} sconosciuta`);
    for (const k of ["scaffold_script", "history_file"]) {
      const f = y.context?.[k];
      if (f !== undefined && (typeof f !== "string" || f.includes("..") || !existsSync(join(c.dir, f)))) errs.push(`${where}: context.${k} '${f}' non è un file del caso`);
    }
    for (const d of y.context?.add_dirs ?? []) if (typeof d !== "string" || d.includes("..") || !existsSync(join(c.dir, d)) || !statSync(join(c.dir, d)).isDirectory()) errs.push(`${where}: add_dirs '${d}' non è una cartella del caso`);
    for (const [i, g] of (y.graders ?? []).entries()) errs.push(...graderErrors(g, g?.criteria ?? "", `${where} graders[${i}]`, c.dir));
  }
  assert.deepEqual(errs, []);
});

// ---------- grader ----------

test("graders/*.md: type ammesso, campi richiesti e ammessi per tipo, target validi, regex compilabili", () => {
  const errs = [];
  for (const c of ALL) {
    if (!Object.keys(c.graders).length && !(c.caseYaml?.graders ?? []).length) errs.push(`${rel(c.dir)}: nessun grader`);
    for (const [name, g] of Object.entries(c.graders)) {
      const where = rel(join(c.dir, "graders", `${name}.md`));
      if (!g.data) { errs.push(`${where}: ${g.error}`); continue; }
      errs.push(...graderErrors(g.data, g.body, where, c.dir));
      if (g.data.type !== "llm" && g.body.trim()) errs.push(`${where}: corpo non vuoto in un grader ${g.data.type} (il pattern sta nel frontmatter)`);
    }
  }
  assert.deepEqual(errs, []);
});

test("criteri §49.1 per caso: dispatch del ruolo, traccia presente, nessun deny di cella, domanda solo con gap (§16), strategia se il caso la determina", () => {
  const errs = [];
  for (const c of ALL) {
    const role = roleOf(c.dir);
    const g = (n) => c.graders[n]?.data;
    const where = rel(c.dir);
    const d = g("dispatch");
    if (!(d?.type === "tool_used" && d.tool === "Agent" && new RegExp(d.input_match).test(`"subagent_type":"jaggaer-virtual-consultant:${role}"`)
      && !AGENTS.filter((a) => a !== role).some((a) => new RegExp(d.input_match).test(`"subagent_type":"jaggaer-virtual-consultant:${a}"`)))) errs.push(`${where}: dispatch deve riconoscere solo ${role}`);
    const t = g("trace");
    if (!(t?.type === "regex" && /cognitive_trace/.test(t.pattern) && /self_check/.test(t.pattern) && /strategy/.test(t.pattern) && /lesson/.test(t.pattern) && (t.target ?? "last_message") === "last_message")) errs.push(`${where}: trace deve cercare cognitive_trace (strategy, self_check) e lesson nel rapporto`);
    const cell = g("cell");
    if (!(cell?.type === "regex" && cell.target === "trace" && cell.match === "not_contains" && CELL_GUARDS.every((x) => cell.pattern.includes(x.slice(6))))) errs.push(`${where}: cell deve escludere dalla trascrizione i deny di ${CELL_GUARDS.join(", ")}`);
    else {
      const re = new RegExp(cell.pattern);
      if (!re.test("[guard-scope] fuori cella") || !re.test(String.raw`{\"guard\":\"guard-customer\",\"tool\":\"Read\"}`) || re.test("guard-scope è l'hook della cella")) errs.push(`${where}: cell non riconosce i deny`);
    }
    const q = g("question");
    if (!(q?.type === "llm" && /§16/.test(c.graders.question.body))) errs.push(`${where}: question deve essere un llm che cita §16`);
    const e = c.scenario?.expect ?? {};
    if (e.strategy) {
      const s = g("strategy");
      if (!(s?.type === "regex" && new RegExp(s.pattern).test(`strategy: ${e.strategy}`) && !new RegExp(s.pattern).test("strategy: STR-OTHER"))) errs.push(`${where}: strategy deve cercare ${e.strategy}`);
    } else if (g("strategy")) errs.push(`${where}: grader strategy senza expect.strategy nello scenario`);
    const ph = g("phrase");
    if (!(ph?.type === "regex" && ph.target === "trace" && ph.match === "not_contains" && ph.pattern === PHRASE_DENY_PATTERN)) errs.push(`${where}: phrase deve escludere dalla trascrizione i deny di guard-phrase`);
    const pr = g("phrase-report");
    if (!(pr?.type === "regex" && (pr.target ?? "last_message") === "last_message" && pr.match === "not_contains" && pr.pattern === USER_PHRASE_PATTERN)) errs.push(`${where}: phrase-report deve escludere le frasi dell'utente dal rapporto`);
    if (e.approval) {
      const ar = g("approval-request");
      if (!(ar?.type === "regex" && ar.pattern === approvalRegex(e.approval))) errs.push(`${where}: approval-request deve cercare ${JSON.stringify(e.approval)}`);
    } else if (g("approval-request")) errs.push(`${where}: grader approval-request senza expect.approval`);
    if (t && c.scenario?.dispatch?.header?.depth && !t.pattern.includes(`depth:\\s*${c.scenario.dispatch.header.depth}`)) errs.push(`${where}: trace deve chiedere la profondità dell'header (${c.scenario.dispatch.header.depth})`);
  }
  assert.deepEqual(errs, []);
});

// ---------- mock ----------

function mockDirs() {
  const out = [];
  if (existsSync(join(EVALS, "mocks"))) out.push(join(EVALS, "mocks"));
  for (const c of ALL) if (existsSync(join(c.dir, "mocks"))) out.push(join(c.dir, "mocks"));
  return out;
}
const recordedTexts = () => RECORDED.flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".txt")).map((f) => readFileSync(join(d, f), "utf8").replace(/\r\n/g, "\n")));

test("mocks: server dichiarati in .mcp.json, chiavi del frontmatter note, fixture e snapshot = risultati pre-registrati del tenant demo", () => {
  const errs = [];
  const recorded = recordedTexts();
  for (const m of mockDirs()) {
    for (const server of readdirSync(m, { withFileTypes: true }).filter((e) => e.isDirectory() && e.name !== ".replay").map((e) => e.name)) {
      if (!MCP_SERVERS.includes(server)) errs.push(`${rel(join(m, server))}: server '${server}' non dichiarato in .mcp.json`);
      const sdir = join(m, server);
      for (const f of readdirSync(sdir).filter((x) => x.endsWith(".md"))) {
        const where = rel(join(sdir, f));
        const { data, body, error } = frontmatter(join(sdir, f));
        if (!data) { errs.push(`${where}: ${error}`); continue; }
        for (const k of Object.keys(data)) if (!MOCK_KEYS.has(k)) errs.push(`${where}: chiave '${k}' non ammessa in un mock`);
        if (data.type !== undefined && !["fixed", "agent"].includes(data.type)) errs.push(`${where}: type ${data.type}`);
        for (const [, ref] of body.matchAll(/\{\{file:([^}]+)\}\}/g)) if (!/\{input\./.test(ref) && !existsSync(join(sdir, ref))) errs.push(`${where}: fixture '${ref}' inesistente`);
        if (f === "take_snapshot.md" && !/\{\{file:/.test(body) && !recorded.includes(body.trim() + "\n") && !recorded.includes(body.trim())) errs.push(`${where}: snapshot non pre-registrato (deve coincidere con test/fixtures/demo-tenant/mcp/*)`);
      }
      const fx = join(sdir, "fixtures");
      if (existsSync(fx)) for (const f of readdirSync(fx)) {
        const text = readFileSync(join(fx, f), "utf8").replace(/\r\n/g, "\n");
        if (!recorded.includes(text)) errs.push(`${rel(join(fx, f))}: fixture diversa dai risultati pre-registrati del tenant demo`);
      }
    }
  }
  for (const c of ALL) {
    const usesMock = Object.values(c.graders).some((g) => g.data?.target === "mock_calls" || g.data?.focus === "mock_calls");
    if (usesMock && !mockDirs().length) errs.push(`${rel(c.dir)}: grader su mock_calls senza mocks`);
  }
  assert.deepEqual(errs, []);
});

// ---------- dispatch ----------

const dispatchText = (body) => {
  const m = /=== INIZIO PROMPT ===\n([\s\S]*?)\n=== FINE PROMPT ===/.exec(body.replace(/\r\n/g, "\n"));
  return m ? m[1] : null;
};

test("header del dispatch: schema agent-prompt, cliente e scope = comandi use, tier = modello, nessuna frase dell'utente nel testo del dispatch", () => {
  const errs = [];
  for (const c of ALL) {
    const where = rel(c.dir);
    const role = roleOf(c.dir);
    const body = c.prompt?.body ?? "";
    const text = dispatchText(body);
    if (!text) { errs.push(`${where}: testo del dispatch fra INIZIO/FINE PROMPT assente`); continue; }
    const h = parsePromptHeader(text.replaceAll("<SID>", "sess-eval"));
    if (!h) { errs.push(`${where}: header YAML non leggibile`); continue; }
    const v = validatePrompt(h);
    if (!v.ok) errs.push(`${where}: header non valido (${v.errors.join("; ")})`);
    if (!FICTIONAL.has(h.customer) || h.customer === "STD") errs.push(`${where}: cliente ${h.customer} non fittizio`);
    if (!body.includes(`use customer ${h.customer}\``) || !body.includes(`use scope ${h.scope}\``) || !body.includes(`use mode ${h.mode}\``)) errs.push(`${where}: i comandi use non impostano cliente/scope/modalità dell'header`);
    const model = /con `model: (haiku|sonnet|opus)`/.exec(body)?.[1];
    if (!model || MODEL_TIER[model] !== h.tier) errs.push(`${where}: tier ${h.tier} e modello ${model} in disaccordo (guard-budget nega il dispatch)`);
    if (!body.includes(`sub-agente \`jaggaer-virtual-consultant:${role}\``)) errs.push(`${where}: il prompt non invoca ${role}`);
    if (!body.includes(`agents show ${h.task_id}`)) errs.push(`${where}: manca la console agents show ${h.task_id} (serve al grader di cella)`);
    if (PHRASES.test(text) || CONTROL_PHRASES.test(text)) errs.push(`${where}: il testo del dispatch contiene una frase dell'utente (guard-phrase negherebbe Agent)`);
    if (!(h.allowed_paths ?? []).some((p) => p.includes("/.sessions/<SID>/") || p.includes("/.sessions/sess-eval/"))) errs.push(`${where}: allowed_paths senza la cartella di sessione`);
    if (c.scenario?.dispatch?.header?.task_id !== h.task_id) errs.push(`${where}: scenario.yaml e prompt.md con task_id diversi`);
    const grants = [...body.matchAll(/use paths --agent ([a-z-]+) --grant/g)].map((m) => m[1]);
    if (CROSS_READ_ROLES.includes(role) ? !(grants.length === 1 && grants[0] === role && body.includes(`use paths --agent ${role} --restore`)) : grants.length) {
      errs.push(`${where}: lettura trasversale concessa (e ripristinata) solo e sempre ai tipi ${CROSS_READ_ROLES.join(", ")}, per il proprio tipo`);
    }
  }
  const ids = ALL.map((c) => c.scenario?.dispatch?.header?.task_id);
  assert.equal(new Set(ids).size, ids.length, "task_id duplicati fra i casi");
  assert.deepEqual(errs, []);
});

// ---------- scaffold e scenario ----------

test("scaffold: scaffold.sh identico in ogni caso; ogni scenario costruisce il workspace; forma e precedente dal DB determinano la strategia attesa", async () => {
  const { buildWorkspace } = await import("../../evals/_support/scaffold.mjs");
  const { subjectProfile } = await import("../../scripts/kb/coverage-report.mjs");
  const { precedents } = await import("../../scripts/kb/precedents.mjs");
  const { openDb } = await import("../../scripts/kb/db.mjs");
  const canonical = readFileSync(join(EVALS, "_support", "scaffold.sh"), "utf8");
  const errs = [];
  for (const c of ALL) {
    const where = rel(c.dir);
    if (!c.scenario) { errs.push(`${where}: scenario.yaml assente`); continue; }
    if (c.caseYaml?.context?.scaffold_script !== "scaffold.sh" || readFileSync(join(c.dir, "scaffold.sh"), "utf8") !== canonical) errs.push(`${where}: scaffold.sh diverso da evals/_support/scaffold.sh`);
    if (c.scenario.role !== roleOf(c.dir)) errs.push(`${where}: scenario.role ${c.scenario.role}`);
    const ws = mkdtempSync(join(tmpdir(), "jvc-eval-"));
    try {
      buildWorkspace(ws, c.scenario);
      for (const f of ["customers/ACME/knowledge.db", "product/knowledge.db", "customers/ACME/config/environments.yaml"]) if (!existsSync(join(ws, f))) errs.push(`${where}: lo scaffold non crea ${f}`);
      const e = c.scenario.expect ?? {};
      if (e.strategy_inputs) {
        const si = e.strategy_inputs;
        const r = selectStrategy({ ...si, depth: si.depth ?? c.scenario.dispatch.header.depth });
        if (r.strategy !== e.strategy) errs.push(`${where}: strategy-select dà ${r.strategy} per ${JSON.stringify(si)}, atteso ${e.strategy}`);
        const db = openDb(join(ws, "customers", "ACME", "knowledge.db"));
        try {
          const p = subjectProfile(db, si.subject);
          if (p?.shape !== si.shape) errs.push(`${where}: forma di ${si.subject} nel workspace ${p?.shape} ≠ ${si.shape}`);
          const cls = precedentClass(precedents(db, si.subject, { customer: "ACME", top: 3 }));
          if (cls !== si.precedent) errs.push(`${where}: precedente di ${si.subject} nel workspace ${cls} ≠ ${si.precedent}`);
        } finally { db.close(); }
      } else if (e.strategy && !["scope-extractor"].includes(c.scenario.role)) errs.push(`${where}: strategia attesa senza strategy_inputs (non verificabile)`);
      if (!["required", "forbidden", "optional", undefined].includes(e.question)) errs.push(`${where}: expect.question ${e.question}`);
      if (!e.gap) errs.push(`${where}: expect.gap assente (serve al giudice di §16)`);
    } catch (err) {
      errs.push(`${where}: scaffold fallito (${err.message})`);
    } finally { rmSync(ws, { recursive: true, force: true }); }
  }
  assert.deepEqual(errs, []);
});

// ---------- confine: niente contenuti del cliente o proprietari ----------

function* evalFiles(dir = EVALS) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!(dir === EVALS && e.name === "results")) yield* evalFiles(p); } else if (/\.(md|ya?ml|sh|mjs|json|txt)$/.test(e.name)) yield p;
  }
}

test("confine: nessun identificatore analitico (regole di validate-boundary), solo clienti fittizi (ACME, BETA), nessun dato di un tenant reale", () => {
  const idRule = BOUNDARY_RULES.find((r) => /identificatore analitico/.test(r.rule));
  assert.ok(idRule, "regola degli identificatori analitici in validate-boundary");
  const errs = [];
  for (const f of evalFiles()) {
    const text = readFileSync(f, "utf8");
    const m = new RegExp(idRule.re.source, idRule.re.flags.replace("g", "")).exec(text);
    if (m) errs.push(`${rel(f)}: ${idRule.rule} → ${m[0]}`);
    for (const [, cust] of text.matchAll(/\b[SCL]\.([A-Z0-9]{4})\.[A-Z0-9]{3}\.[A-Z]{3}\.\d{4}\b/g)) if (!FICTIONAL.has(cust)) errs.push(`${rel(f)}: codice di un cliente non fittizio (${cust})`);
    for (const [, cust] of text.matchAll(/customers\/([A-Z0-9]{4})\//g)) if (!FICTIONAL.has(cust)) errs.push(`${rel(f)}: cartella di un cliente non fittizio (${cust})`);
    for (const [, host] of text.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) if (!/^acme(-sbx|-pre)?\.jaggaer\.com$/i.test(host) && !/^(sso(-test)?\.acme\.it|cdn\.jaggaer\.com)$/i.test(host)) errs.push(`${rel(f)}: host non del tenant demo (${host})`);
  }
  assert.deepEqual(errs, []);
});

// Frammenti di 8 parole dei file di evals/ contro il corpus di partenza (JAGGAER DOC/, gitignorato: solo in locale).
const SHINGLE = 8;
const words = (s) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);

test("confine: nessun frammento del corpus JAGGAER DOC nei casi (8 parole consecutive)", async (t) => {
  const corpus = join(ROOT, "JAGGAER DOC");
  if (process.env.JVC_SKIP_CORPUS === "1") { t.skip("JVC_SKIP_CORPUS=1: controllo sul corpus saltato"); return; }
  if (!existsSync(corpus)) { t.skip("corpus JAGGAER DOC assente (gitignorato): controllo solo in locale"); return; }
  const mine = new Map();
  for (const f of evalFiles()) {
    const w = words(readFileSync(f, "utf8"));
    for (let i = 0; i + SHINGLE <= w.length; i++) { const k = w.slice(i, i + SHINGLE).join(" "); if (!mine.has(k)) mine.set(k, f); }
  }
  const { parseDocx } = await import("../../scripts/ingest/parse-docx.mjs");
  const { parsePdf } = await import("../../scripts/ingest/parse-pdf.mjs");
  const hits = [];
  const walk = function* (d) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) yield* walk(p); else yield p; } };
  for (const f of walk(corpus)) {
    const x = extname(f).toLowerCase();
    let text;
    try {
      if ([".txt", ".xml", ".csv"].includes(x)) text = readFileSync(f, "utf8");
      else if (x === ".docx") text = JSON.stringify(parseDocx(readFileSync(f), { id: "C", title: "c" }));
      else if (x === ".pdf") text = JSON.stringify(parsePdf(readFileSync(f), { id: "C", title: "c" }));
      else continue;
    } catch { continue; }
    const w = words(text);
    for (let i = 0; i + SHINGLE <= w.length; i++) {
      const k = w.slice(i, i + SHINGLE).join(" ");
      if (mine.has(k)) { hits.push(`${rel(mine.get(k))}: frammento del corpus (${relative(corpus, f).length} caratteri di percorso)`); mine.delete(k); }
    }
  }
  assert.deepEqual(hits, []);
});
