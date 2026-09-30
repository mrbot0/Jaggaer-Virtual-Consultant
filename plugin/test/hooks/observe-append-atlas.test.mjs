// Soluzione A (spec 2026-09-30 §A1): observe-append scrive il registro dell'esplorazione (pagine e click); il file è
// protetto in scrittura come gli altri file del monitor.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { envWs, patchSession, ROOT } from "../helpers/env-fixture.mjs";
import { runHook, decisionOf } from "../helpers/hook-env.mjs";

const DT = "mcp__chrome-devtools__";
const URL = "https://acme-sbx.jaggaer.com/p2p/po/new";
const SNAP = `## Latest page snapshot\nuid=1_0 RootWebArea "Nuovo ordine - ACME SBX" url="${URL}"\n  uid=1_1 heading "Nuovo ordine" level="1"\n  uid=1_2 textbox "Descrizione " required value="segreto@example.com"\n  uid=1_3 button "Salva bozza"\n  uid=1_4 link "Ordini"\n`;
const T = (text) => [{ type: "text", text }];
function ws0() {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  patchSession(ws, (s) => { s.browser = { current_url: URL, tab: "1", updated_by: "browser-origin" }; });
  return ws;
}
const post = (ws, tool, ti, resp) => runHook("observe-append", { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input: ti, tool_response: resp }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
const log = (ws) => { const f = join(ws, "customers/ACME/.sessions/sess-1/atlas/pages.jsonl"); return existsSync(f) ? readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []; };

test("snapshot completo ⇒ riga di pagina senza valori; click ⇒ arco con il nome dall'ultimo snapshot", () => {
  const ws = ws0();
  const r = post(ws, `${DT}take_snapshot`, { pageId: 1 }, T(SNAP));
  const [page] = log(ws);
  assert.equal(page?.kind, "page", `riga di pagina assente: ${r.stdout}${r.stderr}`);
  assert.equal(page.url_path, "/p2p/po/new");
  assert.ok(page.elements.some((e) => e.name === "Salva bozza" && e.role === "button"));
  assert.ok(!JSON.stringify(page).includes("segreto@"));
  post(ws, `${DT}click`, { uid: "1_4", pageId: 1 }, T("Successfully clicked on the element"));
  const click = log(ws).at(-1);
  assert.equal(click.kind, "click");
  assert.equal(click.target.name, "Ordini");
  assert.equal(click.from_sig, page.page_sig);
});

test("lettura parziale (find) o risposta d'errore ⇒ nessuna riga di pagina", () => {
  const ws = ws0();
  post(ws, "mcp__claude-in-chrome__find", { query: "salva" }, T(SNAP));
  post(ws, `${DT}take_snapshot`, { pageId: 1 }, T("Error: page closed"));
  assert.equal(log(ws).filter((x) => x.kind === "page").length, 0);
});

test("il registro è protetto: né la sessione principale né un sub-agente lo scrivono (Write, Edit, shell)", () => {
  const ws = ws0();
  const f = join(ws, "customers/ACME/.sessions/sess-1/atlas/pages.jsonl");
  const rel = "customers/ACME/.sessions/sess-1/atlas/pages.jsonl";
  for (const who of [{}, { agent_id: "b1", agent_type: "jaggaer-virtual-consultant:scope-expert" }]) {
    for (const [tool, ti] of [["Write", { file_path: f, content: "{}" }], ["Edit", { file_path: f, old_string: "a", new_string: "b" }], ["Bash", { command: `echo {} >> ${rel}` }]]) {
      const r = runHook("guard-scope", { session_id: "sess-1", cwd: ws, hook_event_name: "PreToolUse", tool_name: tool, tool_input: ti, ...who }, { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT });
      assert.equal(decisionOf(r), "deny", `${tool} ${who.agent_id ?? "manager"}`);
    }
  }
});

// Revisione finale (I4): un click su un link dentro una riga di tabella (un record: fornitore, persona) non entra nel
// registro; un click sulla navigazione sì
test("click su un record di tabella ⇒ nessuna riga di click; click sulla navigazione ⇒ riga", () => {
  const ws = ws0();
  const TABLE = `## Latest page snapshot\nuid=2_0 RootWebArea "Ordini - ACME SBX" url="${URL}"\n  uid=2_1 heading "Ordini" level="1"\n  uid=2_2 link "Nuovo ordine"\n  uid=2_3 table "Elenco"\n    uid=2_4 row\n      uid=2_5 cell "x"\n        uid=2_6 link "Bianchi Srl"\n`;
  post(ws, `${DT}take_snapshot`, { pageId: 1 }, T(TABLE));
  post(ws, `${DT}click`, { uid: "2_6", pageId: 1 }, T("Successfully clicked on the element"));
  assert.ok(!JSON.stringify(log(ws)).includes("Bianchi"), JSON.stringify(log(ws)));
  post(ws, `${DT}take_snapshot`, { pageId: 1 }, T(TABLE));
  post(ws, `${DT}click`, { uid: "2_2", pageId: 1 }, T("Successfully clicked on the element"));
  assert.equal(log(ws).at(-1).target?.name, "Nuovo ordine");
});
