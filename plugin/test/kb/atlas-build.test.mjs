// Soluzione A (spec 2026-09-30 §A2): kb atlas-build — dal registro dell'esplorazione a FLD, SEL e percorsi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { buildDrafts, atlasBuild } from "../../scripts/kb/atlas-build.mjs";

const home = { kind: "page", ts: "1", url_path: "/home", page_sig: "home#benvenuto", title: "Home", elements: [
  { i: 0, parent: null, role: "heading", name: "Benvenuto", level: 1 }, { i: 1, parent: null, role: "link", name: "Ordini" }] };
const list = { kind: "page", ts: "3", url_path: "/p2p/po", page_sig: "p2p/po#ordini", title: "Ordini", elements: [
  { i: 0, parent: null, role: "heading", name: "Ordini", level: 1 }, { i: 1, parent: null, role: "button", name: "Nuovo ordine" }] };
const form = { kind: "page", ts: "5", url_path: "/p2p/po/new", page_sig: "p2p/po/new#nuovo-ordine", title: "Nuovo ordine", elements: [
  { i: 0, parent: null, role: "heading", name: "Nuovo ordine", level: 1 },
  { i: 1, parent: null, role: "group", name: "Testata" },
  { i: 2, parent: 1, role: "textbox", name: "Descrizione", required: true },
  { i: 3, parent: 1, role: "combobox", name: "Divisa" }, { i: 4, parent: 3, role: "option", name: "EUR" }, { i: 5, parent: 3, role: "option", name: "USD" },
  { i: 6, parent: null, role: "button", name: "Salva bozza" }] };
const LOG = [home, { kind: "click", ts: "2", from_sig: "home#benvenuto", target: { name: "Ordini" } }, list,
  { kind: "click", ts: "4", from_sig: "p2p/po#ordini", target: { name: "Nuovo ordine" } }, form];

test("buildDrafts: FLD con tipo, obbligo, sezione, opzioni; percorso home → ordini → nuovo ordine", () => {
  const d = buildDrafts(LOG);
  const desc = d.fields.find((f) => f.label === "Descrizione");
  assert.deepEqual([desc.document, desc.section, desc.field_type, desc.mandatory], ["Nuovo ordine", "Testata", "text", "always"]);
  assert.deepEqual(d.fields.find((f) => f.label === "Divisa").options, ["EUR", "USD"]);
  const r = d.routes.find((x) => x.page_sig === "p2p/po/new#nuovo-ordine");
  assert.deepEqual(r.steps.map((s) => (s.kind === "click" ? s.name : s.url_path)), ["/home", "Ordini", "Nuovo ordine"]);
});

test("atlasBuild: FLD, SEL legati ai campi, percorsi; seconda esecuzione senza item nuovi", () => {
  const ws = mkdtempSync(join(tmpdir(), "abuild-"));
  mkdirSync(join(ws, "customers/ACME/.sessions/sess-1/atlas"), { recursive: true });
  writeFileSync(join(ws, "customers/ACME/.sessions/sess-1/atlas/pages.jsonl"), `${LOG.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const r = atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "sess-1" });
  assert.ok(r.written.length >= 7, JSON.stringify(r));
  const kb = join(ws, "customers/ACME/kb/scopes/P2P");
  const load = (dir) => readdirSync(join(kb, dir)).map((f) => YAML.parse(readFileSync(join(kb, dir, f), "utf8")));
  const sels = load("selectors");
  assert.match(sels.find((s) => s.label === "Descrizione").field, /^C\.ACME\.P2P\.FLD\.\d{4}$/);
  assert.equal(sels.find((s) => s.label === "Salva bozza").effect, "write");
  const route = load("flows").find((f) => f.title === "Percorso: Nuovo ordine");
  assert.deepEqual(route.steps.map((s) => s.verb), ["NAVIGATE", "CLICK", "CLICK"]);
  assert.match(route.steps[2].target, /^C\.ACME\.P2P\.SEL\.\d{4}$/);
  assert.equal(route.steps[2].expect.page_sig, "p2p/po/new");
  const again = atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "sess-1" });
  assert.equal(again.written.length, 0, JSON.stringify(again.written));
});

test("atlasBuild: registro assente ⇒ errore d'uso (exit 1)", () => {
  const ws = mkdtempSync(join(tmpdir(), "abuild-"));
  mkdirSync(join(ws, "customers/ACME"), { recursive: true });
  assert.throws(() => atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "nessuna" }), (e) => e.code === 1);
});
