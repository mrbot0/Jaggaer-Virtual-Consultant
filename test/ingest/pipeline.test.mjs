// WP09a — la pipeline /kb ingest (§34.2) sui campioni sintetici: ogni file profilato (DOC) o nel residuo con motivo,
// unità = fonti + residuo per documento, lotti di campi ≤ 50, budget per documento, idempotenza e versioni.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, existsSync, readdirSync, cpSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { ingestFolder } from "../../scripts/ingest/ingest.mjs";
import { openDb } from "../../scripts/kb/db.mjs";
import { validateProfile } from "../../scripts/ingest/profile-doc.mjs";

const FIX = new URL("../fixtures/docs/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

test("ingest dei campioni: ogni file profilato o nel residuo con motivo; unità = fonti + residuo; lotti ≤ 50; budget ≤ 80k; niente in kb/", () => {
  const ws = mkdtempSync(join(tmpdir(), "jvc-ingest-"));
  const r = ingestFolder(FIX, { root: ws, scope: "P2P", today: "2026-09-28" });
  const man = JSON.parse(readFileSync(join(ws, "_inbox", "P2P", "parsed", "_manifest.json"), "utf8"));
  const db = openDb(join(ws, "product", "knowledge.db"));
  const profiled = new Set(db.prepare("select doc_id from doc_profiles").all().map((x) => x.doc_id));
  for (const m of man.files) {
    if (m.status === "parsed") assert.ok(profiled.has(m.doc_id), `${m.path}: senza profilo DOC`);
    else if (m.status === "residue") assert.ok(m.residue.class && m.residue.reason, `${m.path}: residuo senza motivo`);
    else assert.equal(m.status, "sidecar");
  }
  assert.equal(r.documents.errors, 0);
  assert.deepEqual(r.documents.inconsistent, []);
  assert.ok(r.docs.every((d) => d.consistent));
  assert.ok(r.fields.max_batch_rows <= 50);
  assert.equal(r.budget.respected, true);
  assert.equal(r.budget.over_unit_budget, 0);
  for (const f of readdirSync(join(ws, "_inbox", "P2P", "profiles"))) assert.ok(validateProfile(YAML.parse(readFileSync(join(ws, "_inbox", "P2P", "profiles", f), "utf8"))).ok, f);
  assert.ok(existsSync(join(ws, "product", "sources", "units")));
  assert.equal(readdirSync(join(ws, "product", "kb")).length, 0, "la pipeline non scrive in kb/ (§29.6)");
  for (const d of ["raw", "reports", "residue", "fields"]) assert.ok(existsSync(join(ws, "_inbox", "P2P", d)), d);
  assert.ok(existsSync(join(ws, "_inbox", "P2P", "ingest-summary.yaml")));
  assert.ok(existsSync(join(ws, "_inbox", "P2P", "aliases.proposed.yaml")));
  assert.ok(existsSync(join(ws, "_inbox", "P2P", "backlog.yaml")));
  assert.equal(db.prepare("select count(*) as n from units").get().n, r.units.total);
  assert.ok(r.candidates.INT >= 1 && r.candidates.FLW >= 1 && r.candidates.CFG >= 1 && r.candidates.FLD >= 1);
  db.close();
});

test("ingest ripetuto: stessi codici DOC e di unità; un documento cambiato diventa una nuova versione .v2 con i codici delle unità invariate conservati e il diff", () => {
  const src = mkdtempSync(join(tmpdir(), "jvc-src-"));
  cpSync(join(FIX, "notes.txt"), join(src, "Guida_setup_v1.txt"));
  const ws = mkdtempSync(join(tmpdir(), "jvc-ver-"));
  const a = ingestFolder(src, { root: ws, scope: "ADM", today: "2026-09-28" });
  const b = ingestFolder(src, { root: ws, scope: "ADM", today: "2026-09-28" });
  assert.equal(a.docs[0].code, b.docs[0].code);
  const db = openDb(join(ws, "product", "knowledge.db"));
  const before = db.prepare("select code, hash from units").all();
  db.close();
  writeFileSync(join(src, "Guida_setup_v1.txt"), `${readFileSync(join(src, "Guida_setup_v1.txt"), "utf8")}\nUn nuovo paragrafo aggiunto nella versione due della guida.\n`);
  const c = ingestFolder(src, { root: ws, scope: "ADM", today: "2026-09-29" });
  assert.equal(c.docs[0].code, `${a.docs[0].code}.v2`);
  const db2 = openDb(join(ws, "product", "knowledge.db"));
  const after = db2.prepare("select code, hash from units where doc=?").all(c.docs[0].code);
  for (const u of before) assert.ok(after.some((x) => x.code === u.code && x.hash === u.hash), `${u.code} conservato`);
  assert.equal(c.docs[0].diff.nuove, 1);
  assert.ok(existsSync(join(ws, "_inbox", "ADM", "doc-diff")));
});
