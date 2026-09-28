// Caricamento di policy/deny-rules.yaml per guard-destructive (F0.1). Le regole stanno nel file YAML; questo modulo
// le valida e compila le regex. Percorso veloce: hooks/lib/generated/deny-rules.mjs (copia compilata da
// scripts/admin/build-deny-rules.mjs) vale solo se l'impronta del file YAML (a capo LF) coincide con quella registrata;
// altrimenti si rilegge il YAML con il modulo `yaml` (~40 ms). File assente, YAML rotto, regola malformata o regex che
// non compila ⇒ eccezione ⇒ il guard nega (FAIL-CLOSED). Solo moduli built-in in testa.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const POLICY_FILE = fileURLToPath(new URL("../../policy/deny-rules.yaml", import.meta.url));
export const policySha = (text) => createHash("sha256").update(String(text).replace(/\r\n/g, "\n")).digest("hex");

const SEVERITIES = new Set(["hard-deny", "confirm"]);
const APPLIES = new Set(["shell", "write", "browser"]);
const ON = { shell: new Set(["command", "text"]), write: new Set(["path", "content"]), browser: new Set(["label", "key"]) };

// Documento YAML → forma normalizzata (solo dati JSON): lancia su ogni campo non valido.
export function normalizeDoc(doc) {
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.rules)) throw new Error("deny-rules: manca l'elenco rules");
  const ids = new Set();
  const rules = doc.rules.map((r, i) => {
    const at = `deny-rules: regola ${i + 1} (${r?.id ?? "senza id"})`;
    if (!r || typeof r !== "object") throw new Error(`${at}: non è un oggetto`);
    if (typeof r.id !== "string" || !/^DR-[A-Z]+-\d{3}$/.test(r.id) || ids.has(r.id)) throw new Error(`${at}: id mancante, malformato o duplicato`);
    ids.add(r.id);
    if (!SEVERITIES.has(r.severity)) throw new Error(`${at}: severity deve essere hard-deny o confirm`);
    if (typeof r.reason !== "string" || !r.reason.trim()) throw new Error(`${at}: reason mancante`);
    if (!Array.isArray(r.applies_to) || !r.applies_to.length || !r.applies_to.every((a) => APPLIES.has(a))) throw new Error(`${at}: applies_to non valido`);
    if (!r.applies_to.every((a) => ON[a].has(r.on))) throw new Error(`${at}: on "${r.on}" non valido per ${r.applies_to.join(",")}`);
    if (!Array.isArray(r.patterns) || !r.patterns.length) throw new Error(`${at}: patterns mancanti`);
    const patterns = r.patterns.map((p) => {
      if (typeof p === "string") return { re: p, flags: "iu" };
      if (p && typeof p === "object" && typeof p.re === "string") return { re: p.re, flags: typeof p.flags === "string" ? p.flags : "iu", ...(typeof p.unless === "string" ? { unless: p.unless } : {}) };
      if (p && typeof p === "object" && typeof p.glob === "string" && r.on === "path") return { glob: p.glob };
      if (p && typeof p === "object" && typeof p.plugin_glob === "string" && r.on === "path") return { plugin_glob: p.plugin_glob };
      throw new Error(`${at}: pattern non valido ${JSON.stringify(p)}`);
    });
    const list = (k) => (r[k] === undefined ? undefined : Array.isArray(r[k]) && r[k].every((x) => typeof x === "string") ? r[k] : (() => { throw new Error(`${at}: ${k} deve essere un elenco di stringhe`); })());
    const out = { id: r.id, severity: r.severity, reason: r.reason.trim(), applies_to: r.applies_to, on: r.on, patterns };
    for (const k of ["when_step_class", "unless_step_class", "supersedes"]) { const v = list(k); if (v) out[k] = v; }
    if (r.unless_env !== undefined) { if (typeof r.unless_env !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(r.unless_env)) throw new Error(`${at}: unless_env non valido`); out.unless_env = r.unless_env; }
    return out;
  });
  for (const r of rules) for (const s of r.supersedes ?? []) if (!ids.has(s)) throw new Error(`deny-rules: ${r.id} supersedes una regola inesistente ${s}`);
  const sanctioned = (Array.isArray(doc.sanctioned) ? doc.sanctioned : []).map((s, i) => {
    if (!s || typeof s.id !== "string" || typeof s.script !== "string" || !/^[\w./-]+\.mjs$/.test(s.script) || s.script.includes("..")) throw new Error(`deny-rules: sanctioned ${i + 1} non valida`);
    if (!Array.isArray(s.require_args) || !s.require_args.every((a) => typeof a === "string" && /^--[\w-]+$/.test(a))) throw new Error(`deny-rules: sanctioned ${s.id}: require_args non valido`);
    return { id: s.id, script: s.script, require_args: s.require_args, reason: String(s.reason ?? "") };
  });
  return { version: doc.version ?? 1, sanctioned, rules };
}

// Forma normalizzata → regole con regex compilate (lancia se una regex non compila).
export function compileRules(norm) {
  const rules = norm.rules.map((r) => ({
    ...r,
    compiled: r.patterns.map((p) => (p.re ? { re: new RegExp(p.re, p.flags), unless: p.unless ? new RegExp(p.unless, "iu") : null } : p)),
  }));
  return { version: norm.version, sanctioned: norm.sanctioned, rules };
}

// → regole compilate dal file di policy (o dalla copia generata con la stessa impronta).
export async function loadRules(file = POLICY_FILE) {
  const text = readFileSync(file, "utf8");
  const sha = policySha(text);
  if (file === POLICY_FILE) {
    let gen = null;
    try { gen = (await import("./generated/deny-rules.mjs")).default; } catch { gen = null; }
    if (gen && gen.sha256 === sha) return compileRules(gen);
  }
  const YAML = (await import("yaml")).default;
  return compileRules(normalizeDoc(YAML.parse(text)));
}
