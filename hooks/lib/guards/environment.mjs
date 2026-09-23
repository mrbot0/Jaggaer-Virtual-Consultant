// guard-environment (PreToolUse sugli strumenti MCP del browser, FAIL-CLOSED) — §51.2, §44.4.
//  - nessun ambiente dichiarato ⇒ deny di ogni strumento del browser;
//  - environments.yaml cambiato o sparito dopo `use env` ⇒ deny;
//  - navigate: l'host deve essere in allowed_hosts dell'ambiente DICHIARATO
//    (userinfo, suffissi, prefissi, IP, schemi non http(s), porte non dichiarate,
//    redirect SSO verso host non in lista ⇒ deny "host non dichiarato");
//  - pagina corrente (session.browser.current_url) su un host non dichiarato ⇒
//    deny di ogni azione che non sia navigate;
//  - dichiarato ma non verificato (env-check) ⇒ solo navigate e letture;
//  - script: primitive di rete/navigazione solo verso host dichiarati; in prod nessuno;
//  - strumento da browser non classificato (`other`) ⇒ deny per default;
//  - browser_batch: ogni azione valutata, basta un deny.
// Consentito = nessun output (un allow esplicito scavalcherebbe i permessi).
import { browserGuarded, declaredEnv, urlRefusal, scriptRefusal } from "./browser.mjs";

const G = "guard-environment";

function currentHostRefusal(ctx, env) {
  const cur = ctx.session?.browser?.current_url;
  if (typeof cur !== "string" || !cur) return null;
  const r = urlRefusal(cur, env);
  return r ? `pagina corrente fuori dall'ambiente dichiarato (${r}): torna con navigate su un host dichiarato` : null;
}

function actionRefusal(ctx, env, a) {
  if (a.kind === "other") return `strumento del browser non classificato (${a.tool ?? ctx.tool}${a.action ? ` action=${a.action}` : ""}): negato per default`;
  if (a.kind === "navigate") {
    if (a.history) return null;   // storia della scheda: pagine già visitate (e già consentite)
    return urlRefusal(a.url, env);
  }
  const cur = currentHostRefusal(ctx, env);
  if (cur) return cur;
  if (!env.verified && a.kind !== "read") return `ambiente ${env.id} dichiarato ma non verificato: esegui env-check (impronta a ≥ 2 segnali) prima di azioni diverse da navigazione e lettura (§51.2)`;
  if (a.kind === "script") {
    if (env.type === "prod") return "in produzione non si eseguono script nella pagina (§52.1): solo navigazione e lettura";
    return scriptRefusal(a.text, env);
  }
  return null;
}

export const decide = browserGuarded(G, (ctx, no) => {
  const { env, reason } = declaredEnv(ctx);
  if (!env) return no(reason);
  for (const a of ctx.actions) {
    const r = actionRefusal(ctx, env, a);
    if (r) return no(r);
  }
  return null;
});
