// Classificazione degli strumenti MCP del browser (K5, §44.4, §51–§52): una sola
// tabella condivisa da guard-environment, guard-production e guard-config-scope.
// Famiglie: Chrome DevTools MCP, Claude browser / Claude in Chrome, Playwright MCP
// (anche come server del plugin, mcp__plugin_jaggaer-virtual-consultant_<server>__…).
// classify(tool, input) → { tool, family, op, kind, url?, history?, target?, text?,
// submits, actions? }. kind: navigate · read · input · click · upload · script ·
// dialog · other. Uno strumento "da browser" non riconosciuto è `other`, che i
// guard trattano come scrittura (negato per default). La semantica dei matcher di
// Claude Code non è verificata: ogni guard ricontrolla tool_name con isBrowserTool.
// Solo moduli built-in: è sul percorso caldo di ogni chiamata del browser.
import { domainToASCII } from "node:url";

// Per hooks.json: cattura ogni server MCP "da browser" (i guard poi classificano).
export const BROWSER_MATCHER = "mcp__.*([Cc]hrome|[Bb]rowser|[Pp]laywright|[Pp]uppeteer|[Ss]elenium|[Dd]ev[Tt]ools).*";
const BROWSER_LOOKING = new RegExp(`^${BROWSER_MATCHER}$`);
const DEVTOOLS = /^(mcp__.*chrome-devtools.*)__([A-Za-z0-9_]+)$/i;
const CLAUDE = /^(mcp__(?:.*_)?(?:Claude_Browser|claude-in-chrome|claude-browser))__([A-Za-z0-9_]+)$/i;
const PLAYWRIGHT = /^(mcp__.*playwright.*)__([A-Za-z0-9_]+)$/i;

export const KIND_RANK = { read: 0, navigate: 1, click: 2, input: 3, dialog: 4, upload: 5, script: 6, other: 7 };
export const isBrowserTool = (name) => typeof name === "string" && (BROWSER_LOOKING.test(name) || DEVTOOLS.test(name) || CLAUDE.test(name) || PLAYWRIGHT.test(name));

// Host come lo confrontano i guard: minuscolo, IDN in punycode, senza punto finale, porta conservata.
export function normalizeHost(h) {
  const s = String(h ?? "").trim().replace(/\.$/, "");
  const m = /^(.*?)(:\d{1,5})?$/.exec(s);
  const ascii = domainToASCII(m[1].toLowerCase().replace(/\.$/, ""));
  return ascii ? `${ascii}${m[2] ?? ""}` : "";
}

const ENTER = /(^|[+\s])(enter|return|kp_enter|numpadenter)$/i;
const str = (v) => (typeof v === "string" ? v : null);
const targetOf = (ti) => {
  const t = {};
  for (const k of ["uid", "ref", "selector", "element"]) if (typeof ti[k] === "string" || typeof ti[k] === "number") t[k] = ti[k];
  return Object.keys(t).length ? t : undefined;
};
const mk = (family, op, kind, extra = {}) => ({ family, op, kind, submits: false, ...extra });
const valuesText = (arr, key = "value") => (Array.isArray(arr) ? arr.map((x) => (x && typeof x === "object" ? String(x[key] ?? "") : "")).join("\n") : null);

const DEVTOOLS_READ = new Set(["select_page", "close_page", "list_pages", "hover", "take_snapshot", "take_screenshot", "list_console_messages", "get_console_message",
  "list_network_requests", "get_network_request", "wait_for", "emulate", "resize_page", "lighthouse_audit", "take_heapsnapshot"]);
function devtools(op, ti) {
  const F = "chrome-devtools";
  const target = targetOf(ti);
  switch (op) {
    case "navigate_page": {
      const type = str(ti.type);
      if (type && type !== "url") return mk(F, op, "navigate", { history: true, url: null });
      return mk(F, op, "navigate", { url: str(ti.url) });
    }
    case "new_page": return mk(F, op, "navigate", { url: str(ti.url) });
    case "click": return mk(F, op, "click", { target });
    case "drag": return mk(F, op, "input", { target });
    case "fill": return mk(F, op, "input", { target, text: str(ti.value) ?? String(ti.value ?? "") });
    case "fill_form": return mk(F, op, "input", { text: valuesText(ti.elements) });
    case "type_text": { const text = str(ti.text) ?? ""; return mk(F, op, "input", { target, text, submits: (typeof ti.submitKey === "string" && ENTER.test(ti.submitKey)) || /[\r\n]/.test(text) }); }
    case "press_key": return mk(F, op, "input", { target, text: str(ti.key), submits: ENTER.test(str(ti.key) ?? "") });
    case "upload_file": return mk(F, op, "upload", { target });
    case "handle_dialog": return mk(F, op, "dialog", { submits: ti.action === "accept" });
    case "evaluate_script": return mk(F, op, "script", { text: str(ti.function) });
    default:
      if (DEVTOOLS_READ.has(op) || op.startsWith("performance_")) return mk(F, op, "read", target ? { target } : {});
      return mk(F, op, "other");
  }
}

const COMPUTER = {
  left_click: "click", double_click: "click", triple_click: "click", right_click: "click",
  type: "input", key: "input", left_click_drag: "input",
  scroll: "read", screenshot: "read", zoom: "read", hover: "read", wait: "read", scroll_to: "read",
};
const CLAUDE_READ = new Set(["find", "read_page", "get_page_text", "resize_window", "read_console_messages", "read_network_requests", "gif_creator",
  "shortcuts_list", "list_connected_browsers", "select_browser", "switch_browser", "preview_stop", "preview_list", "preview_logs"]);
function claude(op, ti) {
  const F = "claude-browser";
  const target = targetOf(ti);
  if (op === "navigate") {
    const u = str(ti.url);
    if (u && /^(back|forward)$/i.test(u.trim())) return mk(F, op, "navigate", { history: true, url: null });
    return mk(F, op, "navigate", { url: u });
  }
  if (op === "computer") {
    const kind = COMPUTER[ti.action];
    if (!kind) return mk(F, op, "other", { action: ti.action ?? null });
    const text = str(ti.text);
    const submits = ti.action === "type" ? /[\r\n]/.test(text ?? "") : ti.action === "key" ? ENTER.test((text ?? "").trim()) || /(^|\s)(enter|return)(\s|$)/i.test(text ?? "") : false;
    return mk(F, op, kind, { target, action: ti.action, ...(text != null ? { text } : {}), submits });
  }
  if (op === "form_input") return mk(F, op, "input", { target, text: ti.value == null ? null : String(ti.value) });
  if (op === "javascript_tool") return mk(F, op, "script", { text: str(ti.text) });
  if (op === "shortcuts_execute") return mk(F, op, "script", { text: null });
  if (op === "file_upload" || op === "upload_image") return mk(F, op, "upload", { target });
  if (op === "preview_start") return mk(F, op, "navigate", { url: str(ti.url) });
  if (op.startsWith("tabs_") || CLAUDE_READ.has(op)) return mk(F, op, "read");
  return mk(F, op, "other");
}

const PW_READ = new Set(["hover", "snapshot", "take_screenshot", "wait_for", "resize", "console_messages", "network_requests", "network_request", "find", "emulate_media", "close", "tabs"]);
function playwright(op0, ti) {
  const F = "playwright";
  if (!op0.startsWith("browser_")) return mk(F, op0, "other");
  const op = op0.slice("browser_".length);
  const target = targetOf(ti);
  switch (op) {
    case "navigate": return mk(F, op0, "navigate", { url: str(ti.url) });
    case "navigate_back": case "navigate_forward": return mk(F, op0, "navigate", { history: true, url: null });
    case "click": return mk(F, op0, "click", { target });
    case "type": { const text = str(ti.text) ?? ""; return mk(F, op0, "input", { target, text, submits: ti.submit === true || /[\r\n]/.test(text) }); }
    case "fill_form": return mk(F, op0, "input", { text: valuesText(ti.fields) });
    case "select_option": return mk(F, op0, "input", { target, text: Array.isArray(ti.values) ? ti.values.join("\n") : null });
    case "press_key": return mk(F, op0, "input", { text: str(ti.key), submits: ENTER.test(str(ti.key) ?? "") });
    case "drag": case "drop": return mk(F, op0, "input", { target });
    case "file_upload": return mk(F, op0, "upload", { target });
    case "evaluate": return mk(F, op0, "script", { text: str(ti.function) });
    case "run_code_unsafe": return mk(F, op0, "script", { text: str(ti.code) });
    case "handle_dialog": return mk(F, op0, "dialog", { submits: ti.accept === true });
    default:
      if (op === "tabs" && typeof ti.url === "string") return mk(F, op0, "navigate", { url: ti.url });
      if (PW_READ.has(op)) return mk(F, op0, "read", target ? { target } : {});
      return mk(F, op0, "other");
  }
}

function single(name, ti) {
  let m;
  if ((m = CLAUDE.exec(name))) return { server: m[1], ...claude(m[2], ti) };
  if ((m = DEVTOOLS.exec(name))) return { server: m[1], ...devtools(m[2], ti) };
  if ((m = PLAYWRIGHT.exec(name))) return { server: m[1], ...playwright(m[2], ti) };
  return { server: null, ...mk("unknown", name, "other") };
}

// Classifica una chiamata; browser_batch → actions[] classificate una per una
// (nomi brevi risolti sullo stesso server), kind = la più pericolosa, submits in OR.
export function classify(toolName, toolInput) {
  const name = String(toolName ?? "");
  const ti = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput : {};
  const c = single(name, ti);
  if (c.op !== "browser_batch" || c.family !== "claude-browser") return { tool: name, ...c };
  const raw = ti.actions;
  if (!Array.isArray(raw) || raw.length === 0) return { tool: name, ...mk(c.family, c.op, "other"), server: c.server };
  const actions = raw.map((a) => {
    if (!a || typeof a !== "object" || typeof a.name !== "string") return { tool: null, ...mk(c.family, "?", "other") };
    const full = a.name.startsWith("mcp__") ? a.name : `${c.server}__${a.name}`;
    const inner = a.input && typeof a.input === "object" && !Array.isArray(a.input) ? a.input : {};
    const x = single(full, inner);
    if (x.op === "browser_batch") return { tool: full, ...mk(x.family, x.op, "other") };   // niente lotti annidati
    return { tool: full, ...x };
  });
  const worst = actions.reduce((w, a) => (KIND_RANK[a.kind] > KIND_RANK[w.kind] ? a : w), actions[0]);
  return { tool: name, ...mk(c.family, c.op, worst.kind), server: c.server, submits: actions.some((a) => a.submits), actions };
}
