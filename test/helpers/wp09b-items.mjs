// WP09b: item di esempio (validi per gli schemi di tipo) e workspace con kb/ di prodotto e cliente per i test
// di compile-case, compile-cfp, generate-atlas-po, lint-*, run lanes, negative-generator e coverage.
import { mkdirSync, writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";

export const FACETS = Object.freeze({
  F1: "doc-standard", F4: "procedura", F5: "saas-core", F6: [], F7: "nessuno", F8: "universale", F9: "ripetitiva",
  F10: "R1", F11: "deterministico", F12: "validato", F13: { verified_at: "2026-09-01", release: "R25.2" }, F15: "tecnica",
});
const base = (id, type, title, extra = {}) => ({ id, type, title, summary: `${title}.`, facets: structuredClone(FACETS), sources: [{ doc: "Manuale.pdf", section: "1" }], ...extra });

export const sel = (id, { role = "button", effect = "read", label = "Salva", stability = "stable", strategies } = {}) => base(id, "SEL", `Selettore ${label}`, {
  concept: `elemento ${label}`, label, role, effect, stability,
  strategies: strategies ?? [{ kind: "testid", value: label.toLowerCase().replace(/\W+/g, "-") }, { kind: "role", value: role === "search_box" ? "searchbox" : role, name: label }, { kind: "label", value: label }],
});

export const chk = (id, extra = {}) => base(id, "CHK", "Nessun workflow in modifica sul form", {
  kind: "precondition", how: { verb: "READ", target: "S.STD.ADM.SEL.0130", expect: "nessuna riga con stato 'In modifica'" },
  cost: "cheap", deterministic: true, frequency: "before_config_change", cluster: ["CL-CHK-002"],
  classification: { check_area: "pre-modifica-config" }, ...extra,
});

export const hnd = (id, extra = {}) => base(id, "HND", "Consegna della RdA approvata agli acquisti", {
  from_scope: "P2P", to_scope: "SRC", contract: { produces: "RdA approvata", consumes: "evento di gara", entity: "requisition", state: "Approvata" },
  owner_of_test: "P2P", asserts: ["la RdA arriva in stato Approvata"], does_not_pass: ["una RdA non approvata"],
  does_not_assert: ["la creazione dell'evento"], stop_at_step: 4, shared_fixtures: ["buyer_it01"], reciprocal_test: null, ...extra,
});

export const cfp = (id, extra = {}) => base(id, "CFP", "Aggiungere un campo personalizzato a un form documento", {
  governs: ["S.STD.ADM.CFG.0031"], risk: "R2", area: "CL-CFG-005",
  preconditions: [{ check: "S.STD.ADM.CHK.0019" }, { check: "S.STD.ADM.CHK.0051" }],
  steps: [
    { n: 1, verb: "NAVIGATE", target: "S.STD.ADM.SEL.0102", note: "Setup > Documenti > Form" },
    { n: 2, verb: "SELECT", target: "S.STD.ADM.SEL.0103", data: "{{form.name}}" },
    { n: 3, verb: "CLICK", target: "S.STD.ADM.SEL.0110", note: "Nuovo campo" },
    { n: 4, verb: "FILL", target: "S.STD.ADM.SEL.0111", data: "{{field.label}}" },
    { n: 5, verb: "CHOOSE", target: "S.STD.ADM.SEL.0112", data: "{{field.type}}" },
    { n: 6, verb: "TOGGLE", target: "S.STD.ADM.SEL.0113", data: "{{field.mandatory}}" },
    { n: 7, verb: "SAVE", target: "S.STD.ADM.SEL.0120", wait_for: "S.STD.ADM.SEL.0121" },
    { n: 8, verb: "VERIFY", check: "S.STD.ADM.CHK.0044" },
  ],
  verification_test: "NRT.STD.ADM.CFG.0014",
  verification: { fields: [{ sel: "S.STD.ADM.SEL.0111", label: "Centro di costo", mandatory: true, accepts: ["CC-100", "CC-200"], form: { url_pattern: "/requisition/new" }, save: "S.STD.ADM.SEL.0120", error: "S.STD.P2P.ERR.0007" }] },
  rollback: { kind: "procedure", ref: "S.STD.ADM.CFP.0015" },
  snapshot_before: ["S.STD.ADM.CFG.0031"],
  evidence: [{ at: 7, kind: "assertion" }, { at: 8, kind: "assertion" }],
  ...extra,
});

export const cfpClient = (id, extra = {}) => base(id, "CFP", "Campo personalizzato ACME con pubblicazione esplicita", {
  derives_from: "S.STD.ADM.CFP.0014",
  deviations: [
    { step: 5, reason: "tipi campo aggiuntivi da plugin", data_options_from: "C.ACME.ADM.CFG.0019", source: { doc: "ACME_Configurazione_v2.docx", section: "4.1", kind: "doc-cliente-tecnica" } },
    { after: 7, insert: { verb: "CLICK", target: "C.ACME.ADM.SEL.0007", note: "'Pubblica' esplicito" }, source: { obs: "L.ACME.ADM.OBS.0231", kind: "osservazione-chrome" } },
  ],
  confirmed_by_observation: ["L.ACME.ADM.OBS.0231", "L.ACME.ADM.OBS.0240"],
  ...extra,
});

export const flw = (id, extra = {}) => base(id, "FLW", "Creare una richiesta d'acquisto in bozza", {
  actor: "buyer", trigger: "fabbisogno", document: "requisition",
  preconditions: ["fornitore attivo"], postconditions: ["RdA in stato Bozza"], invariants: ["numero RdA univoco"],
  steps: [
    { n: 1, verb: "NAVIGATE", target: { url_pattern: "/requisition/new" }, expect: { page_sig: "requisition/new" } },
    { n: 2, verb: "FILL", target: "C.ACME.P2P.SEL.0001", data: "{{supplier}}", expect: { value: "{{supplier}}" } },
    { n: 3, verb: "SAVE", target: "C.ACME.P2P.SEL.0002", creates: { entity: "requisition", kind: "create" }, expect: { toast: "Bozza salvata" } },
  ],
  compensation: { kind: "cancel", action: "requisition.cancel-draft" },
  evidence: [{ at: 3, kind: "assertion" }],
  ...extra,
});

export const key = (id, extra = {}) => base(id, "KEY", "Partita IVA del fornitore", {
  entity: "supplier", field: "S.STD.VEN.FLD.0003",
  uniqueness: { scope: "tenant", normalization: "maiuscolo senza spazi", channels: ["ui", "import"], gaps: [] },
  reuse_after_deactivation: "forbidden", immutable_after: "Attivo", format: { pattern: "^IT\\d{11}$", max_length: 13, transform: null, truncation: "none" },
  cross_system: [{ system: "SAP", field: "STCD1", existence_validated_locally: false }], document_impact: { severity: "blocking", documents: ["order"] },
  enforced_at: ["ui"], mandatory_in: ["Attivo"], ...extra,
});

export const lcy = (id, extra = {}) => base(id, "LCY", "Ciclo di vita della richiesta d'acquisto", {
  document: "requisition", states: ["Bozza", "In approvazione", "Approvata"],
  transitions: [{ from: "Bozza", to: "In approvazione", action: "submit" }, { from: "In approvazione", to: "Approvata", action: "approve", role: "approver" }],
  mandatory_by_state: { "In approvazione": ["S.STD.P2P.FLD.0001"] }, immutable_after: "Approvata",
  validations: [{ rule: "importo > 0", on_fail: "block" }, { rule: "centro di costo coerente", on_fail: "undocumented" }], ...extra,
});

export const int = (id, extra = {}) => base(id, "INT", "IDoc ORDERS verso SAP", {
  protocol: "IDoc", direction: "outbound", trigger: "ordine approvato", mode_latency: { mode: "async", p95_s: 300 },
  mappings: [
    { field: "S.STD.P2P.FLD.0001", target: "E1EDK01/BELNR", mandatory: true, key_ref: "S.STD.P2P.KEY.0001" },
    { field: "S.STD.P2P.FLD.0002", target: "E1EDKA1/PARTN", mandatory: false, one_of: { group: "partner", required: true } },
  ],
  error_catalog: [{ code: "E51", description: "fornitore sconosciuto" }],
  silence_semantics: { silent_failure_possible: true, on_empty_mandatory: "silent" },
  e2e_checkpoint: { stage: "queued_accepted" }, owner_scope: "P2P", touches_scopes: ["P2P", "XSC"],
  tolerances: { numeric: { "E1EDP01/MENGE": 0.001 }, ignore_fields: ["EDI_DC40/CREDAT"], order_insensitive: ["E1EDP01"], date_formats: ["YYYYMMDD"] },
  document_impact: { severity: "blocking" }, ...extra,
});

export const cfg = (id, extra = {}) => base(id, "CFG", "Campo personalizzato Centro di costo sul form RdA", {
  area: "CL-CFG-005", location: { path: "Setup > Documenti > Form", page_sig: "setup/forms", selectors: ["S.STD.ADM.SEL.0111"] },
  options: ["testo", "lista"], dependencies: [], impacts: ["S.STD.P2P.FLD.0001"],
  current_state: { value: "assente", observed_at: "2026-09-01", source: "osservazione" }, risk: "R2",
  rollback: { kind: "procedure", ref: "S.STD.ADM.CFP.0015" }, ...extra,
});

export const nrtCase = (id = "NRT.ACME.P2P.NEG.0001", extra = {}) => {
  const [, , scope, genre] = id.split(".");
  return {
    id, type: "NRT", title: "RdA senza centro di costo in approvazione è rifiutata", scope, genre, state: "candidate",
    persona: "buyer", criticality: "alta",
    composition: {
      flows: ["C.ACME.P2P.FLW.0001"],
      steps: [
        { n: 1, verb: "NAVIGATE", target: { url_pattern: "/requisition/new" }, expect: { page_sig: "requisition/new" } },
        { n: 2, verb: "FILL", target: "C.ACME.P2P.SEL.0001", data: "{{fixture.supplier}}", expect: { value: "{{fixture.supplier}}" } },
        { n: 3, verb: "SAVE", target: "C.ACME.P2P.SEL.0002", creates: { entity: "requisition", kind: "create" }, expect: { toast: "Bozza salvata" } },
        { n: 4, verb: "SUBMIT", target: "C.ACME.P2P.SEL.0003", creates: { entity: "requisition", kind: "submit" }, expect: { messages: ["Centro di costo obbligatorio"] } },
      ],
    },
    derivation: { from: ["S.STD.P2P.FLD.0001"], risk_mode: "obbligatorio condizionale non applicato", rule: "§27.2 FLD.mandatory.kind: conditional", strategy: "ciclo-di-vita", condition: "importo > 5000", state: "In approvazione" },
    boundary: { stop_at_step: 4, does_not_assert: ["l'approvazione successiva"] },
    evidence: [{ at: 4, kind: "assertion" }],
    alm: { test_key: null, labels: ["scope:P2P"] },
    epistemic_at_generation: { shape: "consolidato", subject: "S.STD.P2P.FLD.0001" },
    fixtures: [{ name: "supplier", kind: "supplier", lookup_or_fail: { kind: "supplier", tag: "attivo-it" } }],
    compensations: [{ step: 3, kind: "cancel", entity: "requisition", action: "requisition.cancel-draft" }, { step: 4, kind: "cancel", entity: "requisition", action: "requisition.withdraw" }],
    expected_errors: ["S.STD.P2P.ERR.0007"],
    ...extra,
  };
};

// Workspace temporaneo con cliente ACME: scrive item (per tipo nella cartella di §8.2) e file arbitrari.
const DIRS = { SEL: "selectors", CHK: "checks", CFP: "procedures", FLW: "flows", KEY: "keys", LCY: "lifecycles", INT: "integrations", CFG: "configs", FLD: "fields", ERR: "errors", HND: null };
export function kbWs() { const ws = mkdtempSync(join(tmpdir(), "jvc-wp09b-")); mkdirSync(join(ws, "customers/ACME/config"), { recursive: true }); return ws; }
export function writeItem(ws, item) {
  const [level, cust, scope, type] = item.id.split(".");
  const root = level === "S" ? join(ws, "product/kb") : join(ws, "customers", cust, "kb");
  const dir = DIRS[type] === null ? join(root, "handoffs") : join(root, "scopes", scope, DIRS[type] ?? type.toLowerCase());
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${item.id}.yaml`);
  writeFileSync(f, YAML.stringify(item));
  return f;
}
export function writeCase(ws, c, customer = "ACME") {
  const dir = join(ws, "customers", customer, "tests", "cases", c.scope);
  mkdirSync(dir, { recursive: true });
  const f = join(dir, `${c.id}.yaml`);
  writeFileSync(f, YAML.stringify(c));
  return f;
}
export function writeYaml(ws, rel, obj) { const f = join(ws, rel); mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, YAML.stringify(obj)); return f; }
