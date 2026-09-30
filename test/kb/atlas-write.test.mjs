// kb atlas-write (soluzione B, 30/09/2026): la bozza dell'agente diventa SEL/FLD/FLW del cliente, validati, senza
// doppioni, codici dal DB; un piano diventa procedura solo con esito verde.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { writeDraft, draftFromPlan } from "../../scripts/kb/atlas-write.mjs";
import { atlasIndex, atlasMatch } from "../../scripts/chrome/atlas.mjs";

function ws() {
  const w = mkdtempSync(join(tmpdir(), "atlasw-"));
  mkdirSync(join(w, "customers", "ACME"), { recursive: true });
  return w;
}
const DRAFT = {
  page: { url: "https://acme-pre.jaggaer.com/po/new?user=mario.rossi@example.com", signature: "/po/new#nuovo-ordine", title: "Nuovo ordine" },
  items: [
    { type: "SEL", label: "Ordini", role: "link" },
    { type: "SEL", label: "Salva", role: "button" },
    { type: "SEL", label: "Descrizione", role: "textbox", field: "C.ACME.P2P.FLD.0001" },
    { type: "FLD", label: "Descrizione", document: "Ordine", section: "Testata", field_type: "text", mandatory: "always" },
    { type: "FLD", label: "Divisa", document: "Ordine", section: "Testata", field_type: "list", options: ["EUR", "USD"] },
  ],
};

test("bozza ⇒ SEL/FLD del cliente con codici dal DB, effetto dedotto, fonti redatte; l'Atlas li ritrova; seconda scrittura = doppioni scartati", () => {
  const w = ws();
  const r = writeDraft({ ws: w, customer: "ACME", scope: "P2P", draft: DRAFT });
  assert.equal(r.written.length, 5);
  assert.deepEqual(r.written.map((x) => x.code), ["C.ACME.P2P.SEL.0001", "C.ACME.P2P.SEL.0002", "C.ACME.P2P.SEL.0003", "C.ACME.P2P.FLD.0001", "C.ACME.P2P.FLD.0002"]);
  const sel = (n) => readFileSync(join(w, `customers/ACME/kb/scopes/P2P/selectors/C.ACME.P2P.SEL.000${n}.yaml`), "utf8");
  assert.equal(YAML.parse(sel(2)).effect, "write");
  assert.equal(YAML.parse(sel(2)).facets.F12, "digerito");
  assert.equal(YAML.parse(sel(1)).effect, "read");
  assert.ok(!sel(1).includes("mario.rossi"), "URL redatto");
  assert.match(readFileSync(join(w, "customers/ACME/kb/scopes/P2P/fields/C.ACME.P2P.FLD.0002.yaml"), "utf8"), /EUR · USD/);
  assert.equal(atlasMatch(atlasIndex(w, "ACME", "P2P"), { role: "button", name: "Salva" })?.code, "C.ACME.P2P.SEL.0002");
  const again = writeDraft({ ws: w, customer: "ACME", scope: "P2P", draft: DRAFT });
  assert.equal(again.written.length, 0);
  assert.equal(again.skipped.length, 5);
});

test("bozza non valida ⇒ nessun file scritto; tipi non ammessi e clienti inesistenti rifiutati", () => {
  const w = ws();
  assert.throws(() => writeDraft({ ws: w, customer: "ACME", scope: "P2P", draft: { items: [{ type: "SEL", label: "Ok", role: "button" }, { type: "FLD", label: "X", document: "Ordine", field_type: "banana" }] } }), /field_type/);
  assert.ok(!existsSync(join(w, "customers/ACME/kb/scopes/P2P/selectors")));
  assert.throws(() => writeDraft({ ws: w, customer: "ACME", scope: "P2P", draft: { items: [{ type: "CFG", label: "x" }] } }), /tipo non ammesso/);
  assert.throws(() => writeDraft({ ws: w, customer: "BETA", scope: "P2P", draft: DRAFT }), /non esiste/);
});

test("piano ⇒ procedura FLW solo con esito verde, dati redatti, compensazione conservata; piano di un altro cliente rifiutato", () => {
  const w = ws();
  const run = join(w, "customers/ACME/runs/RUN.ACME.20260930.0900.P2P");
  mkdirSync(join(run, "results"), { recursive: true });
  const plan = { plan_id: "PLAN.ACME.PO.0001", customer: "ACME", env: "pre", goal: "crea ordine", steps: [
    { n: 1, verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "/po/new" }, expect: { page_sig: "/po/new" } },
    { n: 2, verb: "FILL", action_class: "ACT-CREATE", target: "C.ACME.P2P.SEL.0003", data: { value: "Carta per mario.rossi@example.com" }, expect: { elements: [{ sel: "C.ACME.P2P.SEL.0003" }] } },
    { n: 3, verb: "SAVE", action_class: "ACT-CREATE", target: "C.ACME.P2P.SEL.0002", expect: { toast: "salvato" } }],
    compensations: [{ step: 3, kind: "cancel", entity: "order", action: "order.cancel" }], repair_policy: { skip_allowed: false, substitute_allowed: false, abort_on: [] } };
  const pf = join(run, "plan.json");
  writeFileSync(pf, JSON.stringify(plan));
  assert.throws(() => draftFromPlan({ ws: w, customer: "ACME", planFile: pf, title: "Crea ordine" }), /esito verde/);
  writeFileSync(join(run, "results", "PLAN.ACME.PO.0001.yaml"), YAML.stringify({ plan_id: plan.plan_id, status: "green" }));
  const r = writeDraft({ ws: w, customer: "ACME", scope: "P2P", draft: draftFromPlan({ ws: w, customer: "ACME", planFile: pf, title: "Crea ordine" }) });
  assert.equal(r.written[0].code, "C.ACME.P2P.FLW.0001");
  const flw = readFileSync(join(w, "customers/ACME/kb/scopes/P2P/flows/C.ACME.P2P.FLW.0001.yaml"), "utf8");
  assert.ok(!flw.includes("mario.rossi"));
  assert.match(flw, /order\.cancel/);
  const other = join(run, "plan-beta.json");
  writeFileSync(other, JSON.stringify({ ...plan, customer: "BETA" }));
  assert.throws(() => draftFromPlan({ ws: w, customer: "ACME", planFile: other, title: "x" }), /cliente BETA/);
});
