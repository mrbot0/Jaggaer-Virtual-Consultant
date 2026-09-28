// WP09a-F — il tenant come documento (§19.17) sul tenant dimostrativo (test/fixtures/demo-tenant/mcp).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, mkdtempSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { surveyDoc, surveyCandidates, survey } from "../../scripts/chrome/survey.mjs";
import { segmentUnits } from "../../scripts/ingest/segment.mjs";
import { validateWith } from "../../scripts/lib/schemas.mjs";
import { openDb } from "../../scripts/kb/db.mjs";

const MCP = new URL("../fixtures/demo-tenant/mcp/", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const snaps = readdirSync(MCP).filter((f) => f.endsWith(".snapshot.txt")).sort().map((f) => ({ name: f, text: readFileSync(join(MCP, f), "utf8") }));

test("snapshot MCP → documento normalizzato con sezioni `schermata` per pagina; unità schermata, regole di sistema dai messaggi, righe di campi", () => {
  const doc = surveyDoc(snaps, { date: "2026-09-28" });
  assert.ok(validateWith("parsed-doc.schema.json", doc).ok);
  assert.equal(doc.sections.length, snaps.length);
  assert.ok(doc.sections.every((s) => s.kind === "schermata" && s.meta.page_signature));
  const { units } = segmentUnits(doc, { docCode: "C.ACME.XSC.DOC.0042" });
  assert.equal(units.filter((u) => u.type === "schermata").length, snaps.length);
  assert.ok(units.some((u) => u.type === "regola" && u.system_message && /centro di costo è obbligatorio/.test(u.text)));
  assert.ok(units.some((u) => u.type === "riga-tabella-campi" && /Centro di costo/.test(u.text)));
});

test("candidati: FLD livello L con mandatory.kind OSSERVATO (Centro di costo required ⇒ always), messaggio d'errore ⇒ validation block, pagina di setup ⇒ CFG.current_state a 0.85", () => {
  const doc = surveyDoc(snaps, { date: "2026-09-28" });
  const c = surveyCandidates(doc);
  const cdc = c.fld.find((f) => f.label === "Centro di costo");
  assert.deepEqual([cdc.level, cdc.mandatory.kind, cdc.mandatory.observed, cdc.source], ["L", "always", true, "osservazione-chrome"]);
  assert.equal(c.fld.find((f) => f.label === "Codice progetto").mandatory.kind, "never");
  const v = c.validations.find((x) => /centro di costo è obbligatorio/i.test(x.message));
  assert.equal(v.on_fail, "block");
  assert.equal(v.message, "Il centro di costo è obbligatorio (REQ-VAL-014)", "testo esatto del messaggio");
  const tol = c.cfg.find((x) => /Tolleranza quantità/.test(x.parameter));
  assert.deepEqual([tol.current_state.value, tol.confidence, tol.current_state.source], ["2", 0.85, "osservazione-chrome"]);
  assert.equal(c.cfg.find((x) => /approvazione automatica/.test(x.parameter)).current_state.value, true);
  assert.ok(!c.cfg.some((x) => /Centro di costo/.test(x.parameter)), "le pagine non di setup non danno CFG");
  // formato senza `required` (Claude read_page): obbligatorietà ignota, mai "falsa"
  const cb = surveyCandidates(surveyDoc([{ name: "rp.txt", text: 'textbox "Centro di costo" [ref_7]\nTab Context:\nExecuted on tabId: 1\ntabId 1: "Nuova richiesta" (https://acme-sbx.jaggaer.com/p2p/requisition/new)' }]));
  assert.equal(cb.fld[0]?.mandatory.kind ?? null, null);
});

test("survey su disco: _inbox/<scope>/survey/<data>/ + DOC tenant-survey datato nel DB del cliente", () => {
  const ws = mkdtempSync(join(tmpdir(), "survey-"));
  const r = survey(MCP, { root: ws, customer: "ACME", scope: "ADM", date: "2026-09-28" });
  assert.match(r.code, /^C\.ACME\.XSC\.DOC\.\d{4}$/);
  const dir = join(ws, "customers", "ACME", "_inbox", "ADM", "survey", "2026-09-28");
  for (const f of ["parsed.json", "units.json", "candidates.yaml"]) assert.ok(existsSync(join(dir, f)), f);
  const prof = YAML.parse(readFileSync(r.profile, "utf8"));
  assert.equal(prof.kind, "tenant-survey");
  assert.equal(prof.genre, "empirica");
  assert.equal(prof.dated, "2026-09-28");
  assert.equal(prof.facets.F1, "osservazione-chrome");
  const db = openDb(join(ws, "customers", "ACME", "knowledge.db"));
  assert.equal(db.prepare("select kind from doc_profiles where code=?").get(r.code).kind, "tenant-survey");
  assert.ok(r.fld >= 5 && r.cfg >= 3 && r.validations >= 1);
});
