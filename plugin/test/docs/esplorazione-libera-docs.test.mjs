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

test("documenti (sicurezza dopo la revisione): snapshot su file nella cartella snapshots/ con percorso assoluto; il find non aggiunge nulla", () => {
  for (const p of ["agents/scope-expert.md", "docs/MANUAL.md", "commands/use.md"]) assert.match(read(p), /snapshots\//, p);
  assert.match(read("agents/scope-expert.md"), /assoluto/);
  assert.doesNotMatch(read("agents/scope-expert.md"), /vi aggiunge solo ref/);
  assert.match(read("docs/MANUAL.md"), /troppo grande/);
});

// N3 superato dal guard sulla grandezza tolto (27/10/2026, decisione dell'utente): nessuna "pagina troppo grande per essere
// mappata"; il base64 delle immagini si toglie alla lettura; il marcatore di una chiamata non registrata guarisce con una
// lettura completa della scheda.
test("documenti (guard sulla grandezza tolto, 27/10/2026): niente limite in byte della mappa; base64 omesso; il marcatore guarisce con una lettura completa", () => {
  for (const p of ["agents/scope-expert.md", "docs/MANUAL.md"]) {
    const t = read(p);
    assert.doesNotMatch(t, /troppo grande per essere mappata/, p);
    assert.match(t, /base64 omesso/, p);
    assert.match(t, /non è stata\s+registrata/, p);
    assert.match(t, /per intero/, p);
  }
});

test("documenti (N4, verifica del 27/10/2026): precondizioni dello snapshot su file di DevTools e percorso assoluto da use show", () => {
  for (const p of ["agents/scope-expert.md", "commands/use.md", "docs/MANUAL.md"]) {
    const t = read(p);
    assert.match(t, /cartella\s+di\s+lavoro\s+di\s+Claude\s+Code/, `${p}: workspace sotto la cartella di lavoro`);
    assert.match(t, /radice\s+MCP/, `${p}: cartelle radice MCP di chrome-devtools-mcp`);
    assert.match(t, /giunzioni/, `${p}: niente giunzioni`);
    assert.match(t, /8\.3/, `${p}: niente nomi 8.3`);
    assert.match(t, /snapshots_dir/, `${p}: percorso assoluto da use show`);
  }
  assert.match(read("skills/agent-manager/SKILL.md"), /inputs\.snapshots_dir/);
});
