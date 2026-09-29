// WP09d — A. Comandi kb rimanenti (§8.4, §56.3, §49.3, §49.4): related, facet-count, graph, scopes, handoffs,
// clusters, contradictions, outcomes, promote (L→C e C/L→S con approvazione umana), deprecate, migrate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import Database from "better-sqlite3";
import YAML from "yaml";
import { openDb } from "../../scripts/kb/db.mjs";
import { reindex } from "../../scripts/kb/reindex.mjs";
import { related, facetCount, graph, scopes, handoffs, validateHandoffs, clusters, contradictions } from "../../scripts/kb/registries.mjs";
import { InvalidFacetError } from "../../scripts/kb/find.mjs";
import { migrate, migrationFiles } from "../../scripts/kb/migrate.mjs";
import { flw, hnd, sel, writeItem, FACETS } from "../helpers/wp09b-items.mjs";
import { ws09d, withSession, say, cli, SALT } from "../helpers/wp09d.mjs";
import { readApprovals, approvalsFile } from "../../scripts/admin/approvals.mjs";

const KB = "scripts/kb/kb.mjs";
const custDb = (ws) => join(ws, "customers", "ACME", "knowledge.db");

function seedGraph() {
  const ws = ws09d();
  writeItem(ws, flw("C.ACME.CAT.FLW.0001", { invariants: ["vedi `C.ACME.CAT.KEY.0009` (inesistente)", "consegna a C.ACME.P2P.FLW.0002"] }));
  writeItem(ws, flw("C.ACME.P2P.FLW.0002"));
  writeItem(ws, sel("C.ACME.P2P.SEL.0001")); writeItem(ws, sel("C.ACME.P2P.SEL.0002", { label: "Invia" }));
  writeItem(ws, flw("C.ACME.CAT.FLW.0003", { facets: { ...FACETS, F6: ["indirect", "catalogo-centrico"], F10: "R2" } }));
  reindex(join(ws, "customers", "ACME"), custDb(ws));
  return ws;
}

test("related: relazioni in entrambe le direzioni, filtro per kind, ordinate per W", () => {
  const ws = seedGraph();
  const db = openDb(custDb(ws));
  db.prepare("insert into relations(from_code,to_code,kind) values (?,?,?),(?,?,?),(?,?,?)").run(
    "C.ACME.CAT.FLW.0001", "C.ACME.P2P.FLW.0002", "consegna", "C.ACME.CAT.FLW.0003", "C.ACME.CAT.FLW.0001", "precede", "C.ACME.CAT.FLW.0001", "C.ACME.CAT.KEY.0009", "usa");
  const r = related(db, "C.ACME.CAT.FLW.0001");
  assert.equal(r.items.length, 3);
  assert.deepEqual(r.items.find((x) => x.code === "C.ACME.CAT.FLW.0003"), { ...r.items.find((x) => x.code === "C.ACME.CAT.FLW.0003"), direction: "in", kind: "precede", exists: true });
  assert.equal(r.items.find((x) => x.code === "C.ACME.CAT.KEY.0009").exists, false);
  assert.deepEqual(related(db, "C.ACME.CAT.FLW.0001", { kind: "consegna" }).items.map((x) => x.code), ["C.ACME.P2P.FLW.0002"]);
  db.close();
  const c = cli(KB, ["related", "C.ACME.CAT.FLW.0001", "--kind", "usa", "--db", custDb(ws), "--json"], { ws });
  assert.equal(c.status, 0, c.stdout + c.stderr);
  assert.deepEqual(c.json.items.map((x) => x.code), ["C.ACME.CAT.KEY.0009"]);
  assert.equal(cli(KB, ["related", "--db", custDb(ws), "--json"], { ws }).status, 1);
});

test("facet-count: conteggi per valore (F6 elenco, scalari), faccetta fuori allowlist ⇒ errore utente", () => {
  const ws = seedGraph();
  const db = openDb(custDb(ws));
  const f10 = facetCount(db, { facet: "F10" });
  assert.equal(f10.total, 5);
  assert.deepEqual(f10.items, [{ value: "R1", n: 4 }, { value: "R2", n: 1 }]);
  const f6 = facetCount(db, { facet: "F6", scope: "CAT" });
  assert.deepEqual(f6.items, [{ value: "catalogo-centrico", n: 1 }, { value: "indirect", n: 1 }]);
  assert.deepEqual(facetCount(db, { facet: "F13" }).items, [{ value: "R25.2", n: 5 }]);
  assert.throws(() => facetCount(db, { facet: "F10') or ('1'='1" }), InvalidFacetError);
  db.close();
  assert.equal(cli(KB, ["facet-count", "--facet", "F99", "--db", custDb(ws), "--json"], { ws }).status, 1);
  const c = cli(KB, ["facet-count", "--facet", "F12", "--scope", "CAT", "--db", custDb(ws), "--json"], { ws });
  assert.equal(c.status, 0);
  assert.deepEqual(c.json.items, [{ value: "validato", n: 2 }]);
});

test("graph: riferimento pendente (anche fra backtick) e handoff mancante per un riferimento fra scope; l'HND lo chiude", () => {
  const ws = seedGraph();
  const db = openDb(custDb(ws));
  const g = graph(db, { root: join(ws, "customers", "ACME") });
  assert.equal(g.ok, false);
  assert.deepEqual(g.dangling, [{ from: "C.ACME.CAT.FLW.0001", to: "C.ACME.CAT.KEY.0009" }]);
  assert.deepEqual(g.missing_handoffs.map((m) => [m.from_scope, m.to_scope]), [["CAT", "P2P"]]);
  assert.ok(g.missing_handoffs[0].examples.some((e) => e.to === "C.ACME.P2P.FLW.0002"));
  db.close();
  let c = cli(KB, ["graph", "--db", custDb(ws), "--root", join(ws, "customers", "ACME"), "--json"], { ws });
  assert.equal(c.status, 3, "incoerente ⇒ exit 3");
  writeItem(ws, hnd("C.ACME.CAT.HND.0001", { from_scope: "CAT", to_scope: "P2P", owner_of_test: "CAT", reciprocal_test: "NRT.ACME.P2P.HND.0001" }));
  writeItem(ws, flw("C.ACME.CAT.FLW.0001"));   // riferimento pendente tolto
  reindex(join(ws, "customers", "ACME"), custDb(ws));
  c = cli(KB, ["graph", "--db", custDb(ws), "--root", join(ws, "customers", "ACME"), "--json"], { ws });
  assert.equal(c.status, 0, c.stdout);
  assert.deepEqual(c.json.missing_handoffs, []);
});

test("scopes: registro (10) + estensione kb/scopes.yaml (§49.3), estensione fuori registro segnalata", () => {
  const ws = seedGraph();
  writeFileSync(join(ws, "product", "kb", "scopes.yaml"), YAML.stringify({ scopes: [{ id: "LOG", name: "Logistica", neighbours: ["P2P"] }, { id: "CAT", name: "Cataloghi elettronici" }, { id: "bad" }] }));
  const db = openDb(custDb(ws));
  const r = scopes(db, { roots: [join(ws, "product")] });
  assert.equal(r.items.length, 11);
  assert.equal(r.items.find((s) => s.id === "CAT").name, "Cataloghi elettronici");
  assert.equal(r.items.find((s) => s.id === "CAT").items, 2);
  const log = r.items.find((s) => s.id === "LOG");
  assert.equal(log.source, "extension"); assert.equal(log.in_registry, false);
  assert.equal(r.errors.length, 1);
  db.close();
});

test("handoffs --validate: ogni HND ha i due lati, il proprietario su un lato, il confine e il test reciproco", () => {
  const ws = ws09d();
  writeItem(ws, hnd("C.ACME.CAT.HND.0001", { from_scope: "CAT", to_scope: "P2P", owner_of_test: "CAT", reciprocal_test: "NRT.ACME.P2P.HND.0001" }));
  writeItem(ws, hnd("C.ACME.P2P.HND.0002", { reciprocal_test: null }));
  reindex(join(ws, "customers", "ACME"), custDb(ws));
  const db = openDb(custDb(ws));
  const list = handoffs(db, { root: join(ws, "customers", "ACME") });
  assert.equal(list.items.length, 2);
  const v = validateHandoffs(list.items);
  assert.equal(v.ok, false);
  assert.deepEqual(v.problems.map((p) => p.code), ["C.ACME.P2P.HND.0002"]);
  assert.match(v.problems[0].problems.join(" "), /test reciproco/);
  db.close();
  assert.equal(cli(KB, ["handoffs", "--validate", "--db", custDb(ws), "--root", join(ws, "customers", "ACME"), "--json"], { ws }).status, 3);
  assert.equal(cli(KB, ["handoffs", "--scope", "CAT", "--db", custDb(ws), "--root", join(ws, "customers", "ACME"), "--json"], { ws }).status, 0);
});

test("clusters e contradictions [--open]: registri dal DB", () => {
  const ws = seedGraph();
  const db = openDb(custDb(ws));
  db.prepare("insert into cluster_members(cluster_code,item_code) values ('CL-CFG-020','C.ACME.CAT.FLW.0001')").run();
  db.prepare("insert into contradictions(code,a_code,b_code,facet,resolution,status) values ('L.ACME.CAT.CTR.0001','a','b','F7',null,'aperto'),('L.ACME.CAT.CTR.0002','a','c','F6','vince-L','risolto')").run();
  const cl = clusters(db, { family: "CL-CFG" });
  assert.ok(cl.items.length >= 20, "i cluster del plugin sono caricati da reindex");
  assert.equal(cl.items.find((c) => c.code === "CL-CFG-020").members, 1);
  assert.equal(contradictions(db).items.length, 2);
  assert.deepEqual(contradictions(db, { open: true }).items.map((x) => x.code), ["L.ACME.CAT.CTR.0001"]);
  db.close();
  const c = cli(KB, ["contradictions", "--open", "--db", custDb(ws), "--json"], { ws });
  assert.equal(c.status, 0); assert.equal(c.json.items.length, 1);
});

test("outcomes: tassi di esito per tabella e cliente (outcomes-rates)", () => {
  const ws = seedGraph();
  const db = openDb(custDb(ws));
  const dec = db.prepare("insert into decisions(code,table_code,outcome,at) values (?,?,?,?)");
  const out = db.prepare("insert into outcomes(decision_code,result) values (?,?)");
  ["confermata", "smentita", "confermata", "parziale"].forEach((r, i) => { const c = `L.ACME.CAT.DEC.000${i + 1}`; dec.run(c, "DT-001", "x", "2026-09-20"); out.run(c, r); });
  db.close();
  const c = cli(KB, ["outcomes", "--table", "DT-001", "--customer", "ACME", "--db", custDb(ws), "--json"], { ws });
  assert.equal(c.status, 0, c.stdout);
  assert.equal(c.json.n, 4); assert.equal(c.json.disproved, 1.5); assert.equal(c.json.sufficient, false);
});

// ---------------- promote / deprecate ----------------
function promoteWs() {
  const ws = ws09d();
  withSession(ws);
  mkdirSync(join(ws, "customers", "ACME", "profile"), { recursive: true });
  writeFileSync(join(ws, "customers", "ACME", "profile", "profile.yaml"), YAML.stringify({ name: "Acme Industrie SpA", people: [{ name: "Mario Rossi" }] }));
  const steps = [
    { n: 1, verb: "NAVIGATE", target: { url_pattern: "/requisition/new" }, expect: { page_sig: "requisition/new" } },
    { n: 2, verb: "SAVE", target: "S.STD.P2P.SEL.0002", creates: { entity: "requisition", kind: "create" }, expect: { toast: "Bozza salvata" } },
  ];
  writeItem(ws, flw("L.ACME.CAT.FLW.0001", { title: "Bozza RdA ACME approvata da Mario Rossi", invariants: ["ordine 4500012345 di Acme Industrie SpA", "scrivere a mario.rossi@acme.it"],
    steps, evidence: [{ at: 2, kind: "assertion" }], facets: { ...FACETS, F12: "clusterizzato" } }));
  writeItem(ws, flw("L.ACME.CAT.FLW.0003", { steps, evidence: [{ at: 2, kind: "assertion" }], invariants: ["come C.ACME.CAT.FLW.0005"] }));
  writeItem(ws, flw("L.ACME.CAT.FLW.0002", { facets: { ...FACETS, F12: "quarantena" } }));
  writeItem(ws, flw("C.ACME.CAT.FLW.0005", { summary: "Flusso ACME validato." }));
  reindex(join(ws, "customers", "ACME"), custDb(ws));
  return ws;
}
const item = (ws, rel) => YAML.parse(readFileSync(join(ws, rel), "utf8"));

test("promote L → C: codice dal DB, promoted_from; l'L diventa deprecato con superseded_by (mai cancellato); stato non ammesso ⇒ exit 3", () => {
  const ws = promoteWs();
  const r = cli(KB, ["promote", "L.ACME.CAT.FLW.0001", "--customer", "ACME", "--json"], { ws });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.code, "C.ACME.CAT.FLW.0006", "SEQ assegnato dal DB dopo C.ACME.CAT.FLW.0005");
  const c = item(ws, "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0006.yaml");
  assert.equal(c.promoted_from, "L.ACME.CAT.FLW.0001"); assert.equal(c.facets.F12, "promosso");
  const l = item(ws, "customers/ACME/kb/scopes/CAT/flows/L.ACME.CAT.FLW.0001.yaml");
  assert.equal(l.facets.F12, "deprecato"); assert.equal(l.superseded_by, "C.ACME.CAT.FLW.0006");
  const db = new Database(custDb(ws), { readonly: true });
  assert.equal(db.prepare("select status from items where code=?").get("C.ACME.CAT.FLW.0006").status, "promosso");
  assert.equal(db.prepare("select status from items where code=?").get("L.ACME.CAT.FLW.0001").status, "deprecato");
  db.close();
  const q = cli(KB, ["promote", "L.ACME.CAT.FLW.0002", "--customer", "ACME", "--json"], { ws });
  assert.equal(q.status, 3, "quarantena non si promuove");
  assert.equal(cli(KB, ["promote", "L.ACME.CAT.FLW.0002", "--json"], { ws }).status, 1, "senza --customer");
  assert.equal(cli(KB, ["promote", "L.ACME.CAT.FLW.0002", "--customer", "BETA", "--json"], { ws }).status, 3, "cliente diverso dalla sessione");
});

test("promote --to product: senza approvazione impossibile; token forgiato rifiutato; con la frase dell'utente ⇒ nuovo S pseudonimizzato, approvazione monouso", () => {
  const ws = promoteWs();
  const code = "L.ACME.CAT.FLW.0001";
  const env = { JVC_PSEUDO_SALT: SALT };
  let r = cli(KB, ["promote", code, "--customer", "ACME", "--to", "product", "--json"], { ws, env });
  assert.equal(r.status, 3, "senza --approval"); assert.match(r.json.error, /APPROVO PROMOZIONE/);
  r = cli(KB, ["promote", code, "--customer", "ACME", "--to", "product", "--approval", "0123456789abcdef", "--json"], { ws, env });
  assert.equal(r.status, 3, "token inesistente");
  const s = say(ws, `APPROVO PROMOZIONE ${code}`);
  assert.equal(s.last.kind, "promote"); assert.equal(s.last.target, code);
  const tok = s.last.hash.slice(0, 16);
  r = cli(KB, ["promote", code, "--customer", "ACME", "--to", "product", "--approval", tok, "--json"], { ws });
  assert.equal(r.status, 3, "senza JVC_PSEUDO_SALT niente promozione"); assert.match(r.json.error, /JVC_PSEUDO_SALT/);
  r = cli(KB, ["promote", code, "--customer", "ACME", "--to", "product", "--approval", tok, "--json"], { ws, env });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.equal(r.json.code, "S.STD.CAT.FLW.0001");
  const text = readFileSync(join(ws, "product/kb/scopes/CAT/flows/S.STD.CAT.FLW.0001.yaml"), "utf8");
  const s1 = YAML.parse(text);
  assert.equal(s1.promoted_from, code); assert.equal(s1.facets.F12, "promosso"); assert.equal(s1.facets.F1, "promozione-digest");
  for (const leak of ["Mario Rossi", "mario.rossi@acme.it", "4500012345", "Acme Industrie SpA", "Bozza RdA ACME"]) assert.ok(!text.includes(leak), `valore del cliente nel livello S: ${leak}`);
  assert.match(s1.title, /PERS-[0-9a-f]{10}/);
  assert.equal(item(ws, `customers/ACME/kb/scopes/CAT/flows/${code}.yaml`).promoted_to, "S.STD.CAT.FLW.0001");
  const recs = readApprovals(approvalsFile(ws, "ACME", "sess-1")).records;
  assert.ok(recs.some((x) => x.kind === "consume" && x.ref === s.last.hash && x.consumed_kind === "promote"), "approvazione consumata");
  r = cli(KB, ["promote", code, "--customer", "ACME", "--to", "product", "--approval", tok, "--json"], { ws, env });
  assert.equal(r.status, 3, "monouso"); assert.match(r.json.error, /già stata usata/);
});

test("promote --to product: un item che cita item del cliente non sale a S (exit 3)", () => {
  const ws = promoteWs();
  const s = say(ws, "APPROVO PROMOZIONE L.ACME.CAT.FLW.0003");
  const r = cli(KB, ["promote", "L.ACME.CAT.FLW.0003", "--customer", "ACME", "--to", "product", "--approval", s.last.hash, "--json"], { ws, env: { JVC_PSEUDO_SALT: SALT } });
  assert.equal(r.status, 3); assert.ok(r.json.error.includes("cita item del cliente (C.ACME.CAT.FLW.0005)"), r.json.error);
});

test("promote --to product: un'approvazione di un altro item o un record non di promozione non vale", () => {
  const ws = promoteWs();
  const s = say(ws, "APPROVO PROMOZIONE C.ACME.CAT.FLW.0005");
  assert.equal(s.last.kind, "promote");
  const r = cli(KB, ["promote", "L.ACME.CAT.FLW.0001", "--customer", "ACME", "--to", "product", "--approval", s.last.hash, "--json"], { ws, env: { JVC_PSEUDO_SALT: SALT } });
  assert.equal(r.status, 3); assert.match(r.json.error, /approva C\.ACME\.CAT\.FLW\.0005/);
  const other = say(ws, "APPROVO PROMOZIONE C.BETA.CAT.FLW.0001");
  assert.match(other.context, /non è del cliente della sessione/, "un item di un altro cliente non si approva in questa sessione");
});

test("deprecate: F12 deprecato + superseded_by nel file e nel DB; successore assente ⇒ exit 1", () => {
  const ws = promoteWs();
  writeItem(ws, flw("C.ACME.CAT.FLW.0007"));
  reindex(join(ws, "customers", "ACME"), custDb(ws));
  let r = cli(KB, ["deprecate", "C.ACME.CAT.FLW.0005", "--superseded-by", "C.ACME.CAT.FLW.0007", "--customer", "ACME", "--json"], { ws });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const it = item(ws, "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0005.yaml");
  assert.equal(it.facets.F12, "deprecato"); assert.equal(it.superseded_by, "C.ACME.CAT.FLW.0007");
  assert.ok(existsSync(join(ws, "customers/ACME/kb/scopes/CAT/flows/C.ACME.CAT.FLW.0005.yaml")), "mai cancellato");
  r = cli(KB, ["deprecate", "C.ACME.CAT.FLW.0007", "--superseded-by", "C.ACME.CAT.FLW.0099", "--customer", "ACME", "--json"], { ws });
  assert.equal(r.status, 1);
  assert.equal(cli(KB, ["deprecate", "C.ACME.CAT.FLW.0007", "--customer", "ACME", "--json"], { ws }).status, 1, "senza successore");
});

// ---------------- migrate ----------------
test("migrate: migrazioni registrate, knowledge_version portata al massimo del plugin, reindex; DB più nuovo ⇒ exit 3", () => {
  const ws = seedGraph();
  const f = custDb(ws);
  const raw = new Database(f);
  raw.exec("drop table if exists schema_migrations");
  raw.prepare("update meta set value='0' where key='knowledge_version'").run();
  raw.close();
  const r1 = migrate(f, { root: join(ws, "customers", "ACME") });
  assert.deepEqual(r1.applied, migrationFiles().map((x) => x.name));
  assert.deepEqual(r1.knowledge_version, { from: 0, to: 1 });
  assert.ok(r1.reindex.scanned >= 5);
  assert.deepEqual(migrate(f).applied, [], "nessuna migrazione pendente");
  const db = new Database(f); db.prepare("update meta set value='9' where key='knowledge_version'").run(); db.close();
  const c = cli(KB, ["migrate", "--db", f, "--json"], { ws });
  assert.equal(c.status, 3, c.stdout); assert.match(c.json.error, /più nuova del plugin/);
  const d = cli(KB, ["migrate", "--db", join(ws, "nuovo.db"), "--dry-run", "--json"], { ws });
  assert.equal(d.status, 0); assert.equal(d.json.pending.length, migrationFiles().length);
});
