// observe-append, stadio "legame" (29/10/2026, punto 7: observe-append scomposto in stadi). Che lettura dell'albero è la
// chiamata (readMode), conteggio dei token dei ref (tokenCounts), etichette per la storia della scheda (labelKey) e il nuovo
// stato del legame ref ↔ SEL dopo la chiamata (nextBinding). Puro rispetto al file system: lo chiama record() sotto i lock.
import { createHash } from "node:crypto";
import { tabKey, settlePending, updateHistory, bindable, stillBound } from "../ref-history.mjs";
import { normLabel } from "../../../scripts/chrome/snapshot-parse.mjs";

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");

// WP07 giro 4 (I-A): che lettura dell'albero è la chiamata, per il legame ref ↔ SEL.
//  "complete" — lettura intera della pagina: read_page di Claude senza ref_id, depth, filter diverso da "all" e senza
//               nota di troncamento; take_snapshot di DevTools con sole chiavi previste (con filePath: il file scritto dallo
//               strumento, snapshotFileResponse); browser_snapshot di Playwright senza target né depth;
//  "partial"  — find di Claude e di Playwright, letture ristrette o troncate, chiavi non previste, ogni browser_batch
//               che legge l'albero. Esplorazione libera (26/10/2026): i pezzi della STESSA pagina (URL, scheda,
//               famiglia) si sommano alla mappa con gli stessi controlli del legame; un pezzo di un'altra pagina apre una
//               mappa nuova; i pezzi legano al SEL solo in modalità esplorazione; un find non conferma la pagina: non
//               svuota la mappa e vi aggiunge solo i ref già legati nella storia della scheda con la stessa etichetta;
//  "nobind"   — altre chiamate di Claude (i ref di Claude si legano solo da un read_page completo);
//  null       — nessuna lettura dell'albero: comportamento invariato (DevTools e Playwright legano dalle risposte
//               delle azioni che riportano lo snapshot intero, come prima).
export const TRUNCATED = /\btruncated\b|\bmax_chars\b/i;
export function readMode(call, ti, text = "") {
  const x = ti && typeof ti === "object" && !Array.isArray(ti) ? ti : {};
  const op = String(call.op ?? "");
  const unknown = call.kind === "other" || (Array.isArray(call.unknownKeys) && call.unknownKeys.length > 0);
  if (op === "browser_batch") return (call.actions ?? []).some((a) => ["read_page", "find"].includes(String(a.op ?? ""))) ? "partial" : "nobind";
  if (call.family === "claude-browser") {
    if (op === "find") return "partial";
    if (op !== "read_page") return "nobind";
    if (unknown || x.ref_id !== undefined || x.depth !== undefined || (x.filter !== undefined && x.filter !== "all") || TRUNCATED.test(String(text))) return "partial";
    return "complete";
  }
  if (call.family === "chrome-devtools") return op === "take_snapshot" ? (unknown ? "partial" : "complete") : null;
  if (call.family === "playwright") {
    if (op === "browser_find") return "partial";
    if (op === "browser_snapshot") return unknown || x.target !== undefined || x.depth !== undefined ? "partial" : "complete";
  }
  return null;
}
// Lettura "find" (Claude, Playwright, o un browser_batch che ne contiene uno): risultati di una ricerca, non la pagina.
const FIND_OPS = new Set(["find", "browser_find"]);
export const isFindRead = (call) => (call.actions ?? [call]).some((a) => FIND_OPS.has(String(a.op ?? ""))) || FIND_OPS.has(String(call.op ?? ""));
// Etichetta di un ref per la storia della pagina (ruolo + nome normalizzato), compatta.
export const labelKey = (e) => sha(`${e.role ?? ""}\u0001${normLabel(e.name ?? "")}`).slice(0, 16);
// Correzioni dopo la revisione (27/10/2026, decisione dell'utente): nessun tetto sul numero di elementi, ref, nomi o
// etichette di una lettura o di una mappa; tolti anche i limiti in byte (guard sulla grandezza, 27/10/2026).
// Ambienti in cui un pezzo lega al SEL, e solo in modalità esplorazione (in un piano legano solo le letture complete):
// produzione e ambiente ignoto mai (i pezzi vi aggiungono solo i nomi).
export const PARTIAL_BIND_ENVS = new Set(["sandbox", "dev", "preprod"]);

// Conteggio esatto, in un solo passaggio, dei token di ref nei formati delle tre famiglie (uid=X preceduto da inizio o
// da un carattere non di parola e seguito da uno che non lo è · [ref=X] · [X]): stesso risultato di tokenRe di WP07 giro 3
// per i ref fatti di caratteri di parola (tutti quelli delle tre famiglie); gli altri usano la regex del singolo ref.
const W = /\w/;
export function tokenCounts(str) {
  const m = new Map();
  const add = (k) => m.set(k, (m.get(k) ?? 0) + 1);
  for (const x of str.matchAll(/\[([^[\]]*)\]/g)) { add(x[1]); if (x[1].startsWith("ref=")) add(x[1].slice(4)); }
  let i = str.indexOf("uid=");
  while (i >= 0) {
    if (i === 0 || !W.test(str[i - 1])) {
      let j = i + 4;
      while (j < str.length && W.test(str[j])) j++;
      if (j > i + 4) add(str.slice(i + 4, j));
    }
    i = str.indexOf("uid=", i + 1);
  }
  return m;
}


// Nuovo stato del legame ref ↔ SEL in session.browser e della storia dei ref dopo la chiamata (puro: copie).
// WP07 giro 4 (I-A): navigazione o cambio di scheda di Claude ⇒ mappa della pagina azzerata ({}).
// WP07 giro 5 (I-A'): la storia delle etichette è PER SCHEDA e persistente (hooks/lib/ref-history.mjs), in tutte e tre
// le famiglie: si azzera solo con un navigate a un nuovo documento o la chiusura di quella scheda; un ref visto con
// un'altra etichetta, o la prima volta in un find, non si lega più; la voce obs_pending della chiamata (scritta da
// browser-origin) si chiude qui, nella stessa scrittura.
// Esplorazione libera (brief del 26/10/2026, approvato dall'utente):
//  - una lettura completa basta in ogni ambiente (tolta la catena delle due letture identiche di Claude fuori dalla
//    sandbox: le sue azioni con effetto fuori dalla sandbox restano negate da claudeEffectRefusal, decisione WP08);
//  - una lettura parziale (ristretta, troncata, find) della STESSA pagina (URL, scheda, famiglia della mappa) si SOMMA alla
//    mappa; un pezzo di un'altra pagina apre una mappa nuova con i soli suoi ref; la mappa è marcata partial (un passo
//    DELETE vuole una lettura completa); in produzione (e ambiente ignoto) un pezzo non crea legami al SEL.
// Revisione di sicurezza dei commit (quattro rilievi):
//  1. un pezzo aggiunge un ref E il suo nome solo se il ref è verificato (una occorrenza, fuori dai valori fra virgolette)
//     e coerente con la storia della scheda (stillBound); di una lettura completa i ref non verificati sono elencati in
//     `unverified` e il guard dell'esplorazione nega click e input su di loro;
//  2. un pezzo con nota di troncamento o con un numero dispari di virgolette non ha ref verificati (buildObservation):
//     non aggiunge nulla, la mappa resta;
//  3. mai nomi uniti né tagliati: un ref della mappa che la storia non conferma più (mostrato con un'altra etichetta) esce
//     dalla mappa con il suo nome; un ref confermato prende il nome dell'ultimo pezzo (stessa etichetta normalizzata);
//  4. pezzo di pagina non confermata (o di un'altra pagina, senza ref) ⇒ mappa svuotata; un'azione nella stessa chiamata
//     (click, testo, upload, dialog, script, batch con effetto) ⇒ niente legami portati dalla mappa precedente.
// Correzioni dopo la revisione indipendente (27/10/2026):
//  - un'azione che non rilegge la pagina (nessuno snapshot nella risposta) marca la mappa `after_action`: il pezzo
//    successivo, anche sullo stesso URL, apre una mappa nuova (dopo un salvataggio o un reload i ref cambiano);
//  - un pezzo lega al SEL solo in modalità esplorazione (sandbox, dev, preprod); in un piano legano solo le letture complete;
//  - firma di una mappa di pezzi: quella della mappa a cui si somma; una mappa nuova prende percorso + h1 se il pezzo lo
//    mostra, altrimenti la firma dell'ultima mappa dello stesso URL (lettura completa), altrimenti il solo percorso;
//  - un find (pagina mai confermata) non svuota la mappa e non vi aggiunge nulla: la tiene, ricontrollata sulla storia
//    (un ref che il find mostra con un'altra etichetta esce); non crea legami e non riscrive i nomi (sicurezza 3);
//  - mappa e storia mai troncate; guard sulla grandezza tolto (27/10/2026, decisione dell'utente: «rimuoviamo il Guard
//    sulla grandezza, risulta bloccante e inutile»): nessun limite in byte, nessuna mappa "inutilizzabile".
// Marcatore che guarisce (27/10/2026): una lettura COMPLETA riuscita (pagina confermata dal marcatore del server) ricostruisce
// la mappa della scheda: chiude anche le voci obs_pending rimaste di chiamate precedenti della stessa famiglia e scheda
// (quella chiesta, quella del marcatore del server e, se la lettura non nomina la scheda, la scheda ignota). `settled`:
// schede le cui voci si chiudono (navigazioni, chiusure, letture complete), per il marcatore del cliente.
// Firma del giro 4 nextBinding(b, opts) → browser ancora accettata (storia vuota); altrimenti → { browser, hist }.
const ACT_KINDS = new Set(["click", "input", "upload", "dialog", "script", "other"]);
export function nextBinding(b, hist, opts) {
  if (opts === undefined && hist && typeof hist === "object" && "call" in hist) return nextBinding(b, null, hist).browser;
  const { call, obs, ts, envType, mode, refs, pageUrl, labels = [], labelLoc = null, asked = null, cleared = [], key = null, names = null, verified = null, find = false, sig = null,
    confirmedUrl = null, sessionMode = null, pieceSig = null, pieceH1 = false } = opts;
  const out = { ...b };
  // N5 (verifica del 27/10/2026): che cosa ha fatto un pezzo — merged: si è sommato alla mappa precedente; afterAction:
  // ha aperto una mappa nuova della stessa pagina perché in mezzo c'è stata un'azione (il registro lo marca)
  let piece = null;
  delete out.ref_labels;   // storia del giro 4 (un solo posto in session.json): sostituita dal file per scheda
  const tab = asked != null ? String(asked) : null;
  const fam = call.family ?? null;
  const claudeNav = call.family === "claude-browser" && (call.actions ?? [call]).some((a) => a.kind === "navigate" || a.switches);
  const acted = (call.actions ?? [call]).some((a) => ACT_KINDS.has(a.kind) || a.submits === true);
  const prev = out.snapshot && typeof out.snapshot === "object" && !Array.isArray(out.snapshot) ? out.snapshot : null;
  if (claudeNav && prev) out.snapshot = { obs: prev.obs, url: prev.url ?? null, tab: prev.tab ?? null, ts, refs: {}, cleared_by: String(call.op ?? call.tool ?? "") };
  // schede della storia: quella chiesta e quella del marcatore del server (se diverse, entrambe); nessuna ⇒ ignota
  const tabs = [...new Set([tab, labelLoc?.tab != null ? String(labelLoc.tab) : null].filter((t) => t != null))];
  const keys = tabs.length ? tabs.map((t) => tabKey(call.family, t)) : [tabKey(call.family, null)];
  const partial = mode === "partial";
  const complete = !partial && !!(refs && pageUrl);
  const okSet = new Set(Array.isArray(verified) ? verified : []);
  const firstOk = partial && !find && !claudeNav && refs && pageUrl ? okSet : null;
  const h = updateHistory(hist ?? { v: 1, tabs: {} }, { cleared: cleared.map((c) => c.key).filter((k) => k != null), keys, labels, complete, firstOk, url: labelLoc?.url ?? null });
  const mapOk = (m) => m && m.refs && typeof m.refs === "object" && !Array.isArray(m.refs);
  const pieceUrl = pageUrl ?? confirmedUrl;
  const sameMap = (m) => !claudeNav && !acted && mapOk(m) && m.after_action !== true && (m.tab ?? null) === tab && (m.family ?? null) === fam;
  const samePage = sameMap(prev) && pieceUrl != null && prev.url === pieceUrl;
  const bindPieces = sessionMode === "esplorazione" && PARTIAL_BIND_ENVS.has(envType);
  // la mappa precedente, ricontrollata sulla storia aggiornata (schede su cui era stata legata): un ref che la storia non
  // conferma più esce con il suo nome
  const kept = (m) => {
    const ks = Array.isArray(m.hist_keys) && m.hist_keys.length && m.hist_keys.every((k) => typeof k === "string") ? m.hist_keys : keys;
    const rs = Object.fromEntries(Object.entries(m.refs).filter(([r]) => ks.every((k) => stillBound(h, k, r))));
    const ns = m.names && typeof m.names === "object" ? Object.fromEntries(Object.entries(m.names).filter(([r]) => Object.hasOwn(rs, r))) : {};
    const unv = Array.isArray(m.unverified) ? m.unverified.filter((r) => Object.hasOwn(rs, r)) : [];
    return { rs, ns, unv };
  };
  const nm = names && typeof names === "object" ? names : {};
  const label = new Map();
  for (const [r, k] of labels) label.set(r, label.has(r) && label.get(r) !== k ? "!" : k);
  const good = (r) => okSet.has(r) && keys.every((k) => stillBound(h, k, r));
  // somma dei ref verificati e coerenti di un pezzo (o di un find) a una mappa; in un piano, in produzione o in ambiente
  // ignoto un pezzo non crea legami al SEL (un ref già legato da una lettura completa resta com'è)
  const addPiece = (merged, mergedNames, unv) => {
    for (const [r, v0] of Object.entries(refs ?? {})) {
      if (!good(r)) continue;
      const v = v0 != null && keys.every((k) => bindable(h, k, r, label.get(r))) ? v0 : null;
      merged[r] = bindPieces ? v : Object.hasOwn(merged, r) ? merged[r] : null;
      if (typeof nm[r] === "string") mergedNames[r] = nm[r]; else delete mergedNames[r];
      const i = unv.indexOf(r);
      if (i >= 0) unv.splice(i, 1);
    }
  };
  if (find && partial && !claudeNav) {
    // un find: la mappa resta, ricontrollata sulla storia; nessun ref, nome o legame aggiunto (sicurezza 3); N2 (verifica
    // del 27/10/2026): se la stessa chiamata ha agito (browser_batch [click, find]) la mappa è marcata after_action
    if (mapOk(prev)) {
      const { rs, ns, unv } = kept(prev);
      const { unverified: _u, ...rest } = prev;
      out.snapshot = { ...rest, refs: rs, names: ns, ...(unv.length ? { unverified: unv } : {}), ...(acted ? { after_action: true } : {}) };
    }
  } else if (refs && pageUrl && !(partial && claudeNav)) {
    const bound = { ...refs };
    for (const r of Object.keys(bound)) if (bound[r] != null && !keys.every((k) => bindable(h, k, r, label.get(r)))) bound[r] = null;
    if (partial) {
      const { rs: merged, ns: mergedNames, unv } = samePage ? kept(prev) : { rs: {}, ns: {}, unv: [] };
      addPiece(merged, mergedNames, unv);
      const sigOut = samePage ? prev.sig ?? pieceSig : pieceH1 ? pieceSig : (prev && prev.url === pageUrl && typeof prev.sig === "string" ? prev.sig : null) ?? pieceSig ?? sig;
      piece = { merged: samePage, afterAction: !samePage && mapOk(prev) && prev.url === pageUrl && (prev.tab ?? null) === tab && (prev.family ?? null) === fam && (acted || prev.after_action === true) };
      out.snapshot = { obs, url: pageUrl, tab, ts, refs: merged, family: fam, hist_keys: keys, partial: true, sig: sigOut, names: mergedNames, ...(unv.length ? { unverified: unv } : {}) };
    } else {
      out.snapshot = { obs, url: pageUrl, tab, ts, refs: bound, family: fam, hist_keys: keys, sig };
      if (names && typeof names === "object") out.snapshot.names = Object.fromEntries(Object.entries(names).filter(([r]) => Object.hasOwn(bound, r)));
      if (Array.isArray(verified)) {
        const unv = Object.keys(bound).filter((r) => !okSet.has(r));
        if (unv.length) out.snapshot.unverified = unv;
      }
    }
  } else if (partial && !claudeNav && mapOk(prev)) {
    // pezzo senza ref: sulla stessa pagina confermata, senza azioni, la mappa resta (ricontrollata); altrimenti si svuota
    if (samePage) {
      const { rs, ns, unv } = kept(prev);
      const { unverified: _u, ...rest } = prev;
      out.snapshot = { ...rest, refs: rs, names: ns, ...(unv.length ? { unverified: unv } : {}) };
    } else out.snapshot = { obs: prev.obs, url: prev.url ?? null, tab: prev.tab ?? null, ts, refs: {}, names: {}, cleared_by: String(call.op ?? call.tool ?? "") };
  } else if (acted && !claudeNav && mapOk(out.snapshot) && out.snapshot === prev) {
    // un'azione che non ha riletto la pagina: la mappa resta per i guard, ma un pezzo successivo non vi si somma
    out.snapshot = { ...prev, after_action: true };
  }
  // marcatore che guarisce: lettura completa riuscita della scheda ⇒ voci rimaste della stessa famiglia e scheda chiuse
  const healed = mode === "complete" && refs && pageUrl && !claudeNav ? [...keys, ...(tab == null ? [tabKey(call.family, null)] : [])] : [];
  const settled = [...new Set([...cleared.flatMap((c) => c.pend), ...healed])];
  const browser = key ? settlePending(out, key, settled) : out;
  return { browser, hist: h, piece, settled };
}

