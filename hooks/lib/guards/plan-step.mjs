// Il passo attivo del piano (session.active_plan, mantenuto da step-check in K6)
// e le voci dell'Atlas (SEL) che guard-production e guard-config-scope leggono.
// Il guard non legge il prompt: legge il piano, l'Atlas e la classe dell'azione (§52.1).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadPlanFile } from "../../../scripts/admin/approvals.mjs";

// → { none: true } | { reason } | { ap, plan, step, sha256, file }
export async function activeStep(ctx) {
  const ap = ctx.session?.active_plan;
  if (!ap) return { none: true };
  // revisione finale (minore B#7): passo verificato, gate del successivo negato ⇒ nessuna azione legata al piano
  if (ap.gate_denied && typeof ap.gate_denied === "object") return { reason: `passo ${ap.step} del piano ${ap.plan_id} completato; il passo ${ap.gate_denied.step} è stato negato (${String(ap.gate_denied.reason ?? "gate").slice(0, 160)}): nessuna azione legata al piano finché step-check non riattiva un passo (--resume) o il piano si chiude (--close)` };
  let info;
  try { info = await loadPlanFile(ctx.ws, ctx.customer, ap.file); } catch (err) { return { reason: `piano attivo illeggibile (${String(err.message).split("\n")[0]})` }; }
  if (!info) return { reason: `piano attivo non trovato o fuori dalla cartella del cliente: ${ap.file}` };
  const plan = info.plan;
  if (!plan || plan.plan_id !== ap.plan_id) return { reason: `il file ${ap.file} non è il piano attivo ${ap.plan_id}` };
  // WP07 giro 1 (C2 b, I1): il piano attivo è quello validato e attivato da step-check, con la sua impronta
  if (typeof ap.plan_sha256 !== "string") return { reason: `piano attivo ${ap.plan_id} senza impronta: riattivalo con step-check` };
  if (ap.plan_sha256 !== info.sha256) return { reason: `il piano ${ap.plan_id} è stato modificato dopo l'attivazione (impronta diversa): chiudilo e riattivalo con step-check` };
  const step = Array.isArray(plan.steps) ? plan.steps.find((s) => s && s.n === ap.step) : null;
  if (!step) return { reason: `il piano ${ap.plan_id} non ha il passo attivo ${ap.step}` };
  return { ap, plan, step, sha256: info.sha256, file: info.file };
}

const SEL_RE = /^([SCL])\.([A-Z0-9]{3,4})\.([A-Z0-9]{3})\.SEL\.\d{4}(\.v\d+)?$/;
// Voce dell'Atlas per codice: S → product/kb, C/L → customers/<cliente attivo>/kb;
// kb/scopes/<SCOPE>/selectors/<codice>.yaml (§8.2). → { role, effect, code } | null
export async function readSel(ctx, code) {
  const m = typeof code === "string" ? SEL_RE.exec(code) : null;
  if (!m) return null;
  const [, level, cust, scope] = m;
  if (level !== "S" && cust !== ctx.customer) return null;
  const base = level === "S" ? join(ctx.ws, "product", "kb") : join(ctx.ws, "customers", ctx.customer, "kb");
  let text;
  try { text = readFileSync(join(base, "scopes", scope, "selectors", `${code}.yaml`), "utf8"); } catch { return null; }
  const fast = topScalars(text, ["id", "role", "effect"]);
  let doc = fast;
  if (!doc) { try { doc = (await import("yaml")).default.parse(text); } catch { return null; } }
  if (!doc || doc.id !== code) return null;
  return { code, role: typeof doc.role === "string" ? doc.role : null, effect: typeof doc.effect === "string" ? doc.effect : null };
}

// Lettura veloce (senza il modulo yaml, ~40 ms) delle chiavi scalari di primo
// livello di una voce dell'Atlas: solo se ogni chiave compare al più una volta, in
// colonna 0, con un valore semplice (parola, eventualmente fra virgolette) e il
// file non ha più documenti né ancore. Altrimenti null ⇒ parser YAML completo.
function topScalars(text, keys) {
  if (/^(---|\.\.\.)\s*$/m.test(text.replace(/^---\s*\n/, "")) || /[&*!]\w/.test(text.split("\n").filter((l) => keys.some((k) => l.startsWith(`${k}:`))).join("\n"))) return null;
  const out = {};
  for (const k of keys) {
    const lines = text.split(/\r?\n/).filter((l) => l.startsWith(`${k}:`));
    if (lines.length > 1) return null;
    if (!lines.length) continue;
    const m = /^[A-Za-z_]+:\s*(?:"([A-Za-z0-9._-]*)"|'([A-Za-z0-9._-]*)'|([A-Za-z0-9._-]+))\s*(?:#.*)?$/.exec(lines[0]);
    if (!m) return null;
    out[k] = m[1] ?? m[2] ?? m[3];
  }
  return out;
}
