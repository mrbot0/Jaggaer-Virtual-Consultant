// WP09b F — negative-generator (§27.2 tabella di deduzione come codice, proprietà del test, epistemic_at_generation;
// F7: un caso senza derivation non è emesso).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { deduce, generate, emit } from "../../scripts/compile/negative-generator.mjs";
import { validateCase } from "../../scripts/kb/validate-schema.mjs";
import { kbWs, writeItem, key, lcy, int, hnd, FACETS } from "../helpers/wp09b-items.mjs";

const CLI = fileURLToPath(new URL("../../scripts/compile/negative-generator.mjs", import.meta.url));
const fld = (id, extra = {}) => ({ id, type: "FLD", title: `Campo ${id.slice(-4)}`, summary: "Campo.", facets: FACETS, sources: [{ doc: "d" }], document: "document.requisition", label: { it: `Campo ${id.slice(-4)}` }, section: "h", field_type: "text", ...extra });
const modes = (list) => list.map((d) => `${d.genre}:${d.risk_mode}`).sort();

test("KEY: una deduzione per riga di §27.2 (collisione, riuso, aggiramento, mutazione tardiva, formato, riferimento pendente, propagazione, obbligatorio omesso)", () => {
  const k = key("S.STD.VEN.KEY.0001", { uniqueness: { scope: "tenant", channels: ["ui", "import"] }, enforced_at: ["ui"], format: { pattern: "^IT\\d{11}$", max_length: 13, transform: "upper", truncation: "none" } });
  assert.deepEqual(modes(deduce(k)), ["BSL:riferimento pendente", "INT:propagazione", "INT:troncamento silenzioso", "NEG:aggiramento", "NEG:collisione", "NEG:formato", "NEG:mutazione tardiva", "NEG:obbligatorio omesso", "NEG:riuso"]);
  assert.equal(deduce(k).find((d) => d.risk_mode === "aggiramento").channel, "import");
  // cross_system con l'INT: la trasformazione la testa chi possiede l'interfaccia
  const withInt = key("S.STD.VEN.KEY.0001", { cross_system: [{ system: "SAP", existence_validated_locally: false, int: "S.STD.XSC.INT.0009" }] });
  const byId = new Map([["S.STD.XSC.INT.0009", int("S.STD.XSC.INT.0009", { owner_scope: "XSC" })]]);
  const pend = deduce(withInt, { byId }).find((d) => d.risk_mode === "riferimento pendente");
  assert.equal(pend.genre, "INT"); assert.equal(pend.owner, "XSC"); assert.ok(pend.from.includes("S.STD.XSC.INT.0009"));
  assert.equal(deduce(key("S.STD.VEN.KEY.0001")).find((d) => d.risk_mode === "collisione").owner, "VEN", "il proprietario della chiave testa gli invarianti intrinseci");
});

test("FLD: conditional ⇒ un NEG per stato × ruolo + un POS a condizione falsa; by_role; reason integration ⇒ INT dell'owner dell'interfaccia; ui senza ragione ⇒ BSL + domanda", () => {
  const c = fld("S.STD.P2P.FLD.0001", { mandatory: { kind: "conditional", when: "importo > 5000", in_states: ["In approvazione", "Approvata"], by_role: ["buyer", "approver"] } });
  const d = deduce(c);
  assert.equal(d.filter((x) => x.genre === "NEG").length, 4);
  assert.equal(d.filter((x) => x.genre === "POS").length, 1);
  assert.deepEqual(d.filter((x) => x.genre === "NEG").map((x) => `${x.state}|${x.role}`).sort(), ["Approvata|approver", "Approvata|buyer", "In approvazione|approver", "In approvazione|buyer"]);
  assert.equal(deduce(fld("S.STD.P2P.FLD.0002", { mandatory: { kind: "always", by_role: ["buyer", "approver"] } })).filter((x) => x.risk_mode === "obbligatorio per ruolo").length, 2);
  const byId = new Map([["S.STD.XSC.INT.0001", int("S.STD.XSC.INT.0001", { owner_scope: "XSC" })]]);
  const i = deduce(fld("S.STD.P2P.FLD.0003", { mandatory: { kind: "always", reason: { kind: "integration", ref: "S.STD.XSC.INT.0001" } } }), { byId }).find((x) => x.genre === "INT");
  assert.equal(i.owner, "XSC"); assert.equal(i.risk_mode, "campo vuoto arriva al tracciato");
  const ui = deduce(fld("S.STD.P2P.FLD.0004", { mandatory: { kind: "always", reason: { kind: "ui" } } })).find((x) => x.genre === "BSL");
  assert.match(ui.question, /è voluto\?/);
  assert.equal(deduce(fld("S.STD.P2P.FLD.0005", { mandatory: { kind: "always", reason: { kind: "ui" } }, lineage: { required_by: [{ ref: "S.STD.XSC.INT.0001" }] } })).some((x) => x.genre === "BSL"), false, "con una ragione a valle nessun BSL");
});

test("LCY, INT, HND: undocumented ⇒ BSL; mandatory_by_state ⇒ NEG per stato; INT ⇒ contratto + campo vuoto se il controparte tace; HND ⇒ HND + NEG does_not_pass con il confine dell'handoff", () => {
  assert.deepEqual(modes(deduce(lcy("S.STD.P2P.LCY.0001"))), ["BSL:ignoto", "NEG:mutazione tardiva", "NEG:obbligatorio omesso"]);
  assert.deepEqual(modes(deduce(int("S.STD.P2P.INT.0001"))), ["INT:campo vuoto arriva al tracciato", "INT:contratto"]);
  const h = hnd("S.STD.P2P.HND.0001", { owner_of_test: "P2P", does_not_pass: ["RdA non approvata", "RdA senza centro di costo"] });
  const r = generate([h], { customer: "ACME", shapes: { "S.STD.P2P.HND.0001": "consolidato" } });
  assert.deepEqual(r.cases.map((c) => c.genre).sort(), ["HND", "NEG", "NEG"]);
  for (const c of r.cases) { assert.equal(c.boundary.handoff, "S.STD.P2P.HND.0001"); assert.equal(c.boundary.stop_at_step, 4); assert.deepEqual(c.boundary.does_not_assert, ["la creazione dell'evento"]); assert.equal(c.scope, "P2P"); }
});

test("catene CL-FLD-CHAIN: uno HND/INT per catena, dello scope del documento di origine", () => {
  const items = [
    fld("S.STD.P2P.FLD.0010", { mandatory: { kind: "always" }, cluster: ["CL-FLD-CHAIN-001"] }),
    fld("S.STD.INV.FLD.0011", { mandatory: { kind: "never" }, cluster: ["CL-FLD-CHAIN-001"] }),
  ];
  const r = generate(items, { customer: "ACME", shapes: Object.fromEntries(items.map((x) => [x.id, "consolidato"])) });
  const chain = r.cases.filter((c) => c.derivation.chain === "CL-FLD-CHAIN-001");
  assert.equal(chain.length, 1); assert.equal(chain[0].genre, "HND"); assert.equal(chain[0].scope, "P2P");
  assert.equal(chain[0].derivation.risk_mode, "valore alterato lungo la catena");
});

test("epistemic_at_generation: ignoto ⇒ nessun caso, un'esplorazione; libresco (default dai documenti) ⇒ shadow con osservazione preliminare; consolidato ⇒ candidate; ogni caso emesso valida (F7)", () => {
  const k = key("S.STD.VEN.KEY.0001");
  const ign = generate([k], { customer: "ACME", shapes: { "S.STD.VEN.KEY.0001": "ignoto" } });
  assert.equal(ign.cases.length, 0); assert.deepEqual(ign.explorations.map((e) => [e.subject, e.strategy]), [["S.STD.VEN.KEY.0001", "STR-EXPLORE-BUDGET"]]);
  const lib = generate([k], { customer: "ACME" });
  assert.ok(lib.cases.length > 0 && lib.cases.every((c) => c.state === "shadow" && /osservazione preliminare/.test(c.epistemic_at_generation.preliminary_observation)));
  const cons = generate([k], { customer: "ACME", shapes: { "S.STD.VEN.KEY.0001": "consolidato" } });
  assert.ok(cons.cases.every((c) => c.state === "candidate" && c.epistemic_at_generation.shape === "consolidato"));
  for (const c of [...lib.cases, ...cons.cases]) { assert.equal(validateCase(c).ok, true, validateCase(c).errors.join("; ")); assert.ok(c.derivation.from.length && c.derivation.risk_mode); }
  assert.deepEqual([...new Set(cons.cases.map((c) => c.id.split(".").slice(0, 3).join(".")))], ["NRT.ACME.VEN"]);
  // F7: un caso senza derivation non si emette
  const bad = structuredClone(cons.cases[0]); delete bad.derivation;
  assert.equal(emit(bad).ok, false);
  assert.match(emit(bad).reason, /derivation/);
});

test("CLI --write: scheletri in customers/<C>/tests/cases/<S>/ con SEQ successivi a quelli esistenti", () => {
  const w = kbWs();
  writeItem(w, key("S.STD.VEN.KEY.0001"));
  writeItem(w, lcy("S.STD.P2P.LCY.0001"));
  const r = spawnSync(process.execPath, [CLI, "--customer", "ACME", "--workspace", w, "--write", "--json"], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.cases.length >= 10);
  assert.ok(existsSync(join(w, "customers/ACME/tests/cases/VEN")) && existsSync(join(w, "customers/ACME/tests/cases/P2P")));
  const again = JSON.parse(spawnSync(process.execPath, [CLI, "--customer", "ACME", "--workspace", w, "--json"], { encoding: "utf8" }).stdout);
  assert.ok(again.cases.every((c) => !readdirSync(join(w, "customers/ACME/tests/cases", c.scope)).includes(`${c.id}.yaml`)), "i nuovi SEQ seguono quelli già scritti");
});
