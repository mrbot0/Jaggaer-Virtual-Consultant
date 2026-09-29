// WP10a — helper dei test dei comandi e del manuale: lettura dei comandi, frontmatter, righe di comando, azioni
// dell'argument-hint e delle tabelle §56 del manuale.
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./hook-env.mjs";

export const FAMILIES = ["vc", "use", "kb", "nrt", "cfg", "ops", "learn", "admin"];
// §44.2 / WP10b: le 15 definizioni foglia (il manager è la skill agent-manager, non un agente)
export const LEAF_AGENTS = ["scope-expert", "scope-extractor", "scope-digester", "customer-profiler", "process-mapper", "cluster-validator", "weekly-digest",
  "root-cause-analyst", "config-designer", "lesson-validator", "analytics-learner", "test-mechanic", "failure-triage", "config-auditor", "defect-reporter"];

const lf = (s) => s.replace(/\r\n/g, "\n");
export function commandFiles() {
  const out = {};
  for (const f of readdirSync(join(ROOT, "commands")).filter((x) => x.endsWith(".md")).sort()) out[f.slice(0, -3)] = lf(readFileSync(join(ROOT, "commands", f), "utf8"));
  return out;
}

export function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---/.exec(lf(text));
  if (!m) return {};
  const fm = {};
  for (const line of m[1].split("\n")) { const i = line.indexOf(":"); if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
  return fm;
}

// Righe `node "${CLAUDE_PLUGIN_ROOT}/…mjs" …` (blocchi rientrati o fra backtick), senza l'annotazione finale
// "   (…)" che spiega quando aggiungere un'opzione.
export function commandLines(text) {
  return [...lf(text).matchAll(/node "\$\{CLAUDE_PLUGIN_ROOT\}\/[^"\n]+"[^`\n]*/g)].map((m) => m[0].replace(/\s{2,}\(.*$/, "").replace(/[\s;,.]+$/, "").trim());
}

// Resa con valori di esempio: il percorso del plugin (Claude Code lo sostituisce nel corpo), $ARGUMENTS, segnaposto <…>.
export function renderLine(line, root) {
  return line.replaceAll("${CLAUDE_PLUGIN_ROOT}", root).replace(/\$ARGUMENTS/g, "status").replace(/<[^<>]*>/g, "X1");
}

// Azioni di un argument-hint: alternative separate da " | " al livello più esterno (fuori da [] <> ()), prima parola.
export function hintActions(hint) {
  const parts = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < hint.length; i++) {
    const ch = hint[i];
    if ("[<(".includes(ch)) depth++;
    else if ("]>)".includes(ch)) depth--;
    if (depth === 0 && hint.startsWith(" | ", i)) { parts.push(cur); cur = ""; i += 2; continue; }
    cur += ch;
  }
  parts.push(cur);
  return new Set(parts.map((p) => p.trim().split(/\s+/)[0]).filter(Boolean));
}

// Azioni della tabella del manuale per una famiglia: la prima tabella dopo il titolo "### 56.n `<famiglia>`"; nella prima
// colonna ogni tratto fra backtick, separato da " · ", dà un'azione (prima parola); "*(nessuna)*" non è un'azione.
export function manualActions(manual, family) {
  const text = lf(manual);
  const h = new RegExp(`^### 56\\.\\d+ \`${family}\``, "m").exec(text);
  if (!h) return null;
  const rest = text.slice(h.index);
  const next = rest.slice(4).search(/^#{2,3} /m);
  const section = next >= 0 ? rest.slice(0, next + 4) : rest;
  const rows = section.split("\n").filter((l) => /^\|/.test(l)).slice(2);
  const out = new Set();
  for (const r of rows) {
    const first = r.split(/(?<!\\)\|/)[1] ?? "";
    for (const m of first.matchAll(/`([^`]+)`/g)) for (const part of m[1].split(" · ")) { const w = part.trim().split(/\s+/)[0]; if (w) out.add(w); }
  }
  return out;
}
