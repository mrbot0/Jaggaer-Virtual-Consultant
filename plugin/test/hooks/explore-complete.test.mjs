// Esplorazione completa (richiesta dell'utente, 05/10/2026): in sandbox e pre-produzione, con ESPLORA <AMBIENTE> COMPLETA,
// l'agente clicca tutto, compila con valori di prova, salva, invia, approva, conferma i dialoghi — mai Elimina, mai upload,
// mai script; ogni azione con effetto finisce nel registro; in esplorazione niente tetti per agente (resta il budget di
// token e i limiti dichiarati dall'utente); il registro delle pagine è più ricco (struttura, valori di esempio, righe).
import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFileSync, mkdtempSync, appendFileSync, readFileSync, readdirSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import YAML from "yaml";
import { runHook, runSessionCli, decisionOf, reasonOf, ROOT } from "../helpers/hook-env.mjs";
import { envWs, browserCall, patchSession } from "../helpers/env-fixture.mjs";
import { parseApprovalPrompt } from "../../scripts/admin/approvals.mjs";
import { parseSnapshot } from "../../scripts/chrome/snapshot-parse.mjs";
import { pageRecord } from "../../hooks/lib/atlas-log.mjs";
import { effectiveLimits } from "../../hooks/lib/guards/control.mjs";
import { buildDrafts, atlasBuild } from "../../scripts/kb/atlas-build.mjs";

const DT = "mcp__chrome-devtools__";
const denied = (r) => decisionOf(r) === "deny";
const silent = (r) => r.status === 0 && r.stdout.trim() === "";
const URL = "https://acme-pre.jaggaer.com/p2p/po/new";
const NAMES = { "1_1": "Ordini", "1_3": "Salva", "1_4": "Invia per approvazione", "1_5": "Descrizione", "1_6": "Elimina bozza", "1_7": "Approva" };

function say(ws, tr, prompt) {
  appendFileSync(tr, `${JSON.stringify({ type: "user", isSidechain: false, userType: "external", message: { role: "user", content: prompt }, timestamp: new Date().toISOString() })}\n`);
  return runHook("approval-capture", { session_id: "sess-1", cwd: ws, hook_event_name: "UserPromptSubmit", prompt, transcript_path: tr }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
}
function setup(env = "preprod", phrase = "ESPLORA PREPROD COMPLETA") {
  const ws = envWs({ env, scope: "P2P" });
  const tr = join(mkdtempSync(join(tmpdir(), "xc-")), "t.jsonl"); writeFileSync(tr, "");
  say(ws, tr, phrase);
  const r = runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: ws });
  assert.equal(r.status, 0, r.stderr + r.stdout);
  patchSession(ws, (s) => { s.browser = { ...(s.browser ?? {}), current_url: URL, tab: "1", snapshot: { obs: "x", url: URL, tab: "1", ts: new Date().toISOString(), refs: Object.fromEntries(Object.keys(NAMES).map((k) => [k, null])), names: NAMES } }; });
  const c = (t, i) => browserCall("guard-config-scope", ws, t, i, { transcript_path: tr });
  return { ws, tr, c };
}

test("frasi: ESPLORA PREPROD COMPLETA e ESPLORA SANDBOX COMPLETA; il modello non può scriverle", () => {
  assert.deepEqual(parseApprovalPrompt("ESPLORA PREPROD COMPLETA"), { kind: "explore", env_type: "preprod", full: true });
  assert.deepEqual(parseApprovalPrompt("ESPLORA SANDBOX COMPLETA"), { kind: "explore", env_type: "sandbox", full: true });
  assert.deepEqual(parseApprovalPrompt("ESPLORA PREPROD"), { kind: "explore", env_type: "preprod" });
  const ws = envWs({ env: "preprod", scope: "P2P" });
  const g = runHook("guard-phrase", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "echo ESPLORA PREPROD COMPLETA" } }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
  assert.ok(denied(g));
});

test("pre-produzione completa: salva, invia, approva, compila, Invio, conferma dialogo consentiti; Elimina, upload, script negati", () => {
  const { c } = setup();
  for (const uid of ["1_1", "1_3", "1_4", "1_7"]) assert.ok(silent(c(`${DT}click`, { uid, pageId: 1 })), NAMES[uid]);
  assert.ok(silent(c(`${DT}fill`, { uid: "1_5", value: "TEST JVC", pageId: 1 })), "compilare");
  assert.ok(silent(c(`${DT}press_key`, { key: "Enter", pageId: 1 })), "Invio");
  assert.ok(silent(c(`${DT}handle_dialog`, { action: "accept", pageId: 1 })), "conferma del dialogo");
  const del = c(`${DT}click`, { uid: "1_6", pageId: 1 });
  assert.ok(denied(del), "Elimina"); assert.match(reasonOf(del), /elimin|cancell|delete/i);
  assert.ok(denied(c(`${DT}upload_file`, { uid: "1_5", filePath: "x.pdf", pageId: 1 })), "upload");
  assert.ok(denied(c(`${DT}evaluate_script`, { function: "() => 1", pageId: 1 })), "script");
});

test("pre-produzione con ESPLORA PREPROD semplice: invariato (solo click senza effetto)", () => {
  const { c } = setup("preprod", "ESPLORA PREPROD");
  assert.ok(silent(c(`${DT}click`, { uid: "1_1", pageId: 1 })));
  assert.ok(denied(c(`${DT}click`, { uid: "1_3", pageId: 1 })), "Salva resta negato senza COMPLETA");
  assert.ok(denied(c(`${DT}fill`, { uid: "1_5", value: "x", pageId: 1 })));
});

test("sandbox completa: anche Invio e salvataggio; produzione mai", () => {
  const { c } = setup("sandbox", "ESPLORA SANDBOX COMPLETA");
  assert.ok(silent(c(`${DT}press_key`, { key: "Enter", pageId: 1 })));
  assert.ok(silent(c(`${DT}click`, { uid: "1_3", pageId: 1 })));
  const ws = envWs({ env: "prod", scope: "P2P" });
  const tr = join(mkdtempSync(join(tmpdir(), "xc-")), "t.jsonl"); writeFileSync(tr, "");
  say(ws, tr, "ESPLORA PREPROD COMPLETA");
  assert.equal(runSessionCli(["use", "mode", "esplorazione", "--session", "sess-1"], { JVC_WORKSPACE: ws }).status, 3);
});

test("limiti per agente: in esplorazione nessun tetto se l'utente non ne ha dichiarati; i suoi restano; fuori esplorazione i predefiniti", () => {
  const def = { calls: 200, minutes: 30, set_at: null };
  assert.deepEqual(effectiveLimits(def, { mode: "esplorazione" }, null), { calls: Infinity, minutes: Infinity });
  assert.deepEqual(effectiveLimits({ calls: 900, minutes: 120, set_at: "t" }, { mode: "esplorazione" }, null), { calls: 900, minutes: 120 });
  assert.deepEqual(effectiveLimits(def, { mode: "ops" }, { minutes: 10 }), { calls: 200, minutes: 10 });
});

test("registro più ricco: aiuto, sola lettura, non valido, testo lungo, link, valori di esempio redatti, messaggi, righe di tabella marcate", () => {
  const snap = `uid=1_0 RootWebArea "Nuovo ordine" url="https://h/p2p/po/new"
  uid=1_1 heading "Nuovo ordine" level="1"
  uid=1_2 link "Ordini" url="https://h/p2p/po?x=1"
  uid=1_3 textbox "Data consegna" description="Formato gg/mm/aaaa" value="05/10/2026"
  uid=1_4 textbox "Referente" value="mario.rossi@acme.it" readonly
  uid=1_5 textbox "Note" multiline invalid="true"
  uid=1_6 alert "Il campo Centro di costo è obbligatorio"
  uid=1_7 table "Righe"
    uid=1_8 row
      uid=1_9 columnheader "Articolo"
    uid=1_10 row
      uid=1_11 cell "Sedia ergonomica"
`;
  const r = pageRecord(parseSnapshot(snap), { pageSig: "p2p/po/new#nuovo-ordine", profile: "strict", env: {} });
  const by = (n) => r.elements.find((e) => e.name === n);
  assert.equal(by("Data consegna").help, "Formato gg/mm/aaaa");
  assert.equal(by("Data consegna").sample, "05/10/2026");
  assert.equal(by("Referente").readonly, true);
  assert.ok(!JSON.stringify(r).includes("mario.rossi"), "valori redatti");
  assert.equal(by("Note").multiline, true);
  assert.equal(by("Note").invalid, true);
  assert.equal(by("Ordini").href, "/p2p/po");
  assert.ok((r.messages ?? []).some((m) => /obbligatorio/.test(m)), JSON.stringify(r.messages));
  assert.equal(by("Sedia ergonomica")?.record, true, JSON.stringify(r.elements));
});

test("registro: la struttura ha la precedenza sulle righe; al più 20 righe per tabella", () => {
  const rows = Array.from({ length: 40 }, (_, i) => `    uid=2_${100 + i} row\n      uid=2_${200 + i} cell "Riga ${i}"`).join("\n");
  const snap = `uid=2_0 RootWebArea "X" url="https://h/x"\n  uid=2_1 heading "X" level="1"\n  uid=2_2 table "T"\n${rows}\n  uid=2_3 button "Salva bozza"\n`;
  const r = pageRecord(parseSnapshot(snap), { pageSig: "x#x", profile: "standard", env: {} });
  assert.ok(r.elements.some((e) => e.name === "Salva bozza"), "struttura dopo la tabella conservata");
  assert.ok(r.elements.filter((e) => e.role === "row").length <= 20);
});

test("atlas-build: valori di esempio e aiuto nei campi, tipo data, tabella con colonne e righe, click su record senza percorso, azioni con effetto nell'esito", () => {
  const ws = mkdtempSync(join(tmpdir(), "xc-ab-"));
  mkdirSync(join(ws, "customers/ACME/.sessions/s1/atlas"), { recursive: true });
  const form = { kind: "page", page_sig: "p2p/po/new#nuovo-ordine", title: "Nuovo ordine", url_path: "/p2p/po/new", elements: [
    { i: 0, parent: null, role: "heading", name: "Nuovo ordine", level: 1 },
    { i: 1, parent: null, role: "textbox", name: "Data consegna", help: "Formato gg/mm/aaaa", sample: "05/10/2026" },
    { i: 2, parent: null, role: "table", name: "Righe" }, { i: 3, parent: 2, role: "row", name: "", record: true },
    { i: 4, parent: 3, role: "columnheader", name: "Articolo" }, { i: 5, parent: 2, role: "row", name: "", record: true },
    { i: 6, parent: 5, role: "cell", name: "Sedia ergonomica", record: true }, { i: 7, parent: null, role: "button", name: "Salva bozza" }] };
  const saved = { kind: "page", page_sig: "p2p/po/edit#ordine-po-1", title: "Ordine PO-1", url_path: "/p2p/po/edit", elements: [{ i: 0, parent: null, role: "heading", name: "Ordine PO-1", level: 1 }] };
  const lines = [form, { kind: "click", from_sig: "p2p/po/new#nuovo-ordine", target: { name: "Salva bozza" }, effect: true }, saved,
    { kind: "click", from_sig: "p2p/po/edit#ordine-po-1", target: { name: "Sedia ergonomica" }, record: true }, form];
  writeFileSync(join(ws, "customers/ACME/.sessions/s1/atlas/pages.jsonl"), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const d = buildDrafts(lines);
  const f = d.fields.find((x) => x.label === "Data consegna");
  assert.equal(f.field_type, "date");
  assert.deepEqual(f.samples, ["05/10/2026"]);
  assert.equal(f.help, "Formato gg/mm/aaaa");
  const t = d.sels.find((s) => s.role === "table");
  assert.deepEqual(t.columns, ["Articolo"]);
  assert.deepEqual(t.sample_rows, [["Sedia ergonomica"]]);
  assert.ok(!d.sels.some((s) => s.label === "Sedia ergonomica"), "un record non diventa selettore");
  const r = atlasBuild({ ws, customer: "ACME", scope: "P2P", sid: "s1" });
  assert.deepEqual(r.effects.map((e) => [e.page, e.action, e.result]), [["Nuovo ordine", "Salva bozza", "Ordine PO-1"]]);
  const dir = join(ws, "customers/ACME/kb/scopes/P2P/fields");
  const fld = readdirSync(dir).map((x) => YAML.parse(readFileSync(join(dir, x), "utf8"))).find((x) => x.label.it === "Data consegna");
  assert.match(fld.notes, /valori di esempio: 05\/10\/2026/);
  assert.match(fld.notes, /aiuto: Formato gg\/mm\/aaaa/);
  const tdir = join(ws, "customers/ACME/kb/scopes/P2P/selectors");
  const tsel = readdirSync(tdir).map((x) => YAML.parse(readFileSync(join(tdir, x), "utf8"))).find((x) => x.role === "table");
  assert.deepEqual(tsel.columns, ["Articolo"]);
});
