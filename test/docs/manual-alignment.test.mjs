// WP10a — criterio di uscita G3 "manuale allineato ai comandi": per ogni famiglia le azioni dell'argument-hint del comando
// e quelle della tabella §56 di docs/MANUAL.md coincidono (uguaglianza di insiemi); il manuale copre §55–59 e §61.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../helpers/hook-env.mjs";
import { commandFiles, frontmatter, hintActions, manualActions, FAMILIES } from "../helpers/commands.mjs";

const manual = readFileSync(join(ROOT, "docs/MANUAL.md"), "utf8");

// §44.1 e §56.x (con le aggiunte del codice: vc agents di WP10d, use show/close-stale di WP03, learn promote di §56.7)
const EXPECTED = {
  vc: ["status", "agents", "doctor", "watch", "why"],
  use: ["customer", "env", "scope", "mode", "budget", "show", "close-stale"],
  kb: ["ingest", "digest", "review", "find", "fields", "identity", "resolve", "precedents", "epistemic", "impact", "graph", "scopes", "handoffs", "clusters", "contradictions", "coverage", "reindex", "migrate"],
  nrt: ["plan", "run", "compile", "integration", "explore", "triage", "heal", "evidence", "push-xray", "report", "release-check", "author"],
  cfg: ["design", "apply", "verify", "audit", "coverage", "impact"],
  ops: ["crea", "approva", "chiudi", "pubblica", "query", "tables", "learn-analytics"],
  learn: ["lessons", "validate", "outcomes", "calibrate", "digest-weekly", "competence-report", "promote", "tickets", "patterns", "brief"],
  admin: ["retention", "customer", "lock", "session", "integrity"],
};

test("argument-hint di ogni comando = azioni di §44.1/§56.x (più le aggiunte del codice)", () => {
  const c = commandFiles();
  for (const fam of FAMILIES) assert.deepEqual([...hintActions(frontmatter(c[fam])["argument-hint"])].sort(), [...EXPECTED[fam]].sort(), fam);
});

test("G3: tabella §56 del manuale = argument-hint del comando, per ogni famiglia", () => {
  const c = commandFiles();
  for (const fam of FAMILIES) {
    const fromManual = manualActions(manual, fam);
    assert.ok(fromManual, `manuale: manca la sezione 56.x \`${fam}\``);
    assert.deepEqual([...fromManual].sort(), [...hintActions(frontmatter(c[fam])["argument-hint"])].sort(), fam);
  }
});

test("il manuale copre §55–§59 e §61 e l'invocazione /jaggaer-virtual-consultant:<famiglia>", () => {
  for (const h of ["## 55. Installazione e primo avvio", "## 56. Riferimento dei comandi", "## 57. Scrivere un intento", "## 58. Risoluzione dei problemi",
    "## 59. Sintesi in una pagina", "## 61. Catalogo degli intenti"]) assert.ok(manual.includes(h), h);
  assert.match(manual, /\/jaggaer-virtual-consultant:<famiglia> <azione> \[opzioni\]/);
  for (const fam of FAMILIES) assert.match(manual, new RegExp(`### 56\\.\\d+ \`${fam}\``), fam);
});

test("§61: sedici righe nel catalogo degli intenti, allineate ai casi golden 61-01…61-16 di intent.mjs", () => {
  const sec = manual.slice(manual.indexOf("## 61. Catalogo degli intenti"));
  const rows = sec.split("\n").filter((l) => /^\| "/.test(l));
  assert.equal(rows.length, 16);
  const golden = readFileSync(join(ROOT, "test/golden/intent/cases.yaml"), "utf8");
  for (let i = 1; i <= 16; i++) assert.match(golden, new RegExp(`id: 61-${String(i).padStart(2, "0")}`));
  assert.match(sec, /test\/golden\/intent\/cases\.yaml/);
});

test("§58: le righe di risoluzione dei problemi della spec più quelle dei riporti (dipendenze, ${CLAUDE_PLUGIN_ROOT}, browser di Claude fuori sandbox)", () => {
  const sec = manual.slice(manual.indexOf("## 58. Risoluzione dei problemi"), manual.indexOf("## 59."));
  for (const s of ["Nessun ambiente dichiarato", "Ambiente non riconosciuto", "Host non in allow-list", "Azione negata: produzione", "Approvazione non valida", "Budget esaurito",
    "traccia cognitiva mancante", "Compensazioni pendenti", "Integrità del pacchetto fallita", "Knowledge version incompatibile", "Jira irraggiungibile", "DB bloccato",
    "Troppe domande", "Troppe sorprese", "npm install", "${CLAUDE_PLUGIN_ROOT}", "plugin-root", "Chrome DevTools MCP"]) assert.ok(sec.includes(s), s);
});
