import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";

// FINAL Ruling (manifest reference di Claude Code): hooks/hooks.json e .mcp.json alla radice del plugin sono caricati
// SEMPRE e ciò che il manifest dichiara si UNISCE ⇒ le chiavi "hooks" e "mcpServers" rischiano la doppia registrazione
// (audit doppi, conteggi doppi di guard-control, catture doppie): non ci sono; descrizione completa di §31.3.
// 29/10/2026 (decisione dell'utente, punto 1 del piano): la versione non è più fissa a 0.1.0 — Claude Code tiene i plugin
// in cache per versione, quindi a ogni rilascio si alza; qui basta che sia x.y.z e uguale a package.json (la coerenza con
// integrity.json e CHANGELOG.md è in test/admin/plugin-version.test.mjs).
test("il manifest esiste ed è valido: senza hooks/mcpServers (file predefiniti caricati comunque), descrizione completa §31.3", () => {
  const m = JSON.parse(readFileSync(new URL("../.claude-plugin/plugin.json", import.meta.url), "utf8"));
  assert.equal(m.name, "jaggaer-virtual-consultant");
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.equal(m.version, JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version);
  assert.equal(Object.hasOwn(m, "hooks"), false, "hooks/hooks.json è caricato di default: dichiararlo lo registrerebbe due volte");
  assert.equal(Object.hasOwn(m, "mcpServers"), false, ".mcp.json è caricato di default: dichiararlo lo registrerebbe due volte");
  assert.ok(existsSync(new URL("../hooks/hooks.json", import.meta.url)));
  assert.ok(existsSync(new URL("../.mcp.json", import.meta.url)));
  assert.equal(m.description, "Piattaforma di agenti per collaudo NRT, configurazione e operatività su JAGGAER via Chrome, multi-cliente, con conoscenza codificata e agenti che ragionano su storico, conoscenza, scoperte e copertura epistemica.");
  assert.deepEqual(m.author, { name: "Marco Passaretti" });
  assert.equal(m.license, "UNLICENSED");
  assert.ok(Number.isInteger(m.metadata?.knowledge_version_min) && Number.isInteger(m.metadata?.knowledge_version_max));
});
