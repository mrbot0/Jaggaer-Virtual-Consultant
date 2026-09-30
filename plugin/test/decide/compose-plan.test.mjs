// Soluzione A (spec 2026-09-30 §A3): compose-plan — piano dalla mappa e dai dati, oppure l'elenco delle mancanze.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeDraft } from "../../scripts/kb/atlas-write.mjs";
import { composePlan } from "../../scripts/decide/compose-plan.mjs";
import { validatePlan } from "../../scripts/decide/validate-plan.mjs";

const ENV = { id: "sandbox", type: "sandbox" };
const code = (r, label) => r.written.find((w) => w.label.trim() === label).code;
function atlas({ dupDescrizione = false } = {}) {
  const ws = mkdtempSync(join(tmpdir(), "compose-"));
  mkdirSync(join(ws, "customers/ACME"), { recursive: true });
  const page = { signature: "p2p/po/new#nuovo-ordine", title: "Nuovo ordine" };
  const f = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page, items: [
    { type: "FLD", label: "Descrizione", document: "Nuovo ordine", section: "Testata", field_type: "text", mandatory: "always" },
    { type: "FLD", label: "Divisa", document: "Nuovo ordine", section: "Testata", field_type: "list" },
    { type: "FLD", label: "Centro di costo", document: "Nuovo ordine", section: "Testata", field_type: "text", mandatory: "always" }] } });
  const s = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page, items: [
    { type: "SEL", label: "Descrizione", role: "textbox", field: code(f, "Descrizione") },
    ...(dupDescrizione ? [{ type: "SEL", label: "Descrizione (note)", role: "textbox", field: code(f, "Descrizione") }] : []),
    { type: "SEL", label: "Divisa", role: "combobox", field: code(f, "Divisa") },
    { type: "SEL", label: "Centro di costo", role: "textbox", field: code(f, "Centro di costo") },
    { type: "SEL", label: "Salva bozza", role: "button" }, { type: "SEL", label: "Invia", role: "button" }] } });
  const h = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page: { signature: "home#benvenuto" }, items: [{ type: "SEL", label: "Ordini", role: "link" }] } });
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { items: [{ type: "FLW", title: "Percorso: Nuovo ordine", trigger: "navigazione", steps: [
    { verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "/home" }, expect: { page_sig: "home" } },
    { verb: "CLICK", action_class: "ACT-OBS", target: code(h, "Ordini"), expect: { page_sig: "p2p/po/new" } }] }] } });
  return { ws, sel: (l) => code(s, l) };
}
const DATA = { Descrizione: "Sedie per sala riunioni", Divisa: "EUR", "Centro di costo": "IT-0442" };

test("senza procedura memorizzata: percorso + un passo per campo + salva + compensazione; valido per validate-plan", () => {
  const { ws } = atlas();
  const r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine per sedie", data: DATA, planId: "PLAN.ACME.PO.0001" });
  assert.ok(r.plan, JSON.stringify(r.gaps));
  assert.deepEqual(r.plan.steps.map((s) => s.verb), ["NAVIGATE", "CLICK", "FILL", "CHOOSE", "FILL", "SAVE"]);
  assert.equal(r.plan.steps.find((s) => s.verb === "CHOOSE").data, "EUR");
  assert.deepEqual(r.plan.compensations, [{ step: 6, kind: "cancel", entity: "ordine", action: "ordine.cancel" }]);
  assert.deepEqual(validatePlan(r.plan, { env: ENV }).errors, []);
});

test("fino a invio: SUBMIT ACT-SUBMIT dopo il salvataggio", () => {
  const r = composePlan({ ws: atlas().ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: DATA, until: "invio", planId: "PLAN.ACME.PO.0002" });
  assert.ok(r.plan, JSON.stringify(r.gaps));
  assert.equal(r.plan.steps.at(-1).verb, "SUBMIT");
  assert.equal(r.plan.steps.at(-1).action_class, "ACT-SUBMIT");
  assert.deepEqual(validatePlan(r.plan, { env: ENV }).errors, []);
});

test("mancanze: obbligatorio senza dato, campo sconosciuto, elemento ambiguo, modulo inesistente ⇒ nessun piano", () => {
  const miss = composePlan({ ws: atlas().ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x", Colore: "blu" }, planId: "PLAN.ACME.PO.0003" });
  assert.equal(miss.plan, undefined);
  assert.ok(miss.gaps.some((g) => g.kind === "missing-data" && g.what === "Centro di costo"), JSON.stringify(miss.gaps));
  assert.ok(miss.gaps.some((g) => g.kind === "unknown-field" && g.what === "Colore"));
  const amb = composePlan({ ws: atlas({ dupDescrizione: true }).ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: DATA, planId: "PLAN.ACME.PO.0004" });
  assert.ok(amb.gaps?.some((g) => g.kind === "ambiguous" && g.what === "Descrizione"), JSON.stringify(amb));
  const none = composePlan({ ws: atlas().ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea contratto", data: {}, planId: "PLAN.ACME.CO.0001" });
  assert.ok(none.gaps.some((g) => g.kind === "no-form"));
});

test("procedura memorizzata: riusata con i dati nuovi", () => {
  const { ws, sel } = atlas();
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { run: "RUN.ACME.20260930.0900.P2P", items: [{ type: "FLW", title: "Crea ordine", steps: [
    { verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "/p2p/po/new" }, expect: { page_sig: "p2p/po/new" } },
    { verb: "FILL", action_class: "ACT-CREATE", target: sel("Descrizione"), data: "vecchio", expect: { elements: [{ sel: sel("Descrizione") }] } },
    { verb: "FILL", action_class: "ACT-CREATE", target: sel("Centro di costo"), data: "vecchio", expect: { elements: [{ sel: sel("Centro di costo") }] } },
    { verb: "SAVE", action_class: "ACT-CREATE", target: sel("Salva bozza"), expect: { page_sig: "p2p/po" } }] }] } });
  const r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "nuovo", "Centro di costo": "IT-1" }, planId: "PLAN.ACME.PO.0005" });
  assert.ok(r.plan, JSON.stringify(r.gaps));
  assert.deepEqual(r.plan.steps.filter((s) => s.verb === "FILL").map((s) => s.data), ["nuovo", "IT-1"]);
  assert.deepEqual(validatePlan(r.plan, { env: ENV }).errors, []);
});
