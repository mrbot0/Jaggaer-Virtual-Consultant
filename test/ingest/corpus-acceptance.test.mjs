// WP09a — test di accettazione sul CORPUS REALE (JAGGAER DOC, materiale proprietario ignorato da git): la pipeline
// completa su tutto il corpus, in un workspace temporaneo. SALTATO se la cartella non esiste (CI senza documenti) o
// con JVC_SKIP_CORPUS=1. Verifica: nessun crash; ogni file profilato (DOC) o nel residuo con motivo; nessun lotto di
// campi > 50; budget per documento rispettato (sessioni ≤ 80k token, unità ≤ 3k); unità = fonti + residuo.
// Nessun contenuto del corpus è citato qui: solo conteggi e invarianti.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ingestFolder } from "../../scripts/ingest/ingest.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { DOC_BUDGET } from "../../scripts/ingest/extract.mjs";

const CORPUS = new URL("../../JAGGAER DOC/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1").replace(/%20/g, " ");
const skip = !existsSync(CORPUS) ? "corpus JAGGAER DOC assente" : process.env.JVC_SKIP_CORPUS === "1" ? "JVC_SKIP_CORPUS=1" : false;

test("accettazione sul corpus reale: nessun crash, ogni file profilato o nel residuo con motivo, lotti ≤ 50, budget per documento", { skip, timeout: 600000 }, () => {
  const ws = mkdtempSync(join(tmpdir(), "jvc-corpus-"));
  const r = ingestFolder(CORPUS, { root: ws, scope: "XSC" });
  assert.deepEqual(r.errors, [], "nessun documento in errore");
  const man = JSON.parse(readFileSync(join(ws, "_inbox", "XSC", "parsed", "_manifest.json"), "utf8"));
  assert.equal(man.files.length, r.files.total);
  const db = openDb(join(ws, "product", "knowledge.db"));
  const profiled = new Set(db.prepare("select doc_id from doc_profiles").all().map((x) => x.doc_id));
  let parsed = 0, residue = 0;
  for (const m of man.files) {
    if (m.status === "parsed") { parsed++; assert.ok(profiled.has(m.doc_id), `file senza profilo DOC (#${man.files.indexOf(m)})`); }
    else if (m.status === "residue") { residue++; assert.ok(m.residue?.class && m.residue?.reason, "residuo senza classe o motivo"); }
  }
  assert.equal(parsed + residue + r.files.sidecars, man.files.length);
  assert.equal(profiled.size, parsed);
  for (const d of r.docs) {
    assert.ok(d.consistent, `${d.code}: unità ≠ fonti + residuo`);
    for (const b of d.fields.batches) assert.ok(b.rows <= 50, `${d.code}: lotto di ${b.rows} campi`);
    assert.ok((d.fields.tokens ?? 0) <= DOC_BUDGET, `${d.code}: digestione dei campi oltre ${DOC_BUDGET}`);
    for (const s of d.llm.sessions) assert.ok(s <= DOC_BUDGET, `${d.code}: sessione di ${s} token`);
    assert.equal(d.llm.over_unit_budget, 0, `${d.code}: unità oltre 3k token`);
  }
  assert.ok(r.fields.max_batch_rows <= 50);
  assert.equal(r.budget.respected, true);
  db.close();
});
