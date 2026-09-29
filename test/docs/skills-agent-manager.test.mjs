// WP10c — la skill agent-manager codifica i contratti dei WP chiusi (brief del controllore, contratti 1–9) e il §23.2:
// 1 docs/orchestration.md come contratto (console prima/dopo/prima di rispondere, agents show, frasi di controllo, watch
//   da un terminale separato; vigilanza, escalation, handoff e limiti citati come vincoli del codice);
// 2 dispatch da templates/agent-prompt.md, tier dell'header = modello, DT-003/DT-023, budget mai alzato;
// 3 approval_request → frase esatta di phraseOf nel messaggio del manager, mai in un input di strumento;
// 4 grant/restore della lettura trasversale, mai due dispatch paralleli dello stesso tipo;
// 5 ruoli con soli Read e Bash: lesson_draft scritta dal manager + self-check, summary_file, lesson_code;
// 6 APPROVO PIANO prima dell'esecuzione fuori sandbox, ESPLORA SANDBOX, PR del test-mechanic mai unita;
// 7 input da file o nome=valore, --session "${CLAUDE_SESSION_ID}";
// 8 description stretta e guardia per i sub-agenti; 9 R5 ≤ 15 %, kb find solo per instradare.
import { test } from "node:test";
import assert from "node:assert/strict";
import { phraseOf, EXPLORE_PHRASE } from "../../scripts/admin/approvals.mjs";
import { CONTROL_SYNTAX } from "../../hooks/lib/control.mjs";
import { VIGILANCE_MESSAGE } from "../../hooks/lib/invocations.mjs";
import { ESCALATION_MESSAGE } from "../../hooks/lib/guards/orchestration.mjs";
import { commandLines } from "../helpers/commands.mjs";
import { MANAGER, readSkill, fullText } from "../helpers/skills-md.mjs";

const skill = readSkill(MANAGER);
const flat = (s) => s.replace(/\s+/g, " ");
const body = flat(skill.body);
const all = flat(fullText(skill));
const lines = commandLines(fullText(skill));
const section = (title) => {
  const m = new RegExp(`^## ${title}[^\\n]*\\n([\\s\\S]*?)(?=^## |(?![\\s\\S]))`, "m").exec(skill.body);
  return m ? flat(m[1]) : null;
};

test("frontmatter: name, description stretta (solo sessione principale), disable-model-invocation false, niente context: fork (contratto 8)", () => {
  assert.equal(skill.fm.name, "agent-manager");
  assert.equal(skill.fm["disable-model-invocation"], false);
  assert.ok(!("context" in skill.fm) && !("allowed-tools" in skill.fm));
  assert.match(skill.fm.description, /Solo per la sessione principale/);
  assert.match(skill.fm.description, /mai dentro un sub-agente/);
  assert.match(skill.fm.description, /carica la skill agent-manager/, "si aggancia al contesto di SessionStart");
  assert.match(body, /Se sei un sub-agente invocato da Agent\(\), non usare questa skill/i, "guardia esplicita nel corpo");
});

test("§23.2: le nove responsabilità come istruzioni (Stato … Diario)", () => {
  const t = section("2\\. Le responsabilità");
  assert.ok(t, "sezione delle responsabilità");
  for (const r of ["Stato", "Routing", "Handoff", "Escalation", "Blackboard", "Registro", "Budget", "Vigilanza cognitiva", "Diario"]) assert.match(t, new RegExp(`\\*\\*${r}\\*\\*`), r);
  assert.match(t, /session\.json/);
  assert.match(t, /mai a mano/);
  assert.match(t, /DT-003/);
  assert.match(t, /DT-002/);
  assert.match(t, /asking-the-user/);
  assert.match(t, /non vede come l'altro ha fatto/);
  assert.match(t, /80 %/);
  assert.match(t, /§10\.1/);
  assert.ok(t.includes(VIGILANCE_MESSAGE), "messaggio esatto della vigilanza");
});

test("contratto 1: docs/orchestration.md; console prima di instradare, dopo ogni ritorno, prima di rispondere; agents show; watch da un terminale separato; frasi di controllo", () => {
  assert.match(body, /docs\/orchestration\.md/);
  assert.ok(lines.some((l) => /agents\.mjs" status --session "\$\{CLAUDE_SESSION_ID\}" --json$/.test(l)), "agents status");
  assert.ok(lines.some((l) => /agents\.mjs" show <task_id> --session "\$\{CLAUDE_SESSION_ID\}" --json$/.test(l)), "agents show");
  // giro 1 (minore 2): nel terminale dell'utente ${CLAUDE_PLUGIN_ROOT} non esiste — percorso assoluto del plugin,
  // sessione presa da agents status, --workspace
  assert.ok(all.includes('node "<percorso assoluto del plugin>/scripts/admin/agents.mjs" watch --session <session_id o session_code da agents status> --workspace <cartella del workspace> --interval 5'), "agents watch");
  assert.match(body, /\$\{CLAUDE_PLUGIN_ROOT\}`? non è definita/);
  const c = section("3\\. La console");
  for (const w of ["prima di instradare", "dopo ogni ritorno", "prima di rispondere", "cosa o come sta lavorando", "terminale separato"]) assert.ok(c.includes(w), w);
  for (const p of CONTROL_SYNTAX.filter((x) => !x.includes("|"))) assert.ok(all.includes(p), `frase di controllo ${p}`);
  for (const p of ["PASSO PASSO <task_id>", "PASSO PASSO TUTTI", "PASSO PASSO OFF"]) assert.ok(all.includes(p), p);
  assert.match(c, /FERMA TUTTI[^|]*solo per gli agenti in corso/);
  assert.match(c, /non le scrivi mai in un input di strumento/);
});

test("contratto 1: le regole dei guard sono citate come vincoli del codice, non come istruzioni (vigilanza, escalation, handoff, limiti per dispatch)", () => {
  const v = section("1\\. Il contratto operativo");
  assert.match(v, /Vincoli già applicati dal codice/);
  assert.ok(v.includes(VIGILANCE_MESSAGE));
  assert.ok(v.includes(ESCALATION_MESSAGE));
  assert.match(v, /via: agent-manager/);
  assert.match(v, /HND/);
  assert.match(v, /limiti per dispatch/);
  assert.match(v, /guard-budget/);
  assert.match(v, /guard-control/);
  assert.match(v, /non li "applichi" tu e non li aggiri/);
});

test("contratto 2: prompt da templates/agent-prompt.md con i campi letti dai guard; tier dell'header = modello; DT-003/DT-023; budget mai alzato", () => {
  const d = section("4\\. Il dispatch");
  assert.match(d, /templates\/agent-prompt\.md/);
  for (const f of ["task_id", "customer", "scope", "mode", "tier", "depth", "budget: { tokens, minutes }", "allowed_paths", "reply_to", "kind: handoff", "via: agent-manager", "contract: <HND>"]) assert.ok(d.includes(f), f);
  assert.match(d, /T0 ⇔ haiku, T1 ⇔ sonnet, T2 ⇔ opus/);
  assert.match(d, /disaccordo è negato/);
  assert.match(d, /DT-023/);
  assert.match(d, /DT-003/);
  assert.match(d, /Il budget non si alza/);
  assert.match(body, /Non alzi mai un budget/);
  assert.match(d, /jaggaer-virtual-consultant:<agente>/);
});

test("contratto 3: approval_request → la frase esatta di phraseOf nel messaggio del manager, mai in un input di strumento", () => {
  const a = section("6\\. Le richieste di approvazione");
  assert.match(a, /approval_request: \{ kind, plan\?, step\?, target\? \}/);
  assert.match(a, /phraseOf/);
  assert.match(a, /scripts\/admin\/approvals\.mjs/);
  assert.match(a, /mai in un input di strumento/);
  assert.match(a, /guard-phrase/);
  const P = "<PLAN>";
  for (const [kind, extra] of [["A1", {}], ["A2", {}], ["A3", { step: "<n>" }], ["action", {}], ["promote", { target: "<codice>" }], ["retention", { target: "<C>" }], ["purge", { target: "<ID>" }]]) {
    const phrase = phraseOf({ kind, plan: P, ...extra });
    assert.ok(a.includes(`\`${phrase}\``), `${kind}: ${phrase}`);
  }
});

test("contratto 4: grant prima e restore dopo per process-mapper e weekly-digest; mai due dispatch paralleli dello stesso tipo", () => {
  assert.ok(lines.some((l) => /session\.mjs" use paths --agent process-mapper --grant --session "\$\{CLAUDE_SESSION_ID\}" --json$/.test(l)));
  assert.ok(lines.some((l) => /session\.mjs" use paths --agent process-mapper --restore --session "\$\{CLAUDE_SESSION_ID\}" --json$/.test(l)));
  assert.ok(lines.some((l) => /session\.mjs" use paths --agent weekly-digest --grant /.test(l)) && lines.some((l) => /session\.mjs" use paths --agent weekly-digest --restore /.test(l)), "sequenza della digestione settimanale");
  assert.match(body, /mai due dispatch in parallelo dello stesso tipo/);
});

test("contratto 5: failure-triage, config-auditor, defect-reporter — il manager scrive la lezione da output.lesson_draft e riesegue self-check; inputs.summary_file; inputs.lesson_code", () => {
  const s = section("7\\. Casi speciali");
  for (const w of ["failure-triage", "config-auditor", "defect-reporter", "output.lesson_draft", "inputs.lesson_code", "inputs.summary_file", "templates/lesson.md", "riesegui l'auto-verifica"]) assert.ok(s.includes(w), w);
  assert.ok(lines.some((l) => /self-check\.mjs" --report .*--lesson .*--json$/.test(l)), "riga di self-check");
});

test("I2 (giro 1): attivazione del piano dalla sessione principale — in sandbox subito, fuori sandbox dopo l'A1 — poi nuovo dispatch con reply_to; anche nelle sequenze §45.3/§45.4", () => {
  const act = /step-check\.mjs" --plan <piano> --step 1 --run <RUN> --session "\$\{CLAUDE_SESSION_ID\}" --json$/;
  assert.ok(commandLines(skill.text).some((l) => act.test(l)), "riga di attivazione nel corpo");
  const a = section("6\\. Le richieste di approvazione");
  assert.match(a, /Attivare un piano/);
  assert.match(a, /in sandbox/i);
  assert.match(a, /fuori sandbox/i);
  assert.match(a, /reply_to/);
  assert.match(a, /guard-config-scope/);
  assert.match(section("5\\. Il ritorno"), /richiesta di attivazione/);
  const seq = skill.refs.find((r) => r.file === "sequences.md").text;
  for (const h of ["## §45.3", "## §45.4"]) {
    const from = seq.indexOf(h);
    const to = seq.indexOf("\n## ", from + 3);
    assert.ok(commandLines(seq.slice(from, to < 0 ? undefined : to)).some((l) => act.test(l)), `${h}: attivazione dalla sessione principale`);
  }
});

test("minore 1 (giro 1): handoff e dispatch di process-mapper/weekly-digest su un altro scope — prima /use scope, a sotto-compiti chiusi", () => {
  const s7 = section("7\\. Casi speciali");
  assert.match(s7, /\*\*Handoff\*\*:[^-]*\/use scope <destinatario>/);
  assert.match(s7, /sotto-compiti chiusi/);
  assert.match(s7, /process-mapper[^.]*\/use scope XSC/);
  assert.match(s7, /weekly-digest[^.]*scope della sessione/);
});

test("contratto 6: APPROVO PIANO prima dell'esecuzione fuori sandbox, ESPLORA SANDBOX dell'utente, PR del test-mechanic per la review umana e mai unita", () => {
  assert.match(body, /`APPROVO PIANO <id>` \*\*prima\*\* che lo scope-expert esegua/);
  assert.ok(body.includes(`\`${EXPLORE_PHRASE}\``));
  assert.match(body, /test-mechanic/);
  assert.match(body, /--apply/);
  assert.match(body, /review umana e non la unisci mai/);
});

test("contratto 7: input da file o nome=valore, niente JSON in linea, --session \"${CLAUDE_SESSION_ID}\" nelle forme esatte", () => {
  const s = section("8\\. Come invochi gli script");
  assert.match(s, /\*\*file\*\* o \*\*`nome=valore`\*\*/);
  assert.match(s, /mai JSON in linea/);
  assert.ok(s.includes('--session "${CLAUDE_SESSION_ID}"'));
  for (const l of lines.filter((x) => /scripts\/admin\/(agents|session)\.mjs" (status|show|use)/.test(x))) assert.match(l, /--session "\$\{CLAUDE_SESSION_ID\}"/, l);
});

test("contratto 9 (R5): ≤ 15 % dei token, nessun lavoro di dominio, kb find solo per instradare", () => {
  assert.match(body, /≤ 15 %/);
  assert.match(body, /R5/);
  assert.match(body, /Non usi mai `kb find`/);
  assert.match(body, /solo per \*\*instradare\*\*/);
  assert.match(body, /Non fai lavoro di dominio/);
});

test("§45.3–§45.6: le sequenze come esempi lavorati (references/sequences.md, citato dal corpo)", () => {
  assert.match(body, /references\/sequences\.md/);
  const seq = flat(skill.refs.find((r) => r.file === "sequences.md")?.text ?? "");
  for (const h of ["§45.2", "§45.3", "§45.4", "§45.5", "§45.6"]) { assert.ok(seq.includes(h), h); assert.ok(body.includes(h), `corpo: ${h}`); }
  assert.match(seq, /reply_to/);
  assert.match(seq, /resume: \{ checkpoint: <n> \}/);
  assert.match(seq, /--grant/);
  assert.match(seq, /--restore/);
  assert.match(seq, /knowledge\.lock/);
  assert.match(seq, /root-cause-analyst/);
});
