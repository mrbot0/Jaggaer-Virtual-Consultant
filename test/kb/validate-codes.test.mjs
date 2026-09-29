// Revisione finale (Minor A#1, A#3, A#6; §44.5, plan K0.2): validate-codes come CLI sottile sulla validazione dei codici
// esistente (codes.mjs); lifecycle --help senza sottocomando; `name` nel frontmatter dei comandi (§44.1).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { ROOT, cleanEnv } from "../helpers/hook-env.mjs";
import { frontmatter } from "../helpers/commands.mjs";

const CLI = join(ROOT, "scripts/kb/validate-codes.mjs");
const run = (ws, args) => { const r = spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", cwd: ws, env: cleanEnv({ JVC_WORKSPACE: ws }) }); let json = null; try { json = JSON.parse(r.stdout); } catch { /* testo */ } return { ...r, json }; };

function ws() {
  const w = mkdtempSync(join(tmpdir(), "jvc-codes-"));
  const d = join(w, "customers/ACME/kb/scopes/P2P/flows");
  mkdirSync(d, { recursive: true });
  const put = (f, id) => writeFileSync(join(d, f), YAML.stringify({ id, type: "FLW", title: "x" }));
  return { w, d, put };
}

test("validate-codes: codici validi e uguali al nome del file ⇒ exit 0", () => {
  const { w, put } = ws();
  put("C.ACME.P2P.FLW.0001.yaml", "C.ACME.P2P.FLW.0001");
  put("C.ACME.P2P.FLW.0002.yaml", "C.ACME.P2P.FLW.0002");
  const r = run(w, ["customers/ACME/kb", "--json"]);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.ok, true);
  assert.equal(r.json.checked, 2);
});

test("validate-codes: codice non valido per livello/tipo/scope, nome del file diverso dal codice, SEQ già usato da un altro file ⇒ exit 1", () => {
  const { w, put } = ws();
  put("C.ACME.P2P.FLW.0001.yaml", "C.ACME.P2P.FLW.0001");
  put("S.ACME.P2P.FLW.0003.yaml", "S.ACME.P2P.FLW.0003");        // S con un cliente
  put("C.ACME.P2P.FLW.0004.yaml", "C.ACME.P2P.FLW.0005");        // il codice è il nome del file (§5)
  put("copia.yaml", "C.ACME.P2P.FLW.0001");                      // stesso codice, un'altra entità
  const r = run(w, ["customers/ACME/kb", "--json"]);
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const why = r.json.errors.map((e) => e.error).join("\n");
  assert.match(why, /S\.ACME\.P2P\.FLW\.0003.*non valido/);
  assert.match(why, /nome del file/);
  assert.match(why, /C\.ACME\.P2P\.FLW\.0001.*già usato/);
});

test("validate-codes: --help exit 0; senza argomenti exit 1; percorso fuori dal workspace rifiutato", () => {
  const { w } = ws();
  assert.equal(run(w, ["--help"]).status, 0);
  assert.equal(run(w, ["--json"]).status, 1);
  const out = mkdtempSync(join(tmpdir(), "jvc-codes-out-"));
  assert.equal(run(w, [out, "--json"]).status, 1);
});

test("lifecycle.mjs --help senza sottocomando ⇒ exit 0 con l'uso di promote e deprecate", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "scripts/kb/lifecycle.mjs"), "--help"], { encoding: "utf8", env: cleanEnv() });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /promote/); assert.match(r.stdout, /deprecate/);
});

test("comandi: `name` nel frontmatter = nome del file (§44.1)", () => {
  for (const f of readdirSync(join(ROOT, "commands")).filter((x) => x.endsWith(".md"))) {
    assert.equal(frontmatter(readFileSync(join(ROOT, "commands", f), "utf8")).name, f.slice(0, -3), f);
  }
});
