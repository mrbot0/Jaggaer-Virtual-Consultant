// Controllo dell'utente sugli agenti (WP10d D8, D2): cattura delle frasi dal prompt dell'utente (la chiama SOLO
// approval-capture, UserPromptSubmit) e registrazione in control.jsonl (hooks/lib/control.mjs). Ogni atto di
// controllo va in audit con actor: user. Le frasi che AUMENTANO la protezione (PAUSA, FERMA, PASSO PASSO) valgono dal
// record; quelle che la RIDUCONO (RIPRENDI, SBLOCCA SCOPE, PASSO PASSO OFF, LIMITI DISPATCH) valgono solo dopo la
// conferma nel transcript dell'utente (record `confirm`, scritto da un hook alla prima occasione).
// FERMA AGENTE chiude subito l'invocazione del compito nel ledger (closed_by: user-stop, status_effective:
// aborted-by-user): subagent-trace adotta quella voce quando l'agente si ferma (ABORTED-BY-USER di K6.6).
import { appendAudit } from "../../hooks/lib/audit.mjs";
import { invocationsFile } from "../../hooks/lib/workspace.mjs";
import { readJsonl } from "../../hooks/lib/state-summary.mjs";
import { openFrom } from "../../hooks/lib/invocations.mjs";
import { controlFile, readControl, appendControl, controlPhraseOf, confirmPending, transcriptCandidates, REDUCING, ALL, CONTROL_SYNTAX, TX_MARGIN } from "../../hooks/lib/control.mjs";
import { statSync } from "node:fs";
import { sha256 } from "./approvals.mjs";

export const MAX_LIMIT_CALLS = 5000;
export const MAX_LIMIT_MINUTES = 480;
const ctxOut = (text, user) => ({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: text }, ...(user ? { systemMessage: user } : {}) });

const EFFECT = {
  pause: (r) => `${r.target === ALL ? "tutti i sub-agenti" : `il sub-agente del compito ${r.target}`} in pausa: ogni sua chiamata di strumento è negata dai guard e nessun nuovo dispatch${r.target === ALL ? "" : " del compito"} finché non scrivi ${r.target === ALL ? "RIPRENDI TUTTI" : `RIPRENDI AGENTE ${r.target}`}`,
  resume: (r) => `ripresa di ${r.target === ALL ? "tutti i sub-agenti in pausa" : `${r.target}`}: vale appena confermata nel transcript (automatico)`,
  stop: (r) => (r.target === ALL
    ? `${r.tasks?.length ? `sub-agenti in corso fermati (${r.tasks.join(", ")})` : "nessun sub-agente in corso: nulla da fermare"}: ogni loro chiamata negata, invocazioni chiuse, rapporto aborted-by-user, quei compiti non si ridispacciano; i dispatch successivi non sono toccati`
    : `sub-agente ${r.target} fermato: ogni chiamata negata, invocazione chiusa, rapporto aborted-by-user; il compito non si ridispaccia`),
  step: (r) => `passo-passo per ${r.target === ALL ? "tutti i sub-agenti" : r.target}: ogni azione con effetto (browser input/click/invio, scritture fuori dalle cartelle di lavoro, scritture sull'ALM) attende il tuo \`sì\``,
  "step-off": () => "passo-passo disattivato: vale appena confermato nel transcript (automatico)",
  unlock: (r) => `vigilanza dello scope ${r.scope} azzerata: nuovi dispatch consentiti appena confermata nel transcript (automatico)`,
  limits: (r) => `limiti per dispatch ${r.calls} chiamate di strumento e ${r.minutes} minuti: valgono appena confermati nel transcript (automatico)`,
};

// → output di UserPromptSubmit
export async function captureControl(st, input, p) {
  const s = st.session;
  if (p.kind === "attempt") {
    return ctxOut(`Frase di controllo non valida: scrivi esattamente una di ${CONTROL_SYNTAX.map((x) => `\`${x}\``).join(", ")}. Nessun controllo registrato; il manager lo dice all'utente e attende.`, "⚠ Frase di controllo non valida");
  }
  if (p.kind === "limits" && (p.calls > MAX_LIMIT_CALLS || p.minutes > MAX_LIMIT_MINUTES)) {
    return ctxOut(`Limiti non registrati: al più ${MAX_LIMIT_CALLS} chiamate e ${MAX_LIMIT_MINUTES} minuti per dispatch.`, "⚠ Limiti fuori scala");
  }
  const file = controlFile(st.ws, st.customer, st.sid);
  const reg = readControl(file);
  if (!reg.ok) return ctxOut(`Controllo NON registrato: il registro di controllo è manomesso (${reg.reason}); i guard negano ogni chiamata dei sub-agenti.`, "⚠ Registro di controllo manomesso");
  // WP10d giro 1 (I1): FERMA TUTTI registra i compiti dei dispatch esistenti (aperti) alla cattura: vale solo per loro
  const invs = readJsonl(invocationsFile(st.ws, st.customer, st.sid));
  const openNow = p.kind === "stop" ? openFrom(invs, s?.ledger?.invocations ?? [], { ttlMs: Infinity }).filter((i) => p.target === ALL || String(i.task_id) === p.target) : [];
  // minore 4: dove comincia, nel transcript, la ricerca del prompt di un record che riduce la protezione
  let txOffset;
  if (REDUCING.has(p.kind)) { try { txOffset = Math.max(0, statSync(String(input.transcript_path)).size - TX_MARGIN); } catch { txOffset = undefined; } }
  const rec = { kind: p.kind, ...(p.target ? { target: p.target } : {}), ...(p.scope ? { scope: p.scope } : {}), ...(p.kind === "limits" ? { calls: p.calls, minutes: p.minutes } : {}),
    ...(p.kind === "stop" && p.target === ALL ? { tasks: [...new Set(openNow.map((i) => String(i.task_id)))] } : {}), ...(txOffset != null ? { tx_offset: txOffset } : {}),
    prompt_sha256: sha256(input.prompt), session: st.sid };
  const ev = appendControl(file, rec);
  let closed = [];
  if (p.kind === "stop") {
    // l'invocazione (o le invocazioni) aperta del compito si chiude subito: stato fermato anche se l'agente non torna
    try {
      const { updateSession } = await import("./session.mjs");
      updateSession(st.sessionFile, (x) => {
        const open = openFrom(invs, x.ledger.invocations, { ttlMs: Infinity }).filter((i) => p.target === ALL || String(i.task_id) === p.target);
        const at = new Date().toISOString();
        for (const i of open) {
          const running = x.ledger.invocations.find((e) => e?.inv_seq === i.seq && !e.completed_at);
          if (running) Object.assign(running, { completed_at: at, closed_by: "user-stop", status_effective: "aborted-by-user", control: ev.hash });
          else x.ledger.invocations.push({ agent_id: null, agent_type: i.subagent_type ?? null, inv_seq: i.seq, task_id: i.task_id ?? null, enforced: false, closed_by: "user-stop", status_effective: "aborted-by-user", scope: i.scope ?? null, control: ev.hash, completed_at: at });
          closed.push(i.task_id ?? `#${i.seq}`);
        }
      });
    } catch { closed = null; }
  }
  try {
    appendAudit(st.ws, { session: st.sid, customer: st.customer, scope: s?.scope ?? null, kind: "decision", actor: "user", correlation: { task: p.target && p.target !== ALL ? p.target : null },
      payload: { control: p.kind, target: p.target ?? null, scope: p.scope ?? null, calls: p.calls ?? null, minutes: p.minutes ?? null, hash: ev.hash, prompt_sha256: ev.prompt_sha256, reduces_protection: REDUCING.has(p.kind), closed } });
  } catch { /* l'audit non annulla un controllo già registrato */ }
  // un controllo che riduce la protezione si prova a confermare subito (il prompt può essere già nel transcript)
  if (REDUCING.has(p.kind)) { try { confirmPending(file, readControl(file).records, transcriptCandidates(input)); } catch { /* si conferma alla prossima chiamata */ } }
  const phrase = controlPhraseOf(p);
  return ctxOut(`Controllo registrato: ${phrase} alle ${ev.ts} — ${EFFECT[p.kind](ev)}${closed?.length ? ` (invocazioni chiuse: ${closed.join(", ")})` : ""}. Applicato dai guard, non dal modello: il manager lo riferisce e non lo aggira.`, `✓ ${phrase}`);
}
