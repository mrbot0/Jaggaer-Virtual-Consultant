// guard-production (PreToolUse sugli strumenti MCP del browser, FAIL-CLOSED) —
// §52.1 strato 3, §51.2 "verifica prima di ogni azione con effetti". Attivo
// quando session.env.type = prod. Il guard non legge il prompt: legge l'ambiente,
// il passo attivo del piano, l'Atlas (SEL) e la classe dell'azione.
// Ops veloce (spec 2026-10-06 §3.6): scritture solo dentro un passo di piano approvato, con write_data: true; DELETE mai.
//   - navigate (host dichiarati) e letture ⇒ consentiti;
//   - script, strumenti non classificati, emulazione di rete/intestazioni, reload ⇒ deny sempre;
//     upload, invio (Enter / submit) e dialog accettato ⇒ solo dentro un passo di scrittura approvato, altrimenti deny;
//   - fuori dai passi di scrittura: input solo se il passo attivo (classe di lettura) punta a un SEL con
//     role search_box; click solo se il SEL del passo ha effect: read (write o ignoto ⇒ deny);
//     nessun piano attivo ⇒ deny di ogni input/click/caricamento;
//   - passo di scrittura (classe con prod "approval"): dati (effect write) solo con policy.write_data: true; la
//     configurazione (ACT-CFG-CHANGE) è governata dalle sole approvazioni; in entrambi i casi servono A1 + token
//     del passo (+ A2 da persona diversa col secondo approvatore), frasi confermate nel transcript (prodStepApproval
//     di approvals.mjs; il consumo monouso lo fa guard-config-scope);
//   - ACT-DELETE ⇒ deny sempre: in produzione non si cancella.
import { browserGuarded, declaredEnv, urlRefusal } from "./browser.mjs";
import { activeStep, readSel } from "./plan-step.mjs";
import { ACT } from "../act-classes.mjs";
import { approvalsFile, readApprovals, prodStepApproval, confirmInTranscript } from "../../../scripts/admin/approvals.mjs";

const G = "guard-production";
export const PROD_NO_WRITE = "In produzione si scrive solo dentro un passo di piano approvato (APPROVO PIANO + APPROVO PASSO n) e con policy.write_data: true";
const READ_CLASSES = new Set(Object.entries(ACT).filter(([, a]) => a.prod === "allowed").map(([c]) => c));
const INPUT_VERBS = new Set(["FILL", "CHOOSE", "SELECT"]);
const CLICK_VERBS = new Set(["CLICK", "NAVIGATE", "READ", "SELECT", "CHOOSE", "VERIFY", "CAPTURE", "WAIT"]);

// Sempre negato, in ogni passo. Upload, invio (Enter/submit) e dialog accettato sono ammessi solo dentro un passo di
// scrittura (vedi decide): lì li autorizza prodWrite.
function alwaysDenied(a, env) {
  if (a.kind === "other") return `strumento del browser non classificato (${a.tool}${a.action ? ` action=${a.action}` : ""}): in produzione negato. ${PROD_NO_WRITE}`;
  if (a.kind === "script") return `in produzione non si eseguono script nella pagina. ${PROD_NO_WRITE}`;
  if (a.kind === "upload") return `caricamento di file in produzione fuori da un passo di scrittura approvato. ${PROD_NO_WRITE}`;
  if (a.kind === "dialog" && a.submits) return `conferma di una finestra di dialogo in produzione fuori da un passo di scrittura approvato. ${PROD_NO_WRITE}`;
  if (a.submits) return `invio (Enter/submit) in produzione fuori da un passo di scrittura approvato. ${PROD_NO_WRITE}`;
  if (a.emulation) return `emulazione di rete o intestazioni (userAgent, extraHttpHeaders, networkConditions) in produzione. ${PROD_NO_WRITE}`;
  if (a.kind === "navigate" && a.history) return a.historyKind === "reload" ? `ricaricare la pagina in produzione può ripetere un invio (POST). ${PROD_NO_WRITE}` : null;
  if (a.kind === "navigate") return urlRefusal(a.url, env);
  return null;
}

// Passo di scrittura in produzione (classe con prod "approval"): interruttore dei dati + approvazione del passo.
async function prodWrite(ctx, st, env) {
  // write_data governa i dati (effect write); ACT-CFG-CHANGE (effect config) resta alle approvazioni (come guard-config-scope)
  if (ACT[st.step.action_class]?.effect !== "config" && env.policy?.write_data !== true) return `scritture spente in produzione per l'ambiente ${env.id} (policy.write_data: false in environments.yaml)`;
  const reg = readApprovals(approvalsFile(ctx.ws, ctx.customer, ctx.sid));
  if (!reg.ok) return `registro delle approvazioni corrotto (${reg.reason})`;
  const policy = { ...env.policy, second_approver_required: env.policy?.second_approver_required ?? true };
  const s = prodStepApproval(reg.records, st.ap.plan_id, st.step.n, policy, Date.now());
  if (!s.ok) return `in produzione ogni passo che modifica o carica si approva prima: ${s.reason}`;
  if (s.used[0].plan_sha256 && s.used[0].plan_sha256 !== st.sha256) return `il piano è cambiato dopo A1: serve una nuova \`APPROVO PIANO ${st.ap.plan_id}\``;
  const c = confirmInTranscript(ctx.input.transcript_path, s.used);
  if (!c.ok) return `approvazione non confermata dal transcript dell'utente (${c.reason})`;
  return null;
}

export const decide = browserGuarded(G, async (ctx, no) => {
  const s = ctx.session;
  if (s?.env?.type !== "prod") return null;
  const { env, reason } = declaredEnv(ctx);
  if (!env) return no(reason);
  if (env.type !== "prod") return no("ambiente di sessione incoerente con environments.yaml: riesegui /use env");
  let st = null;
  if (s.active_plan) { st = await activeStep(ctx); if (st.reason) return no(st.reason); }
  const cls = st?.step?.action_class;
  const writeStep = !!cls && ACT[cls]?.prod === "approval";
  // upload, invio e conferma del dialogo valgono solo dentro un passo di scrittura (approvato sotto)
  for (const a of ctx.actions) {
    if (writeStep && (a.kind === "upload" || a.submits)) continue;
    const r = alwaysDenied(a, env); if (r) return no(r);
  }
  const touches = ctx.actions.filter((a) => a.kind === "input" || a.kind === "click" || a.kind === "upload" || a.submits);
  if (!touches.length) return null;
  if (!st) return no(`nessun piano attivo: in produzione input, click e caricamenti solo dentro un passo di piano. ${PROD_NO_WRITE}`);
  const { step } = st;
  const at = `passo ${step.n} (${step.verb}, ${cls ?? "senza classe"})`;
  if (cls === "ACT-DELETE") return no(`${at}: in produzione non si cancella mai`);
  if (writeStep) { const r = await prodWrite(ctx, st, env); return r ? no(`${at}: ${r}`) : null; }
  if (!READ_CLASSES.has(cls)) return no(`${at}: ${cls ?? "classe mancante"} non è ammessa in produzione. ${PROD_NO_WRITE}`);
  if (typeof step.target !== "string") return no(`${at}: il passo non punta a una voce dell'Atlas (SEL): in produzione input e click solo su selettori dichiarati`);
  const sel = await readSel(ctx, step.target);
  if (!sel) return no(`${at}: ${step.target} non è nell'Atlas del cliente o del prodotto: negato`);
  for (const a of touches) {
    if (a.kind === "input") {
      if (!INPUT_VERBS.has(step.verb) || sel.role !== "search_box") return no(`${at}: in produzione, fuori dai passi di scrittura, si scrive solo in un campo di ricerca dichiarato (search_box). ${PROD_NO_WRITE}`);
    } else if (!CLICK_VERBS.has(step.verb) || sel.effect !== "read") {
      return no(`${at}: click su ${sel.code} con effect ${sel.effect ?? "ignoto"}: fuori dai passi di scrittura solo target di sola lettura. ${PROD_NO_WRITE}`);
    }
  }
  return null;
});
