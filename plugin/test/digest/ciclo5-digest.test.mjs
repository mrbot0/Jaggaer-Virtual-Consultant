// 18/11/2026 (ciclo di bug fixing 5, digestione settimanale su più clienti):
//   1. un cliente con knowledge.db illeggibile (file corrotto) non ferma la digestione degli altri: è saltato, l'errore
//      è tracciato (pseudonimizzato) nel risultato, in report.json e nel competence report; prima: exit 2 per tutti;
//   2. competence-report --week accetta solo AAAA-Www (niente percorsi).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../scripts/kb/db.mjs";
import { weekly, runReport } from "../../scripts/digest/weekly.mjs";

const SALT = { JVC_PSEUDO_SALT: "0123456789abcdef0123" };
function ws() {
  const w = realpathSync.native(mkdtempSync(join(tmpdir(), "jvc-c5dig-")));
  for (const d of ["product/kb", "customers/ACME/kb", "customers/BADC/kb"]) mkdirSync(join(w, d), { recursive: true });
  openDb(join(w, "customers/ACME/knowledge.db")).close();
  writeFileSync(join(w, "customers/BADC/knowledge.db"), "questo non è un database SQLite ".repeat(200));
  return w;
}

test("digest-weekly: un knowledge.db corrotto salta quel cliente, gli altri si digeriscono; errore tracciato e pseudonimizzato", async () => {
  const w = ws();
  const r = await weekly({ ws: w, env: SALT, now: new Date("2026-11-18T12:00:00Z") });
  assert.equal(r.week, "2026-W47");
  assert.equal(r.customers.length, 2);
  assert.ok(r.errors.length >= 1, JSON.stringify(r.errors));
  assert.ok(r.errors.every((e) => /^CUST-[0-9a-f]{10}$/.test(e.customer) && e.step && e.error), JSON.stringify(r.errors));
  const text = JSON.stringify(r.errors);
  assert.ok(!/BADC/.test(text), "il codice del cliente non esce in chiaro");
  const rep = JSON.parse(readFileSync(join(w, "product/digest/2026-W47/report.json"), "utf8"));
  assert.deepEqual(rep.errors.map((e) => e.customer).sort(), [...new Set(r.errors.map((e) => e.customer))].sort().flatMap((c) => r.errors.filter((e) => e.customer === c).map(() => c)));
  assert.match(readFileSync(join(w, "product/digest/2026-W47/competence-report.md"), "utf8"), /ERRORI/);
  assert.ok(r.reindexed.product, "il prodotto si reindicizza comunque");
});

test("competence-report --week: solo AAAA-Www", async () => {
  const w = ws();
  await weekly({ ws: w, env: SALT, now: new Date("2026-11-18T12:00:00Z") });
  const out = [];
  const log = console.log;
  console.log = (s) => out.push(String(s));
  try {
    assert.equal(await runReport(["--week", "../../customers/ACME", "--workspace", w, "--json"]), 1);
    assert.match(out.at(-1), /settimana non valida/);
    assert.equal(await runReport(["--week", "2026-W47", "--workspace", w, "--json"]), 0);
  } finally { console.log = log; }
});
