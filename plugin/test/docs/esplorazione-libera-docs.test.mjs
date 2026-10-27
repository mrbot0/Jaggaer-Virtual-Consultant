// Documenti e istruzioni dell'esplorazione libera (brief 26/10/2026, punto 5): un'unica esplorazione (salva e invia con
// valori di prova; mai cancellazioni, upload, script, produzione); le pagine pesanti si leggono a pezzi e i pezzi si
// sommano; rischio: in pre-produzione un invio può mandare davvero e-mail ai fornitori o dati all'ERP. Nessuna frase
// letterale dell'utente nel corpo dell'agente.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers/hook-env.mjs";

const read = (p) => readFileSync(join(ROOT, p), "utf8");
const FILES = ["commands/use.md", "commands/ops.md", "agents/scope-expert.md", "skills/agent-manager/SKILL.md", "docs/MANUAL.md",
  "MANUALE-UTENTE.md", "docs/GUIDA-PRIMO-USO.md", "README.md", "../README.md"];

test("documenti: un'unica esplorazione con salvataggi e invii di prova, pagine pesanti a pezzi, rischio dell'invio in pre-produzione", () => {
  for (const p of FILES) {
    const t = read(p);
    assert.match(t, /valori di prova/i, `${p}: valori di prova`);
    assert.match(t, /a pezzi/i, `${p}: pagine pesanti lette a pezzi`);
    assert.match(t, /e-mail[^.]*fornitori/i, `${p}: rischio e-mail ai fornitori`);
    assert.match(t, /\bERP\b/, `${p}: rischio dati all'ERP`);
    assert.match(t, /cancell/i, `${p}: mai cancellazioni`);
  }
});

test("documenti: niente più esplorazione semplice (solo click, mai salvataggio) né doppia lettura", () => {
  for (const p of FILES) {
    const t = read(p);
    assert.doesNotMatch(t, /solo click/i, p);
    assert.doesNotMatch(t, /mai invio o salvataggio|non preme mai|mai salva\/invia/i, p);
    assert.doesNotMatch(t, /due letture complete/i, p);
  }
});

test("agente: nessuna frase letterale dell'utente nel corpo", () => {
  const agent = read("agents/scope-expert.md").split("---").slice(2).join("---");
  assert.doesNotMatch(agent, /ESPLORA (SANDBOX|PREPROD)/);
});

// Correzioni dopo la revisione (27/10/2026): DevTools e il file dello snapshot, preprod solo con DevTools, click solo su
// elementi con nome (mai a coordinate), limiti di uscita degli strumenti, find che non svuota la mappa.
test("documenti (correzioni dopo la revisione): pagine pesanti con DevTools via filePath; preprod con Chrome DevTools; click su elementi con nome", () => {
  const agent = read("agents/scope-expert.md");
  assert.match(agent, /filePath/);
  assert.doesNotMatch(agent, /snapshot ristretti con DevTools/i);
  assert.doesNotMatch(agent, /un `find` svuota la mappa/);
  for (const p of ["agents/scope-expert.md", "docs/MANUAL.md", "MANUALE-UTENTE.md", "docs/GUIDA-PRIMO-USO.md", "commands/use.md"]) {
    const t = read(p);
    assert.match(t, /filePath/, `${p}: filePath`);
    assert.match(t, /Chrome DevTools/, `${p}: esplorazione in preprod con Chrome DevTools`);
    assert.match(t, /coordinate/i, `${p}: click a coordinate negati`);
  }
  const manual = read("docs/MANUAL.md");
  assert.match(manual, /MAX_MCP_OUTPUT_TOKENS/);
  assert.match(manual, /max_chars/);
  assert.doesNotMatch(manual, /un pezzo troncato o un find non aggiungono elementi\)/);
});
