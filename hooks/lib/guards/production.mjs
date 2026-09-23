// guard-production (PreToolUse sugli strumenti MCP del browser, FAIL-CLOSED) —
// §52.1 strato 3, §51.2 "verifica prima di ogni azione con effetti". Attivo
// quando session.env.type = prod. Il guard non legge il prompt: legge l'ambiente,
// il passo attivo del piano, l'Atlas (SEL) e la classe dell'azione.
//   - navigate (host dichiarati) e letture ⇒ consentiti;
//   - upload, dialog accettato, invio (Enter / submit), script, strumenti non
//     classificati ⇒ deny sempre;
//   - input ⇒ solo se il passo attivo (classe di lettura) punta a un SEL con
//     role search_box; click ⇒ solo se il SEL del passo ha effect: read
//     (write o ignoto ⇒ deny); nessun piano attivo ⇒ deny di ogni input/click;
//   - classe di scrittura dati ⇒ deny; ACT-CFG-CHANGE ⇒ solo con finestra 3A
//     valida e token del passo (threeAState di approvals.mjs), frasi confermate
//     nel transcript (il consumo monouso lo fa guard-config-scope).
import { browserGuarded, declaredEnv, urlRefusal } from "./browser.mjs";
import { activeStep, readSel } from "./plan-step.mjs";
import { ACT } from "../act-classes.mjs";
import { approvalsFile, readApprovals, threeAState, confirmInTranscript } from "../../../scripts/admin/approvals.mjs";

const G = "guard-production";
export const PROD_NO_WRITE = "In produzione non si scrivono dati; posso farlo in sandbox o pre-produzione (§52.1)";
const READ_CLASSES = new Set(Object.entries(ACT).filter(([, a]) => a.prod === "allowed").map(([c]) => c));
const INPUT_VERBS = new Set(["FILL", "CHOOSE", "SELECT"]);
const CLICK_VERBS = new Set(["CLICK", "NAVIGATE", "READ", "SELECT", "CHOOSE", "VERIFY", "CAPTURE", "WAIT"]);

function alwaysDenied(a, env) {
  if (a.kind === "other") return `strumento del browser non classificato (${a.tool}${a.action ? ` action=${a.action}` : ""}): in produzione negato. ${PROD_NO_WRITE}`;
  if (a.kind === "script") return `in produzione non si eseguono script nella pagina. ${PROD_NO_WRITE}`;
  if (a.kind === "upload") return `caricamento di file in produzione. ${PROD_NO_WRITE}`;
  if (a.kind === "dialog" && a.submits) return `conferma di una finestra di dialogo in produzione. ${PROD_NO_WRITE}`;
  if (a.submits) return `invio (Enter/submit) in produzione. ${PROD_NO_WRITE}`;
  if (a.kind === "navigate") return a.history ? null : urlRefusal(a.url, env);
  return null;
}

async function prodConfig(ctx, st, env) {
  const file = approvalsFile(ctx.ws, ctx.customer, ctx.sid);
  const reg = readApprovals(file);
  if (!reg.ok) return `registro delle approvazioni corrotto (${reg.reason})`;
  const policy = { ...env.policy, second_approver_required: env.policy?.second_approver_required ?? true };
  const s = threeAState(reg.records, st.ap.plan_id, st.step.n, policy, Date.now());
  if (!s.ok) return `configurazione in produzione solo con tripla approvazione (§52.2): ${s.reason}`;
  if (s.used[0].plan_sha256 && s.used[0].plan_sha256 !== st.sha256) return `il piano è cambiato dopo A1: serve una nuova \`APPROVO PIANO ${st.ap.plan_id}\``;
  const c = confirmInTranscript(ctx.input.transcript_path, s.used);
  if (!c.ok) return `3A non confermata dal transcript dell'utente (${c.reason})`;
  return null;
}

export const decide = browserGuarded(G, async (ctx, no) => {
  const s = ctx.session;
  if (s?.env?.type !== "prod") return null;
  const { env, reason } = declaredEnv(ctx);
  if (!env) return no(reason);
  if (env.type !== "prod") return no("ambiente di sessione incoerente con environments.yaml: riesegui /use env");
  for (const a of ctx.actions) { const r = alwaysDenied(a, env); if (r) return no(r); }
  const writes = ctx.actions.filter((a) => a.kind === "input" || a.kind === "click");
  if (!writes.length) return null;
  if (!s.active_plan) return no(`nessun piano attivo: in produzione input e click solo dentro un passo di piano (search_box o SEL di sola lettura). ${PROD_NO_WRITE}`);
  const st = await activeStep(ctx);
  if (st.reason) return no(st.reason);
  const { step } = st;
  const cls = step.action_class;
  const at = `passo ${step.n} (${step.verb}, ${cls ?? "senza classe"})`;
  if (cls === "ACT-CFG-CHANGE") {
    const r = await prodConfig(ctx, st, env);
    return r ? no(`${at}: ${r}`) : null;
  }
  if (!READ_CLASSES.has(cls)) return no(`${at}: ${cls ?? "classe mancante"} non è ammessa in produzione. ${PROD_NO_WRITE}`);
  if (typeof step.target !== "string") return no(`${at}: il passo non punta a una voce dell'Atlas (SEL): in produzione input e click solo su selettori dichiarati`);
  const sel = await readSel(ctx, step.target);
  if (!sel) return no(`${at}: ${step.target} non è nell'Atlas del cliente o del prodotto: negato`);
  for (const a of writes) {
    if (a.kind === "input") {
      if (!INPUT_VERBS.has(step.verb) || sel.role !== "search_box") return no(`${at}: in produzione si scrive solo in un campo di ricerca dichiarato nell'Atlas come search_box (${sel.code}: role ${sel.role ?? "ignoto"}). ${PROD_NO_WRITE}`);
    } else if (!CLICK_VERBS.has(step.verb) || sel.effect !== "read") {
      return no(`${at}: click su ${sel.code} con effect ${sel.effect ?? "ignoto"}: in produzione solo su target di sola lettura. ${PROD_NO_WRITE}`);
    }
  }
  return null;
});
