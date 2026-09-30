// WP09d — D. Dominio analitico (§1.1, F8): importazione dei ticket con pseudonimizzazione (golden), clustering per firma
// del sintomo, catena causale a 4 livelli, PAT/PBK/BRF per scope e livello, schemi pat/pbk/brf/rul, confine dei domini
// (validate-boundary rifiuta un PAT che cita un test NRT.*).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { parseCsv, importRows, mapColumns } from "../../scripts/analysis/ticket-import.mjs";
import { clusterTickets, signature, normalizeMessage } from "../../scripts/analysis/cluster.mjs";
import { chain } from "../../scripts/analysis/chain.mjs";
import { writeAnalysisItem, facetsFor, AnalysisError } from "../../scripts/analysis/common.mjs";
import { checkBoundary } from "../../scripts/kb/validate-boundary.mjs";
import { validateItem } from "../../scripts/kb/validate-schema.mjs";
import { ws09d, cli, SALT } from "../helpers/wp09d.mjs";

const GOLDEN = fileURLToPath(new URL("../golden/wp09d/", import.meta.url));
const csv = () => readFileSync(join(GOLDEN, "tickets.csv"), "utf8");
const LEARN = "scripts/digest/learn.mjs";

test("pseudonimizzazione golden: stesso sale ⇒ stesso output; nessuna persona, email, numero di documento, nome del cliente né test", () => {
  const r = importRows(parseCsv(csv()), { salt: SALT, customer: "ACME", customerNames: ["Acme Industrie SpA"] });
  assert.deepEqual(r, JSON.parse(readFileSync(join(GOLDEN, "tickets.golden.json"), "utf8")));
  const text = JSON.stringify(r.tickets);
  for (const leak of ["Mario Rossi", "Anna Bianchi", "Luca Verdi", "Paolo Neri", "mario.rossi@acme.it", "4500012345", "Acme Industrie", "INC-1001", "NRT.ACME"]) assert.ok(!text.includes(leak), leak);
  assert.equal(r.tickets[0].reporter, r.tickets[2].reporter, "stessa persona ⇒ stesso token");
  const other = importRows(parseCsv(csv()), { salt: `${SALT}-x`, customer: "ACME" });
  assert.notEqual(other.tickets[0].reporter, r.tickets[0].reporter, "sale diverso ⇒ token diversi");
  assert.deepEqual(Object.keys(mapColumns(["Numero", "Oggetto", "Causa radice", "Assegnatario"])).sort(), ["assignee", "id", "root_cause", "summary"]);
});

test("firma del sintomo e cluster: numeri e token non separano i ticket; catena causale a 4 livelli con quote", () => {
  const { tickets } = importRows(parseCsv(csv()), { salt: SALT, customer: "ACME" });
  assert.equal(signature(tickets[0]).hash, signature(tickets[1]).hash, "RdA con numeri diversi ⇒ stessa firma");
  assert.notEqual(signature(tickets[0]).hash, signature(tickets[3]).hash);
  assert.equal(normalizeMessage("Errore 500 alle 10:30 del 2026-09-01 su 'Ordine X'"), "errore # alle # # del # su …");
  const groups = clusterTickets(tickets);
  assert.deepEqual(groups.map((g) => g.count), [3, 2], "singoli esclusi (min 2)");
  const c = groups[0].chain;
  assert.equal(c.symptom.value, "Errore al salvataggio della RdA DOCN-1281349d6e".replace(/DOCN-\w+/, (m) => m));
  assert.deepEqual([c.immediate_cause.value, c.immediate_cause.share, c.immediate_cause.missing], ["Centro di costo di altra società", 0.67, 1]);
  assert.deepEqual([c.root_cause.value, c.root_cause.share], ["Lookup CdC non filtrato per società", 1]);
  assert.equal(c.resolution.share, 0.67); assert.equal(c.confidence, 0.33);
  assert.deepEqual(chain([{ summary: "x" }]).root_cause, { value: null, share: 0, missing: 1 });
});

test("learn tickets → patterns → brief: PAT e PBK con codice dal DB in customers/<C>/analysis, BRF per scope e livello C; schemi validi", () => {
  const ws = ws09d();
  const f = join(ws, "tickets.csv"); writeFileSync(f, csv());
  assert.equal(cli(LEARN, ["tickets", f, "--customer", "ACME", "--json"], { ws }).status, 3, "senza sale niente importazione");
  const t = cli(LEARN, ["tickets", f, "--customer", "ACME", "--write", "--json"], { ws, env: { JVC_PSEUDO_SALT: SALT } });
  assert.equal(t.status, 0, t.stdout + t.stderr); assert.equal(t.json.count, 6);
  const p = cli(LEARN, ["patterns", "--customer", "ACME", "--write", "--json"], { ws });
  assert.equal(p.status, 0, p.stdout + p.stderr);
  assert.deepEqual(p.json.written.map((w) => [w.pattern, w.playbook]), [["C.ACME.P2P.PAT.0001", "C.ACME.P2P.PBK.0001"], ["C.ACME.P2P.PAT.0002", "C.ACME.P2P.PBK.0002"]]);
  const pat = YAML.parse(readFileSync(join(ws, "customers/ACME/analysis/patterns/C.ACME.P2P.PAT.0001.yaml"), "utf8"));
  assert.equal(pat.occurrences, 3); assert.equal(validateItem(pat).ok, true, validateItem(pat).errors.join("; "));
  const pbk = YAML.parse(readFileSync(join(ws, "customers/ACME/analysis/playbooks/C.ACME.P2P.PBK.0001.yaml"), "utf8"));
  assert.equal(pbk.pattern, "C.ACME.P2P.PAT.0001"); assert.equal(pbk.steps.length, 4);
  const b = cli(LEARN, ["brief", "--customer", "ACME", "--scope", "P2P", "--json"], { ws });
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.equal(b.json.code, "C.ACME.P2P.BRF.0001");
  assert.equal(b.json.brief.top_patterns[0].pattern, "C.ACME.P2P.PAT.0001"); assert.equal(b.json.brief.tickets_total, 5);
  assert.match(b.json.brief.text, /Causa radice: Lookup CdC non filtrato per società/);
  assert.equal(validateItem(b.json.brief).ok, true);
  assert.deepEqual(checkBoundary(join(ws, "customers", "ACME")), [], "nessuna violazione del confine");
  const again = cli(LEARN, ["patterns", "--customer", "ACME", "--write", "--json"], { ws });
  assert.equal(again.json.written[0].pattern, "C.ACME.P2P.PAT.0003", "SEQ dal DB, mai riusato");
});

test("confine: validate-boundary rifiuta un PAT che cita un test NRT; lo scrittore del dominio analitico lo rifiuta prima di scrivere", () => {
  const r = mkdtempSync(join(tmpdir(), "bnd-"));
  mkdirSync(join(r, "analysis/patterns"), { recursive: true });
  writeFileSync(join(r, "analysis/patterns/C.ACME.P2P.PAT.0009.yaml"), YAML.stringify({ id: "C.ACME.P2P.PAT.0009", type: "PAT", prevention_test: "NRT.ACME.P2P.NEG.0036" }));
  const v = checkBoundary(r);
  assert.equal(v.length, 1); assert.equal(v[0].rule, "analysis referenzia un test");
  const res = cli("scripts/kb/validate-boundary.mjs", [r, "--json"], {});
  assert.equal(res.status, 3);
  const ws = ws09d();
  assert.throws(() => writeAnalysisItem(ws, { customer: "ACME", scope: "P2P", type: "PAT" }, (code) => ({
    id: code, type: "PAT", title: "Pattern con test", summary: "x.", facets: facetsFor("PAT"), sources: [{ note: "NRT.ACME.P2P.NEG.0036" }],
    signature: { hash: "0123456789ab" }, symptom: "sintomo", occurrences: 2,
    chain: { symptom: { value: "s" }, immediate_cause: { value: null }, root_cause: { value: null }, resolution: { value: null } },
  })), (e) => e instanceof AnalysisError && e.code === 3);
  assert.equal(existsSync(join(ws, "customers/ACME/analysis/patterns")), false, "nulla scritto");
});

test("schemi del dominio analitico: RUL con condizione verificabile, BRF con livello e testo, PBK con pattern", () => {
  const base = (id, type, extra) => ({ id, type, title: `Item ${type}`, summary: "x.", facets: facetsFor(type), sources: [{ note: "t" }], ...extra });
  assert.equal(validateItem(base("C.ACME.ADM.RUL.0001", "RUL", { rule: { applies_to: { area: "CL-CFG-020" }, assert: { path: "strict_import", op: "eq", value: true }, severity: "high" } })).ok, true);
  assert.equal(validateItem(base("C.ACME.ADM.RUL.0001", "RUL", { rule: { applies_to: {}, assert: { path: "x", op: "boh" }, severity: "high" } })).ok, false);
  assert.equal(validateItem(base("S.STD.P2P.BRF.0001", "BRF", { scope_ref: "P2P", level: "S", top_patterns: [], text: "Nessun pattern per lo scope." })).ok, true);
  assert.equal(validateItem(base("C.ACME.P2P.PBK.0001", "PBK", { pattern: "C.ACME.P2P.FLW.0001", steps: [{ n: 1, action: "fare" }] })).ok, false, "pattern deve essere un PAT");
});
