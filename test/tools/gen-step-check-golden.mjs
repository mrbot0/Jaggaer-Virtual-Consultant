// Genera gli snapshot golden di step-check (test/golden/step-check/<formato>/<caso>.txt) da un
// modello di pagina, nei tre formati di testo degli strumenti MCP del browser. I formati riproducono
// l'output reale degli strumenti (Chrome DevTools take_snapshot, Claude browser read_page, Playwright
// browser_snapshot) catturato sulla pagina test/fixtures/demo-tenant/requisition.html (2026-09-23).
// Uso: node test/tools/gen-step-check-golden.mjs   (riscrive i file; i test li leggono così come sono)
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const OUT = fileURLToPath(new URL("../golden/step-check/", import.meta.url));
const URL_EDIT = "https://acme-sbx.jaggaer.com/p2p/requisition/edit/10045";
const TITLE = "Richiesta d'acquisto - ACME SBX";

// Pagina di base: il passo 2 del piano demo (modulo compilato, in attesa di salvataggio).
function basePage() {
  return [
    { role: "banner", text: "SANDBOX" },
    { role: "heading", name: "Richiesta d'acquisto", level: 1 },
    { role: "textbox", name: "Descrizione", value: "RdA di prova - 5 sedie" },
    { role: "spinbutton", name: "Quantità", value: "5" },
    { role: "textbox", name: "Centro di costo", value: "IT-0442" },
    { role: "combobox", name: "Categoria", value: "Arredi", options: ["Arredi", "Informatica"] },
    { role: "checkbox", name: "Urgente", checked: false },
    { role: "button", name: "Salva bozza" },
    { role: "link", name: "Elenco richieste" },
  ];
}
const edit = (fn) => { const p = basePage(); fn(p); return p; };
const find = (p, name) => p.find((n) => n.name === name);

export const CASES = {
  ok: basePage(),
  "elemento-assente": edit((p) => p.splice(p.indexOf(find(p, "Centro di costo")), 1)),
  "stato-diverso": edit((p) => { find(p, "Urgente").checked = true; }),
  "attributo-diverso": edit((p) => { find(p, "Centro di costo").required = true; }),
  "elemento-in-piu": edit((p) => { find(p, "Categoria").options.push("Servizi"); }),
  "messaggio-inatteso": edit((p) => p.splice(2, 0, { role: "alert", text: "Il centro di costo non è attivo per la società selezionata (REQ-VAL-014)" })),
  novelty: edit((p) => p.splice(5, 0, { role: "textbox", name: "Codice progetto", value: "" })),
  "would-change": edit((p) => p.splice(2, 0, { role: "status", text: "Attenzione: la richiesta verrà riconvalidata al salvataggio" })),
};

// ---- Chrome DevTools take_snapshot ----
function devtools(page) {
  const out = ["## Latest page snapshot", `uid=1_0 RootWebArea "${TITLE}" url="${URL_EDIT}"`];
  let n = 1;
  const id = () => `1_${n++}`;
  const q = (s) => s.replace(/"/g, '\\"');
  for (const e of page) {
    if (e.role === "banner" || e.role === "alert" || e.role === "status") {
      out.push(`  uid=${id()} ${e.role}${e.role === "alert" ? ' atomic live="assertive" relevant="additions text"' : e.role === "status" ? ' live="polite"' : ""}`);
      out.push(`    uid=${id()} StaticText "${q(e.text)}"`);
      continue;
    }
    if (e.role === "heading") { out.push(`  uid=${id()} heading "${q(e.name)}" level="${e.level}"`); continue; }
    if (["button", "link"].includes(e.role)) { out.push(`  uid=${id()} ${e.role} "${q(e.name)}"${e.disabled ? " disableable disabled" : ""}`); continue; }
    out.push(`  uid=${id()} StaticText "${q(e.name)} "`);
    const attrs = [];
    if (e.role === "checkbox") attrs.push(e.checked ? "checked" : 'checked="false"');
    if (e.value !== undefined && e.role !== "checkbox") attrs.push(`value="${q(e.value)}"`);
    if (e.role === "combobox") attrs.push('expandable haspopup="listbox"');
    if (e.required) attrs.push("required");
    out.push(`  uid=${id()} ${e.role} "${q(e.name)} "${attrs.length ? ` ${attrs.join(" ")}` : ""}`);
    for (const o of e.options ?? []) out.push(`    uid=${id()} option "${q(o)}" selectable${o === e.value ? " selected" : ""}`);
  }
  return `${out.join("\n")}\n`;
}

// ---- Claude browser read_page ----
function claude(page) {
  const out = [];
  let n = 1;
  const ref = () => `[ref_${n++}]`;
  for (const e of page) {
    if (e.role === "banner" || e.role === "alert" || e.role === "status") { out.push(`${e.role} "${e.text}" ${ref()}`); continue; }
    if (e.role === "heading") { out.push(`heading "${e.name}" ${ref()}`); continue; }
    if (e.role === "button") { out.push(`button "${e.name}" ${ref()} type="button"${e.disabled ? " disabled" : ""}`); continue; }
    if (e.role === "link") { out.push(`link "${e.name}" ${ref()} href="/p2p/requisition/list"`); continue; }
    out.push(`label "${e.name}" ${ref()}`);
    const attrs = [];
    if (e.role === "checkbox" && e.checked) attrs.push("checked");
    if (e.required) attrs.push("required");
    const val = e.role === "checkbox" ? "" : e.value ? ` "${e.value}"` : "";
    out.push(` ${e.role}${val} ${ref()}${attrs.length ? ` ${attrs.join(" ")}` : ""}`);
    for (const o of e.options ?? []) out.push(`  option "${o}" ${ref()}`);
  }
  out.push("", "Viewport: 1280x800", "", "Tab Context:", "- Executed on tabId: 101", "- Available tabs:", `  • tabId 101: "${TITLE}" (${URL_EDIT})`);
  return `${out.join("\n")}\n`;
}

// ---- Playwright browser_snapshot ----
function playwright(page) {
  const out = ["### Page state", `- Page URL: ${URL_EDIT}`, `- Page Title: ${TITLE}`, "- Page Snapshot:", "```yaml"];
  let n = 2;
  const ref = () => `[ref=e${n++}]`;
  for (const e of page) {
    if (e.role === "banner" || e.role === "alert" || e.role === "status") { out.push(`- ${e.role} ${ref()}: ${e.text}`); continue; }
    if (e.role === "heading") { out.push(`- heading "${e.name}" [level=${e.level}] ${ref()}`); continue; }
    if (e.role === "button") { out.push(`- button "${e.name}"${e.disabled ? " [disabled]" : ""} ${ref()} [cursor=pointer]`); continue; }
    if (e.role === "link") { out.push(`- link "${e.name}" ${ref()} [cursor=pointer]:`, "  - /url: /p2p/requisition/list"); continue; }
    const br = [];
    if (e.role === "checkbox" && e.checked) br.push("[checked]");
    if (e.required) br.push("[required]");
    br.push(ref());
    if (e.options) {
      out.push(`- combobox "${e.name}" ${br.join(" ")}:`);
      for (const o of e.options) out.push(`  - option "${o}"${o === e.value ? " [selected]" : ""}`);
      continue;
    }
    out.push(`- ${e.role} "${e.name}" ${br.join(" ")}${e.value ? `: ${e.value}` : ""}`);
  }
  out.push("```");
  return `${out.join("\n")}\n`;
}

export const RENDER = { "chrome-devtools": devtools, "claude-browser": claude, playwright };

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const [fmt, fn] of Object.entries(RENDER)) {
    mkdirSync(join(OUT, fmt), { recursive: true });
    for (const [name, page] of Object.entries(CASES)) writeFileSync(join(OUT, fmt, `${name}.txt`), fn(page));
  }
  console.log(`golden scritti in ${OUT}`);
}
