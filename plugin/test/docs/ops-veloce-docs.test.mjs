// Documenti e istruzioni agli agenti del piano "Ops veloce" (spec 2026-10-06 §2.2, §3).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers/hook-env.mjs";

const read = (p) => readFileSync(join(ROOT, p), "utf8");
test("documenti: frasi AUTONOMIA, template, produzione, cancellazioni; nessuna frase letterale nel corpo dell'agente", () => {
  for (const p of ["docs/MANUAL.md", "MANUALE-UTENTE.md", "README.md"]) assert.match(read(p), /AUTONOMIA ALTA/, p);
  assert.match(read("commands/ops.md"), /template-fill/);
  assert.match(read("commands/kb.md"), /template-learn/);
  assert.match(read("MANUALE-UTENTE.md"), /APPROVO PASSO/);
  assert.match(read("MANUALE-UTENTE.md"), /write_data/);
  assert.doesNotMatch(read("agents/scope-expert.md").split("---").slice(2).join("---"), /AUTONOMIA (ALTA|MEDIA|BASSA)/);
});

test("documenti: testi di produzione aggiornati, nessun rifiuto assoluto superato", () => {
  assert.doesNotMatch(read("MANUALE-UTENTE.md"), /write_data è sempre false/);
  assert.doesNotMatch(read("commands/ops.md"), /Rifiuta prima di ogni dispatch\*\* se `env\.type` è `prod`/);
  assert.match(read("commands/ops.md"), /autonomy\.yaml|use show/);
  assert.match(read("commands/ops.md"), /import-result/);
  assert.match(read("commands/ops.md"), /APPROVO PIANO|approvazione/i);
  assert.match(read("MANUALE-UTENTE.md"), /autonomy\.yaml/);
  assert.match(read("docs/GUIDA-PRIMO-USO.md"), /AUTONOMIA/);
  assert.match(read("docs/IMPLEMENTATION-CHECKLIST.md"), /Ops veloce/);
  const agent = read("agents/scope-expert.md").split("---").slice(2).join("---");
  assert.doesNotMatch(agent, /APPROVO (PIANO|PASSO|PROVA)/);
  assert.match(agent, /includeSnapshot/);
  assert.match(agent, /fill_form/);
});
