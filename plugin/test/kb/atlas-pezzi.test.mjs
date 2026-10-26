// Esplorazione libera e pagine pesanti (brief 26/10/2026, punto 3): il registro dell'esplorazione non ha più il tetto di
// 300 elementi per pagina (resta il tetto del file, 20 MB, e al più 20 righe per tabella); anche le letture parziali (i
// pezzi di una pagina pesante, non i find) scrivono un record della pagina marcato partial: true, con la firma della mappa
// a cui si sommano; atlas-build unisce i record parziali consecutivi della stessa page_sig in una sola visita (unione
// degli elementi, senza doppioni) prima di costruire campi, selettori e "da fare".
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSnapshot } from "../../scripts/chrome/snapshot-parse.mjs";
import { pageRecord } from "../../hooks/lib/atlas-log.mjs";
import { buildDrafts, atlasBuild, atlasTodo } from "../../scripts/kb/atlas-build.mjs";
import { envWs, patchSession, ROOT } from "../helpers/env-fixture.mjs";
import { runHook } from "../helpers/hook-env.mjs";

test("pageRecord: nessun tetto di 300 elementi per pagina; al più 20 righe per tabella; partial: true sulle letture parziali", () => {
  const many = `uid=9_0 RootWebArea "X" url="https://h/x"\n${Array.from({ length: 450 }, (_, i) => `  uid=9_${i + 1} button "B${i}"`).join("\n")}\n`;
  const r = pageRecord(parseSnapshot(many), { pageSig: "x", profile: "standard", env: {} });
  assert.equal(r.elements.length, 450);
  assert.equal(r.partial, undefined);
  const rows = Array.from({ length: 40 }, (_, i) => `    uid=2_${100 + i} row\n      uid=2_${200 + i} cell "Riga ${i}"`).join("\n");
  const t = pageRecord(parseSnapshot(`uid=2_0 RootWebArea "X" url="https://h/x"\n  uid=2_2 table "T"\n${rows}\n`), { pageSig: "x", profile: "standard", env: {} });
  assert.ok(t.elements.filter((e) => e.role === "row").length <= 20);
  assert.equal(pageRecord(parseSnapshot(many), { pageSig: "x", profile: "standard", env: {}, partial: true }).partial, true);
});

const atlasTodoKinds = (d) => atlasTodo(d).map((t) => t.kind);
const CL = "mcp__claude-in-chrome__";
const URL = "https://acme-sbx.jaggaer.com/p2p/po/new";
let seq = 0;
const E = (ws) => ({ JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const post = (ws, tool, ti, body) => {
  const i = { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input: ti, tool_use_id: `toolu_ap_${++seq}`,
    tool_response: [{ type: "text", text: body }, { type: "text", text: `\n\nTab Context:\n- Executed on tabId: 101\n- Available tabs:\n  • tabId 101: "ACME" (${URL})` }] };
  runHook("browser-origin", i, E(ws));
  return runHook("observe-append", i, E(ws));
};
const log = (ws) => { const f = join(ws, "customers/ACME/.sessions/sess-1/atlas/pages.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };

test("observe-append: i pezzi di una pagina scrivono record marcati partial con la firma della mappa; un find non scrive pagine", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  patchSession(ws, (s) => { s.browser = { current_url: URL, tab: "101", updated_by: "browser-origin" }; });
  post(ws, CL + "navigate", { url: URL, tabId: 101 }, `Navigated to ${URL}`);
  post(ws, CL + "read_page", { tabId: 101, ref_id: "ref_1" }, `heading "Nuovo ordine" [ref_2]\nlink "Ordini" [ref_3]`);
  post(ws, CL + "read_page", { tabId: 101, ref_id: "ref_10" }, `textbox "Descrizione" [ref_11]\nbutton "Salva bozza" [ref_12]`);
  post(ws, CL + "find", { tabId: 101, query: "salva" }, `Found 1 matching element\n- button "Salva bozza" [ref_12]`);
  const pages = log(ws).filter((l) => l.kind === "page");
  assert.equal(pages.length, 2, JSON.stringify(log(ws)));
  assert.ok(pages.every((p) => p.partial === true));
  assert.equal(pages[0].page_sig, pages[1].page_sig, "stessa pagina, stessa firma (quella della mappa)");
  assert.ok(pages[1].elements.some((e) => e.name === "Salva bozza"));
});

test("atlas-build: i record parziali consecutivi della stessa page_sig sono una visita sola (unione senza doppioni); un'altra firma è un'altra pagina", () => {
  const sig = "p2p/po/new#nuovo-ordine";
  const p1 = { kind: "page", partial: true, page_sig: sig, title: "Nuovo ordine", url_path: "/p2p/po/new", elements: [
    { i: 0, parent: null, role: "heading", name: "Nuovo ordine", level: 1 }, { i: 1, parent: null, role: "textbox", name: "Descrizione", required: true },
    { i: 2, parent: null, role: "combobox", name: "Divisa" }] };
  // secondo pezzo: la tendina aperta (radice del pezzo = la combobox già vista) e la barra in fondo; Descrizione ripetuta
  const p2 = { kind: "page", partial: true, page_sig: sig, title: "Nuovo ordine", url_path: "/p2p/po/new", elements: [
    { i: 0, parent: null, role: "combobox", name: "Divisa" }, { i: 1, parent: 0, role: "option", name: "EUR" }, { i: 2, parent: 0, role: "option", name: "USD" },
    { i: 3, parent: null, role: "textbox", name: "Descrizione", sample: "prova" }, { i: 4, parent: null, role: "button", name: "Salva bozza" }] };
  const other = { kind: "page", partial: true, page_sig: "p2p/po/list#ordini", title: "Ordini", url_path: "/p2p/po/list", elements: [{ i: 0, parent: null, role: "heading", name: "Ordini", level: 1 }] };
  const d = buildDrafts([p1, p2, { kind: "click", from_sig: sig, target: { name: "Salva bozza" }, effect: true }, other]);
  assert.equal(d.pages.size, 2);
  assert.equal(d.pages.get(sig).visits.length, 1, "i due pezzi sono una visita");
  const visit = d.pages.get(sig).visits[0];
  assert.equal(visit.filter((e) => e.name === "Descrizione").length, 1, "senza doppioni");
  assert.equal(visit.filter((e) => e.name === "Divisa").length, 1);
  const desc = d.fields.find((f) => f.label === "Descrizione");
  assert.ok(desc && !desc.ambiguous, JSON.stringify(desc));
  assert.equal(desc.mandatory, "always");
  assert.deepEqual(desc.samples, ["prova"]);
  assert.deepEqual(d.fields.find((f) => f.label === "Divisa").options, ["EUR", "USD"], "opzioni sotto la tendina giusta");
  assert.ok(d.sels.some((s) => s.label === "Salva bozza"), "elemento del secondo pezzo");
  assert.deepEqual(d.effects.map((e) => [e.page, e.action, e.result]), [["Nuovo ordine", "Salva bozza", "Ordini"]]);
  assert.ok(!atlasTodoKinds(d).includes("open-dropdown"), "la tendina aperta nel pezzo non è più da fare");
});

test("atlas-build: un pezzo dopo la lettura completa della stessa pagina la completa; due letture complete restano due visite", () => {
  const sig = "x#x";
  const full = { kind: "page", page_sig: sig, title: "X", url_path: "/x", elements: [{ i: 0, parent: null, role: "heading", name: "X", level: 1 }, { i: 1, parent: null, role: "button", name: "Apri" }] };
  const piece = { kind: "page", partial: true, page_sig: sig, title: "X", url_path: "/x", elements: [{ i: 0, parent: null, role: "button", name: "Apri" }, { i: 1, parent: null, role: "link", name: "Dettaglio" }] };
  const d = buildDrafts([full, piece]);
  assert.equal(d.pages.get(sig).visits.length, 1);
  assert.deepEqual(d.pages.get(sig).visits[0].map((e) => e.name), ["X", "Apri", "Dettaglio"]);
  assert.equal(buildDrafts([full, full]).pages.get(sig).visits.length, 2);
  // atlasBuild sul file della sessione
  const ws = mkdtempSync(join(tmpdir(), "ap-ab-"));
  mkdirSync(join(ws, "customers/ACME/.sessions/s1/atlas"), { recursive: true });
  writeFileSync(join(ws, "customers/ACME/.sessions/s1/atlas/pages.jsonl"), `${[full, piece].map((l) => JSON.stringify(l)).join("\n")}\n`);
  const r = atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "s1" });
  assert.equal(r.pages, 1);
  assert.ok(r.written.some((w) => /Dettaglio/.test(JSON.stringify(w))), JSON.stringify(r.written));
});

