// Budget rigidi (K6.7, §29.10): i budget non sono stime, sono limiti — per classe di azione, per compito,
// per sessione, per documento — e nessuno li alza da un agente (solo `session.mjs use budget`, in audit).
// Solo moduli built-in: lo importa guard-budget sul percorso caldo.
//
//   classBudget(cls, env, { level })   catalogo (§29.4, budget_tokens) × budget_multiplier dell'ambiente (§51.3)
//   estimateTask(plan, env)            somma delle azioni del piano (passi consecutivi della stessa classe = un'azione) + 20%
//   checkRemaining(session, estimate, { open })  residuo = tokens − used − budget PRENOTATO dalle invocazioni aperte
//   enforceClass(invocation, env)      il budget di un'invocazione non supera quello delle classi che dichiara
//   checkDocument({ used, unitTokens }) 80k per documento, 3k per unità (kb digest)
//   filesOpenedUnused(audit, report)   spreco a livello di report: file dell'Atlas aperti ma non citati
export const ACT_BUDGET = Object.freeze({
  "ACT-OBS": { tokens: 5000 }, "ACT-READ": { tokens: 8000 }, "ACT-QRY": { tokens: 15000 }, "ACT-CREATE": { tokens: 15000 },
  "ACT-UPDATE": { tokens: 10000 }, "ACT-UPLOAD": { tokens: 10000 }, "ACT-SUBMIT": { tokens: 20000 }, "ACT-APPROVE": { tokens: 15000 },
  "ACT-TRANSMIT": { tokens: 25000 }, "ACT-CLOSE": { tokens: 10000 }, "ACT-PUBLISH": { tokens: 20000 }, "ACT-CFG-READ": { tokens: 8000 },
  "ACT-CFG-CHANGE": { tokens: 40000, rosso: 60000 }, "ACT-BULK": { tokens: 60000 }, "ACT-DELETE": { tokens: 15000 },
});
export const TASK_MARGIN = 0.2;
export const HAIKU_THRESHOLD = 0.8;
export const DOC_BUDGET = 80000;
export const UNIT_BUDGET = 3000;
const DEFAULT_MULT = { dev: 1.0, sandbox: 1.0, preprod: 0.8, prod: 0.5 };

export function multiplier(env) {
  const m = env?.policy?.budget_multiplier;
  if (Number.isFinite(m) && m > 0) return m;
  return DEFAULT_MULT[env?.type] ?? 0.5;   // ambiente ignoto: il più restrittivo
}

export function classBudget(cls, env, { level = null } = {}) {
  const b = ACT_BUDGET[cls];
  if (!b || b.tokens == null) return 0;
  const base = level === "rosso" && b.rosso ? b.rosso : b.tokens;
  return Math.round(base * multiplier(env));
}

export function estimateTask(plan, env) {
  const steps = Array.isArray(plan?.steps) ? [...plan.steps].sort((a, b) => a.n - b.n) : [];
  const actions = [];
  for (const s of steps) {
    const cls = s?.action_class;
    if (!cls) continue;
    const level = s.config?.level ?? null;
    if (actions.length && actions.at(-1).class === cls) continue;
    actions.push({ class: cls, from_step: s.n, tokens: classBudget(cls, env, { level }) });
  }
  const sum = actions.reduce((a, x) => a + x.tokens, 0);
  return { actions, sum, margin: TASK_MARGIN, tokens: Math.round(sum * (1 + TASK_MARGIN)) };
}

// open: invocazioni aperte (hooks/lib/invocations.mjs openFrom) con budget_tokens; null = nessuna prenotazione dichiarata.
export function checkRemaining(session, estimate, { open = [] } = {}) {
  const tokens = session?.budget?.tokens ?? 0;
  const used = session?.budget?.used ?? 0;
  const reserved = (open ?? []).reduce((a, i) => a + (Number.isInteger(i?.budget_tokens) && i.budget_tokens > 0 ? i.budget_tokens : 0), 0);
  const remaining = Math.max(0, tokens - used - reserved);
  const downgrade = tokens > 0 && used >= HAIKU_THRESHOLD * tokens;
  if (used >= tokens) return { ok: false, remaining: 0, reserved, downgrade, reason: `budget di sessione esaurito (${used}/${tokens})` };
  if (Number.isFinite(estimate) && estimate > remaining) {
    return { ok: false, remaining, reserved, downgrade, reason: `budget del compito ${estimate} supera il residuo di sessione ${remaining}${reserved ? ` (${tokens} − usati ${used} − ${reserved} prenotati dalle invocazioni aperte)` : ""}` };
  }
  return { ok: true, remaining, reserved, downgrade, reason: null };
}

export function enforceClass(inv, env) {
  const classes = [...new Set([...(inv?.action_class ? [inv.action_class] : []), ...(Array.isArray(inv?.actions) ? inv.actions : [])])].filter(Boolean);
  if (!classes.length) return { ok: true, limit: null, reason: null };
  const unknown = classes.filter((c) => !ACT_BUDGET[c] || ACT_BUDGET[c].tokens == null);
  if (unknown.length) return { ok: false, limit: 0, reason: `classe senza budget o fuori catalogo: ${unknown.join(", ")}` };
  const level = inv?.level ?? null;
  const parts = classes.map((c) => classBudget(c, env, { level }));
  const limit = classes.length === 1 ? parts[0] : Math.round(parts.reduce((a, b) => a + b, 0) * (1 + TASK_MARGIN));
  const t = inv?.budget_tokens;
  if (Number.isFinite(t) && t > limit) return { ok: false, limit, reason: `budget ${t} oltre il limite di ${classes.join(" + ")}: ${limit}${classes.length > 1 ? " (somma + 20%)" : ""} (§29.10: si ridisegna il compito, non si finanzia)` };
  return { ok: true, limit, reason: null };
}

export function checkDocument({ used = 0, unitTokens = [] } = {}) {
  if (used > DOC_BUDGET) return { ok: false, reason: `digestione del documento oltre ${DOC_BUDGET} token: ci si ferma al lotto corrente` };
  const over = unitTokens.findIndex((u) => u > UNIT_BUDGET);
  if (over >= 0) return { ok: false, reason: `unità ${over + 1} oltre ${UNIT_BUDGET} token` };
  return { ok: true, reason: null };
}

// Spreco a livello di report (§29.10): file dell'Atlas letti (Read nell'audit) il cui codice non compare nel
// risultato: bastava il summary. → [codici]
const CODE = /\b[SCL]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.[A-Z]{3}\.\d{4}(?:\.v\d+)?\b/;
export function filesOpenedUnused(audit = [], report = {}) {
  const cited = new Set(JSON.stringify(report ?? null).match(new RegExp(CODE.source, "g")) ?? []);
  const opened = [];
  for (const e of audit ?? []) {
    const p = e?.payload ?? {};
    if (e?.kind !== "tool" || p.tool !== "Read") continue;
    let s = {};
    try { s = typeof p.input_summary === "string" ? JSON.parse(p.input_summary) : p.input_summary ?? {}; } catch { s = {}; }
    const m = CODE.exec(String(s.file_path ?? ""));
    if (m && !opened.includes(m[0])) opened.push(m[0]);
  }
  return opened.filter((c) => !cited.has(c));
}
