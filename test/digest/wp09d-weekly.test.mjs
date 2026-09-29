// WP09d — B. Digestione settimanale (§22, §45.6, §6.3): raccolta in sola lettura, pseudonimizzazione stabile e
// irreversibile senza sale, allineamento, portabilità (DT-006) e CTR di prodotto, candidati S (DT-010) in attesa di
// approvazione (mai promossi dal digest), item contraddetti mai candidati, calibrazione solo con ≥ 10 DEC, decadimenti,
// competence report, lock e reindex.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync } from "node:fs";
import YAML from "yaml";
import { openDb } from "../../scripts/kb/db.mjs";
import { reindex } from "../../scripts/kb/reindex.mjs";
import { makeToken, pseudonymizer, saltFrom, PseudonymError } from "../../scripts/digest/pseudonymize.mjs";
import { align, claimOf } from "../../scripts/digest/align.mjs";
import { portability } from "../../scripts/digest/portability.mjs";
import { collect, isoWeek } from "../../scripts/digest/collect.mjs";
import { decayCustomer } from "../../scripts/digest/decay.mjs";
import { flw, writeItem, FACETS } from "../helpers/wp09b-items.mjs";
import { evaluate, loadTable, writeDecision, TABLES_DIR } from "../../scripts/decide/dt-eval.mjs";
import { ws09d, cli, SALT } from "../helpers/wp09d.mjs";

const LEARN = "scripts/digest/learn.mjs";
const DATE = "2026-09-29";
const L = (c, n, parent, claim, facets = {}) => flw(`L.${c}.CAT.FLW.${String(n).padStart(4, "0")}`, { deviates_from: parent, claim, facets: { ...FACETS, F12: "clusterizzato", ...facets } });

function digestWs() {
  const ws = ws09d();
  for (const c of ["ACME", "BETA", "GAMA"]) mkdirSync(join(ws, "customers", c, "kb"), { recursive: true });
  // U: universale (3 clienti, stessa affermazione)
  for (const [c, n] of [["ACME", 1], ["BETA", 1], ["GAMA", 1]]) writeItem(ws, L(c, n, "S.STD.CAT.FLW.0100", "unicità bloccante"));
  // C: condizionata da F7 (ACME e BETA su SAP dicono A, GAMA su Oracle dice B)
  writeItem(ws, L("ACME", 2, "S.STD.CAT.FLW.0200", "A", { F7: "sap-s4" }));
  writeItem(ws, L("BETA", 2, "S.STD.CAT.FLW.0200", "A", { F7: "sap-s4" }));
  writeItem(ws, L("GAMA", 2, "S.STD.CAT.FLW.0200", "B", { F7: "oracle" }));
  // X: divergente senza faccetta che spieghi (specifica)
  writeItem(ws, L("ACME", 3, "S.STD.CAT.FLW.0300", "A"));
  writeItem(ws, L("BETA", 3, "S.STD.CAT.FLW.0300", "B"));
  // K: stessa affermazione, ma l'item di ACME ha un CTR aperto
  writeItem(ws, L("ACME", 4, "S.STD.CAT.FLW.0400", "Z"));
  writeItem(ws, L("BETA", 4, "S.STD.CAT.FLW.0400", "Z"));
  for (const c of ["ACME", "BETA", "GAMA"]) reindex(join(ws, "customers", c), join(ws, "customers", c, "knowledge.db"));
  const db = openDb(join(ws, "customers", "ACME", "knowledge.db"));
  db.prepare("insert into contradictions(code,a_code,b_code,facet,resolution,status) values ('L.ACME.CAT.CTR.0001','L.ACME.CAT.FLW.0004','S.STD.CAT.FLW.0400','F12',null,'aperto')").run();
  const dec = db.prepare("insert into decisions(code,table_code,outcome,strategy,at) values (?,?,?,?,?)");
  const out = db.prepare("insert into outcomes(decision_code,result) values (?,?)");
  for (let i = 1; i <= 9; i++) { const c = `L.ACME.CAT.DEC.${String(i).padStart(4, "0")}`; dec.run(c, "DT-002", "decidi", i % 2 ? "STR-REPLAY" : "STR-VERIFY-FIRST", "2026-09-28T10:00:00Z"); out.run(c, i === 3 ? "smentita" : "confermata"); }
  db.prepare("insert into meta(key,value) values ('releases', ?) on conflict(key) do update set value=excluded.value").run(JSON.stringify(["R25.2", "R25.3", "R25.4", "R26.1"]));
  db.prepare("insert into epistemic(subject_code, shape) values ('C.ACME.CAT.CFG.0001','ignoto'),('C.ACME.CAT.CFG.0002','consolidato')").run();
  db.close();
  mkdirSync(join(ws, "customers", "ACME", "profile"), { recursive: true });
  writeFileSync(join(ws, "customers", "ACME", "profile", "profile.yaml"), YAML.stringify({ name: "Acme Industrie SpA" }));
  return ws;
}

test("pseudonimizzazione: token stabili, salati, irreversibili senza sale; il sale viene solo da JVC_PSEUDO_SALT", () => {
  const a = makeToken(SALT, "person", "Mario Rossi");
  assert.equal(a, makeToken(SALT, "person", "  mario   rossi "), "stabile rispetto a maiuscole e spazi");
  assert.match(a, /^PERS-[0-9a-f]{10}$/);
  assert.notEqual(a, makeToken(`${SALT}-altro`, "person", "Mario Rossi"), "sale diverso ⇒ token diverso");
  assert.notEqual(makeToken(SALT, "customer", "ACME"), makeToken(SALT, "supplier", "ACME"), "il tipo entra nel token");
  assert.throws(() => saltFrom({}), PseudonymError);
  assert.throws(() => saltFrom({ JVC_PSEUDO_SALT: "corto" }), PseudonymError);
  assert.equal(saltFrom({ JVC_PSEUDO_SALT: SALT }), SALT);
  const ps = pseudonymizer({ salt: SALT, customers: ["ACME"], customerNames: ["Acme Industrie SpA"], people: ["Mario Rossi"], suppliers: ["Fornitore Beta Srl"] });
  const out = ps.text("ACME: ordine PO-4500012345 di Acme Industrie SpA, Mario Rossi (mario.rossi@acme.it) con Fornitore Beta Srl; vedi C.ACME.CAT.FLW.0001 e S.STD.CAT.FLW.0002 del 2026-09-01");
  for (const leak of ["ACME", "4500012345", "Acme Industrie", "Mario Rossi", "mario.rossi@acme.it", "Fornitore Beta", "C.ACME.CAT.FLW.0001"]) assert.ok(!out.includes(leak), leak);
  assert.ok(out.includes("S.STD.CAT.FLW.0002") && out.includes("2026-09-01"), "codici S e date restano");
  assert.equal(out, pseudonymizer({ salt: SALT, customers: ["ACME"], customerNames: ["Acme Industrie SpA"], people: ["Mario Rossi"], suppliers: ["Fornitore Beta Srl"] }).text(out.length ? "ACME: ordine PO-4500012345 di Acme Industrie SpA, Mario Rossi (mario.rossi@acme.it) con Fornitore Beta Srl; vedi C.ACME.CAT.FLW.0001 e S.STD.CAT.FLW.0002 del 2026-09-01" : ""), "golden stabile");
});

test("align + portability: universale, condizionata (F7 spiega la partizione, P nella partizione), specifica con CTR di prodotto", () => {
  const ws = digestWs();
  const data = collect(ws, {});
  const items = Object.values(data.customers).flatMap((d) => d.items);
  assert.equal(items.length, 10, "solo item L clusterizzati");
  const groups = align(items);
  const by = Object.fromEntries(groups.map((g) => [g.key, g]));
  const u = portability(by["S:S.STD.CAT.FLW.0100"]);
  assert.equal(u.class, "universale"); assert.equal(u.p, 1); assert.equal(u.cluster_proposal, "CL-PRT-001");
  const c = portability(by["S:S.STD.CAT.FLW.0200"]);
  assert.equal(c.class, "condizionata"); assert.equal(c.facet.facet, "F7");
  assert.deepEqual(c.condition, { facet: "F7", value: "sap-s4", customers: ["ACME", "BETA"], p: 1 });
  assert.equal(c.ctr_proposal.cluster, "CL-PRT-002");
  const x = portability(by["S:S.STD.CAT.FLW.0300"]);
  assert.equal(x.class, "specifica"); assert.equal(x.p, -0.5); assert.equal(x.ctr_proposal.cluster, "CL-PRT-005");
  assert.notEqual(claimOf({ claim: "A" }), claimOf({ claim: "B" }));
});

test("digest-weekly: candidati S in attesa (mai promossi), item contraddetto escluso, product/ pseudonimizzato, calibrazione solo con ≥ 10 DEC, report §22.1, reindex", () => {
  const ws = digestWs();
  const r = cli(LEARN, ["digest-weekly", "--date", DATE, "--json"], { ws, env: { JVC_PSEUDO_SALT: SALT } });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const week = isoWeek(new Date(`${DATE}T12:00:00Z`)).id;
  assert.equal(r.json.week, week);
  assert.equal(r.json.candidates.length, 2, "universale + condizionata");
  assert.deepEqual(r.json.candidates.map((c) => c.class).sort(), ["condizionata", "universale"]);
  // promozione senza approvazione impossibile: il digest non crea nessun S
  assert.equal(existsSync(join(ws, "product", "kb", "scopes")), false, "nessun item S scritto dal digest");
  const pdir = join(ws, "product", "digest", week);
  const rep = JSON.parse(readFileSync(join(pdir, "report.json"), "utf8"));
  assert.ok(rep.excluded.some((e) => /contraddetti/.test(e.reason)), "item con CTR aperto mai candidato");
  assert.equal(rep.contradictions.length, 3, "gruppi divergenti (anche per un CTR aperto) ⇒ CTR di prodotto");
  assert.deepEqual(rep.contradictions.map((c) => c.cluster).sort(), ["CL-PRT-002", "CL-PRT-005", "CL-PRT-005"]);
  assert.equal(rep.decisions.calibration.length, 0, "9 DEC: nessuna proposta di calibrazione");
  assert.equal(rep.decisions.n, 9); assert.equal(rep.decisions.disproved_pct, 11);
  const all = [readFileSync(join(pdir, "competence-report.md"), "utf8"), readFileSync(join(pdir, "report.json"), "utf8"),
    ...readdirSync(join(pdir, "candidates")).map((f) => readFileSync(join(pdir, "candidates", f), "utf8"))].join("\n");
  for (const leak of ["ACME", "BETA", "GAMA", "Acme Industrie", "L.ACME", "L.BETA"]) assert.ok(!all.includes(leak), `valore del cliente in product/: ${leak}`);
  const text = readFileSync(join(pdir, "competence-report.md"), "utf8");
  for (const h of ["COMPETENCE REPORT — settimana 40/2026", "PROMOZIONI A S (in attesa)", "CONTRADDIZIONI FRA CLIENTI", "NUOVI CLUSTER", "DECADIMENTI",
    "COPERTURA EPISTEMICA", "DECISIONI", "DEC con esito verificato", "strategie: STR-REPLAY", "sorprese per compito", "CHECK IN MEMORIA", "ECONOMIA"]) assert.ok(text.includes(h), h);
  assert.match(text, /servono ≥ 10 DEC/);
  const mine = YAML.parse(readFileSync(join(ws, "customers", "ACME", "digest", week, "candidates.yaml"), "utf8"));
  assert.ok(mine.candidates.some((c) => c.items.includes("L.ACME.CAT.FLW.0001")), "la corrispondenza reale resta nel cliente");
  assert.equal(existsSync(join(ws, "product", "knowledge.lock")), false, "lock rilasciato");
});

test("digest-weekly: senza JVC_PSEUDO_SALT ⇒ exit 3; lock attivo ⇒ exit 3", () => {
  const ws = digestWs();
  assert.equal(cli(LEARN, ["digest-weekly", "--json"], { ws }).status, 3);
  writeFileSync(join(ws, "product", "knowledge.lock"), JSON.stringify({ pid: 1, expires: Date.now() + 600000 }));
  const r = cli(LEARN, ["digest-weekly", "--json"], { ws, env: { JVC_PSEUDO_SALT: SALT } });
  assert.equal(r.status, 3); assert.match(r.json.error, /lock attivo/);
});

test("digest-weekly: con ≥ 10 DEC verificate la calibrazione PROPONE (nella cartella del cliente, codici pseudonimizzati nel report), la tabella non cambia", () => {
  const ws = digestWs();
  const root = join(ws, "customers", "ACME");
  const db = openDb(join(root, "knowledge.db"));
  db.exec("delete from outcomes; delete from decisions;");
  const t = loadTable("DT-002");
  const add = (inputs, priors, result) => {
    const r = evaluate(t, inputs, { priors });
    const code = writeDecision(db, { customer: "ACME", scope: "ADM", root, result: r, agent: "adm-expert", at: "2026-09-28T10:00:00Z", context: { confidence: 0.9, effects: true } });
    db.prepare("insert into outcomes(decision_code,result) values (?,?)").run(code, result);
  };
  const base = { mandatory_missing: false, open_contradiction: false, novelty: true };
  for (let i = 0; i < 4; i++) add({ ...base, risk: "R2", shape: "libresco" }, { disproved_procedi: 0.3 }, "smentita");
  for (let i = 0; i < 6; i++) add({ ...base, risk: "R1", shape: "libresco" }, {}, "confermata");
  for (let i = 0; i < 2; i++) add({ ...base, risk: "R2", shape: "ignoto" }, {}, "confermata");
  db.close();
  const tableFile = join(TABLES_DIR, "DT-002.yaml");
  const before = readFileSync(tableFile, "utf8");
  const r = cli(LEARN, ["digest-weekly", "--date", DATE, "--json"], { ws, env: { JVC_PSEUDO_SALT: SALT } });
  assert.equal(r.status, 0, r.stdout);
  assert.equal(r.json.calibration, 1, "una proposta con 12 DEC verificate");
  assert.equal(readFileSync(tableFile, "utf8"), before, "mai una tabella sovrascritta");
  const week = r.json.week;
  const files = readdirSync(join(root, "digest", week, "calibration"));
  assert.deepEqual(files, ["DT-002.v2.proposal.yaml"], "la proposta resta nella cartella del cliente");
  const rep = readFileSync(join(ws, "product", "digest", week, "report.json"), "utf8");
  assert.ok(!rep.includes("L.ACME"), "i DEC a supporto sono pseudonimizzati nel report di prodotto");
  assert.match(readFileSync(join(ws, "product", "digest", week, "competence-report.md"), "utf8"), /proposta di calibrazione: DT-002 bordo 0.5 → 0.47/);
});

test("decadimento: item non verificato da 3 release, cluster vuoto da 2 digestioni", () => {
  const d = decayCustomer({ releases: ["R1", "R2", "R3", "R4"], all_items: [{ code: "a", release_ref: "R1" }, { code: "b", release_ref: "R2" }, { code: "c", release_ref: "RX" }],
    cluster_decay: [{ code: "CL-CFG-020", empty_digests: 2 }] });
  assert.deepEqual(d.items.map((x) => x.code), ["a"]);
  assert.deepEqual(d.clusters, [{ code: "CL-CFG-020", empty_digests: 2 }]);
  assert.equal(d.unknown_release, 1);
});
