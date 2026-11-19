// 18/11/2026 (ciclo di bug fixing 5, authoring NRT): compile-case con --run e generate-atlas-po senza SEL.
//   1. --run che non è un codice RUN del cliente del caso ⇒ errore d'uso (exit 1) PRIMA di scrivere: prima un --run con
//      risalita scriveva plan.json fuori da runs/ (e un codice malformato dava exit 2, "errore di sistema");
//   2. generate-atlas-po su uno scope senza SEL avvisa che i page object sono vuoti (prima: ok muto con 0 selettori).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compileCase, CompileError } from "../../scripts/compile/compile-case.mjs";
import { kbWs, writeItem, writeCase, writeYaml, sel, flw, nrtCase } from "../helpers/wp09b-items.mjs";
import { cleanEnv } from "../helpers/hook-env.mjs";

const CC = fileURLToPath(new URL("../../scripts/compile/compile-case.mjs", import.meta.url));
const PO = fileURLToPath(new URL("../../scripts/compile/generate-atlas-po.mjs", import.meta.url));
function ws() {
  const w = kbWs();
  writeItem(w, sel("C.ACME.P2P.SEL.0001", { role: "textbox", label: "Fornitore" }));
  writeItem(w, sel("C.ACME.P2P.SEL.0002", { role: "button", effect: "write", label: "Salva bozza" }));
  writeItem(w, sel("C.ACME.P2P.SEL.0003", { role: "button", effect: "write", label: "Invia" }));
  writeItem(w, flw("C.ACME.P2P.FLW.0001"));
  writeYaml(w, "customers/ACME/tests/fixtures.yaml", { fixtures: [{ name: "supplier_it", kind: "supplier", tags: ["attivo-it"], scope: "VEN", value: "FORN-0001", attrs: { vat: "IT01234567890" } }] });
  return w;
}

test("compile-case --run: codice non valido, con risalita o di un altro cliente ⇒ CompileError 1, nessun file fuori da runs/", () => {
  const w = ws();
  for (const run of ["RUN.ACME.bad", "../../../fuori", "RUN.BETA.20261118.1000.P2P"]) {
    assert.throws(() => compileCase(w, nrtCase(), { run }), (e) => e instanceof CompileError && e.code === 1, run);
  }
  const f = writeCase(w, nrtCase());
  const cli = spawnSync(process.execPath, [CC, "--case", f, "--workspace", w, "--run", "../../evil", "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: w }) });
  assert.equal(cli.status, 1, cli.stdout + cli.stderr);
  assert.equal(existsSync(join(w, "customers/evil")), false, "nessun piano scritto fuori da runs/");
  assert.ok(compileCase(w, nrtCase(), { run: "RUN.ACME.20261118.1000.P2P" }).plan.plan_id, "il codice valido compila");
});

test("generate-atlas-po: scope senza SEL ⇒ avviso esplicito (page object vuoti)", () => {
  const w = ws();
  const r = spawnSync(process.execPath, [PO, "--scope", "SRC", "--customer", "ACME", "--workspace", w, "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: w }) });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout.trim().split("\n").pop());
  assert.equal(out.selectors, 0);
  assert.ok(out.warnings.some((x) => /nessun SEL/.test(x)), JSON.stringify(out.warnings));
  const ok = JSON.parse(spawnSync(process.execPath, [PO, "--scope", "P2P", "--customer", "ACME", "--workspace", w, "--json"], { encoding: "utf8", env: cleanEnv({ JVC_WORKSPACE: w }) }).stdout.trim().split("\n").pop());
  assert.ok(ok.selectors > 0);
  assert.ok(!ok.warnings.some((x) => /nessun SEL/.test(x)));
});
