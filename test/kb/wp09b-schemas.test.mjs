// WP09b A — schemi di tipo (NRT, SEL, HND, CHK, CFP, FLW, KEY, LCY, INT, CFG): per ognuno un item valido e uno invalido,
// agganciati a validate-schema per `type` (i casi NRT.* per codice).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { validateItem, validateCase } from "../../scripts/kb/validate-schema.mjs";
import { sel, chk, hnd, cfp, cfpClient, flw, key, lcy, int, cfg, nrtCase } from "../helpers/wp09b-items.mjs";

const load = (f) => YAML.parse(readFileSync(new URL(`../fixtures/wp09b/${f}`, import.meta.url), "utf8"));
const ok = (it) => { const r = validateItem(it); assert.equal(r.ok, true, `${it.id}: ${r.errors.join("; ")}`); };
const bad = (it, re) => { const r = validateItem(it); assert.equal(r.ok, false, `${it.id} doveva essere invalido`); if (re) assert.ok(r.errors.some((e) => re.test(e)), r.errors.join("; ")); };
const without = (o, k) => { const x = structuredClone(o); delete x[k]; return x; };

test("SEL: fixture valida (search_box, effect read, ≥ 2 strategie con una semantica) e invalida (effect delete, una sola strategia css)", () => {
  ok(load("sel.valid.yaml"));
  const r = validateItem(load("sel.invalid.yaml"));
  assert.equal(r.ok, false);
  assert.ok(r.errors.some((e) => /effect/.test(e)), r.errors.join("; "));
  assert.ok(r.errors.some((e) => /strategies/.test(e)), r.errors.join("; "));
  bad({ ...sel("S.STD.P2P.SEL.0001"), strategies: [{ kind: "testid", value: "a" }, { kind: "css", value: "#a" }] }, /strategies/);
  bad({ ...sel("S.STD.P2P.SEL.0001"), stability: "solid" }, /stability/);
  bad({ ...sel("S.STD.P2P.SEL.0001"), role: "search-box" }, /role/);
});

test("HND: valido; senza stop_at_step o does_not_pass (critici §64) invalido", () => {
  ok(hnd("S.STD.P2P.HND.0001"));
  bad(without(hnd("S.STD.P2P.HND.0001"), "stop_at_step"), /stop_at_step/);
  bad({ ...hnd("S.STD.P2P.HND.0001"), does_not_pass: [] }, /does_not_pass/);
  bad({ ...hnd("S.STD.P2P.HND.0001"), owner_of_test: "XXX" }, /owner_of_test/);
});

test("CHK: valido (§5.6); how senza target per READ o senza script per SCRIPT invalido; cluster CL-CHK obbligatorio", () => {
  ok(chk("S.STD.ADM.CHK.0019"));
  ok(chk("S.STD.ADM.CHK.0051", { how: { verb: "SCRIPT", script: "snapshot-coverage", expect: "lista completa" } }));
  bad(chk("S.STD.ADM.CHK.0019", { how: { verb: "READ", expect: "x" } }), /target/);
  bad(chk("S.STD.ADM.CHK.0019", { how: { verb: "SCRIPT", expect: "x" } }), /script/);
  bad(chk("S.STD.ADM.CHK.0019", { cluster: ["CL-CFG-002"] }), /cluster/);
  bad(chk("S.STD.ADM.CHK.0019", { kind: "controllo" }), /kind/);
});

test("CFP (C1.1): S valida e C (delta) valida; verbo fuori vocabolario (DELETE) invalido; rollback obbligatorio per R ≥ R2; la C non copia i passi", () => {
  ok(cfp("S.STD.ADM.CFP.0014"));
  ok(cfpClient("C.ACME.ADM.CFP.0002"));
  const del = cfp("S.STD.ADM.CFP.0014"); del.steps[5] = { n: 6, verb: "DELETE", target: "S.STD.ADM.SEL.0113" };
  bad(del, /verb/);
  bad(without(cfp("S.STD.ADM.CFP.0014"), "rollback"), /rollback/);
  ok(without(cfp("S.STD.ADM.CFP.0014", { risk: "R1" }), "rollback"));
  bad(cfp("S.STD.ADM.CFP.0014", { rollback: { kind: "delete", ref: "S.STD.ADM.CFP.0015" } }), /rollback/);
  bad({ ...cfpClient("C.ACME.ADM.CFP.0002"), steps: cfp("S.STD.ADM.CFP.0014").steps });
  bad(cfpClient("C.ACME.ADM.CFP.0002", { deviations: [{ step: 5, source: { doc: "x" } }] }), /deviations/);
});

test("FLW: valido; compensazione delete e verbo DELETE invalidi; FLW senza attributi (lacune) resta valido", () => {
  ok(flw("C.ACME.P2P.FLW.0001"));
  const base = flw("C.ACME.P2P.FLW.0001"); for (const k of ["steps", "compensation", "actor", "trigger", "preconditions", "postconditions", "invariants", "evidence", "document"]) delete base[k];
  ok(base);
  bad(flw("C.ACME.P2P.FLW.0001", { compensation: { kind: "delete" } }), /compensation/);
  const d = flw("C.ACME.P2P.FLW.0001"); d.steps[2].verb = "DELETE";
  bad(d, /verb/);
});

test("KEY: valido; uniqueness.scope fuori dominio invalido", () => {
  ok(key("S.STD.VEN.KEY.0001"));
  bad(key("S.STD.VEN.KEY.0001", { uniqueness: { scope: "universo" } }), /uniqueness/);
  bad(key("S.STD.VEN.KEY.0001", { reuse_after_deactivation: "mai" }), /reuse_after_deactivation/);
});

test("LCY: valido; validazione con esito fuori dominio invalida; mandatory_by_state solo codici FLD", () => {
  ok(lcy("S.STD.P2P.LCY.0001"));
  bad(lcy("S.STD.P2P.LCY.0001", { validations: [{ rule: "x", on_fail: "warn" }] }), /on_fail/);
  bad(lcy("S.STD.P2P.LCY.0001", { mandatory_by_state: { Bozza: ["importo"] } }), /mandatory_by_state/);
});

test("INT (piano F2): valido con mappings[].field FLD e one_of; senza silence_semantics invalido; field_ref grezzo non accettato; one_of con mandatory true invalido", () => {
  ok(int("S.STD.P2P.INT.0001"));
  bad(without(int("S.STD.P2P.INT.0001"), "silence_semantics"), /silence_semantics/);
  for (const k of ["e2e_checkpoint", "owner_scope", "touches_scopes", "tolerances"]) bad(without(int("S.STD.P2P.INT.0001"), k), new RegExp(k));
  bad(int("S.STD.P2P.INT.0001", { mappings: [{ field_ref: "R.X.1", target: "A" }] }), /mappings/);
  bad(int("S.STD.P2P.INT.0001", { mappings: [{ field: "S.STD.P2P.FLD.0002", target: "A", mandatory: true, one_of: { group: "g", required: true } }] }), /mandatory/);
  bad(int("S.STD.P2P.INT.0001", { e2e_checkpoint: { stage: "delivered" } }), /stage/);
});

test("CFG: valido; rollback delete e options scalare invalidi", () => {
  ok(cfg("S.STD.ADM.CFG.0031"));
  bad(cfg("S.STD.ADM.CFG.0031", { rollback: { kind: "delete" } }), /rollback/);
  bad(cfg("S.STD.ADM.CFG.0031", { options: "testo" }), /options/);
});

test("NRT (F7): caso valido; senza derivation o boundary invalido; genere/scope del codice coerenti; NEG in shadow senza expected_errors invalido; compensazione delete invalida", () => {
  const c = nrtCase();
  assert.equal(validateCase(c).ok, true, validateCase(c).errors.join("; "));
  assert.equal(validateItem(c).ok, true, "validate-schema instrada i codici NRT.* su nrt-case.schema.json");
  bad(without(c, "derivation"), /derivation/);
  bad(without(c, "boundary"), /boundary/);
  bad({ ...c, genre: "POS" }, /genere/);
  bad({ ...c, id: "NRT.ACME.P2P.XYZ.0001" }, /id/);
  bad({ ...c, state: "shadow", expected_errors: [] }, /expected_errors/);
  bad({ ...c, compensations: [{ step: 3, kind: "delete" }] }, /compensations/);
  bad({ ...c, boundary: { stop_at_step: 9, does_not_assert: [] } }, /stop_at_step/);
  bad({ ...c, state: "archiviato" }, /state/);
});
