// guard-domain-boundary (FAIL-CLOSED): kb/ ↔ analysis/ (§1.1, §5.4, §32).
//  - scrittura in kb/ che cita analysis/ o codici PAT/PBK/BRF/RUL ⇒ deny;
//  - scrittura in analysis/ che cita test NRT.* ⇒ deny
//    (stesse regex di scripts/kb/validate-boundary.mjs);
//  - lettura/ricerca in analysis/ ⇒ solo root-cause-analyst, failure-triage,
//    defect-reporter; scope-expert solo in modalità diag e solo il BRF del
//    proprio scope (Read puntuale).
import { intersects, segs, skeleton } from "../paths.mjs";
import { BOUNDARY_RULES } from "../../../scripts/kb/validate-boundary.mjs";
import { guarded, denyAudited, targetsOf, FILE_TOOLS, SEARCH_TOOLS, WRITE_TOOLS } from "./common.mjs";

const G = "guard-domain-boundary";
const KB = ["product/kb/**", "customers/*/kb/**"];
const AN = ["product/analysis/**", "customers/*/analysis/**"];
const ANALYSTS = new Set(["root-cause-analyst", "failure-triage", "defect-reporter"]);

function writtenContent(tool, ti) {
  if (tool === "Write") return ti.content;
  if (tool === "Edit") return ti.new_string;
  if (tool === "MultiEdit") return Array.isArray(ti.edits) ? ti.edits.map((e) => e?.new_string ?? "").join("\n") : "";
  if (tool === "NotebookEdit") return ti.new_source;
  return "";
}

function firstViolation(dir, text) {
  if (typeof text !== "string" || !text) return null;
  const texts = text.length < 1_000_000 ? [text, skeleton(text)] : [text];
  for (const r of BOUNDARY_RULES.filter((x) => x.dir === dir)) {
    for (const t of texts) { const m = r.re.exec(t); if (m) return `${r.rule} → "${m[0]}"`; }
  }
  return null;
}

function isOwnBrf(p, session) {
  if (!session?.scope || !session.customer) return false;
  const s = segs(p);
  const inBriefings = (s[0] === "product" && s[1] === "analysis" && s[2] === "briefings" && s.length === 4)
    || (s[0] === "customers" && s[1] === session.customer.toLowerCase() && s[2] === "analysis" && s[3] === "briefings" && s.length === 5);
  const re = new RegExp(`^[scl]\\.[a-z0-9]{3,4}\\.${session.scope.toLowerCase()}\\.brf\\.\\d{4}(\\.v\\d+)?\\.(ya?ml|md)$`);
  return inBriefings && re.test(s[s.length - 1]);
}

export const decide = guarded(G, (ctx) => {
  const { tool, ti, session } = ctx;
  if (!FILE_TOOLS.has(tool) && !SEARCH_TOOLS.has(tool)) return null;
  const T = targetsOf(ctx);
  if (WRITE_TOOLS.has(tool)) {
    const content = writtenContent(tool, ti);
    for (const p of T.ws) {
      if (KB.some((a) => intersects(p, a))) { const v = firstViolation("kb", content); if (v) return denyAudited(ctx, G, `kb/ non referenzia mai il dominio analitico (§1.1): ${v}`); }
      if (AN.some((a) => intersects(p, a))) { const v = firstViolation("analysis", content); if (v) return denyAudited(ctx, G, `analysis/ non referenzia mai un test (§1.1): ${v}`); }
    }
    return null;
  }
  for (const p of T.ws) {
    if (!AN.some((a) => intersects(p, a))) continue;
    if (ANALYSTS.has(ctx.agentType)) continue;
    if (ctx.agentType === "scope-expert" && session?.mode === "diag" && tool === "Read" && isOwnBrf(p, session)) continue;
    return denyAudited(ctx, G, `analysis/ è riservato alla diagnosi (root-cause-analyst, failure-triage, defect-reporter; scope-expert solo il BRF del proprio scope in modalità diag): ${p}`);
  }
  return null;
});
