// K6.4 — intent: 30 intenti golden (ogni riga di §61 compresa) → 30/30; senza ambiente → chiedi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import YAML from "yaml";
import { ROOT, cleanEnv } from "../helpers/hook-env.mjs";
import { parseIntent } from "../../scripts/decide/intent.mjs";

const G = YAML.parse(readFileSync(join(ROOT, "test/golden/intent/cases.yaml"), "utf8"));

test("intent: 30 intenti golden (le 16 righe di §61 e 14 casi limite) → 30/30", () => {
  assert.equal(G.cases.length, 30);
  const failures = [];
  for (const c of G.cases) {
    const session = c.session ? { customer: c.session.customer ?? null, env: c.session.env ? { type: c.session.env } : null } : null;
    const r = parseIntent(c.text, { customers: G.customers, session });
    for (const [k, v] of Object.entries(c.expect)) {
      if (k === "reason_match") { if (!new RegExp(v).test(r.reason)) failures.push(`${c.id}: reason «${r.reason}» !~ ${v}`); continue; }
      if (k === "data") { for (const [dk, dv] of Object.entries(v)) if (String(r.data[dk]) !== String(dv)) failures.push(`${c.id}: data.${dk} = ${JSON.stringify(r.data[dk])} ≠ ${JSON.stringify(dv)}`); continue; }
      if (k === "missing") { for (const m of v) if (!r.missing.includes(m)) failures.push(`${c.id}: missing ${JSON.stringify(r.missing)} senza ${m}`); continue; }
      if (JSON.stringify(r[k] ?? null) !== JSON.stringify(v)) failures.push(`${c.id}: ${k} = ${JSON.stringify(r[k])} ≠ ${JSON.stringify(v)}`);
    }
  }
  assert.deepEqual(failures, [], failures.join("\n"));
});

test("intent: senza ambiente (né nell'intento né in sessione) ⇒ chiedi prima di qualunque passo; con l'ambiente in sessione ⇒ avvia", () => {
  const a = parseIntent("Su ACME crea una RdA per 3 sedie, CdC IT-0442, in bozza", { customers: ["ACME"] });
  assert.equal(a.outcome, "chiedi"); assert.ok(a.missing.includes("env")); assert.match(a.reason, /ambiente/i);
  const b = parseIntent("Su ACME crea una RdA per 3 sedie, CdC IT-0442, in bozza", { customers: ["ACME"], session: { customer: "ACME", env: { type: "sandbox" } } });
  assert.equal(b.outcome, "avvia");
});

test("intent: il DT-026 decide l'esito (tabella e punteggio nel risultato); CLI --json", () => {
  const r = parseIntent("Su ACME sandbox crea una RdA per 5 sedie, CdC IT-0442", { customers: ["ACME"] });
  assert.equal(r.dt.table, "DT-026"); assert.equal(r.dt.outcome, r.outcome);
  const cli = spawnSync(process.execPath, [join(ROOT, "scripts/decide/intent.mjs"), "--text", "Su ACME produzione crea un ordine di test", "--customers", "ACME,BETA", "--json"], { encoding: "utf8", env: cleanEnv() });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).outcome, "rifiuta");
  assert.equal(spawnSync(process.execPath, [join(ROOT, "scripts/decide/intent.mjs"), "--json"], { encoding: "utf8", env: cleanEnv() }).status, 1);
});
