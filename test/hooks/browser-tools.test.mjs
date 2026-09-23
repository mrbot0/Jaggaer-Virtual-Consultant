// K5 — classificazione degli strumenti MCP del browser (hooks/lib/browser-tools.mjs):
// tabella esaustiva delle tre famiglie (Chrome DevTools, Claude browser / Claude in
// Chrome, Playwright) e dei server del plugin; uno strumento "da browser" sconosciuto
// è `other` (trattato come scrittura: negato per default).
import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, isBrowserTool, BROWSER_MATCHER, KIND_RANK, normalizeHost } from "../../hooks/lib/browser-tools.mjs";

const DT = ["mcp__chrome-devtools__", "mcp__plugin_chrome-devtools-mcp_chrome-devtools__", "mcp__plugin_jaggaer-virtual-consultant_chrome-devtools__"];
const CB = ["mcp__Claude_Browser__", "mcp__claude-in-chrome__", "mcp__plugin_jaggaer-virtual-consultant_claude-in-chrome__"];
const PW = ["mcp__playwright__", "mcp__plugin_playwright_playwright__", "mcp__plugin_jaggaer-virtual-consultant_playwright__"];

// [op, input, kind, extra]
const DEVTOOLS = [
  ["navigate_page", { url: "https://a.example.com/" }, "navigate", { url: "https://a.example.com/" }],
  ["navigate_page", { type: "back" }, "navigate", { history: true }],
  ["navigate_page", { type: "reload" }, "navigate", { history: true }],
  ["new_page", { url: "https://a.example.com/" }, "navigate", { url: "https://a.example.com/" }],
  ["select_page", { pageId: 1 }, "read"], ["close_page", { pageId: 1 }, "read"], ["list_pages", {}, "read"],
  ["click", { uid: "1_4" }, "click", { target: { uid: "1_4" } }],
  ["click", { uid: "1_4", dblClick: true }, "click"],
  ["hover", { uid: "1_4" }, "read"],
  ["drag", { from_uid: "1", to_uid: "2" }, "input"],
  ["fill", { uid: "1_5", value: "x" }, "input", { text: "x", target: { uid: "1_5" } }],
  ["fill_form", { elements: [{ uid: "1", value: "a" }, { uid: "2", value: "b" }] }, "input"],
  ["type_text", { text: "abc" }, "input", { submits: false }],
  ["type_text", { text: "abc", submitKey: "Enter" }, "input", { submits: true }],
  ["press_key", { key: "Enter" }, "input", { submits: true }],
  ["press_key", { key: "Control+Enter" }, "input", { submits: true }],
  ["press_key", { key: "Tab" }, "input", { submits: false }],
  ["upload_file", { uid: "1", filePath: "C:/x.pdf" }, "upload"],
  ["handle_dialog", { action: "accept" }, "dialog", { submits: true }],
  ["handle_dialog", { action: "dismiss" }, "dialog", { submits: false }],
  ["evaluate_script", { function: "() => document.title" }, "script", { text: "() => document.title" }],
  ["take_snapshot", {}, "read"], ["take_screenshot", {}, "read"], ["list_console_messages", {}, "read"], ["get_console_message", { msgid: 1 }, "read"],
  ["list_network_requests", {}, "read"], ["get_network_request", { reqid: 1 }, "read"], ["wait_for", { text: "x" }, "read"], ["emulate", {}, "read"],
  ["resize_page", { width: 1, height: 1 }, "read"], ["performance_start_trace", {}, "read"], ["performance_stop_trace", {}, "read"],
  ["performance_analyze_insight", {}, "read"], ["lighthouse_audit", {}, "read"], ["take_heapsnapshot", {}, "read"],
  ["some_future_tool", {}, "other"],
];
const CLAUDE = [
  ["navigate", { url: "https://a.example.com/" }, "navigate", { url: "https://a.example.com/" }],
  ["navigate", { url: "back" }, "navigate", { history: true }],
  ["computer", { action: "left_click", ref: "ref_1" }, "click", { target: { ref: "ref_1" } }],
  ["computer", { action: "double_click", coordinate: [1, 2] }, "click"], ["computer", { action: "triple_click" }, "click"], ["computer", { action: "right_click" }, "click"],
  ["computer", { action: "type", text: "ciao" }, "input", { text: "ciao", submits: false }],
  ["computer", { action: "type", text: "ciao\n" }, "input", { submits: true }],
  ["computer", { action: "key", text: "Return" }, "input", { submits: true }],
  ["computer", { action: "key", text: "ctrl+a" }, "input", { submits: false }],
  ["computer", { action: "scroll" }, "read"], ["computer", { action: "screenshot" }, "read"], ["computer", { action: "zoom" }, "read"],
  ["computer", { action: "hover" }, "read"], ["computer", { action: "wait" }, "read"], ["computer", { action: "scroll_to", ref: "r" }, "read"],
  ["computer", { action: "left_click_drag" }, "input"], ["computer", { action: "mouse_move_secret" }, "other"],
  ["form_input", { ref: "ref_2", value: "x" }, "input", { target: { ref: "ref_2" } }],
  ["find", { query: "x" }, "read"], ["read_page", {}, "read"], ["get_page_text", {}, "read"],
  ["javascript_tool", { action: "javascript_exec", text: "1+1" }, "script", { text: "1+1" }],
  ["file_upload", { paths: ["x"] }, "upload"], ["upload_image", {}, "upload"],
  ["tabs_context", {}, "read"], ["tabs_create", {}, "read"], ["tabs_close", { tabId: "1" }, "read"], ["tabs_select", {}, "read"],
  ["resize_window", {}, "read"], ["read_console_messages", {}, "read"], ["read_network_requests", {}, "read"], ["gif_creator", {}, "read"],
  ["shortcuts_execute", { id: "x" }, "script"],
  ["preview_start", { url: "https://a.example.com/" }, "navigate", { url: "https://a.example.com/" }],
  ["preview_start", { name: "dev" }, "navigate", { url: null }],
  ["preview_stop", {}, "read"], ["preview_list", {}, "read"], ["preview_logs", {}, "read"],
  ["brand_new", {}, "other"],
];
const PLAYWRIGHT = [
  ["browser_navigate", { url: "https://a.example.com/" }, "navigate", { url: "https://a.example.com/" }],
  ["browser_navigate_back", {}, "navigate", { history: true }],
  ["browser_click", { element: "Salva", ref: "e12" }, "click", { target: { ref: "e12", element: "Salva" } }],
  ["browser_type", { ref: "e1", text: "x" }, "input", { submits: false }],
  ["browser_type", { ref: "e1", text: "x", submit: true }, "input", { submits: true }],
  ["browser_fill_form", { fields: [] }, "input"], ["browser_select_option", { ref: "e", values: ["a"] }, "input"],
  ["browser_press_key", { key: "Enter" }, "input", { submits: true }], ["browser_press_key", { key: "ArrowDown" }, "input", { submits: false }],
  ["browser_hover", {}, "read"], ["browser_drag", {}, "input"], ["browser_drop", {}, "input"],
  ["browser_file_upload", { paths: [] }, "upload"],
  ["browser_evaluate", { function: "() => 1" }, "script", { text: "() => 1" }],
  ["browser_run_code_unsafe", { code: "await page.goto('x')" }, "script", { text: "await page.goto('x')" }],
  ["browser_snapshot", {}, "read"], ["browser_take_screenshot", {}, "read"], ["browser_tabs", { action: "list" }, "read"],
  ["browser_wait_for", {}, "read"], ["browser_handle_dialog", { accept: true }, "dialog", { submits: true }],
  ["browser_handle_dialog", { accept: false }, "dialog", { submits: false }],
  ["browser_close", {}, "read"], ["browser_resize", {}, "read"], ["browser_console_messages", {}, "read"],
  ["browser_network_requests", {}, "read"], ["browser_network_request", {}, "read"], ["browser_find", {}, "read"], ["browser_emulate_media", {}, "read"],
  ["browser_install", {}, "other"], ["not_browser_prefixed", {}, "other"],
];

function checkTable(prefixes, table, family) {
  for (const p of prefixes) {
    for (const [op, input, kind, extra = {}] of table) {
      const name = p + op;
      assert.ok(isBrowserTool(name), `${name} deve essere uno strumento del browser`);
      assert.ok(new RegExp(BROWSER_MATCHER).test(name), `BROWSER_MATCHER deve catturare ${name}`);
      const c = classify(name, input);
      assert.equal(c.kind, kind, `${name} ${JSON.stringify(input)} → ${c.kind}, atteso ${kind}`);
      if (kind !== "other") assert.equal(c.family, family, name);
      for (const [k, v] of Object.entries(extra)) assert.deepEqual(c[k], v, `${name}.${k}`);
      if (!("submits" in extra)) assert.equal(typeof c.submits, "boolean");
    }
  }
}

test("tabella esaustiva: Chrome DevTools MCP (anche server di plugin)", () => checkTable(DT, DEVTOOLS, "chrome-devtools"));
test("tabella esaustiva: Claude browser / Claude in Chrome", () => checkTable(CB, CLAUDE, "claude-browser"));
test("tabella esaustiva: Playwright MCP", () => checkTable(PW, PLAYWRIGHT, "playwright"));

test("browser_batch: ogni azione classificata, kind = la più pericolosa, submits in OR", () => {
  const c = classify("mcp__Claude_Browser__browser_batch", { actions: [
    { name: "navigate", input: { url: "https://a.example.com/" } },
    { name: "computer", input: { action: "left_click", ref: "r1" } },
    { name: "computer", input: { action: "key", text: "Enter" } },
    { name: "computer", input: { action: "screenshot" } },
  ] });
  assert.equal(c.actions.length, 4);
  assert.deepEqual(c.actions.map((a) => a.kind), ["navigate", "click", "input", "read"]);
  assert.equal(c.kind, "input");
  assert.equal(c.submits, true);
  assert.equal(classify("mcp__claude-in-chrome__browser_batch", { actions: [{ name: "find", input: {} }] }).kind, "read");
  // batch annidato, batch malformato → other
  assert.equal(classify("mcp__Claude_Browser__browser_batch", { actions: [{ name: "browser_batch", input: { actions: [] } }] }).kind, "other");
  assert.equal(classify("mcp__Claude_Browser__browser_batch", { actions: "x" }).kind, "other");
  assert.equal(classify("mcp__Claude_Browser__browser_batch", {}).kind, "other");
  assert.ok(KIND_RANK.other > KIND_RANK.script && KIND_RANK.script > KIND_RANK.upload && KIND_RANK.read < KIND_RANK.navigate);
});

test("strumenti da browser sconosciuti → other; strumenti non da browser → non classificati", () => {
  for (const n of ["mcp__puppeteer__puppeteer_click", "mcp__selenium__click", "mcp__my-browser__do", "mcp__plugin_ecc_chrome-devtools__get_css_styles", "mcp__chrome__x"]) {
    assert.ok(isBrowserTool(n), n);
    assert.equal(classify(n, {}).kind, "other", n);
  }
  for (const n of ["Read", "Bash", "mcp__alm__create_issue", "mcp__ccd_session__mark_chapter", "Agent"]) assert.equal(isBrowserTool(n), false, n);
});

test("normalizeHost: minuscolo, punto finale, IDN in punycode, porta conservata", () => {
  assert.equal(normalizeHost("ACME.Jaggaer.COM."), "acme.jaggaer.com");
  assert.equal(normalizeHost("acme.jaggaer.com:8443"), "acme.jaggaer.com:8443");
  assert.equal(normalizeHost("bücher.example"), "xn--bcher-kva.example");
});
