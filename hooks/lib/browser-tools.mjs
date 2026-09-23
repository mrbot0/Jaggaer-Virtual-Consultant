// Classificazione degli strumenti MCP del browser (K5, §44.4, §51–§52): una sola
// tabella condivisa da guard-environment, guard-production e guard-config-scope.
// Famiglie: Chrome DevTools MCP, Claude browser / Claude in Chrome, Playwright MCP
// (anche come server del plugin, mcp__plugin_jaggaer-virtual-consultant_<server>__…).
//
// classify(tool, input) → { tool, family, op, kind, url?, history?, switches?,
// outputs?, emulation?, target?, text?, submits, actions?, unknownKeys? }.
// kind: navigate · read · input · click · upload · script · dialog · other.
//
// Giro di correzione 1 (revisione WP06):
//  - ogni operazione ha un'ALLOW-LIST delle chiavi di input: una chiave non
//    prevista ⇒ `other` (i server dichiarano additionalProperties: true e ogni
//    nuova versione aggiunge parametri, come initScript);
//  - navigate_page: type solo "url" | "back" | "forward" | "reload" (o assente con
//    url); initScript non vuoto ⇒ `script`;
//  - browser_run_code_unsafe ⇒ `other` (RCE nel processo del server, ADR-97);
//  - cambi di scheda/pagina/browser ⇒ `switches: true` (l'URL corrente diventa ignoto);
//  - emulate con userAgent/extraHttpHeaders/networkConditions ⇒ `input` con emulation;
//  - parametri che scrivono file (filePath, filename, outputDirPath…) ⇒ `outputs`.
// Uno strumento "da browser" non riconosciuto è `other`, che i guard negano.
// La semantica dei matcher di Claude Code non è verificata: ogni guard ricontrolla
// tool_name con isBrowserTool. Solo moduli built-in: è sul percorso caldo.
import { domainToASCII } from "node:url";

// Per hooks.json: server MCP "da browser" (guard-production, guard-config-scope).
export const BROWSER_MATCHER = "mcp__.*([Cc]hrome|[Bb]rowser|[Pp]laywright|[Pp]uppeteer|[Ss]elenium|[Dd]ev[Tt]ools).*";
const BROWSER_LOOKING = new RegExp(`^${BROWSER_MATCHER}$`);
const DEVTOOLS = /^(mcp__.*chrome-devtools.*)__([A-Za-z0-9_]+)$/i;
const CLAUDE = /^(mcp__(?:.*_)?(?:Claude_Browser|claude-in-chrome|claude-browser))__([A-Za-z0-9_]+)$/i;
const PLAYWRIGHT = /^(mcp__.*playwright.*)__([A-Za-z0-9_]+)$/i;

export const KIND_RANK = { read: 0, navigate: 1, click: 2, input: 3, dialog: 4, upload: 5, script: 6, other: 7 };
export const isBrowserTool = (name) => typeof name === "string" && (BROWSER_LOOKING.test(name) || DEVTOOLS.test(name) || CLAUDE.test(name) || PLAYWRIGHT.test(name));
// Server di uno strumento MCP: mcp__<server>__<tool> → <server> (o null).
export const mcpServer = (name) => (typeof name === "string" ? /^mcp__(.+?)__[^_]/.exec(name)?.[1] ?? null : null);

// Host come lo confrontano i guard: minuscolo, IDN in punycode, senza punto finale, porta conservata.
export function normalizeHost(h) {
  const s = String(h ?? "").trim().replace(/\.$/, "");
  const m = /^(.*?)(:\d{1,5})?$/.exec(s);
  const ascii = domainToASCII(m[1].toLowerCase().replace(/\.$/, ""));
  return ascii ? `${ascii}${m[2] ?? ""}` : "";
}

const ENTER = /(^|[+\s])(enter|return|kp_enter|numpadenter)$/i;
const str = (v) => (typeof v === "string" ? v : null);
const nonEmpty = (v) => v !== undefined && v !== null && v !== "" && !(typeof v === "object" && Object.keys(v).length === 0);
const targetOf = (ti) => {
  const t = {};
  for (const k of ["uid", "ref", "selector", "element"]) if (typeof ti[k] === "string" || typeof ti[k] === "number") t[k] = ti[k];
  return Object.keys(t).length ? t : undefined;
};
const tabOf = (ti) => (ti.tabId ?? ti.pageId ?? null);
const valuesText = (arr, key = "value") => (Array.isArray(arr) ? arr.map((x) => (x && typeof x === "object" ? String(x[key] ?? "") : "")).join("\n") : null);
const outputsOf = (ti, keys) => keys.map((k) => ti[k]).filter((v) => v !== undefined);
const R = (extra = {}) => ({ kind: "read", ...extra });

// ---- Chrome DevTools MCP ----
const SNAP = ["includeSnapshot"];
const DEVTOOLS_OPS = {
  navigate_page: { keys: ["type", "url", "timeout", "ignoreCache", "initScript", "handleBeforeUnload", "pageId"], fn: (ti) => {
    if (ti.initScript !== undefined && ti.initScript !== "") return typeof ti.initScript === "string" ? { kind: "script", text: ti.initScript } : { kind: "other" };
    const type = ti.type;
    if (type === undefined) return typeof ti.url === "string" ? { kind: "navigate", url: ti.url } : { kind: "other" };
    if (type === "url") return { kind: "navigate", url: str(ti.url) };   // url mancante ⇒ urlRefusal nega
    if (type === "back" || type === "forward" || type === "reload") return { kind: "navigate", history: true, historyKind: type, url: null };
    return { kind: "other" };
  } },
  new_page: { keys: ["url", "timeout", "background"], fn: (ti) => ({ kind: "navigate", url: str(ti.url), switches: true }) },
  select_page: { keys: ["pageId", "bringToFront"], fn: () => R({ switches: true }) },
  close_page: { keys: ["pageId"], fn: () => R({ switches: true }) },
  list_pages: { keys: [], fn: () => R() },
  click: { keys: ["uid", "dblClick", ...SNAP], fn: (ti) => ({ kind: "click", target: targetOf(ti) }) },
  hover: { keys: ["uid", ...SNAP], fn: (ti) => R({ target: targetOf(ti) }) },
  drag: { keys: ["from_uid", "to_uid", ...SNAP], fn: (ti) => ({ kind: "input", target: targetOf(ti) }) },
  fill: { keys: ["uid", "value", ...SNAP], fn: (ti) => ({ kind: "input", target: targetOf(ti), text: str(ti.value) ?? String(ti.value ?? "") }) },
  fill_form: { keys: ["elements", ...SNAP], fn: (ti) => ({ kind: "input", text: valuesText(ti.elements) }) },
  type_text: { keys: ["text", "submitKey", ...SNAP], fn: (ti) => { const text = str(ti.text) ?? ""; return { kind: "input", text, submits: (typeof ti.submitKey === "string" && ENTER.test(ti.submitKey)) || (ti.submitKey != null && typeof ti.submitKey !== "string") || /[\r\n]/.test(text) }; } },
  press_key: { keys: ["key", ...SNAP], fn: (ti) => ({ kind: "input", text: str(ti.key), submits: ENTER.test(str(ti.key) ?? "") }) },
  upload_file: { keys: ["uid", "filePath", ...SNAP], fn: (ti) => ({ kind: "upload", target: targetOf(ti) }) },
  handle_dialog: { keys: ["action", "promptText"], fn: (ti) => ({ kind: "dialog", submits: ti.action === "accept" }) },
  evaluate_script: { keys: ["function", "args"], fn: (ti) => ({ kind: "script", text: str(ti.function) }) },
  take_snapshot: { keys: ["verbose", "filePath"], fn: (ti) => R({ outputs: outputsOf(ti, ["filePath"]) }) },
  take_screenshot: { keys: ["format", "quality", "uid", "fullPage", "filePath"], fn: (ti) => R({ outputs: outputsOf(ti, ["filePath"]) }) },
  list_console_messages: { keys: ["pageSize", "pageIdx", "types", "includePreservedMessages"], fn: () => R() },
  get_console_message: { keys: ["msgid"], fn: () => R() },
  list_network_requests: { keys: ["pageSize", "pageIdx", "resourceTypes", "includePreservedRequests"], fn: () => R() },
  get_network_request: { keys: ["reqid", "requestFilePath", "responseFilePath"], fn: (ti) => R({ outputs: outputsOf(ti, ["requestFilePath", "responseFilePath"]) }) },
  wait_for: { keys: ["text", "timeout"], fn: () => R() },
  emulate: { keys: ["networkConditions", "cpuThrottlingRate", "geolocation", "userAgent", "colorScheme", "viewport", "extraHttpHeaders"], fn: (ti) =>
    (["userAgent", "extraHttpHeaders", "networkConditions"].some((k) => nonEmpty(ti[k])) ? { kind: "input", emulation: true } : R()) },
  resize_page: { keys: ["width", "height"], fn: () => R() },
  performance_start_trace: { keys: ["reload", "autoStop", "filePath"], fn: (ti) => (ti.reload === true ? { kind: "navigate", history: true, historyKind: "reload", url: null, outputs: outputsOf(ti, ["filePath"]) } : R({ outputs: outputsOf(ti, ["filePath"]) })) },
  performance_stop_trace: { keys: ["filePath"], fn: (ti) => R({ outputs: outputsOf(ti, ["filePath"]) }) },
  performance_analyze_insight: { keys: ["insightSetId", "insightName"], fn: () => R() },
  lighthouse_audit: { keys: ["mode", "device", "outputDirPath"], fn: (ti) => (ti.mode === "snapshot" ? R({ outputs: outputsOf(ti, ["outputDirPath"]) }) : { kind: "navigate", history: true, historyKind: "reload", url: null, outputs: outputsOf(ti, ["outputDirPath"]) }) },
  take_heapsnapshot: { keys: ["filePath"], fn: (ti) => R({ outputs: outputsOf(ti, ["filePath"]) }) },
};

// ---- Claude browser / Claude in Chrome ----
const COMPUTER = {
  left_click: "click", double_click: "click", triple_click: "click", right_click: "click",
  type: "input", key: "input", left_click_drag: "input",
  scroll: "read", screenshot: "read", zoom: "read", hover: "read", wait: "read", scroll_to: "read",
};
const TAB = ["tabId"];
const CLAUDE_OPS = {
  navigate: { keys: ["url", "force", ...TAB], fn: (ti) => {
    const u = str(ti.url);
    if (u && /^(back|forward)$/.test(u.trim())) return { kind: "navigate", history: true, historyKind: u.trim(), url: null };
    return { kind: "navigate", url: u };
  } },
  computer: { keys: ["action", "coordinate", "ref", "text", "duration", "scroll_direction", "scroll_amount", "start_coordinate", "region", "scale", "modifiers", "repeat", ...TAB], fn: (ti) => {
    const kind = COMPUTER[ti.action];
    if (!kind) return { kind: "other", action: ti.action ?? null };
    const text = str(ti.text);
    const submits = ti.action === "type" ? /[\r\n]/.test(text ?? "") : ti.action === "key" ? ENTER.test((text ?? "").trim()) || /(^|\s)(enter|return)(\s|$)/i.test(text ?? "") : false;
    return { kind, target: targetOf(ti), action: ti.action, ...(text != null ? { text } : {}), submits };
  } },
  form_input: { keys: ["ref", "value", ...TAB], fn: (ti) => ({ kind: "input", target: targetOf(ti), text: ti.value == null ? null : String(ti.value) }) },
  find: { keys: ["query", ...TAB], fn: () => R() },
  read_page: { keys: ["filter", "depth", "ref_id", "max_chars", ...TAB], fn: () => R() },
  get_page_text: { keys: ["max_chars", ...TAB], fn: () => R() },
  javascript_tool: { keys: ["action", "text", ...TAB], fn: (ti) => ({ kind: "script", text: str(ti.text) }) },
  shortcuts_execute: { any: true, fn: () => ({ kind: "script", text: null }) },
  shortcuts_list: { keys: [...TAB], fn: () => R() },
  file_upload: { keys: ["paths", "ref", "coordinate", ...TAB], fn: (ti) => ({ kind: "upload", target: targetOf(ti) }) },
  upload_image: { keys: ["imageId", "ref", "coordinate", "filename", ...TAB], fn: (ti) => ({ kind: "upload", target: targetOf(ti) }) },
  tabs_context: { keys: ["createIfEmpty"], fn: () => R() },
  tabs_context_mcp: { keys: ["createIfEmpty"], fn: () => R() },
  tabs_create: { keys: ["foreground"], fn: () => R({ switches: true }) },
  tabs_create_mcp: { keys: ["foreground"], fn: () => R({ switches: true }) },
  tabs_close: { keys: [...TAB], fn: () => R({ switches: true }) },
  tabs_close_mcp: { keys: [...TAB], fn: () => R({ switches: true }) },
  tabs_select: { keys: [...TAB], fn: () => R({ switches: true }) },
  resize_window: { keys: ["preset", "width", "height", "colorScheme", ...TAB], fn: () => R() },
  read_console_messages: { keys: ["limit", "onlyErrors", "pattern", "clear", ...TAB], fn: () => R() },
  read_network_requests: { keys: ["limit", "requestId", "urlPattern", "clear", ...TAB], fn: () => R() },
  list_connected_browsers: { keys: [], fn: () => R() },
  select_browser: { keys: ["browserId", "deviceId", "id", "name"], fn: () => R({ switches: true }) },
  switch_browser: { keys: ["browserId", "deviceId", "id", "name"], fn: () => R({ switches: true }) },
  preview_start: { keys: ["name", "url"], fn: (ti) => ({ kind: "navigate", url: str(ti.url), switches: true }) },
  preview_stop: { keys: ["serverId"], fn: () => R() },
  preview_list: { keys: [], fn: () => R() },
  preview_logs: { keys: ["serverId", "level", "lines", "search"], fn: () => R() },
};

// ---- Playwright MCP ----
const EL = ["element", "ref"];
const PW_OPS = {
  navigate: { keys: ["url"], fn: (ti) => ({ kind: "navigate", url: str(ti.url) }) },
  navigate_back: { keys: [], fn: () => ({ kind: "navigate", history: true, historyKind: "back", url: null }) },
  navigate_forward: { keys: [], fn: () => ({ kind: "navigate", history: true, historyKind: "forward", url: null }) },
  click: { keys: [...EL, "doubleClick", "button", "modifiers"], fn: (ti) => ({ kind: "click", target: targetOf(ti) }) },
  type: { keys: [...EL, "text", "submit", "slowly"], fn: (ti) => { const text = str(ti.text) ?? ""; return { kind: "input", target: targetOf(ti), text, submits: ti.submit === true || /[\r\n]/.test(text) }; } },
  fill_form: { keys: ["fields"], fn: (ti) => ({ kind: "input", text: valuesText(ti.fields) }) },
  select_option: { keys: [...EL, "values"], fn: (ti) => ({ kind: "input", target: targetOf(ti), text: Array.isArray(ti.values) ? ti.values.join("\n") : null }) },
  press_key: { keys: ["key"], fn: (ti) => ({ kind: "input", text: str(ti.key), submits: ENTER.test(str(ti.key) ?? "") }) },
  hover: { keys: [...EL], fn: (ti) => R({ target: targetOf(ti) }) },
  drag: { keys: ["startElement", "startRef", "endElement", "endRef"], fn: () => ({ kind: "input" }) },
  drop: { keys: [...EL, "startElement", "startRef", "endElement", "endRef"], fn: () => ({ kind: "input" }) },
  file_upload: { keys: ["paths"], fn: () => ({ kind: "upload" }) },
  evaluate: { keys: ["function", ...EL], fn: (ti) => ({ kind: "script", text: str(ti.function) }) },
  snapshot: { keys: ["filename"], fn: (ti) => R({ outputs: outputsOf(ti, ["filename"]) }) },
  take_screenshot: { keys: ["type", "filename", ...EL, "fullPage"], fn: (ti) => R({ outputs: outputsOf(ti, ["filename"]) }) },
  tabs: { keys: ["action", "index"], fn: (ti) => (ti.action === "list" ? R() : ["select", "new", "close"].includes(ti.action) ? R({ switches: true }) : { kind: "other" }) },
  wait_for: { keys: ["time", "text", "textGone"], fn: () => R() },
  handle_dialog: { keys: ["accept", "promptText"], fn: (ti) => ({ kind: "dialog", submits: ti.accept === true }) },
  close: { keys: [], fn: () => R({ switches: true }) },
  resize: { keys: ["width", "height"], fn: () => R() },
  console_messages: { keys: ["onlyErrors", "level", "filename"], fn: (ti) => R({ outputs: outputsOf(ti, ["filename"]) }) },
  network_requests: { keys: ["includeStatic", "filename"], fn: (ti) => R({ outputs: outputsOf(ti, ["filename"]) }) },
  network_request: { keys: ["index", "id"], fn: () => R() },
  find: { keys: ["query", "text", ...EL], fn: () => R() },
  emulate_media: { keys: ["media", "colorScheme", "reducedMotion", "forcedColors"], fn: () => R() },
  // browser_run_code_unsafe: codice arbitrario nel processo del server (anche da `filename`) ⇒ sempre other.
};

function apply(family, table, op, ti) {
  const spec = table[op];
  if (!spec) return { family, op, kind: "other", submits: false };
  if (!spec.any) {
    const unknown = Object.keys(ti).filter((k) => !spec.keys.includes(k));
    if (unknown.length) return { family, op, kind: "other", submits: false, unknownKeys: unknown };
  }
  const c = spec.fn(ti);
  const out = { family, op, submits: false, ...c };
  if (!out.target) delete out.target;
  if (out.outputs && !out.outputs.length) delete out.outputs;
  const tab = tabOf(ti);
  if (tab != null) out.tab = String(tab);
  return out;
}

function single(name, ti) {
  let m;
  if ((m = CLAUDE.exec(name))) return { server: m[1], ...apply("claude-browser", CLAUDE_OPS, m[2], ti) };
  if ((m = DEVTOOLS.exec(name))) return { server: m[1], ...apply("chrome-devtools", DEVTOOLS_OPS, m[2], ti) };
  if ((m = PLAYWRIGHT.exec(name))) {
    const op = m[2].startsWith("browser_") ? m[2].slice("browser_".length) : null;
    return { server: m[1], ...(op ? apply("playwright", PW_OPS, op, ti) : { family: "playwright", kind: "other", submits: false }), op: m[2] };
  }
  return { server: null, family: "unknown", op: name, kind: "other", submits: false };
}

// Classifica una chiamata; browser_batch → actions[] classificate una per una
// (nomi brevi risolti sullo stesso server), kind = la più pericolosa, submits in OR.
export function classify(toolName, toolInput) {
  const name = String(toolName ?? "");
  const ti = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput) ? toolInput : {};
  const m = CLAUDE.exec(name);
  if (!m || m[2] !== "browser_batch") return { tool: name, ...single(name, ti) };
  const server = m[1];
  const base = { tool: name, server, family: "claude-browser", op: "browser_batch", submits: false };
  const raw = ti.actions;
  if (!Array.isArray(raw) || raw.length === 0 || Object.keys(ti).some((k) => k !== "actions")) return { ...base, kind: "other" };
  const actions = raw.map((a) => {
    if (!a || typeof a !== "object" || typeof a.name !== "string") return { tool: null, family: "claude-browser", op: "?", kind: "other", submits: false };
    const full = a.name.startsWith("mcp__") ? a.name : `${server}__${a.name}`;
    const inner = a.input && typeof a.input === "object" && !Array.isArray(a.input) ? a.input : {};
    const x = single(full, inner);
    if (x.op === "browser_batch") return { tool: full, ...x, kind: "other" };   // niente lotti annidati
    return { tool: full, ...x };
  });
  const worst = actions.reduce((w, a) => (KIND_RANK[a.kind] > KIND_RANK[w.kind] ? a : w), actions[0]);
  return { ...base, kind: worst.kind, submits: actions.some((a) => a.submits), actions };
}
