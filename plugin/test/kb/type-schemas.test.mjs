// Revisione finale (Important A#2; §44.7 "un JSON Schema per ogni tipo del registro … un file che non valida non entra
// nel DB"): ogni tipo del registro ha uno schema; PRF, PMP, STR, ENV applicati da validateItem; schemi minimi per CAP INV
// GLS OBS CTR EVD DEC EPI; ciò che gli script e le fixture già producono resta valido.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import YAML from "yaml";
import { validateItem, TYPE_SCHEMAS, SCHEMA_FOR_TYPE } from "../../scripts/kb/validate-schema.mjs";
import { getValidator } from "../../scripts/lib/schemas.mjs";

const REGISTRY = JSON.parse(readFileSync(new URL("../../schemas/registry.json", import.meta.url), "utf8"));
const FACETS = YAML.parse(readFileSync(new URL("../fixtures/items/S.STD.P2P.FLD.0117.yaml", import.meta.url), "utf8")).facets;
const item = (id, type, extra = {}) => ({ id, type, title: `Voce ${type} di prova`, summary: `Voce ${type}.`, facets: FACETS, sources: [{ doc: "d" }], ...extra });

test("ogni tipo del registro ha uno schema che esiste e compila", () => {
  const missing = Object.keys(REGISTRY.types).filter((t) => !SCHEMA_FOR_TYPE[t]);
  assert.deepEqual(missing, [], "tipi del registro senza schema");
  for (const [t, f] of Object.entries(SCHEMA_FOR_TYPE)) {
    assert.ok(existsSync(new URL(`../../schemas/${f}`, import.meta.url)), `${t}: ${f} inesistente`);
    assert.equal(typeof getValidator(f), "function", `${t}: ${f} non compila`);
  }
  for (const t of ["PRF", "PMP", "STR", "ENV", "CAP", "INV", "GLS", "OBS", "CTR", "EVD", "DEC", "EPI"]) assert.ok(TYPE_SCHEMAS[t], `${t} applicato da validateItem`);
});

const VALID = {
  CAP: item("S.STD.P2P.CAP.0001", "CAP", { criticality: "alta" }),
  INV: item("S.STD.P2P.INV.0001", "INV", { statement: "Una RdA approvata non torna in bozza", holds_for: ["S.STD.P2P.LCY.0001"] }),
  GLS: item("S.STD.P2P.GLS.0001", "GLS", { term: "RdA", synonyms: ["richiesta d'acquisto", "requisition"], capability: "S.STD.P2P.CAP.0001" }),
  OBS: item("L.ACME.P2P.OBS.0001", "OBS", { session: "SES.ACME.20260929.001", tool: "take_snapshot", kind: "snapshot", url: "https://acme-sbx.jaggaer.com/p2p", ts: "2026-09-29T10:00:00.000Z", surprise: 0, novelty: 1 }),
  CTR: item("C.ACME.P2P.CTR.0001", "CTR", { between: ["S.STD.P2P.FLD.0117", "C.ACME.P2P.FLD.0117"], facet: "F8", status: "aperto" }),
  EVD: item("S.STD.P2P.EVD.0001", "EVD", { kind: "assertion", capture: "region", caption: "Toast di salvataggio" }),
  DEC: item("L.ACME.P2P.DEC.0001", "DEC", { table: "DT-002", table_version: "1.0.0", inputs: { risk: "R2" }, priors: null, score: 0.61, outcome: "genera", at: "2026-09-29T10:00:00Z" }),
  EPI: item("C.ACME.P2P.EPI.0001", "EPI", { subject: "C.ACME.P2P.FLD.0117", shape: "libresco", k_tech: 0.8, k_use: 0.2, k_obs: 0, k_exec: 0 }),
};
const INVALID = {
  CAP: { criticality: "altissima" },
  INV: { statement: undefined },
  GLS: { term: undefined },
  OBS: { kind: undefined },
  CTR: { between: ["S.STD.P2P.FLD.0117"] },
  EVD: { kind: "decorazione" },
  DEC: { table: "DT-2" },
  EPI: { shape: "forse" },
};

test("schemi minimi: un item corretto per tipo è valido; il campo caratterizzante mancante o fuori vocabolario lo rende invalido", () => {
  for (const [t, it] of Object.entries(VALID)) {
    const v = validateItem(it);
    assert.ok(v.ok, `${t}: ${v.errors.join("; ")}`);
    const bad = JSON.parse(JSON.stringify({ ...it, ...INVALID[t] }));
    assert.equal(validateItem(bad).ok, false, `${t}: invalido accettato`);
  }
});

test("STR ed ENV come item: il nucleo della strategia e l'ambiente (regole di produzione comprese) sono verificati", () => {
  const strat = YAML.parse(readFileSync(new URL("../../strategies/STR-ASK-EARLY.yaml", import.meta.url), "utf8"));
  const str = item("S.STD.XSC.STR.0008", "STR", { code: strat.code, name: strat.name, applies_when: strat.applies_when, plan: strat.plan, cost: strat.cost, success_criteria: strat.success_criteria });
  assert.ok(validateItem(str).ok, validateItem(str).errors.join("; "));
  assert.equal(validateItem({ ...str, plan: undefined }).ok, false);
  const envs = YAML.parse(readFileSync(new URL("../fixtures/env/environments.yaml", import.meta.url), "utf8")).environments;
  const env = item("C.ACME.XSC.ENV.0001", "ENV", { environment: envs.find((e) => e.id === "prod") });
  assert.ok(validateItem(env).ok, validateItem(env).errors.join("; "));
  const leaky = structuredClone(env); leaky.environment.policy.write_data = true;
  assert.equal(validateItem(leaky).ok, false, "type prod ⇒ write_data false anche nell'item ENV");
  assert.equal(validateItem({ ...env, environment: undefined }).ok, false);
});

test("PRF e PMP applicati da validateItem: l'esempio della spec con i campi base è valido, senza il nucleo di tipo no", () => {
  const prf = YAML.parse(readFileSync(new URL("../fixtures/profile/C.ACME.XSC.PRF.0001.yaml", import.meta.url), "utf8"));
  const pmp = YAML.parse(readFileSync(new URL("../fixtures/profile/C.ACME.XSC.PMP.0001.yaml", import.meta.url), "utf8"));
  const withBase = (o) => ({ type: o.id.split(".")[3], summary: "Esempio.", facets: FACETS, sources: [{ doc: "d" }], ...o, title: o.title ?? "Profilo del cliente" });
  for (const o of [prf, pmp]) assert.ok(validateItem(withBase(o)).ok, validateItem(withBase(o)).errors.join("; "));
  assert.equal(validateItem({ ...withBase(prf), documentation_inventory: [] }).ok, false);
  assert.equal(validateItem({ ...withBase(pmp), epistemic_by_stage: { 1: "forse" } }).ok, false);
});
