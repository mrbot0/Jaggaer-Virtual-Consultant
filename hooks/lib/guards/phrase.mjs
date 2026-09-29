// guard-phrase (PreToolUse su ogni strumento, FAIL-CLOSED) — K5 giro 2 (N5).
// Le frasi di approvazione (APPROVO PIANO/PROVA/PASSO) e di esplorazione
// (ESPLORA SANDBOX) le scrive solo l'utente, nel prompt: un input di strumento che
// le contiene (mcp__* come send_message o show_widget/sendPrompt, SendMessage,
// Agent, WebFetch, …) potrebbe farle arrivare come "prompt dell'utente". Negato
// in ogni workspace JVC, con o senza ambiente dichiarato.
// Percorso veloce: si cercano le frasi negli input PRIMA di leggere lo stato;
// solo se ce n'è una si carica il contesto (workspace, audit).
// WP09d: anche le frasi amministrative (APPROVO PURGE <ID> DA <Nome>, APPROVO PROMOZIONE <codice>, APPROVO RETENTION <ID>).
export const PHRASES = /APPROVO\s+(PIANO|PROVA|PASSO|PURGE|PROMOZIONE|RETENTION)|ESPLORA\s+SANDBOX/i;
const MAX_NODES = 20000;

export function strings(v) {
  const out = [];
  const stack = [v];
  let n = 0;
  while (stack.length) {
    const x = stack.pop();
    if (++n > MAX_NODES) throw new Error("input dello strumento troppo grande per l'analisi del guard");
    if (typeof x === "string") out.push(x);
    else if (Array.isArray(x)) stack.push(...x);
    else if (x && typeof x === "object") { for (const [k, val] of Object.entries(x)) { out.push(k); stack.push(val); } }
  }
  return out;
}

export async function decide(input, env = process.env) {
  if (!strings(input.tool_input).some((t) => PHRASES.test(t))) return null;
  const { guardContext, denyAudited } = await import("./common.mjs");
  const ctx = guardContext(input, env);
  if (!ctx.jvc) return null;
  return denyAudited(ctx, "guard-phrase", "l'input dello strumento contiene una frase di approvazione o di esplorazione (APPROVO PIANO/PROVA/PASSO/PURGE/PROMOZIONE/RETENTION, ESPLORA SANDBOX): la scrive solo l'utente, nel suo prompt, mai uno strumento");
}
