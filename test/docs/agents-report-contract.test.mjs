// WP10b — contratto in uscita (§46.2, ruling del controller 4): il rapporto d'esempio che chiude il corpo di ogni agente,
// reso come ultimo messaggio, è estratto come fa subagent-trace (ultimo blocco ```yaml) e valida contro
// schemas/agent-report.schema.json e schemas/cognitive-trace.schema.json con i validatori di K2; l'esito effettivo è ok
// (self_check 10/10, nessuna domanda aperta); strategia e tabelle citate esistono; la lezione è dello scope; il modello
// dichiarato è quello del frontmatter; i ruoli senza Write consegnano la bozza della lezione nel rapporto.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { ROOT } from "../helpers/hook-env.mjs";
import { extractReport, validateReport } from "../../scripts/admin/agent-report.mjs";
import { validateWith } from "../../scripts/lib/schemas.mjs";
import { reportedControlsFor } from "../../scripts/decide/self-check-controls.mjs";
import { LEAF_AGENTS, READ_ONLY, agentFiles, parseAgent, lastYamlFence } from "../helpers/agents-md.mjs";

const all = () => Object.entries(agentFiles()).map(([name, text]) => ({ name, ...parseAgent(text) }));

test("ogni agente ha un rapporto d'esempio: 15/15", () => {
  const names = all().filter((a) => lastYamlFence(a.body)).map((a) => a.name).sort();
  assert.deepEqual(names, [...LEAF_AGENTS].sort());
});

test("il rapporto d'esempio, estratto come fa subagent-trace, valida contro agent-report e cognitive-trace (status effettivo ok)", () => {
  for (const { name, body, fm } of all()) {
    const obj = YAML.parse(lastYamlFence(body));
    const extracted = extractReport(`Rapporto finale.\n\n${body.slice(body.lastIndexOf("```yaml"))}`);
    assert.deepEqual(extracted, obj, `${name}: estrazione`);
    const v = validateReport(obj);
    assert.equal(v.ok, true, `${name}: ${JSON.stringify(v.errors)}`);
    assert.equal(v.status_effective, "ok", `${name}: riclassificato ${JSON.stringify(v.reclassified)}`);
    const ct = validateWith("cognitive-trace.schema.json", obj.cognitive_trace);
    assert.equal(ct.ok, true, `${name}: ${ct.errors?.join("; ")}`);
    assert.ok(existsSync(join(ROOT, "strategies", `${obj.cognitive_trace.strategy}.yaml`)), `${name}: strategia ${obj.cognitive_trace.strategy}`);
    for (const dt of JSON.stringify(obj).match(/DT-\d{3}/g) ?? []) assert.ok(existsSync(join(ROOT, "decision-tables", `${dt}.yaml`)), `${name}: ${dt}`);
    for (const d of obj.cognitive_trace.decisions) assert.match(d, /^L\.[A-Z0-9]{4}\.[A-Z0-9]{3}\.DEC\.\d{4}$/, `${name}: DEC`);
    assert.match(obj.task_id, /^MSG\.SES\.[A-Z0-9]{4}\.\d{8}\.\d{3}\.\d{4}$/, `${name}: task_id dell'header`);
    assert.equal(obj.usage?.model, fm.model, `${name}: usage.model = modello del frontmatter`);
    assert.equal(obj.needs_input, null, name);
    assert.deepEqual(obj.open_questions, [], name);
    // giro 1 (I3): `passed` = numero di controlli della profondità dichiarata (rapida 4, standard/profonda 10); i ruoli
    // T0 a ciclo ridotto (solo Read e Bash) dichiarano la profondità rapida che eseguono davvero.
    assert.equal(obj.cognitive_trace.self_check.passed, reportedControlsFor(obj.cognitive_trace.depth).length, `${name}: passed per la profondità ${obj.cognitive_trace.depth}`);
    if (READ_ONLY.includes(name)) assert.equal(obj.cognitive_trace.depth, "rapida", `${name}: ruolo T0 (solo Read e Bash)`);
    if (READ_ONLY.includes(name)) {
      const d = obj.output?.lesson_draft;
      assert.ok(d && typeof d === "object", `${name}: output.lesson_draft (il ruolo non ha Write)`);
      assert.equal(Object.keys(d).length, 8, `${name}: otto sezioni`);
    }
  }
});

test("il rapporto d'esempio non è un modello vuoto: memorie richiamate, forma epistemica, decisioni o motivo, lezione dello scope", () => {
  for (const { name, body } of all()) {
    const r = YAML.parse(lastYamlFence(body));
    const t = r.cognitive_trace;
    assert.ok(t.recalled.semantic.length + t.recalled.episodic.length + t.recalled.working.length > 0, `${name}: richiamo`);
    assert.ok(t.epistemic.subject && !/[<>]/.test(t.epistemic.subject), `${name}: soggetto`);
    const scope = r.lesson.split(".")[2];
    assert.ok(t.epistemic.subject.includes(`.${scope}.`) || /^(CL-|S\.STD\.XSC|C\.[A-Z0-9]{4}\.XSC)/.test(t.epistemic.subject) || scope === "XSC", `${name}: lezione ${r.lesson} e soggetto ${t.epistemic.subject}`);
    assert.ok(r.why && typeof r.why === "object", `${name}: why`);
  }
});
