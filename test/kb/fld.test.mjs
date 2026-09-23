// K4.1 — schema FLD (§19.6.2 + carta d'identità §19.20), regole di grafo di
// validateFld, e ammissione a CL-FLD-MAND solo con regola parsata (§19.6.4 passo 6).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { validateItem } from "../../scripts/kb/validate-schema.mjs";
import { validateFld, hasParsedMandatory, IDENTITY_BLOCKS } from "../../scripts/kb/validate-fld.mjs";
import { judgeAdmission, admit, AdmissionError, PolicyError } from "../../scripts/kb/cluster.mjs";
import { reindex } from "../../scripts/kb/reindex.mjs";
import { openDb } from "../../scripts/kb/db.mjs";

const FIXTURE = fileURLToPath(new URL("../fixtures/items/S.STD.P2P.FLD.0117.yaml", import.meta.url));
const load = () => YAML.parse(readFileSync(FIXTURE, "utf8"));
const cluster = (code) => YAML.parse(readFileSync(fileURLToPath(new URL(`../../clusters/${code.replace(/-\d{3}$/, "")}/${code}.yaml`, import.meta.url)), "utf8"));
const NOW = "2026-09-23T10:00:00.000Z";

test("K4.1 fixture S.STD.P2P.FLD.0117 (esempio di §19.6.2 con identity) valida con validateItem e validateFld", () => {
  const it = load();
  const a = validateItem(it);
  assert.deepEqual(a.errors, []);
  const b = validateFld(it);
  assert.deepEqual(b.errors, []);
  assert.equal(IDENTITY_BLOCKS.length, 12);
  assert.deepEqual(Object.keys(it.identity), IDENTITY_BLOCKS);
});

test("validate-schema CLI valida la fixture FLD (exit 0)", () => {
  const cli = fileURLToPath(new URL("../../scripts/kb/validate-schema.mjs", import.meta.url));
  const r = spawnSync(process.execPath, [cli, FIXTURE, "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(JSON.parse(r.stdout).ok, true);
});

test("mandatory è una REGOLA: kind a vocabolario chiuso, reason.kind a vocabolario chiuso, field_type a vocabolario chiuso", () => {
  const it = load();
  assert.equal(validateFld({ ...it, mandatory: { ...it.mandatory, kind: "sometimes" } }).ok, false);
  assert.equal(validateFld({ ...it, mandatory: { ...it.mandatory, reason: { kind: "capriccio" } } }).ok, false);
  assert.equal(validateFld({ ...it, field_type: "dropdown" }).ok, false);
  assert.equal(validateFld({ ...it, mandatory: "obbligatorio in approvazione" }).ok, false);   // testo libero ≠ regola
  const noKind = { ...it, mandatory: { in_states: ["APPROVED"] } };
  assert.ok(validateFld(noKind).errors.some((e) => /kind/.test(e)));
  // validateItem applica le stesse regole agli item di tipo FLD (hook minimo in validate-schema)
  assert.equal(validateItem({ ...it, field_type: "dropdown" }).ok, false);
});

test("kind: conditional richiede when, in_states o by_role", () => {
  const it = load();
  const bare = { ...it, mandatory: { kind: "conditional", reason: it.mandatory.reason } };
  const r = validateFld(bare);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /conditional/.test(e) && /when|in_states|by_role/.test(e)), r.errors.join("\n"));
  assert.equal(validateItem(bare).ok, false);
  assert.equal(validateFld({ ...bare, mandatory: { ...bare.mandatory, by_role: ["APPROVER"] } }).ok, true);
  assert.equal(validateFld({ ...bare, mandatory: { ...bare.mandatory, when: "document.amount > 5000" } }).ok, true);
  assert.equal(validateFld({ ...bare, mandatory: { ...bare.mandatory, in_states: [] } }).ok, false);   // lista vuota = nessuna condizione
});

test("system_of_record obbligatorio quando il campo compare in un mapping INT (lineage.required_by[].ref di tipo INT)", () => {
  const it = load();
  const { system_of_record, ...rest } = it.identity;
  const r = validateFld({ ...it, identity: rest });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /system_of_record/.test(e) && /S\.STD\.XSC\.INT\.0001/.test(e)), r.errors.join("\n"));
  assert.equal(validateFld({ ...it, identity: { ...rest, system_of_record: null } }).ok, false);
  const noIdentity = { ...it };
  delete noIdentity.identity; delete noIdentity.identity_quality;
  assert.equal(validateFld(noIdentity).ok, false);
  // senza mapping INT la carta d'identità può mancare
  const noInt = { ...noIdentity, lineage: { ...it.lineage, required_by: [it.lineage.required_by[1]] }, mandatory: { ...it.mandatory, reason: { kind: "business" } } };
  assert.deepEqual(validateFld(noInt).errors, []);
});

test("identity: solo i dodici blocchi di §19.20; identity_quality con blocks_covered 0..12", () => {
  const it = load();
  assert.equal(validateFld({ ...it, identity: { ...it.identity, colore: {} } }).ok, false);
  assert.equal(validateFld({ ...it, identity_quality: { ...it.identity_quality, blocks_covered: 13 } }).ok, false);
  assert.equal(validateFld({ ...it, identity_quality: { ...it.identity_quality, shape: "boh" } }).ok, false);
});

test("summary di un FLD: ≤ 20 parole", () => {
  const it = load();
  assert.equal(validateFld({ ...it, summary: Array(21).fill("parola").join(" ") }).ok, false);
  assert.equal(validateFld({ ...it, summary: Array(20).fill("parola").join(" ") }).ok, true);
});

test("cluster[]: al più un CL-FLD di sezione e al più un CL-FLD-MAND (§19.6.3)", () => {
  const it = load();
  assert.equal(validateFld({ ...it, cluster: ["CL-FLD-003", "CL-FLD-004"] }).ok, false);
  assert.equal(validateFld({ ...it, cluster: ["CL-FLD-003", "CL-FLD-MAND-002", "CL-FLD-MAND-006"] }).ok, false);
  assert.equal(validateFld({ ...it, cluster: ["CL-FLD-003", "CL-FLD-MAND-006", "CL-FLD-CHAIN-012", "CL-FLD-CHAIN-001"] }).ok, true);
});

test("hasParsedMandatory: solo un oggetto con kind del vocabolario è una regola parsata", () => {
  assert.equal(hasParsedMandatory({ mandatory: { kind: "conditional", in_states: ["APPROVED"] } }), true);
  assert.equal(hasParsedMandatory({ mandatory: { in_states: ["APPROVED"] }, mandatory_text: "obbligatorio in approvazione" }), false);
  assert.equal(hasParsedMandatory({ mandatory: "obbligatorio" }), false);
  assert.equal(hasParsedMandatory({ mandatory_text: "dovrebbe essere obbligatorio salvo eccezioni" }), false);
  assert.equal(hasParsedMandatory({}), false);
});

test("CL-FLD-MAND: un FLD con testo di obbligatorietà ma senza kind parsato NON entra (criterio I-PARSED, rigettato)", () => {
  const c = cluster("CL-FLD-MAND-002");
  const parsed = { id: "C.ACME.P2P.FLD.0001", type: "FLD", mandatory: { kind: "conditional", in_states: ["PENDING_APPROVAL"] }, facets: { F4: "struttura-dati", F12: "validato" } };
  assert.equal(judgeAdmission(c, parsed).verdict, "ammesso");
  const unparsed = { id: "C.ACME.P2P.FLD.0002", type: "FLD", mandatory: { in_states: ["PENDING_APPROVAL"] }, mandatory_text: "obbligatorio in approvazione",
    facets: { F4: "struttura-dati", F12: "validato" } };
  const j = judgeAdmission(c, unparsed);
  assert.equal(j.verdict, "rigettato");
  assert.equal(j.rule, "inclusion:I-PARSED");
  // il criterio vale solo per la famiglia CL-FLD-MAND
  const sec = cluster("CL-FLD-003");
  assert.equal(judgeAdmission(sec, { ...unparsed, classification: { functional_section: "contabilita" } }).verdict, "ammesso");
});

function facets(over = {}) {
  return { F1: "doc-cliente-tecnica", F4: "struttura-dati", F5: "saas-core", F6: ["indirect"], F7: "sap-ecc", F8: "specifica", F9: "continua",
    F10: "R2", F11: "deterministico", F12: "validato", F13: { verified_at: "2026-09-01", release: "R25.2" }, F15: "tecnica", ...over };
}
function fld(id, over = {}) {
  return { id, type: "FLD", title: `Campo ${id}`, summary: "Campo di prova.", sources: [{ doc: "t" }], document: "document.requisition",
    label: { it: "Campo" }, section: "header", field_type: "text", facets: facets(), ...over };
}
function workspace(items) {
  const root = mkdtempSync(join(tmpdir(), "fld-"));
  const dir = join(root, "kb", "scopes", "P2P", "items");
  mkdirSync(dir, { recursive: true });
  for (const it of items) writeFileSync(join(dir, `${it.id}.yaml`), YAML.stringify(it));
  const dbPath = join(root, "knowledge.db");
  const stats = reindex(root, dbPath);
  return { root, db: openDb(dbPath), stats };
}

test("admit in CL-FLD-MAND-002: regola parsata ammessa, testo non parsato rifiutato con DEC (exit di policy)", () => {
  const { db, root, stats } = workspace([
    fld("C.ACME.P2P.FLD.0001", { mandatory: { kind: "conditional", in_states: ["PENDING_APPROVAL"] } }),
    fld("C.ACME.P2P.FLD.0002", { mandatory_text: "obbligatorio in approvazione" }),
  ]);
  assert.equal(stats.invalid, 0);
  assert.equal(admit(db, "CL-FLD-MAND-002", "C.ACME.P2P.FLD.0001", { root, now: NOW }).verdict, "ammesso");
  assert.throws(() => admit(db, "CL-FLD-MAND-002", "C.ACME.P2P.FLD.0002", { root, now: NOW }),
    (e) => e instanceof AdmissionError && e.verdict === "rigettato" && e.criterion === "I-PARSED" && !!e.dec_code);
});

test("admit: un FLD sta in esattamente un CL-FLD-MAND (secondo cluster della famiglia → rifiuto di policy)", () => {
  const { db, root } = workspace([
    fld("C.ACME.P2P.FLD.0003", { mandatory: { kind: "always" }, classification: { mandatory_condition: "importo" } }),
  ]);
  assert.equal(admit(db, "CL-FLD-MAND-001", "C.ACME.P2P.FLD.0003", { root, now: NOW }).verdict, "ammesso");
  assert.throws(() => admit(db, "CL-FLD-MAND-003", "C.ACME.P2P.FLD.0003", { root, now: NOW }),
    (e) => e instanceof PolicyError && /CL-FLD-MAND-001/.test(e.message));
});
