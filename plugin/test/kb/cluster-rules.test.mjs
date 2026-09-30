import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import {
  jaccard, facetSignatureCoverage, evaluateCriterion, checkCluster, validateCluster,
  rc01, rc02, rc03, rc04, rc05, rc06, rc07, rc08, rc09, rc10,
} from "../../scripts/kb/cluster-rules.mjs";

const CLUSTERS_DIR = fileURLToPath(new URL("../../clusters", import.meta.url));

const base = () => ({
  code: "CL-CFG-005", family: "CL-CFG", name: "Form e campi",
  definition: "Insieme degli item che descrivono form documento e campi configurabili.",
  inclusion: [{ id: "I1", field: "classification.cfg_area", op: "eq", value: "005" }, { id: "I2", facet: "F4", op: "in", value: ["oggetto-config", "procedura"] }],
  exclusion: [{ id: "E1", field: "type", op: "in", value: ["PAT", "PBK", "BRF", "RUL"] }],
  facet_signature: { F4: "oggetto-config" }, owner: "config-designer",
  portability: { class: "condizionata", condition: "F7" }, domain: "kb", status: "bootstrap", depth: 1,
});
const item = (code, facets, extra = {}) => ({ id: code, type: code.split(".")[3], facets: { F4: "oggetto-config", F12: "validato", ...facets }, ...extra });

test("jaccard: intersezione su unione; insiemi vuoti = 0", () => {
  assert.equal(jaccard(["a", "b", "c"], ["b", "c", "d"]), 0.5);
  assert.equal(jaccard(new Set(["a"]), new Set(["a"])), 1);
  assert.equal(jaccard([], []), 0);
});

test("firma di faccette: copertura ≥ 80% dei membri; F6 è un array", () => {
  const members = [1, 2, 3, 4, 5].map((n) => item(`C.ACME.ADM.CFG.000${n}`, { F6: ["indirect", "multi-valuta"] }));
  members[4].facets.F4 = "procedura";
  assert.equal(facetSignatureCoverage(members, { F4: "oggetto-config" }), 0.8);
  assert.equal(facetSignatureCoverage(members, { F4: "oggetto-config", F6: "indirect" }), 0.8);
  assert.equal(facetSignatureCoverage(members, { F6: ["direct"] }), 0);
  assert.equal(facetSignatureCoverage([], { F4: "x" }), 0);
});

test("criteri verificabili: facet eq/in/neq, field exists/eq/in; null = indeterminato", () => {
  const it = item("C.ACME.ADM.CFG.0001", { F6: ["indirect"] }, { classification: { cfg_area: "005" }, mandatory: { kind: "conditional", by_role: null } });
  assert.equal(evaluateCriterion({ facet: "F4", op: "eq", value: "oggetto-config" }, it), true);
  assert.equal(evaluateCriterion({ facet: "F6", op: "eq", value: "indirect" }, it), true);
  assert.equal(evaluateCriterion({ facet: "F6", op: "in", value: ["direct", "misto"] }, it), false);
  assert.equal(evaluateCriterion({ facet: "F10", op: "neq", value: "R3" }, it), null);  // faccetta assente → dubbio
  assert.equal(evaluateCriterion({ field: "mandatory.kind", op: "in", value: ["conditional"] }, it), true);
  assert.equal(evaluateCriterion({ field: "mandatory.by_role", op: "exists" }, it), false);
  assert.equal(evaluateCriterion({ field: "mandatory.by_role", op: "eq", value: "BUYER" }, it), null); // dichiarato ignoto
  assert.equal(evaluateCriterion({ field: "lineage.propagates_to", op: "exists" }, it), false);
  assert.equal(evaluateCriterion({ field: "lineage.x", op: "eq", value: "a" }, it), false);          // non dichiarato
});

test("RC-01 famiglia: esistente, o nuova con ≥ 3 candidati", () => {
  assert.equal(rc01(base(), {}).ok, true);
  const nuova = { ...base(), code: "CL-XYZ-001", family: "CL-XYZ" };
  assert.equal(rc01(nuova, { familyClusters: [nuova] }).ok, false);
  const tre = [1, 2, 3].map((n) => ({ ...nuova, code: `CL-XYZ-00${n}` }));
  assert.equal(rc01(nuova, { familyClusters: tre }).ok, true);
  assert.equal(rc01({ ...base(), code: "CL-ERR-001" }, {}).ok, false); // codice fuori famiglia
});

test("RC-02 nome ≤ 6 parole, definizione ≤ 40 parole che inizia 'Insieme degli item che'", () => {
  assert.equal(rc02(base()).ok, true);
  assert.equal(rc02({ ...base(), name: "uno due tre quattro cinque sei sette" }).ok, false);
  assert.equal(rc02({ ...base(), definition: "Gli item che descrivono i form." }).ok, false);
  assert.equal(rc02({ ...base(), definition: `Insieme degli item che ${"parola ".repeat(40)}` }).ok, false);
});

test("RC-03 ≥ 2 inclusione, ≥ 1 esclusione, verificabili su faccette o contenuto strutturato", () => {
  assert.equal(rc03(base()).ok, true);
  assert.equal(rc03({ ...base(), inclusion: [base().inclusion[0]] }).ok, false);
  assert.equal(rc03({ ...base(), exclusion: [] }).ok, false);
  assert.equal(rc03({ ...base(), inclusion: [...base().inclusion, { text: "sembra un form" }] }).ok, false);
  assert.equal(rc03({ ...base(), inclusion: [{ facet: "F99", op: "eq", value: 1 }, base().inclusion[1]] }).ok, false);
});

test("RC-04 ≥ 3 membri validati; saltata per i cluster di bootstrap", () => {
  const c = { ...base(), status: "attivo" };
  const three = [1, 2, 3].map((n) => item(`C.ACME.ADM.CFG.000${n}`, {}));
  assert.equal(rc04(c, { members: three }).ok, true);
  assert.equal(rc04(c, { members: [...three.slice(0, 2), item("C.ACME.ADM.CFG.0009", { F12: "digerito" })] }).ok, false);
  const b = rc04(base(), { members: [] });
  assert.equal(b.ok, true);
  assert.equal(b.skipped, true);
  assert.match(b.reason, /bootstrap/);
});

test("RC-05 distinzione: Jaccard < 50% con ogni cluster della famiglia", () => {
  const other = { ...base(), code: "CL-CFG-006", inclusion: [{ field: "classification.cfg_area", op: "eq", value: "006" }, base().inclusion[1]] };
  assert.equal(rc05(base(), { familyClusters: [base(), other] }).ok, true);   // 1/3
  const twin = { ...base(), code: "CL-CFG-099" };
  assert.equal(rc05(base(), { familyClusters: [base(), twin] }).ok, false);   // 1
  // con membri: Jaccard sui membri
  const a = { ...base(), status: "attivo", members: ["x", "y", "z", "w"] };
  const b = { ...other, status: "attivo", members: ["x", "y", "z", "q"] };
  assert.equal(rc05(a, { familyClusters: [a, b], members: a.members.map((m) => ({ id: m })) }).ok, false); // 3/5
});

test("RC-06 firma: una combinazione di faccette caratterizza ≥ 80% dei membri", () => {
  const c = { ...base(), status: "attivo" };
  const ms = [1, 2, 3, 4, 5].map((n) => item(`C.ACME.ADM.CFG.000${n}`, {}));
  assert.equal(rc06(c, { members: ms }).ok, true);
  ms[3].facets.F4 = "procedura"; ms[4].facets.F4 = "procedura";
  assert.equal(rc06(c, { members: ms }).ok, false);   // 60%
  assert.equal(rc06(base(), { members: [] }).skipped, true);
});

test("RC-07 profondità ≤ 3 e coerente con il genitore", () => {
  assert.equal(rc07(base(), { catalog: [] }).ok, true);
  assert.equal(rc07({ ...base(), depth: 4 }, {}).ok, false);
  const parent = { ...base(), code: "CL-CFG-005", depth: 1 };
  const child = { ...base(), code: "CL-CFG-ASY-001", depth: 2, parent: "CL-CFG-005" };
  assert.equal(rc07(child, { catalog: [parent, child] }).ok, true);
  assert.equal(rc07({ ...child, depth: 3 }, { catalog: [parent] }).ok, false);
  assert.equal(rc07({ ...child, parent: "CL-CFG-777" }, { catalog: [parent] }).ok, false);
});

test("RC-08 un agente responsabile", () => {
  assert.equal(rc08(base()).ok, true);
  assert.equal(rc08({ ...base(), owner: "" }).ok, false);
  assert.equal(rc08({ ...base(), owner: ["a", "b"] }).ok, false);
});

test("RC-09 portabilità dichiarata con la faccetta condizionante", () => {
  assert.equal(rc09(base()).ok, true);
  assert.equal(rc09({ ...base(), portability: { class: "condizionata" } }).ok, false);
  assert.equal(rc09({ ...base(), portability: { class: "condizionata", condition: "dipende" } }).ok, false);
  assert.equal(rc09({ ...base(), portability: { class: "universale" } }).ok, true);
  assert.equal(rc09({ ...base(), portability: { class: "forse" } }).ok, false);
});

test("RC-10 un solo dominio per cluster", () => {
  assert.equal(rc10(base(), { members: [item("C.ACME.ADM.CFG.0001", {})] }).ok, true);
  assert.equal(rc10({ ...base(), domain: ["kb", "analysis"] }, {}).ok, false);
  assert.equal(rc10(base(), { members: [{ id: "S.STD.P2P.PAT.0001", type: "PAT", facets: {} }] }).ok, false);
  assert.equal(rc10({ ...base(), domain: "analysis" }, { members: [item("C.ACME.ADM.CFG.0001", {})] }).ok, false);
});

// ——— catalogo di bootstrap ———
function loadCatalog() {
  const out = [];
  for (const fam of readdirSync(CLUSTERS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory())) {
    for (const f of readdirSync(join(CLUSTERS_DIR, fam.name)).filter((x) => x.endsWith(".yaml"))) {
      out.push({ file: `${fam.name}/${f}`, dir: fam.name, c: YAML.parse(readFileSync(join(CLUSTERS_DIR, fam.name, f), "utf8")) });
    }
  }
  return out;
}

const COUNTS = { "CL-SYS": 11, "CL-KNW": 14, "CL-PRO": 15, "CL-CUS": 13, "CL-ERP": 6, "CL-CFG": 20, "CL-UIB": 14, "CL-INT": 10,
  "CL-CHK": 11, "CL-ERR": 9, "CL-PRT": 6, "CL-RSK": 4, "CL-LRN": 6, "CL-ANL": 10, "CL-DEC": 6, "CL-EPI": 5, "CL-STR": 12,
  "CL-FLD": 13, "CL-FLD-MAND": 7, "CL-FLD-CHAIN": 3 };

test("catalogo di bootstrap: famiglie e conteggi di §7.2; codice = nome del file", () => {
  const cat = loadCatalog();
  const byFam = {};
  for (const { c, file, dir } of cat) {
    byFam[c.family] = (byFam[c.family] ?? 0) + 1;
    assert.equal(file, `${c.family}/${c.code}.yaml`);
    assert.equal(dir, c.family);
    assert.equal(c.status, "bootstrap");
  }
  assert.deepEqual(byFam, COUNTS);
});

test("ogni cluster di bootstrap valida e passa RC-01, 02, 03, 05, 07, 08, 09, 10", () => {
  const cat = loadCatalog().map((x) => x.c);
  for (const c of cat) {
    const v = validateCluster(c);
    assert.ok(v.ok, `${c.code}: ${v.errors.join("; ")}`);
    const r = checkCluster(c, { familyClusters: cat.filter((x) => x.family === c.family), members: [], catalog: cat });
    for (const res of r.results) {
      if (["RC-04", "RC-06"].includes(res.rule)) { assert.equal(res.skipped, true, `${c.code} ${res.rule}`); continue; }
      assert.ok(res.ok, `${c.code} ${res.rule}: ${res.reason}`);
    }
    assert.equal(r.ok, true, c.code);
  }
});

// Campi di contenuto definiti dalla spec (§19.2 PRF, §19.6.2 FLD, §20.6.2 ERR, §9.4 EPI, §14.4 STR);
// tutto il resto deve passare da `classification.*` a vocabolario chiuso (schemas/item.base.schema.json).
const SPEC_FIELDS = new Set(["type", "message", "category", "page_signature", "key_ref", "lineage.propagates_to", "mandatory.kind",
  "mandatory.in_states", "mandatory.by_role", "mandatory.reason.kind", "shape", "code", "sector", "legal.public_procurement_law",
  "legal.group", "erp.system", "erp.middleware", "procurement_model.centralization", "procurement_model.catalog_usage", "procurement_model.sourcing"]);

test("ogni criterio su un campo usa un campo della spec o classification.<campo> con valori del vocabolario chiuso", () => {
  const schema = JSON.parse(readFileSync(new URL("../../schemas/item.base.schema.json", import.meta.url), "utf8"));
  const vocab = schema.properties.classification.properties;
  const used = new Set();
  for (const { c } of loadCatalog()) {
    for (const k of [...c.inclusion, ...c.exclusion].filter((x) => x.field)) {
      if (k.field.startsWith("classification.")) {
        const name = k.field.slice("classification.".length);
        assert.ok(vocab[name], `${c.code}: ${k.field} non dichiarato in item.base.classification`);
        for (const v of k.value === undefined ? [] : Array.isArray(k.value) ? k.value : [k.value]) assert.ok(vocab[name].enum.includes(v), `${c.code}: ${k.field}=${v} fuori vocabolario`);
        used.add(name);
      } else assert.ok(SPEC_FIELDS.has(k.field), `${c.code}: campo '${k.field}' non della spec e non in classification`);
    }
  }
  assert.deepEqual([...used].sort(), Object.keys(vocab).sort());   // ogni campo del vocabolario è usato da almeno un cluster
});

test("nomi della spec: CL-CFG da §7.2 con rischio base §28.5; CL-CHK da §62; CL-FLD da §19.6.3", () => {
  const cat = Object.fromEntries(loadCatalog().map((x) => [x.c.code, x.c]));
  assert.equal(cat["CL-CFG-005"].name, "Form e campi");
  assert.equal(cat["CL-CFG-020"].base_risk, "R2/R3");
  assert.equal(cat["CL-CFG-009"].base_risk, "R3");
  assert.equal(cat["CL-CHK-002"].name, "Pre-modifica di configurazione");
  assert.equal(cat["CL-FLD-003"].name, "Contabilità");
  assert.equal(cat["CL-FLD-MAND-007"].name, "Obbligatorietà non documentata");
  assert.equal(cat["CL-FLD-CHAIN-012"].name, "CdC → ordine → ERP → fattura");
  assert.equal(cat["CL-UIB-001"].name, "Validazione asincrona in griglia");
  assert.equal(cat["CL-ANL-008"].name, "Pattern di query con LIMIT");
  assert.equal(cat["CL-ERR-005"].name, "Timeout e latenza");
  assert.equal(cat["CL-PRT-004"].portability.condition.includes("CL-CFG"), true);
});
