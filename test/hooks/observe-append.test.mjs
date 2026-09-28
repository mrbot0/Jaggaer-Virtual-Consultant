// K6.2 — observe-append: 20 risultati golden dei tre server MCP (compresi toast d'errore e pagina con
// dati personali) → OBS attese; ERR grezzi con count; redazione (e-mail, P.IVA, CF, IBAN, telefoni;
// importi solo in strict); origine osservata fail-closed; spreco; fail-open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import Database from "better-sqlite3";
import { envWs, readSession, patchSession, writePlan, ROOT } from "../helpers/env-fixture.mjs";
import { runHook } from "../helpers/hook-env.mjs";
import { snap, demoAtlas, demoPlan, PLAN } from "../helpers/k6-fixture.mjs";
import { check } from "../../scripts/decide/step-check.mjs";

const DT = "mcp__chrome-devtools__";
const CL = "mcp__claude-in-chrome__";
const PW = "mcp__playwright__browser_";
const EDIT = "https://acme-sbx.jaggaer.com/p2p/requisition/edit/10045";
const T = (text) => [{ type: "text", text }];
const PII = [
  "Referente: mario.rossi@acme.it · tel. +39 02 1234 5678",
  "Fornitore Arredi Srl P.IVA IT01234567890 · CF RSSMRA80A01H501U",
  "IBAN IT60X0542811101000000123456 · Importo stimato € 1.250,00",
];
const piiDevtools = () => `## Latest page snapshot\nuid=1_0 RootWebArea "Richiesta d'acquisto - ACME SBX" url="${EDIT}"\n  uid=1_1 heading "Richiesta d'acquisto" level="1"\n${PII.map((t, i) => `  uid=1_${i + 2} StaticText "${t}"`).join("\n")}\n  uid=1_9 StaticText "Referente "\n  uid=1_10 textbox "Referente " value="mario.rossi@acme.it"\n  uid=1_11 StaticText "Importo stimato "\n  uid=1_12 textbox "Importo stimato " value="€ 1.250,00"\n`;
const pwState = (url, body = "") => `### Ran Playwright code\n\`\`\`js\nawait page.click();\n\`\`\`\n\n### Page state\n- Page URL: ${url}\n- Page Title: ACME SBX\n- Page Snapshot:\n\`\`\`yaml\n${body}\n\`\`\``;

function ws0({ env = "sandbox", plan = false } = {}) {
  const ws = envWs({ env, scope: "P2P" });
  demoAtlas(ws);
  if (plan) {
    const file = writePlan(ws, demoPlan(), "RUN.ACME.K6");
    patchSession(ws, (s) => { s.active_plan = { plan_id: PLAN, file, step: 2, run: "RUN.ACME.K6" }; });
  }
  patchSession(ws, (s) => { s.session_code = "SES.ACME.20260923.001"; s.browser = { current_url: "https://acme-sbx.jaggaer.com/home", tab: null, updated_by: "browser-origin" }; });
  return ws;
}
const post = (ws, tool, tool_input, tool_response, env = {}) => runHook("observe-append", { session_id: "sess-1", cwd: ws, hook_event_name: "PostToolUse", tool_name: tool, tool_input, tool_response },
  { JVC_WORKSPACE: ws, CLAUDE_PLUGIN_ROOT: ROOT, ...env });
const ctxOf = (r) => r.json?.hookSpecificOutput?.additionalContext ?? "";
const obsOf = (ws, r) => {
  const code = /OBS (\S+)/.exec(ctxOf(r))?.[1];
  assert.ok(code, `nessuna OBS: ${r.stdout}${r.stderr}`);
  return YAML.parse(readFileSync(join(ws, "customers/ACME/observations", `${code}.yaml`), "utf8"));
};

// [nome, famiglia, strumento, input, risposta, attese, opzioni]
const CASES = [
  ["dt-snapshot-ok", DT + "take_snapshot", {}, () => T(snap("chrome-devtools", "ok")), { kind: "snapshot", page_signature: "p2p/requisition/edit#richiesta-d-acquisto", url: EDIT, atlas: "C.ACME.P2P.SEL.0044" }],
  ["dt-snapshot-toast-errore", DT + "take_snapshot", {}, () => T(snap("chrome-devtools", "messaggio-inatteso")), { kind: "snapshot", err: "REQ-VAL-014", category: "validation" }],
  ["dt-snapshot-pii", DT + "take_snapshot", {}, () => T(piiDevtools()), { kind: "snapshot", masks: ["email", "partita-iva", "codice-fiscale", "iban", "telefono"], noAmountMask: true }],
  ["dt-navigate", DT + "navigate_page", { type: "url", url: EDIT }, () => T(`# navigate_page response\nSuccessfully navigated to ${EDIT}.\n## Pages\n1: Richiesta d'acquisto - ACME SBX (${EDIT}) [selected]`), { kind: "navigate", url: EDIT }],
  ["dt-click-senza-pagina", DT + "click", { uid: "1_22" }, () => T("Successfully clicked on the element"), { kind: "action", url: null }],
  ["dt-screenshot", DT + "take_screenshot", {}, () => [{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" }], { kind: "screenshot", url: "https://acme-sbx.jaggaer.com/home" }],
  ["dt-errore-rete", DT + "navigate_page", { type: "url", url: EDIT }, () => T("Error: net::ERR_NAME_NOT_RESOLVED"), { kind: "error", url: null }],
  ["cl-read-page-ok", CL + "read_page", {}, () => T(snap("claude-browser", "ok")), { kind: "snapshot", url: EDIT, page_signature: "p2p/requisition/edit#richiesta-d-acquisto" }],
  ["cl-read-page-novita", CL + "read_page", {}, () => T(snap("claude-browser", "novelty")), { kind: "snapshot", novelty: 1, surprise: 0 }, { plan: true }],
  ["cl-read-page-sorpresa", CL + "read_page", {}, () => T(snap("claude-browser", "attributo-diverso")), { kind: "snapshot", surprise: 1 }, { plan: true }],
  ["cl-get-page-text", CL + "get_page_text", {}, () => T("Richiesta d'acquisto\nDescrizione RdA di prova"), { kind: "snapshot", url: "https://acme-sbx.jaggaer.com/home" }],
  ["cl-screenshot", CL + "computer", { action: "screenshot" }, () => [{ type: "image", data: "x", mimeType: "image/png" }], { kind: "screenshot" }],
  ["cl-navigate", CL + "navigate", { url: EDIT }, () => T(`Navigated to ${EDIT}\n\nTab Context:\n- Executed on tabId: 101\n- Available tabs:\n  • tabId 101: "ACME" (${EDIT})`), { kind: "navigate", url: EDIT }],
  ["cl-cambio-scheda", CL + "tabs_select", { tabId: 102 }, () => T("Switched to tab 102"), { kind: "read", url: null }],
  ["pw-snapshot-ok", PW + "snapshot", {}, () => T(snap("playwright", "ok")), { kind: "snapshot", url: EDIT }],
  ["pw-snapshot-sessione-scaduta", PW + "snapshot", {}, () => T(pwState(EDIT, "- heading \"Accesso\" [level=1] [ref=e2]\n- alert [ref=e3]: La sessione è scaduta, effettua di nuovo l'accesso")), { kind: "snapshot", category: "session", err: "ERR-RAW" }],
  ["pw-click-con-stato", PW + "click", { element: "Elenco richieste", ref: "e10" }, () => T(pwState("https://acme-sbx.jaggaer.com/p2p/requisition/list", "- heading \"Elenco richieste\" [level=1] [ref=e2]")), { kind: "action", url: "https://acme-sbx.jaggaer.com/p2p/requisition/list" }],
  ["pw-navigate", PW + "navigate", { url: EDIT }, () => T(pwState(EDIT)), { kind: "navigate", url: EDIT }],
  ["pw-snapshot-pii-strict", PW + "snapshot", {}, () => T(pwState(EDIT, `- heading "Richiesta d'acquisto" [level=1] [ref=e2]\n- textbox "Importo stimato" [ref=e3]: € 1.250,00\n- textbox "Referente" [ref=e4]: mario.rossi@acme.it\n- paragraph [ref=e5]: ${PII[1]}`)), { kind: "snapshot", masks: ["importo", "email", "partita-iva"] }, { env: "preprod", url: "https://acme-pre.jaggaer.com/home" }],
  ["dt-console", DT + "list_console_messages", {}, () => T("## Console messages\n<no console messages found>"), { kind: "read", url: "https://acme-sbx.jaggaer.com/home" }],
];

test("observe-append: 20 risultati golden dei tre server MCP → OBS attese (codice dal DB, firma, elementi, errori, redazione, origine)", () => {
  assert.equal(CASES.length, 20);
  for (const [name, tool, ti, resp, want, opt = {}] of CASES) {
    const ws = ws0({ env: opt.env ?? "sandbox", plan: opt.plan });
    if (opt.url) patchSession(ws, (s) => { s.browser.current_url = opt.url; });
    const r = post(ws, tool, ti, resp());
    assert.equal(r.status, 0, name);
    assert.match(ctxOf(r), /^OBS L\.ACME\.P2P\.OBS\.0001 · surprise:\d+ novelty:\d+ · ERR:\S+/, `${name}: ${r.stdout} ${r.stderr}`);
    const o = obsOf(ws, r);
    assert.equal(o.id, "L.ACME.P2P.OBS.0001", name);
    assert.equal(o.session, "SES.ACME.20260923.001", name);
    assert.equal(o.kind, want.kind, name);
    if (want.page_signature) assert.equal(o.page_signature, want.page_signature, name);
    if ("url" in want) assert.equal(readSession(ws).browser.current_url, want.url, `${name}: current_url`);
    if (want.atlas) assert.ok(o.elements_seen.some((e) => e.atlas_match === want.atlas), name);
    if (want.surprise !== undefined) assert.equal(o.surprise, want.surprise, name);
    if (want.novelty !== undefined) assert.equal(o.novelty, want.novelty, name);
    if (want.err) {
      assert.ok(o.errors.some((e) => (e.code ?? e.raw_id).startsWith(want.err)), `${name}: ${JSON.stringify(o.errors)}`);
      assert.match(ctxOf(r), new RegExp(`ERR:${want.err}`));
    }
    if (want.category) assert.equal(o.errors[0].category, want.category, name);
    const text = readFileSync(join(ws, "customers/ACME/observations", `${o.id}.yaml`), "utf8");
    if (want.masks) {
      for (const m of want.masks) assert.ok(o.redaction.masks.includes(m), `${name}: maschera ${m} in ${o.redaction.masks}`);
      assert.doesNotMatch(text, /mario\.rossi@acme\.it|01234567890|RSSMRA80A01H501U|IT60X0542811101000000123456/, `${name}: dati personali in chiaro`);
      assert.equal(o.redaction.profile, opt.env === "preprod" ? "strict" : "standard");
      if (want.noAmountMask) assert.match(text, /1\.250,00/, "in sandbox (standard) gli importi restano");
      else assert.doesNotMatch(text, /1\.250,00/, "in strict gli importi sono mascherati");
    }
    for (const e of o.elements_seen) if (typeof e.value === "string") assert.ok(e.value.length <= 40, `${name}: testo libero ≤ 40`);
    const db = new Database(join(ws, "customers/ACME/knowledge.db"), { readonly: true });
    assert.equal(db.prepare("select count(*) n from observations where code=?").get(o.id).n, 1, name);
    db.close();
  }
});

test("ERR grezzo: file in kb/scopes/<S>/errors/_raw/ e riga errors_raw; una ripetizione incrementa count", () => {
  const ws = ws0();
  const r1 = post(ws, DT + "take_snapshot", {}, T(snap("chrome-devtools", "messaggio-inatteso")));
  const r2 = post(ws, DT + "take_snapshot", {}, T(snap("chrome-devtools", "messaggio-inatteso")));
  assert.match(ctxOf(r2), /OBS L\.ACME\.P2P\.OBS\.0002/);
  const dir = join(ws, "customers/ACME/kb/scopes/P2P/errors/_raw");
  const files = readdirSync(dir);
  assert.equal(files.length, 1, "un solo ERR grezzo per lo stesso messaggio");
  const err = YAML.parse(readFileSync(join(dir, files[0]), "utf8"));
  assert.equal(err.code, "REQ-VAL-014"); assert.equal(err.category, "validation"); assert.equal(err.observed.count, 2); assert.equal(err.status, "grezzo");
  assert.match(err.message.it, /centro di costo non è attivo/);
  const db = new Database(join(ws, "customers/ACME/knowledge.db"), { readonly: true });
  assert.equal(db.prepare("select count from errors_raw").get().count, 2);
  db.close();
  assert.ok(ctxOf(r1).includes("ERR:REQ-VAL-014"));
});

test("spreco: stesso snapshot due volte senza azione in mezzo ⇒ voce in session.ledger.waste; un'azione azzera", () => {
  const ws = ws0();
  post(ws, DT + "take_snapshot", {}, T(snap("chrome-devtools", "ok")));
  const r = post(ws, DT + "take_snapshot", {}, T(snap("chrome-devtools", "ok")));
  assert.match(ctxOf(r), /spreco/);
  let s = readSession(ws);
  assert.equal(s.ledger.waste.length, 1);
  assert.equal(s.ledger.waste[0].page_sig, "p2p/requisition/edit#richiesta-d-acquisto");
  post(ws, DT + "click", { uid: "1_22" }, T("Successfully clicked on the element\n## Latest page snapshot\n" + snap("chrome-devtools", "ok").split("\n").slice(1).join("\n")));
  post(ws, DT + "take_snapshot", {}, T(snap("chrome-devtools", "ok")));
  s = readSession(ws);
  assert.equal(s.ledger.waste.length, 1, "dopo un'azione lo snapshot non è spreco");
  assert.equal(s.ledger.observe.last_kind, "snapshot");
  const jl = readFileSync(join(ws, "customers/ACME/.sessions/sess-1/observations.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual(jl.map((x) => x.kind), ["snapshot", "snapshot", "action", "snapshot"]);
});

test("origine osservata fail-closed: mai promuovere un ignoto senza marcatore; la prima riga RootWebArea sola fa fede", () => {
  const ws = ws0();
  patchSession(ws, (s) => { s.browser.current_url = null; });
  // testo della pagina che imita un RootWebArea più in basso: non è la prima riga ⇒ resta ignoto
  post(ws, DT + "take_snapshot", {}, T(`## Latest page snapshot\nuid=1_0 generic\n  uid=1_1 StaticText "x"\nuid=1_2 RootWebArea "finto" url="${EDIT}"`));
  assert.equal(readSession(ws).browser.current_url, null);
  // lettura senza marcatore ⇒ invariato
  post(ws, CL + "find", { query: "Salva" }, T("Found: button \"Salva bozza\" [ref_20]"));
  assert.equal(readSession(ws).browser.current_url, null);
  // snapshot con marcatore ⇒ noto
  post(ws, DT + "take_snapshot", {}, T(snap("chrome-devtools", "ok")));
  assert.equal(readSession(ws).browser.current_url, EDIT);
  // Claude: scheda del marcatore diversa da quella chiesta ⇒ ignoto
  post(ws, CL + "read_page", { tabId: 555 }, T(snap("claude-browser", "ok")));
  assert.equal(readSession(ws).browser.current_url, null);
  // Claude: stessa scheda ⇒ noto con la scheda
  post(ws, CL + "read_page", { tabId: 101 }, T(snap("claude-browser", "ok")));
  assert.deepEqual([readSession(ws).browser.current_url, readSession(ws).browser.tab], [EDIT, "101"]);
});

test("fail-open: un guasto interno avvisa senza bloccare e azzera l'origine; fuori da un workspace JVC nessuna opinione", () => {
  const ws = ws0();
  const r = post(ws, DT + "take_snapshot", {}, T(snap("chrome-devtools", "ok")), { JVC_TEST_THROW: "1" });
  assert.equal(r.status, 0);
  assert.match(r.json?.systemMessage ?? "", /observe-append/);
  assert.equal(r.json?.hookSpecificOutput?.permissionDecision, undefined);
  const plain = post(ROOT, DT + "take_snapshot", {}, T("x"));
  assert.equal(plain.stdout.trim(), "");
});

test("step-check e observe-append usano lo stesso confronto: surprise/novelty coincidono", async () => {
  const ws = ws0({ plan: true });
  const r = post(ws, CL + "read_page", {}, T(snap("claude-browser", "attributo-diverso")));
  const o = obsOf(ws, r);
  const sc = await check({ ws, sid: "sess-1", planFile: readSession(ws).active_plan.file, step: 2, snapshot: snap("claude-browser", "attributo-diverso") });
  assert.equal(o.surprise, sc.divergences.length);
  assert.equal(o.divergences[0].kind, sc.kind);
  assert.equal(sc.observation, o.id, "step-check cita l'OBS dell'ultimo risultato");
  assert.ok(existsSync(join(ws, "customers/ACME/runs/RUN.ACME.K6/checkpoints/2.json")));
});

test("redact: profili standard/strict, nessun falso positivo su codici di dominio (CdC, quantità, date)", async () => {
  const { redactText, profileFor } = await import("../../scripts/chrome/redact.mjs");
  const s = redactText("mail a.b@acme.it, P.IVA 01234567890, CF RSSMRA80A01H501U, IBAN IT60 X054 2811 1010 0000 0123 456, cell 333 123 4567, € 3.190,00", { profile: "standard", env: {} });
  assert.doesNotMatch(s.text, /acme\.it|01234567890|RSSMRA|IT60|333 123/);
  assert.match(s.text, /€ 3\.190,00/);
  assert.match(redactText("totale 3.190,00 € e EUR 50", { profile: "strict", env: {} }).text, /totale \[importo\] e \[importo\]/);
  assert.equal(redactText("CdC IT-0442, quantità 5, data 23/09/2026, RdA 4500012345", { profile: "strict", env: {} }).text, "CdC IT-0442, quantità 5, data 23/09/2026, RdA 4500012345");
  assert.equal(redactText("token segreto-xyz-123 in chiaro", { profile: "standard", env: { JIRA_TOKEN: "segreto-xyz-123" } }).text, "token [segreto] in chiaro");
  assert.deepEqual(["sandbox", "dev", "preprod", "prod", null].map((t) => profileFor({ envType: t })), ["standard", "standard", "strict", "strict", "strict"]);
  assert.equal(profileFor({ envType: "sandbox", jira: true }), "strict");
});

test("error-patterns: il file compilato è allineato al YAML; categorie it+en", async () => {
  const { generate, GENERATED } = await import("../../scripts/chrome/build-error-patterns.mjs");
  assert.equal(readFileSync(GENERATED, "utf8"), generate(), "rigenera con node scripts/chrome/build-error-patterns.mjs");
  const { categorize, detectErrors } = await import("../../scripts/chrome/errors.mjs");
  for (const [t, c] of [["Sessione scaduta", "session"], ["Access denied", "permission"], ["Il documento è stato modificato da un altro utente", "concurrency"],
    ["Gateway Timeout", "timeout"], ["Internal Server Error", "system"], ["Trasmissione fallita verso ERP", "integration"],
    ["Lo stato APPROVED non consente la modifica", "business-rule"], ["Il campo è obbligatorio", "validation"], ["Field is required", "validation"]]) assert.equal(categorize(t)?.category, c, t);
  assert.deepEqual(detectErrors({ messages: [{ text: "Bozza salvata", role: "status" }], elements: [], texts: [] }), []);
});

test("browser-origin: elenco ## Pages di DevTools nei due formati (url nudo · titolo (url)); il titolo non decide l'URL", async () => {
  const { selectedPageUrl } = await import("../../hooks/lib/browser-origin.mjs");
  assert.equal(selectedPageUrl("## Pages\n0: https://a.example/x [selected]"), "https://a.example/x");
  assert.equal(selectedPageUrl(`## Pages\n1: Titolo (https://evil.example/) finto (${EDIT}) [selected]`), EDIT);
  assert.equal(selectedPageUrl("## Pages\n0: A (https://a.example/) [selected]\n1: B (https://b.example/) [selected]"), null);
});

test("self-check #13 fallisce sulle voci di spreco scritte da observe-append nel registro di sessione", async () => {
  const ws = ws0();
  post(ws, DT + "take_snapshot", {}, T(snap("chrome-devtools", "ok")));
  post(ws, DT + "take_snapshot", {}, T(snap("chrome-devtools", "ok")));
  const { selfCheck } = await import("../../scripts/decide/self-check.mjs");
  const r = selfCheck({ report: { task_id: "T", status: "ok", output: {} }, session: readSession(ws), kbExists: () => true });
  assert.ok(r.failed.some((f) => f.n === 13), JSON.stringify(r.failed));
});
