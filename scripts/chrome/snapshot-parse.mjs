// Parser dei tre formati di testo degli strumenti MCP del browser (K6.1, §23.5, §46.3).
// L'agente salva il risultato dello strumento in un file e lo passa agli script; gli hook
// lo leggono da tool_response. Nessun modulo esterno: è sul percorso caldo di observe-append.
//
//   parseSnapshot(text) → { format, url, title, tab, elements: [{ role, name, ref, required?, value?,
//                           checked?, disabled?, level? }], texts: [], messages: [{ text, role }], headings: [] }
//
// Formati (verificati sugli strumenti reali, 2026-09):
//  - Chrome DevTools `take_snapshot`: righe `uid=1_4 heading "Titolo" level="1"`, attributi nudi
//    (required, disabled, checked) o `k="v"`; la prima riga `uid=… RootWebArea "titolo" url="…"`.
//  - Claude browser / Claude in Chrome `read_page`: righe `textbox "valore" [ref_7] type="…"`,
//    rientro di uno spazio per livello; i controlli dentro `label "X"` prendono il nome X e il testo
//    fra virgolette è il valore; in coda `Tab Context:` con `Executed on tabId: N` e `tabId N: "titolo" (url)`.
//  - Playwright `browser_snapshot`: sezione `### Page state` con `- Page URL:`, `- Page Title:` e lo YAML
//    `- textbox "Nome" [ref=e8]: valore`, attributi fra quadre ([checked] [disabled] [level=1]).
//  - altrimenti testo semplice (get_page_text): solo texts.

export const MESSAGE_ROLES = new Set(["alert", "status", "alertdialog", "dialog", "log", "marquee"]);
export const FIELD_ROLES = new Set(["textbox", "searchbox", "spinbutton", "combobox", "listbox", "checkbox", "radio", "switch", "slider", "textarea"]);
const TEXT_ROLES = new Set(["StaticText", "text", "InlineTextBox", "paragraph", "generic", "none", "LineBreak"]);
const unq = (s) => s.replace(/\\(["\\])/g, "$1");
export const clean = (s) => (typeof s === "string" ? s.replace(/\s+/g, " ").trim() : s);
// Etichetta per il confronto: minuscolo, senza accenti, spazi compattati, senza ":" o "*" finali.
export const normLabel = (s) => String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s+/g, " ").trim().replace(/[\s:*]+$/, "");

export function detectFormat(text) {
  const s = String(text ?? "");
  if (/^\s*uid=\S+\s+\S/m.test(s)) return "chrome-devtools";
  if (/\[ref=e\d+\]/.test(s) || /^-\s*Page URL:/m.test(s)) return "playwright";
  if (/\[ref_\d+\]/.test(s) || /^Tab Context:/m.test(s)) return "claude-browser";
  return "text";
}

const boolAttr = (v) => v === undefined || v === "" || v === "true";

function finish(out, nodes) {
  // messaggi: un contenitore (alert/status/dialog…) = un messaggio, dal nome o dai testi discendenti.
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const msgText = new Map();
  for (const n of nodes) {
    if (MESSAGE_ROLES.has(n.role)) msgText.set(n.id, { role: n.role, parts: n.name ? [n.name] : [], named: !!n.name });
  }
  for (const n of nodes) {
    if (!n.text) continue;
    let p = n.parent;
    while (p != null && !msgText.has(p)) p = byId.get(p)?.parent ?? null;
    if (p != null && !msgText.get(p).named) msgText.get(p).parts.push(n.text);
  }
  for (const [, m] of msgText) {
    const text = clean([...new Set(m.parts)].join(" "));
    if (text) out.messages.push({ text, role: m.role });
  }
  for (const n of nodes) {
    if (n.text) out.texts.push(n.text);
    if (n.role === "heading" && n.name) out.headings.push({ text: n.name, level: n.level ?? null });
    if (TEXT_ROLES.has(n.role) || n.role === "RootWebArea" || n.role === "label") continue;
    const e = { role: n.role, name: n.name ?? "", ref: n.ref ?? null };
    for (const k of ["required", "disabled", "checked", "value", "level", "box"]) if (n[k] !== undefined) e[k] = n[k];
    out.elements.push(e);
  }
  return out;
}

const base = (format) => ({ format, url: null, title: null, tab: null, elements: [], texts: [], messages: [], headings: [] });

// ---- Chrome DevTools ----
const DT_LINE = /^(\s*)uid=(\S+)\s+(\S+)(?:\s+"((?:[^"\\]|\\.)*)")?(.*)$/;
const DT_ATTR = /([A-Za-z][\w-]*)(?:="((?:[^"\\]|\\.)*)")?/g;
function parseDevtools(text) {
  const out = base("chrome-devtools");
  const nodes = [];
  const stack = [];
  let first = true;
  for (const line of text.split(/\r?\n/)) {
    const m = DT_LINE.exec(line);
    if (!m) continue;
    const [, ind, uid, role, rawName, rest] = m;
    const attrs = {};
    for (const a of rest.matchAll(DT_ATTR)) attrs[a[1]] = a[2] === undefined ? "" : unq(a[2]);
    if (first) {
      first = false;
      if (role === "RootWebArea") { out.title = rawName != null ? unq(rawName) : null; out.url = attrs.url ?? null; }
    }
    const depth = ind.length;
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const name = rawName != null ? clean(unq(rawName)) : "";
    const n = { id: uid, parent: stack.length ? stack[stack.length - 1].id : null, role, name, ref: uid };
    if (role === "StaticText") n.text = name;
    if ("required" in attrs) n.required = boolAttr(attrs.required);
    if ("disabled" in attrs) n.disabled = boolAttr(attrs.disabled);
    if ("checked" in attrs) n.checked = attrs.checked === "mixed" ? "mixed" : boolAttr(attrs.checked);
    if ("value" in attrs) n.value = attrs.value;
    if ("level" in attrs) n.level = Number(attrs.level);
    nodes.push(n);
    stack.push({ depth, id: uid });
  }
  return finish(out, nodes);
}

// ---- Claude browser / Claude in Chrome ----
const CL_LINE = /^(\s*)(?:-\s+)?([A-Za-z][\w-]*)(?:\s+"((?:[^"\\]|\\.)*)")?(?:\s+\[(ref_\d+)\])?(.*)$/;
function tabContext(text) {
  const i = text.lastIndexOf("Tab Context:");
  if (i < 0) return null;
  const tail = text.slice(i);
  const ex = /Executed on tabId:\s*(\S+)/.exec(tail);
  if (!ex) return null;
  const esc = ex[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = new RegExp(`tabId\\s+${esc}:\\s*"((?:[^"\\\\]|\\\\.)*)"\\s*\\((\\S+)\\)\\s*$`, "m").exec(tail);
  return { tab: ex[1], title: m ? unq(m[1]) : null, url: m ? m[2] : null };
}
function parseClaude(text) {
  const out = base("claude-browser");
  const ctx = tabContext(text);
  if (ctx) { out.tab = ctx.tab; out.title = ctx.title; out.url = ctx.url; }
  const body = text.split(/^(?:Viewport:|Tab Context:)/m)[0];
  const nodes = [];
  const stack = [];
  let seq = 0;
  for (const line of body.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const m = CL_LINE.exec(line);
    if (!m) continue;
    const [, ind, role, rawName, ref, rest] = m;
    if (!ref && rawName == null && !/^(StaticText|text)$/.test(role)) {
      // riga senza riferimento né nome: contenitore anonimo (es. "form") o testo non strutturato
      if (!/^[a-z]+$/i.test(line.trim())) continue;
    }
    const depth = ind.length;
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack.length ? stack[stack.length - 1] : null;
    const id = ref ?? `n${seq++}`;
    const quoted = rawName != null ? clean(unq(rawName)) : "";
    const n = { id, parent: parent?.id ?? null, role, name: quoted, ref: ref ?? null };
    const attrs = {};
    for (const a of (rest ?? "").matchAll(DT_ATTR)) attrs[a[1]] = a[2] === undefined ? "" : unq(a[2]);
    if (FIELD_ROLES.has(role)) {
      // dentro un label: il nome è l'etichetta, il testo fra virgolette è il valore
      if (parent?.label != null) { n.name = parent.label; if (quoted) n.value = quoted; }
      if ("required" in attrs) n.required = boolAttr(attrs.required);
      if ("checked" in attrs) n.checked = boolAttr(attrs.checked);
      if ("value" in attrs) n.value = attrs.value;
    }
    if ("disabled" in attrs) n.disabled = boolAttr(attrs.disabled);
    if ("level" in attrs) n.level = Number(attrs.level);
    if (role === "StaticText" || role === "text") n.text = quoted;
    nodes.push(n);
    stack.push({ depth, id, label: role === "label" ? quoted : null });
  }
  return finish(out, nodes);
}

// ---- Playwright ----
const PW_LINE = /^(\s*)- ([A-Za-z/][\w/-]*)(?: "((?:[^"\\]|\\.)*)")?((?: \[[^\]]*\])*)(:)?(?: (.*))?$/;
function parsePlaywright(text) {
  const out = base("playwright");
  const state = text.indexOf("### Page state");
  const head = state >= 0 ? text.slice(state) : text;
  const u = /^- Page URL:\s*(\S+)\s*$/m.exec(head);
  const t = /^- Page Title:\s*(.*?)\s*$/m.exec(head);
  out.url = u ? u[1] : null;
  out.title = t ? t[1] : null;
  const nodes = [];
  const stack = [];
  let seq = 0;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((l) => /^- Page Snapshot:/.test(l));
  for (const line of start >= 0 ? lines.slice(start + 1) : lines) {
    if (/^(###|```)/.test(line) || /^- Page (URL|Title|Snapshot):/.test(line)) continue;
    const m = PW_LINE.exec(line);
    if (!m) continue;
    const [, ind, role, rawName, brackets, , content] = m;
    if (role.startsWith("/")) continue;   // /url: …, /placeholder: …
    const depth = ind.length;
    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    const parent = stack.length ? stack[stack.length - 1] : null;
    const attrs = {};
    for (const b of (brackets ?? "").matchAll(/\[([^\]=]+)(?:=([^\]]*))?\]/g)) attrs[b[1]] = b[2] === undefined ? "" : b[2];
    const id = attrs.ref ?? `n${seq++}`;
    const n = { id, parent: parent?.id ?? null, role, name: rawName != null ? clean(unq(rawName)) : "", ref: attrs.ref ?? null };
    const body = content != null ? clean(content.replace(/^"(.*)"$/, "$1")) : null;
    if (role === "text") n.text = body ?? n.name;
    else if (body) {
      if (FIELD_ROLES.has(role)) n.value = body;
      else if (!n.name) n.name = body;
      else n.text = body;
    }
    if ("required" in attrs) n.required = boolAttr(attrs.required);
    if ("disabled" in attrs) n.disabled = boolAttr(attrs.disabled);
    if ("checked" in attrs) n.checked = attrs.checked === "mixed" ? "mixed" : boolAttr(attrs.checked);
    if ("level" in attrs) n.level = Number(attrs.level);
    // browser_snapshot con boxes: true ⇒ [box=x,y,w,h] (pixel CSS del viewport): servono a capture per le maschere
    if (/^-?[\d.]+,-?[\d.]+,[\d.]+,[\d.]+$/.test(attrs.box ?? "")) { const [x, y, w, h] = attrs.box.split(",").map(Number); n.box = { x, y, w, h }; }
    if (!FIELD_ROLES.has(role) && !MESSAGE_ROLES.has(role) && TEXT_ROLES.has(role) && n.name && !n.text) n.text = n.name;
    nodes.push(n);
    stack.push({ depth, id });
  }
  return finish(out, nodes);
}

function parseText(text) {
  const out = base("text");
  const u = /^\s*(?:page\s+)?url:\s*(\S+)/im.exec(text);
  const t = /^\s*(?:page\s+)?title:\s*(.+?)\s*$/im.exec(text);
  out.url = u ? u[1] : null;
  out.title = t ? t[1] : null;
  out.texts = text.split(/\r?\n/).map(clean).filter(Boolean);
  return out;
}

export function parseSnapshot(text) {
  const s = String(text ?? "");
  const f = detectFormat(s);
  if (f === "chrome-devtools") return parseDevtools(s);
  if (f === "claude-browser") return parseClaude(s);
  if (f === "playwright") return parsePlaywright(s);
  return parseText(s);
}

// Testo di una tool_response MCP: stringa, array di blocchi { type: "text", text } o { content: [...] }.
export function responseText(resp) {
  if (typeof resp === "string") return resp;
  const blocks = Array.isArray(resp) ? resp : resp && typeof resp === "object" && Array.isArray(resp.content) ? resp.content : [];
  return blocks.filter((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string").map((b) => b.text).join("\n");
}
export function responseHasImage(resp) {
  const blocks = Array.isArray(resp) ? resp : resp && typeof resp === "object" && Array.isArray(resp.content) ? resp.content : [];
  return blocks.some((b) => b && typeof b === "object" && b.type === "image");
}

// ---- firma della pagina (§20.1): percorso normalizzato (senza id, numeri, query) + titolo principale ----
const ID_SEG = /^(\d+|[0-9a-f]{8,}|[0-9a-f-]{16,}|.*\d{3,}.*)$/i;
export const slug = (s) => String(s ?? "").normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
export function normalizePath(url) {
  let u;
  try { u = new URL(String(url)); } catch { return null; }
  if (!/^(https?|file):$/.test(u.protocol)) return null;
  const segs = u.pathname.split("/").filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } })
    .map((x) => x.toLowerCase().replace(/\.(html?|do|aspx?|jsp|php)$/, ""))
    .filter((x) => x && !ID_SEG.test(x));
  return segs.join("/");
}
export function mainHeading(page) {
  const h = page?.headings ?? [];
  return (h.find((x) => x.level === 1) ?? h[0])?.text ?? null;
}
export function pageSignature(page) {
  const p = page?.url ? normalizePath(page.url) : null;
  const h = mainHeading(page);
  if (p == null && !h) return null;
  return `${p ?? ""}${h ? `#${slug(h)}` : ""}`;
}
