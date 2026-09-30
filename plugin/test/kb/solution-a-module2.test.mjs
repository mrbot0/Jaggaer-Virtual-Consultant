// Soluzione A — modulo di appartenenza, revisione: il modulo è della pagina (non della strada fatta), il percorso deve
// arrivare alla pagina del modulo di creazione, --modulo non nasconde gli item senza modulo, briciole di pane pulite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { buildDrafts, atlasBuild } from "../../scripts/kb/atlas-build.mjs";
import { writeDraft } from "../../scripts/kb/atlas-write.mjs";
import { composePlan } from "../../scripts/decide/compose-plan.mjs";

const ENV = { id: "sandbox", type: "sandbox" };
const H1 = (name) => ({ i: 0, parent: null, role: "heading", name, level: 1 });
const ws0 = () => { const ws = mkdtempSync(join(tmpdir(), "sa-mod2-")); mkdirSync(join(ws, "customers/ACME"), { recursive: true }); return ws; };
const writeLog = (ws, sid, lines) => { mkdirSync(join(ws, `customers/ACME/.sessions/${sid}/atlas`), { recursive: true }); writeFileSync(join(ws, `customers/ACME/.sessions/${sid}/atlas/pages.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`); };
const click = (from, name) => ({ kind: "click", from_sig: from, target: { name } });
const page = (sig, h1, extra = []) => ({ kind: "page", page_sig: sig, title: h1, url_path: `/${sig.split("#")[0]}`, elements: [H1(h1), ...extra.map((e, k) => ({ i: k + 1, parent: null, ...e }))] });
const FORM = [{ role: "textbox", name: "Descrizione" }, { role: "button", name: "Salva bozza" }];

test("M2-1: la stessa pagina raggiunta per un'altra strada mantiene il modulo già memorizzato (nessun doppione, nessuna ambiguità)", () => {
  const ws = ws0();
  writeLog(ws, "s1", [page("home#home", "Home", [{ role: "link", name: "Acquisti" }]), click("home#home", "Acquisti"),
    page("p2p#acquisti", "Acquisti", [{ role: "button", name: "Nuovo ordine" }]), click("p2p#acquisti", "Nuovo ordine"), page("p2p/po/new#nuovo-ordine", "Nuovo ordine", FORM)]);
  atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "s1" });
  writeLog(ws, "s2", [page("home#home", "Home", [{ role: "link", name: "Dashboard" }]), click("home#home", "Dashboard"),
    page("dash#dashboard", "Dashboard", [{ role: "button", name: "Nuovo ordine" }]), click("dash#dashboard", "Nuovo ordine"), page("p2p/po/new#nuovo-ordine", "Nuovo ordine", FORM)]);
  const r2 = atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "s2" });
  assert.ok(!r2.written.some((w) => w.type === "FLD"), JSON.stringify(r2.written));
  const flds = readdirSync(join(ws, "customers/ACME/kb/scopes/P2P/fields")).map((f) => YAML.parse(readFileSync(join(ws, "customers/ACME/kb/scopes/P2P/fields", f), "utf8")));
  assert.equal(flds.filter((f) => f.label.it === "Descrizione").length, 1);
  const r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x" }, planId: "PLAN.ACME.M21.1" });
  assert.ok(r.plan, JSON.stringify(r.gaps));
});

test("M2-2: un percorso che non arriva alla pagina del modulo di creazione non si usa ⇒ no-route", () => {
  const ws = ws0();
  const pg = { signature: "p2p/po/new#nuovo-ordine", title: "Nuovo ordine" };
  const f = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page: pg, items: [{ type: "FLD", label: "Descrizione", document: "Nuovo ordine", section: "T", field_type: "text", module: "Acquisti" }] } });
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page: pg, items: [{ type: "SEL", label: "Descrizione", role: "textbox", field: f.written[0].code, module: "Acquisti" }, { type: "SEL", label: "Salva bozza", role: "button", module: "Acquisti" }] } });
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { items: [{ type: "FLW", title: "Percorso: Nuovo ordine", steps: [{ verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "/con/po/new" }, expect: { page_sig: "con/po/new" } }] }] } });
  const r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x" }, planId: "PLAN.ACME.M22.1" });
  assert.ok(r.gaps?.some((g) => g.kind === "no-route"), JSON.stringify(r));
});

test("M2-3: --modulo non nasconde gli item senza modulo quando nessuno ha quel modulo; confronto per livelli, non per sottostringa", () => {
  const ws = ws0();
  const pg = { signature: "p#nuovo-ordine", title: "Nuovo ordine" };
  const f = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page: pg, items: [{ type: "FLD", label: "Descrizione", document: "Nuovo ordine", section: "T", field_type: "text" }] } });
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page: pg, items: [{ type: "SEL", label: "Descrizione", role: "textbox", field: f.written[0].code }, { type: "SEL", label: "Salva bozza", role: "button" }] } });
  writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { items: [{ type: "FLW", title: "Percorso: Nuovo ordine", steps: [{ verb: "NAVIGATE", action_class: "ACT-OBS", target: { url_pattern: "/p" }, expect: { page_sig: "p" } }] }] } });
  const r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x" }, module: "Acquisti", planId: "PLAN.ACME.M23.1" });
  assert.ok(r.plan, JSON.stringify(r.gaps));
});

test("M2-4: briciole di pane senza la radice Home e senza livelli con numeri o dati oscurati", () => {
  const els = [H1("Ordine PO-4500012345"), { i: 1, parent: null, role: "navigation", name: "Breadcrumb" }, { i: 2, parent: 1, role: "link", name: "Home" },
    { i: 3, parent: 1, role: "link", name: "Acquisti" }, { i: 4, parent: 1, role: "link", name: "Ordini" }, { i: 5, parent: 1, role: "link", name: "PO-4500012345 [email]" }];
  const d = buildDrafts([{ kind: "page", page_sig: "p2p/po/x#ordine", title: "Ordine", url_path: "/p2p/po/x", elements: els }]);
  assert.equal(d.pages.get("p2p/po/x#ordine").module, "Acquisti › Ordini");
});
