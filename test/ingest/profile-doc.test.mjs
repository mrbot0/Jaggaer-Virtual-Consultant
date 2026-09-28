// WP09a-C — profilo del documento (§19.7): kind, genere, origine, struttura, unità per tipo, affidabilità calcolata;
// codice DOC dal DB con versioni; reliability.score come peso di base delle affermazioni in reindex.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { openDb } from "../../scripts/kb/db.mjs";
import { reindex, sourceWeight } from "../../scripts/kb/reindex.mjs";
import { validateItem } from "../../scripts/kb/validate-schema.mjs";
import { segmentUnits } from "../../scripts/ingest/segment.mjs";
import { harvest } from "../../scripts/ingest/harvest.mjs";
import { detectKind, genreFor, reliability, internalConsistency, profileDoc, validateProfile, assignDocCode, recordProfile, docKey, detectScopes, releaseDistance, RELIABILITY } from "../../scripts/ingest/profile-doc.mjs";

const FIX = new URL("../fixtures/docs/", import.meta.url);
const fixDir = FIX.pathname.replace(/^\/([A-Za-z]:)/, "$1");
const docs = Object.fromEntries(harvest(fixDir, { write: false }).docs.map((d) => [d.meta.source, d]));

test("kind e genere dal formato, dall'indizio del parser e dal nome", () => {
  const k = (n) => detectKind(docs[n]);
  assert.equal(k("sample.xsd"), "spec-integrazione");
  assert.equal(k("sample.wsdl"), "spec-integrazione");
  assert.equal(k("workflow_definition_demo.xml"), "config-export");
  assert.equal(k("document_config_demo.xml"), "config-export");
  assert.equal(k("thread.eml"), "thread-email");
  assert.equal(k("training.vtt"), "registrazione");
  assert.equal(k("screen.png"), "set-screenshot");
  assert.equal(k("sample.pptx"), "training-deck");
  assert.equal(k("data.csv"), "dati-import");
  assert.equal(k("sample.docx"), "doc-configurazione-cliente");
  assert.equal(detectKind({ title: "Release Notes R25.1", format: "pdf", sections: [] }, { source: "rn.pdf" }), "release-notes");
  assert.equal(detectKind({ title: "JINT WS Development Kit Order", format: "docx", sections: [] }, { source: "kit.docx" }), "spec-integrazione");
  assert.deepEqual([genreFor("spec-integrazione"), genreFor("manuale-utente"), genreFor("tenant-survey"), genreFor("thread-email")], ["tecnica", "d'uso", "empirica", "testimoniale"]);
});

test("affidabilità = base × freschezza × paternità × coerenza × corroborazione (arrotondata), con le tabelle di doc-reliability.yaml", () => {
  const r = reliability({ kind: "doc-configurazione-cliente", origin: "cliente", coversRelease: "R24.3", currentRelease: "R25.1", releases: ["R24.1", "R24.3", "R25.1"], corroboration: 0.9 });
  assert.equal(r.base_by_kind, 0.8);
  assert.equal(r.freshness, 0.9);
  assert.equal(r.authorship, 1);
  assert.equal(r.score, Math.round(0.8 * 0.9 * 1 * 1 * 0.9 * 100) / 100);
  const unknown = reliability({ kind: "manuale-utente", origin: "vendor" });
  assert.equal(unknown.freshness, RELIABILITY.freshness_unknown_release);
  assert.equal(unknown.corroboration, 1);
  assert.ok(unknown.notes.some((n) => /corroborazione/.test(n)));
  assert.equal(reliability({ kind: "manuale-utente", origin: "vendor", title: "UNOFFICIAL considerations" }).authorship, 0.8);
  assert.equal(reliability({ kind: "manuale-utente", origin: "vendor", formal: true }).base_by_kind, 0.95);
  assert.equal(releaseDistance("R24.1", "R25.1", ["R24.1", "R24.3", "R25.1"]), 2);
  assert.equal(releaseDistance(null, "R25.1"), null);
});

test("coerenza interna: righe-campo con lo stesso nome e obbligatorietà opposta nella stessa sezione", () => {
  const d = { id: "d", title: "D", format: "docx", sections: [{ path: "1", title: "Campi", level: 1, paragraphs: [], figures: [], tables: [{ headers: ["Campo", "Tipo", "Obbligatorio"], rows: [["A", "t", "Sì"], ["A", "t", "No"], ["B", "t", "Sì"]] }] }] };
  const ic = internalConsistency(segmentUnits(d).units);
  assert.equal(ic.contradictions, 1);
  assert.equal(ic.rules, 3);
  assert.equal(ic.value, Math.round((1 - 1 / 3) * 100) / 100);
});

test("profileDoc: DOC valido contro item.base e doc.schema.json, con struttura, unità per tipo, lingue, scope, problemi noti", () => {
  const d = docs["sample.docx"];
  const { units, overflow } = segmentUnits(d, { docCode: "C.ACME.XSC.DOC.0007" });
  const p = profileDoc(d, units, { code: "C.ACME.XSC.DOC.0007", origin: "cliente", overflow, today: "2026-09-28" });
  const v = validateProfile(p);
  assert.ok(v.ok, v.errors.join("; "));
  assert.ok(validateItem(p).ok, "validate-schema applica doc.schema.json al tipo DOC");
  assert.equal(p.kind, "doc-configurazione-cliente");
  assert.equal(p.genre, "tecnica");
  assert.equal(p.facets.F15, "tecnica");
  assert.equal(p.facets.F1, "doc-cliente-tecnica");
  assert.equal(p.units.total, units.length);
  assert.equal(p.structure.field_tables, 1);
  assert.equal(p.structure.revisions, 2);
  assert.equal(p.structure.comments, 1);
  assert.deepEqual(p.languages, ["it"]);
  assert.ok(p.scopes.includes("P2P"));
  assert.ok(p.known_issues.some((k) => k.status === "parser"));
  assert.ok(p.summary.split(/\s+/).length <= 60);
  assert.ok(!validateProfile({ ...p, kind: "inventato" }).ok);
  assert.deepEqual(detectScopes({ title: "Web Services Development Kit", sections: [] }, [{ text: "The ERP integration uses the web service API." }]).slice(0, 1), ["XSC"]);
});

test("codice DOC dal DB: stesso contenuto ⇒ stesso codice; stesso documento con contenuto nuovo ⇒ versione .v2; altro documento ⇒ SEQ successivo", () => {
  const db = openDb(":memory:");
  const a = assignDocCode(db, { level: "S", customer: "STD", source: "manuali/Guida_Admin_v2.docx", sha256: "sha256:aa" });
  assert.equal(a.code, "S.STD.XSC.DOC.0001");
  recordProfile(db, { id: a.code, source: { doc_key: docKey("manuali/Guida_Admin_v2.docx"), doc_id: "g", path: "manuali/Guida_Admin_v2.docx", sha256: "sha256:aa" }, kind: "guida-admin", genre: "tecnica", origin: "vendor", version: "2", dated: null, covers_release: null, reliability: { score: 0.6 }, ingestion: { status: "segmented" }, units: { total: 1 } });
  assert.equal(assignDocCode(db, { source: "manuali/Guida_Admin_v2.docx", sha256: "sha256:aa" }).code, "S.STD.XSC.DOC.0001");
  const v3 = assignDocCode(db, { source: "manuali/Guida_Admin_v3.docx", sha256: "sha256:bb" });
  assert.equal(v3.code, "S.STD.XSC.DOC.0001.v2");
  assert.equal(v3.previous, "S.STD.XSC.DOC.0001");
  assert.equal(assignDocCode(db, { source: "altro.pdf", sha256: "sha256:cc" }).code, "S.STD.XSC.DOC.0002");
  assert.equal(docKey("ACME_Configurazione_v2.docx"), docKey("ACME_Configurazione_v3.docx"));
});

test("reindex: la fonte DOC profilata dà il peso di base (reliability.score) al posto del peso per origine F1", () => {
  const root = mkdtempSync(join(tmpdir(), "kb-doc-"));
  const dir = join(root, "kb", "scopes", "P2P", "flows");
  mkdirSync(dir, { recursive: true });
  const base = YAML.parse(readFileSync(new URL("../fixtures/items/valid.flw.yaml", import.meta.url), "utf8"));
  writeFileSync(join(dir, "C.ACME.P2P.FLW.0001.yaml"), YAML.stringify({ ...base, id: "C.ACME.P2P.FLW.0001", facets: { ...base.facets, F1: "doc-cliente-utente", F8: "universale", F12: "promosso" }, sources: [{ doc: "C.ACME.XSC.DOC.0007", unit: "U.DOC0007.0001" }] }));
  const dbPath = join(root, "k.db");
  const db = openDb(dbPath);
  db.prepare("insert into doc_profiles(code, doc_key, doc_id, reliability) values ('C.ACME.XSC.DOC.0007', 'k', 'd', 0.5)").run();
  reindex(root, dbPath, { clustersDir: null });
  assert.equal(db.prepare("select confidence from items where code='C.ACME.P2P.FLW.0001'").get().confidence, 0.5);
  assert.equal(sourceWeight({ facets: { F1: "doc-cliente-utente" }, sources: [{ doc: "C.ACME.XSC.DOC.0099" }] }, { docReliability: new Map([["C.ACME.XSC.DOC.0007", 0.5]]) }), 0.7, "DOC non profilato ⇒ peso per origine");
});
