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
// regole cardine: senza di esse la policy è considerata manomessa
export const REQUIRED = ["DR-SHELL-001", "DR-SHELL-003", "DR-WRITE-001", "DR-WRITE-003", "DR-BROWSER-002"];
const APPLIES = new Set(["shell", "write", "browser"]);
const ON = { shell: new Set(["command", "text", "glob"]), write: new Set(["path", "content"]), browser: new Set(["label", "key"]) };

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
      if (typeof p === "string" && r.on === "glob") return { sample: p };
      if (typeof p === "string") return { re: p, flags: "iu" };
      if (p && typeof p === "object" && typeof p.re === "string") return { re: p.re, flags: typeof p.flags === "string" ? p.flags : "iu", ...(typeof p.unless === "string" ? { unless: p.unless } : {}) };
      if (p && typeof p === "object" && typeof p.glob === "string" && r.on === "path") return { glob: p.glob };
      if (p && typeof p === "object" && typeof p.plugin_glob === "string" && r.on === "path") return { plugin_glob: p.plugin_glob };
      throw new Error(`${at}: pattern non valido ${JSON.stringify(p)}`);
    });
    const list = (k) => (r[k] === undefined ? undefined : Array.isArray(r[k]) && r[k].every((x) => typeof x === "string") ? r[k] : (() => { throw new Error(`${at}: ${k} deve essere un elenco di stringhe`); })());
    const out = { id: r.id, severity: r.severity, reason: r.reason.trim(), applies_to: r.applies_to, on: r.on, patterns };
    for (const k of ["when_step_class", "unless_step_class", "supersedes"]) { const v = list(k); if (v) out[k] = v; }
    if (r.trusted_labels_only === true) out.trusted_labels_only = true;
    if (r.on === "glob") out.samples = patterns.map((p) => p.sample);
    if (r.unless_env !== undefined) { if (typeof r.unless_env !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(r.unless_env)) throw new Error(`${at}: unless_env non valido`); out.unless_env = r.unless_env; }
    return out;
  });
  for (const r of rules) for (const s of r.supersedes ?? []) if (!ids.has(s)) throw new Error(`deny-rules: ${r.id} supersedes una regola inesistente ${s}`);
  const sanctioned = (Array.isArray(doc.sanctioned) ? doc.sanctioned : []).map((s, i) => {
    if (!s || typeof s.id !== "string" || typeof s.script !== "string" || !/^[\w./-]+\.mjs$/.test(s.script) || s.script.includes("..")) throw new Error(`deny-rules: sanctioned ${i + 1} non valida`);
    if (!Array.isArray(s.require_args) || !s.require_args.every((a) => typeof a === "string" && /^--[\w-]+$/.test(a))) throw new Error(`deny-rules: sanctioned ${s.id}: require_args non valido`);
    // giro 1 (C1): forma di ogni argomento (posizionali e opzioni); ogni regex deve compilare
    const positional = Array.isArray(s.positional) ? s.positional : null;
    const flags = s.flags && typeof s.flags === "object" && !Array.isArray(s.flags) ? s.flags : null;
    if (!positional || !positional.every((x) => typeof x === "string") || !flags || !Object.entries(flags).every(([k, v]) => /^--[\w-]+$/.test(k) && (v === null || typeof v === "string"))) throw new Error(`deny-rules: sanctioned ${s.id}: positional/flags mancanti o non validi`);
    for (const re of [...positional, ...Object.values(flags).filter(Boolean)]) new RegExp(re);
    if (!s.require_args.every((a) => Object.hasOwn(flags, a))) throw new Error(`deny-rules: sanctioned ${s.id}: require_args fuori da flags`);
    // WP09d: requires_if { "--flag": ["--altra", …] } — se c'è --flag servono anche le altre (retention: --apply ⇒ --approval)
    const requiresIf = s.requires_if === undefined ? {} : s.requires_if;
    if (!requiresIf || typeof requiresIf !== "object" || Array.isArray(requiresIf) || !Object.entries(requiresIf).every(([k, v]) => Object.hasOwn(flags, k) && Array.isArray(v) && v.every((x) => typeof x === "string" && Object.hasOwn(flags, x)))) throw new Error(`deny-rules: sanctioned ${s.id}: requires_if non valido`);
    // WP09d giro 1: first_arg (sotto-comando a cui la regola si applica) e approvals { kind, tokens, target_arg, when? }
    if (s.first_arg !== undefined && (typeof s.first_arg !== "string" || !/^[a-z][a-z0-9-]*$/.test(s.first_arg))) throw new Error(`deny-rules: sanctioned ${s.id}: first_arg non valido`);
    let approvals = null;
    if (s.approvals !== undefined) {
      const a = s.approvals;
      const ok = a && typeof a === "object" && ["purge", "retention", "promote"].includes(a.kind) && Array.isArray(a.tokens) && a.tokens.length
        && a.tokens.every((t) => typeof t === "string" && Object.hasOwn(flags, t)) && Number.isInteger(a.target_arg) && a.target_arg >= 0 && a.target_arg < positional.length
        && (a.when === undefined || (typeof a.when === "string" && Object.hasOwn(flags, a.when)));
      if (!ok) throw new Error(`deny-rules: sanctioned ${s.id}: approvals non valido`);
      approvals = { kind: a.kind, tokens: [...a.tokens], target_arg: a.target_arg, ...(a.when ? { when: a.when } : {}) };
    }
    return { id: s.id, script: s.script, ...(s.first_arg ? { first_arg: s.first_arg } : {}), require_args: s.require_args, requires_if: requiresIf, positional, flags,
      ...(approvals ? { approvals } : {}), reason: String(s.reason ?? "") };
  });
  // giro 1 (M5): una policy svuotata o senza le regole cardine non è valida (il guard nega)
  for (const area of ["shell", "write", "browser"]) if (!rules.some((r) => r.applies_to.includes(area))) throw new Error(`deny-rules: nessuna regola per ${area}`);
  for (const id of REQUIRED) if (!ids.has(id)) throw new Error(`deny-rules: manca la regola cardine ${id}`);
  const vocab = doc.command_vocabulary === undefined ? [] : doc.command_vocabulary;
  if (!Array.isArray(vocab) || !vocab.every((v) => typeof v === "string" && /^[a-z0-9._-]+$/.test(v))) throw new Error("deny-rules: command_vocabulary non valido");
  return { version: doc.version ?? 1, sanctioned, rules, command_vocabulary: vocab };
}

// Forma normalizzata → regole con regex compilate (lancia se una regex non compila).
export function compileRules(norm) {
  const rules = norm.rules.map((r) => ({
    ...r,
    compiled: r.patterns.map((p) => (p.re ? { re: new RegExp(p.re, p.flags), unless: p.unless ? new RegExp(p.unless, "iu") : null } : p)),
  }));
  return { version: norm.version, sanctioned: norm.sanctioned, rules, command_vocabulary: norm.command_vocabulary ?? [] };
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
