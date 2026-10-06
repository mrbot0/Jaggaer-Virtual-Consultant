// Soluzione A — seconda revisione: finding della verifica sul fix e sulla taratura automatica (RED prima della correzione).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSnapshot, pageSignature } from "../../scripts/chrome/snapshot-parse.mjs";
import { buildDrafts, atlasBuild } from "../../scripts/kb/atlas-build.mjs";
import { writeDraft, enrichField } from "../../scripts/kb/atlas-write.mjs";
import { composePlan } from "../../scripts/decide/compose-plan.mjs";
import { atlasMatch } from "../../scripts/chrome/atlas.mjs";
import { envWs, patchSession, ROOT } from "../helpers/env-fixture.mjs";
import { runHook } from "../helpers/hook-env.mjs";

const ENV = { id: "sandbox", type: "sandbox" };
const ws0 = () => { const ws = mkdtempSync(join(tmpdir(), "sa-rev2-")); mkdirSync(join(ws, "customers/ACME"), { recursive: true }); return ws; };
const writeLog = (ws, sid, lines) => { mkdirSync(join(ws, `customers/ACME/.sessions/${sid}/atlas`), { recursive: true }); writeFileSync(join(ws, `customers/ACME/.sessions/${sid}/atlas/pages.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`); };
const H1 = (name) => ({ i: 0, parent: null, role: "heading", name, level: 1 });

// Important 1 — record nei click anche quando la tabella arriva nella risposta di un click (snapshot legato, non completo)
test("R2-1: tabella mostrata dalla risposta di un click ⇒ il click successivo su una riga non entra nel registro", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  const URL = "https://acme-sbx.jaggaer.com/p2p/po";
  patchSession(ws, (s) => { s.browser = { current_url: URL, tab: "1", updated_by: "browser-origin" }; });
  const post = (tool, ti, text) => runHook("observe-append", { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input: ti, tool_response: [{ type: "text", text }] }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  const DT = "mcp__chrome-devtools__";
  post(`${DT}take_snapshot`, { pageId: 1 }, `## Latest page snapshot\nuid=1_0 RootWebArea "Home" url="${URL}"\n  uid=1_1 heading "Home" level="1"\n  uid=1_2 link "Ordini"\n`);
  post(`${DT}click`, { uid: "1_2", pageId: 1 }, `Successfully clicked on the element\n## Latest page snapshot\nuid=2_0 RootWebArea "Ordini" url="${URL}"\n  uid=2_1 heading "Ordini" level="1"\n  uid=2_3 table "Elenco"\n    uid=2_4 row\n      uid=2_5 cell "x"\n        uid=2_6 link "Mario Rossi"\n`);
  post(`${DT}click`, { uid: "2_6", pageId: 1 }, "Successfully clicked on the element");
  const f = join(ws, "customers/ACME/.sessions/sess-1/atlas/pages.jsonl");
  // esplorazione completa (05/10/2026): il click sulla riga si registra marcato record (snapshot di risposta a un click)
  const clicks = readFileSync(f, "utf8").trim().split(/\r?\n/).map((l) => JSON.parse(l)).filter((x) => x.kind === "click" && x.target?.name === "Mario Rossi");
  assert.ok(clicks.length && clicks.every((c) => c.record === true), readFileSync(f, "utf8"));
});

// Important 2 — l'elenco "da fare" deve potersi svuotare: conteggi dall'ultima visita; voci solo da riportare marcate
test("R2-2: todo dall'ultima visita (una visita successiva senza campi senza etichetta non li ripropone); voci auto vs da riportare", () => {
  const ws = ws0();
  const v1 = { kind: "page", page_sig: "p#f", title: "Nuovo ordine", url_path: "/p", iframes: 1, elements: [H1("Nuovo ordine"), { i: 1, parent: null, role: "textbox", name: "" }] };
  const v2 = { kind: "page", page_sig: "p#f", title: "Nuovo ordine", url_path: "/p", elements: [H1("Nuovo ordine"), { i: 1, parent: null, role: "textbox", name: "Descrizione" }, { i: 2, parent: null, role: "button", name: "Salva bozza" }] };
  writeLog(ws, "s1", [v1, v2]);
  const r = atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "s1" });
  assert.ok(!r.todo.some((t) => t.kind === "unlabeled" || t.kind === "iframe"), JSON.stringify(r.todo));
  writeLog(ws, "s2", [{ kind: "page", page_sig: "q#g", title: "Q", url_path: "/q", iframes: 2, elements: [H1("Q"), { i: 1, parent: null, role: "combobox", name: "Divisa" }, { i: 2, parent: null, role: "textbox", name: "" }] }]);
  const r2 = atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "s2" });
  assert.equal(r2.todo.find((t) => t.kind === "open-dropdown")?.auto, true, JSON.stringify(r2.todo));
  assert.equal(r2.todo.find((t) => t.kind === "unlabeled")?.auto, false);
  assert.equal(r2.todo.find((t) => t.kind === "iframe")?.auto, false);
});

// Important 3 — ambiguità vista in una sessione successiva: il campo già memorizzato la registra, compose-plan chiede
test("R2-3: 'Descrizione' unica nella sessione 1, doppia nella sessione 2 ⇒ compose-plan restituisce ambiguous", () => {
  const ws = ws0();
  const home = { kind: "page", page_sig: "home#h", title: "Home", url_path: "/home", elements: [H1("Home"), { i: 1, parent: null, role: "link", name: "Ordini" }] };
  const one = { kind: "page", page_sig: "p2p/po/new#nuovo-ordine", title: "Nuovo ordine", url_path: "/p2p/po/new", elements: [H1("Nuovo ordine"), { i: 1, parent: null, role: "textbox", name: "Descrizione" }, { i: 2, parent: null, role: "button", name: "Salva bozza" }] };
  writeLog(ws, "s1", [home, { kind: "click", from_sig: "home#h", target: { name: "Ordini" } }, one]);
  atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "s1" });
  const two = { ...one, elements: [...one.elements, { i: 3, parent: null, role: "textbox", name: "Descrizione" }] };
  writeLog(ws, "s2", [two]);
  atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "s2" });
  const r = composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: { Descrizione: "x" }, planId: "PLAN.ACME.R23.1" });
  assert.ok(r.gaps?.some((g) => g.kind === "ambiguous" && g.what === "Descrizione"), JSON.stringify(r));
});

// Minori
test("R2-m: enrichField solo su FLD del cliente e dello scope; elenchi di persone più ampi; page_sig redatta; CREATE esclude 'creati'; atlasMatch con la pagina e senza corrispondenti ⇒ null", () => {
  const ws = ws0();
  assert.equal(enrichField({ ws, customer: "ACME", scope: "P2P", code: "S.STD.P2P.FLD.0003", options: ["A", "B"] }), false);
  const els = [H1("Nuovo ordine"), { i: 1, parent: null, role: "combobox", name: "Nominativo" }, { i: 2, parent: 1, role: "option", name: "Mario" }, { i: 3, parent: 1, role: "option", name: "Anna" }];
  assert.equal(buildDrafts([{ kind: "page", page_sig: "p#f", title: "T", url_path: "/p", elements: els }]).fields[0].options, undefined);
  const sig = pageSignature(parseSnapshot(`uid=1_0 RootWebArea "X" url="https://h/u/mario.rossi@acme.it/o"\n  uid=1_1 heading "X" level="1"\n`), { profile: "strict" });
  assert.ok(!sig.includes("mario.rossi"), sig);
  const f = writeDraft({ ws, customer: "ACME", scope: "P2P", draft: { page: { signature: "l#l" }, items: [{ type: "FLD", label: "Descrizione", document: "Ordini creati", section: "T", field_type: "text" }] } });
  assert.equal(f.written.length, 1);
  assert.ok(composePlan({ ws, customer: "ACME", scope: "P2P", env: ENV, goal: "crea ordine", data: {}, planId: "PLAN.ACME.R2M.1" }).gaps?.some((g) => g.kind === "no-form"));
  const atlas = [{ code: "C.ACME.P2P.SEL.0001", role: "button", label: "Salva", page: "a#a" }];
  assert.equal(atlasMatch(atlas, { role: "button", name: "Salva" }, { page: "b#b" }), null);
});
