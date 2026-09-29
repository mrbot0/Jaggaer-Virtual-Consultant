// Dominio analitico (§1.1, F8) — WP09d: scrittura e lettura degli item PAT, PBK, BRF, RUL.
//   customers/<C>/analysis/{patterns,playbooks,briefings,rules}/<codice>.yaml  (livello C)
//   product/analysis/{…}/<codice>.yaml                                          (livello S)
// Il codice lo assegna il DB (analysis_items, fuori dall'indice di kb); l'item è validato (schema del tipo) e controllato
// sul confine dei domini (validate-boundary: analysis/ non cita mai un test NRT.*) PRIMA di essere scritto.
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { openDb } from "../kb/db.mjs";
import { assignSeq, formatCode } from "../kb/assign-seq.mjs";
import { isValidCode } from "../kb/codes.mjs";
import { validateItem } from "../kb/validate-schema.mjs";
import { BOUNDARY_RULES } from "../kb/validate-boundary.mjs";

export const ANALYSIS_DIRS = Object.freeze({ PAT: "patterns", PBK: "playbooks", BRF: "briefings", RUL: "rules" });
export const NRT_RE = BOUNDARY_RULES.find((r) => r.dir === "analysis").re;
export class AnalysisError extends Error { constructor(code, m) { super(m); this.name = "AnalysisError"; this.code = code; } }

export const rootOf = (ws, level, customer) => (level === "S" ? join(ws, "product") : join(ws, "customers", customer));
export const dbOf = (ws, level, customer) => join(rootOf(ws, level, customer), "knowledge.db");

export function facetsFor(type, { release = "n/d", date = new Date().toISOString().slice(0, 10) } = {}) {
  const F4 = { PAT: "anomalia", PBK: "procedura", BRF: "profilo", RUL: "regola-business" }[type];
  return { F1: "ticket", F4, F5: "saas-core", F6: [], F7: "nessuno", F8: "specifica", F9: "ripetitiva", F10: "R0", F11: "probabilistico", F12: "digerito",
    F13: { verified_at: date, release }, F15: "empirica" };
}

// Scrive un item analitico nuovo: SEQ dal DB, validazione, confine, file per ultimo (nella transazione).
export function writeAnalysisItem(ws, { level = "C", customer, scope, type }, build) {
  const cust = level === "S" ? "STD" : customer;
  const db = openDb(dbOf(ws, level, customer));
  try {
    return db.transaction(() => {
      const key = { level, customer: cust, scope, type };
      const code = formatCode({ ...key, seq: assignSeq(db, key, { table: "analysis_items" }) });
      if (!isValidCode(code)) throw new AnalysisError(1, `codice non valido: ${code}`);
      const obj = build(code);
      const v = validateItem(obj);
      if (!v.ok) throw new AnalysisError(1, `${code} non valido: ${v.errors.join("; ")}`);
      const text = YAML.stringify(obj);
      const m = NRT_RE.exec(text);
      if (m) throw new AnalysisError(3, `confine dei domini: ${code} citerebbe un test (${m[0]}); analysis/ non referenzia mai un test (§1.1)`);
      const root = rootOf(ws, level, customer);
      const dir = join(root, "analysis", ANALYSIS_DIRS[type]);
      const file = join(dir, `${code}.yaml`);
      db.prepare("insert into analysis_items(code,type,scope,path,hash,created_at) values (?,?,?,?,?,?)")
        .run(code, type, scope, relative(root, file).replace(/\\/g, "/"), createHash("sha256").update(text).digest("hex"), new Date().toISOString());
      mkdirSync(dir, { recursive: true });
      writeFileSync(file, text);
      return { code, file, obj };
    })();
  } finally { db.close(); }
}

// Item analitici di un tipo (e di uno scope) sotto una radice (customers/<C> o product).
export function loadAnalysis(root, type, { scope = null } = {}) {
  const dir = join(root, "analysis", ANALYSIS_DIRS[type]);
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => new RegExp(`^[SC]\\.[A-Z0-9]{3,4}\\.[A-Z0-9]{3}\\.${type}\\.\\d{4}\\.ya?ml$`).test(x)).sort()) {
    let o;
    try { o = YAML.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    if (!o || o.type !== type) continue;
    if (scope && o.id.split(".")[2] !== scope) continue;
    out.push(o);
  }
  return out;
}
