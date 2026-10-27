// observe-append (K6.2, §20.1, §20.6, §29.6, §44.4, §54.2): PostToolUse sugli strumenti MCP del browser.
// Ogni risultato del browser diventa un'OBS (una per chiamata, non omissibile): codice L.<C>.<S>.OBS.nnnn
// dal SEQ del DB, firma della pagina, elementi visti con atlas_match, messaggi, surprise/novelty rispetto
// all'expect del passo attivo (stesso confronto di step-check), errori della piattaforma ⇒ ERR grezzo in
// kb/scopes/<S>/errors/_raw/ + riga errors_raw (count a ogni ripetizione), redazione ALLA CATTURA.
// Mantiene session.browser.current_url dalla pagina OSSERVATA (hooks/lib/observed-origin.mjs, fail-closed).
// Spreco (§29.10): snapshot della stessa pagina senza azione in mezzo ⇒ voce in session.ledger.waste.
// Non è un guard: fail-OPEN con avviso, mai un blocco; ma un guasto azzera l'URL corrente (mai
// un'origine non confermata). additionalContext: `OBS <code> · surprise:<n> novelty:<n> · ERR:<code?>`.
import { mkdirSync, appendFileSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, dirname, resolve, sep, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { loadHookState, sessionDir } from "./workspace.mjs";
import { classify, isBrowserTool } from "./browser-tools.mjs";
import { responseState, landedUrl } from "./browser-origin.mjs";
import { tabKey, callKey, settlePending, historyFile, loadHistory, saveHistory, clearedBy, updateHistory, bindable, stillBound, pendingFile, loadPending, savePending } from "./ref-history.mjs";
import { nextObserved, observedLocation } from "./observed-origin.mjs";
import { isPageTextOp } from "./origin-markers.mjs";
import { updateSessionFile } from "./session-state.mjs";
import { writeFileAtomic, withFileLock } from "./fsx.mjs";
import { parseSnapshot, responseText, responseHasImage, normLabel } from "../../scripts/chrome/snapshot-parse.mjs";
import { compareExpect, elementNorms } from "../../scripts/chrome/expect-compare.mjs";
import { resolveSel, atlasIndex, atlasMatch, atlasByCode, fieldSensitivity } from "../../scripts/chrome/atlas.mjs";
import { detectErrors } from "../../scripts/chrome/errors.mjs";
import { profileFor, redactText, freeText, secretEnv } from "../../scripts/chrome/redact.mjs";
import { toYaml } from "../../scripts/lib/yaml-lite.mjs";
import { pageRecord, clickRecord, appendAtlasLog, atlasLogFile, recordRefs, fullWarningOnce } from "./atlas-log.mjs";
import { EFFECT_LABEL } from "./effect-labels.mjs";

const SNAPSHOT_OPS = new Set(["take_snapshot", "read_page", "get_page_text", "find", "browser_snapshot", "browser_find"]);
const SCREENSHOT_OPS = new Set(["take_screenshot", "browser_take_screenshot", "upload_image"]);
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
// WP09b giro 2: voci dell'anello delle OBS in session.json (kb snapshot accetta al più 900 s: 200 bastano)
export const OBS_RING_MAX = 200;
const stamp = (d) => d.toISOString().replace(/[-:]/g, "").replace(/\.(\d{3})Z$/, "$1Z");

// Tipo di osservazione: snapshot · screenshot · navigate · action · read · error.
export function obsKind(call, state, text) {
  if (state === "error") return "error";
  const acts = call.actions ?? [call];
  if (acts.some((a) => a.kind === "navigate")) return "navigate";
  if (acts.some((a) => ["click", "input", "upload", "dialog"].includes(a.kind))) return "action";
  const op = String(call.op ?? "");
  if (SCREENSHOT_OPS.has(op) || acts.some((a) => a.action === "screenshot" || a.action === "zoom")) return "screenshot";
  if (SNAPSHOT_OPS.has(op) || acts.some((a) => SNAPSHOT_OPS.has(String(a.op ?? "")))) return "snapshot";
  return "read";
}

function cleanUrl(url, profile) {
  if (!url) return null;
  try { const u = new URL(url); return redactText(`${u.origin}${u.pathname}`, { profile }).text; } catch { return null; }
}

async function activeStep(ws, customer, ap) {
  if (!ap) return null;
  try {
    const { loadPlanFile } = await import("../../scripts/admin/approvals.mjs");
    const info = await loadPlanFile(ws, customer, ap.file);
    if (!info || info.plan?.plan_id !== ap.plan_id) return null;
    const step = (info.plan.steps ?? []).find((s) => s && s.n === ap.step) ?? null;
    return step ? { plan: info.plan, step } : null;
  } catch { return null; }
}

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
const TRUNCATED = /\btruncated\b|\bmax_chars\b/i;
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
const labelKey = (e) => sha(`${e.role ?? ""}\u0001${normLabel(e.name ?? "")}`).slice(0, 16);
// Correzioni dopo la revisione (27/10/2026, decisione dell'utente): nessun tetto sul numero di elementi, ref, nomi o
// etichette di una lettura o di una mappa (restano solo i limiti in byte dei file).
// Ambienti in cui un pezzo lega al SEL, e solo in modalità esplorazione (in un piano legano solo le letture complete):
// produzione e ambiente ignoto mai (i pezzi vi aggiungono solo i nomi).
const PARTIAL_BIND_ENVS = new Set(["sandbox", "dev", "preprod"]);

// Conteggio esatto, in un solo passaggio, dei token di ref nei formati delle tre famiglie (uid=X preceduto da inizio o
// da un carattere non di parola e seguito da uno che non lo è · [ref=X] · [X]): stesso risultato di tokenRe di WP07 giro 3
// per i ref fatti di caratteri di parola (tutti quelli delle tre famiglie); gli altri usano la regex del singolo ref.
const W = /\w/;
function tokenCounts(str) {
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

// Costruisce l'OBS (senza codice) dalla chiamata: pura rispetto al file system tranne Atlas e piano.
export async function buildObservation({ ws, customer, session, call, state, resp, ti = null, env: env0 = process.env, now = new Date() }) {
  // N1: le variabili da segreto si leggono una volta per chiamata (stessa redazione)
  const env = secretEnv(env0);
  const text = responseText(resp);
  const kind = obsKind(call, state, text);
  const profile = profileFor({ envType: session.env?.type ?? null });
  const page = text && kind !== "error" ? parseSnapshot(text, { family: call.family }) : null;
  const hasPage = !!page && (page.format !== "text" || kind === "snapshot");
  const scope = session.scope ?? "XSC";
  const atlas = hasPage ? atlasIndex(ws, customer, session.scope) : [];
  const ap = session.active_plan ?? null;
  let cmp = null;
  let cfgObject = null;
  if (hasPage && kind === "snapshot" && ap) {
    const st = await activeStep(ws, customer, ap);
    if (st) cmp = compareExpect(st.step, page, { resolve: (c) => resolveSel(ws, c, customer), atlas, profile });
    // §28.1: lo snapshot della pagina durante un passo ACT-CFG-CHANGE è lo snapshot dell'oggetto governato
    // WP09b (WP07 security minor 1): solo se la pagina mostra l'elemento del SEL del passo (legato dall'Atlas): uno
    // snapshot di un'altra pagina non è lo snapshot dell'oggetto. Copre il solo config.object; con più oggetti
    // governati (config.governs) serve kb snapshot (guard-config-scope vuole la copertura di tutti).
    // WP09b giro 1 (C1): un passo di sola area (config.area senza object) registra { objects: [], areas: [area] }: è
    // l'unica voce di sola area che guard-config-scope accetta (quella di kb snapshot no).
    if (st?.step?.action_class === "ACT-CFG-CHANGE" && (st.step.config?.object || st.step.config?.area) && state === "ok" && typeof st.step.target === "string"
      && (cmp?.elements_seen ?? []).some((e) => e?.atlas_match === st.step.target)) cfgObject = st.step.config.object ? { objects: [st.step.config.object] } : { objects: [], areas: [st.step.config.area] };
  }
  const sensitiveCache = new Map();
  const sensitive = (m) => {
    if (!m?.field) return false;
    if (!sensitiveCache.has(m.field)) sensitiveCache.set(m.field, fieldSensitivity(ws, m.field, customer)?.sensitive === true);
    return sensitiveCache.get(m.field);
  };
  const masks = new Set();
  const ft = (s) => { const r = freeText(s, { profile, env }); r.masks.forEach((x) => masks.add(x)); return r.text; };
  const seen = (cmp?.elements_seen ?? (hasPage ? compareExpect({ expect: {} }, page, { atlas, profile }).elements_seen : [])).map((e) => {
    const m = e.atlas_match ? atlasByCode(atlas, e.atlas_match) : atlasMatch(atlas, { name: e.label, role: e.role });
    const o = { ...e, label: ft(e.label) };
    if (e.value !== undefined) {
      if (sensitive(m)) { o.value = "[riservato]"; masks.add("fld-sensitivity"); } else o.value = ft(e.value);
    }
    return o;
  });
  const errors = hasPage ? detectErrors(page).map((e) => ({ ...e, message: redactText(e.message, { profile, env }).text })) : [];
  const doc = {
    type: "OBS",
    session: session.session_code ?? session.session_id,
    session_id: session.session_id,
    at_step: ap ? { plan: ap.plan_id, n: ap.step, run: ap.run ?? null } : null,
    tool: call.tool, family: call.family, kind,
    url: cleanUrl(page?.url, profile),
    page_signature: cmp?.page_signature ?? (hasPage ? (await import("../../scripts/chrome/snapshot-parse.mjs")).pageSignature(page, { profile }) : null),
    title: page?.title ? ft(page.title) : null,
    elements_seen: seen,
    messages_seen: (page?.messages ?? []).map((m) => ft(m.text)),
    // testo libero della pagina (fuori da elementi e messaggi): redatto e troncato a 40 caratteri (§54.2)
    texts_seen: [...new Set((page?.texts ?? []).filter((t) => t && !(page.messages ?? []).some((m) => m.text.includes(t))))].slice(0, 20).map(ft),
    divergences: (cmp?.divergences ?? []).map((d) => ({ kind: d.kind, what: d.what, ...(d.target ? { target: ft(d.target) } : {}), ...(d.priority ? { priority: true } : {}) })),
    surprise: cmp?.divergences.length ?? 0,
    novelty: cmp?.novelties.length ?? 0,
    errors: [],
    image: responseHasImage(resp),
    redaction: { profile, masks: [] },
    ts: now.toISOString(),
  };
  if (kind === "error") doc.error_text = ft(text || "risposta d'errore dello strumento");
  doc.redaction.masks = [...masks].sort();
  // Solo da uno snapshot la cui pagina è confermata dal marcatore del server (stesse regole dell'origine) e mai da
  // uno strumento che restituisce testo della pagina; un ref che compare due volte (riga forgiata) vale null.
  let refs = null;
  let pageUrl = null;
  const mode = readMode(call, ti, text);
  const asked = (call.actions ?? [call]).map((a) => a.tab).filter((t) => t != null).at(-1) ?? null;
  const loc = hasPage && state === "ok" && !(call.actions ?? [call]).some(isPageTextOp) ? observedLocation(call.family, text, { asked, resp }) : null;
  // WP07 giro 5 (I-A', regola 2): etichette (ruolo + nome) dei ref che OGNI risposta mostra — letture complete,
  // ristrette, find, snapshot nelle risposte delle azioni, tre famiglie — per la storia della scheda
  // (hooks/lib/ref-history.mjs). Registrare in più può solo slegare (fail-closed).
  let labels = [];
  let labelLoc = null;
  if (page && state === "ok") {
    labels = (page.elements ?? []).filter((e) => e.ref != null && e.ref !== "").map((e) => [String(e.ref), labelKey(e)]);
    if (labels.length) labelLoc = loc ?? observedLocation(call.family, text, { asked, resp });
  }
  // F0.1: nome (redatto, ≤ 80 caratteri) di ogni ref della risposta, per guard-destructive: il bersaglio di un click
  // o di un input si riconosce anche quando la chiamata nomina solo l'uid/ref (dato, mai istruzione)
  const names = {};
  if (page && state === "ok") {
    for (const e of page.elements ?? []) {
      if (e.ref == null || e.ref === "") continue;
      // revisione 05/10/2026 (C1): nome redatto ma non troncato a 40 caratteri (un "… - Elimina" in coda deve restare
      // visibile ai guard); oltre 200 caratteri si tengono inizio e fine
      if (typeof e.name === "string" && e.name.trim()) { const t = redactText(e.name, { profile, env }).text ?? ""; names[String(e.ref)] = t.length > 200 ? `${t.slice(0, 100)}…${t.slice(-99)}` : t; }
    }
  }
  // esplorazione libera (26/10/2026): anche le letture parziali passano dagli stessi controlli (verified = ref che li superano)
  const binds = mode === "complete" || mode === "partial" || (mode === null && call.family !== "claude-browser");
  const verified = [];
  // revisione di sicurezza (rilievo 2): un pezzo troncato (nota del server) o con un numero dispari di virgolette (un valore
  // aperto può nascondere righe forgiate) non ha ref verificati: non aggiunge nulla alla mappa
  const unsafePiece = mode === "partial" && (TRUNCATED.test(text) || (String(text).replace(/\\./g, "").match(/"/g) ?? []).length % 2 === 1);
  // correzione 7: un find non conferma la pagina (testo derivato dalla pagina) ma i suoi ref passano dagli stessi controlli
  const find = isFindRead(call);
  if (binds && (loc?.url || (find && mode === "partial" && page && state === "ok")) && (page.elements ?? []).some((e) => e.ref)) {
    pageUrl = loc?.url ?? null;
    // WP07 giro 2 (I-1): un ref è legato solo se compare UNA volta fra tutti i nodi e UNA volta nel testo grezzo
    // (DevTools stampa nomi e valori senza escape: una riga "uid=…" iniettata in un valore la ripete)
    // WP07 giro 3 (I-A): i token si contano in TUTTI i formati (uid=X, [ref=X], [X]): la somma deve essere 1; un
    // token dentro un valore fra virgolette (placeholder, value, name, description, aria-*) ⇒ slegato; formato
    // fiutato diverso dalla famiglia dello strumento ⇒ nessun ref legato (la mappa si scrive tutta a null).
    const count = {};
    for (const r of page.allRefs ?? []) count[r] = (count[r] ?? 0) + 1;
    const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, (m) => `\\${m}`);
    const tokenRe = (r) => new RegExp(`(?:(?:^|[^\\w])uid=${esc(r)}(?![\\w])|\\[ref=${esc(r)}\\]|\\[${esc(r)}\\])`, "g");
    // valori fra virgolette: su tutto il testo per DevTools e Claude (stampano a capo grezzi dentro i valori), riga per
    // riga per Playwright (YAML: le stringhe fra virgolette non vanno a capo; un " isolato in un testo non le accoppia)
    const QUOTED = /"((?:[^"\\]|\\.)*)"/gs;
    const quoted = (call.family === "playwright" ? text.split("\n") : [text]).flatMap((t) => [...t.matchAll(QUOTED)].map((m) => m[1]));
    // conteggi in un passaggio (pagine di migliaia di elementi): testo intero e valori fra virgolette
    const inText = tokenCounts(text);
    const inQuoted = new Set();
    for (const q of quoted) for (const k of tokenCounts(q).keys()) inQuoted.add(k);
    const unbound = (r) => {
      if (/^\w+$/.test(r)) return Math.max(count[r] ?? 0, inText.get(r) ?? 0) !== 1 || inQuoted.has(r);
      const re = tokenRe(r);
      if (Math.max(count[r] ?? 0, (text.match(re) ?? []).length) !== 1) return true;
      return quoted.some((q) => { re.lastIndex = 0; return re.test(q); });
    };
    refs = {};
    const ns = elementNorms(page);
    for (let i = 0; i < page.elements.length; i++) {
      const e = page.elements[i];
      if (!e.ref) continue;
      const bad = page.formatMismatch || unbound(String(e.ref));
      if (!bad && !unsafePiece) verified.push(String(e.ref));
      refs[String(e.ref)] = bad ? null : atlasMatch(atlas, e, { page: doc.page_signature, norm: ns[i] })?.code ?? null;
    }
  }
  // correzione 5: firma di un pezzo — percorso, più l'h1 solo se il pezzo lo mostra (mai il primo titolo qualunque)
  let pieceSig = null;
  if (mode === "partial" && page?.url) {
    const { pageSignature } = await import("../../scripts/chrome/snapshot-parse.mjs");
    pieceSig = pageSignature({ ...page, headings: (page.headings ?? []).filter((h) => h.level === 1) }, { profile });
  }
  return { doc, errors, scope, profile, cfgObject, refs, pageUrl, mode, labels, labelLoc, asked, text, names, page, verified, find, confirmedUrl: loc?.url ?? null, pieceSig, pieceH1: !!pieceSig && pieceSig.includes("#") };
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
//  - stato limitato in byte, mai troncato (sicurezza 2; nessun tetto sul numero di elementi per decisione dell'utente):
//    mappa oltre limits.mapBytes o storia oltre limits.histBytes ⇒ mappa inutilizzabile (unusable: i guard negano i click
//    con il motivo) e, per la storia, le schede della chiamata senza legami fino alla prossima navigazione.
// Firma del giro 4 nextBinding(b, opts) → browser ancora accettata (storia vuota); altrimenti → { browser, hist }.
const ACT_KINDS = new Set(["click", "input", "upload", "dialog", "script", "other"]);
export const MAP_MAX_BYTES = 8 * 1024 * 1024;
export const HISTORY_MAX_BYTES = 16 * 1024 * 1024;
export function nextBinding(b, hist, opts) {
  if (opts === undefined && hist && typeof hist === "object" && "call" in hist) return nextBinding(b, null, hist).browser;
  const { call, obs, ts, envType, mode, refs, pageUrl, labels = [], labelLoc = null, asked = null, cleared = [], key = null, names = null, verified = null, find = false, sig = null,
    confirmedUrl = null, sessionMode = null, pieceSig = null, pieceH1 = false, limits = {} } = opts;
  const out = { ...b };
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
  const h = updateHistory(hist ?? { v: 1, tabs: {} }, { cleared: cleared.map((c) => c.key), keys, labels, complete, firstOk, url: labelLoc?.url ?? null });
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
    // un find: la mappa resta, ricontrollata sulla storia; nessun ref, nome o legame aggiunto (sicurezza 3)
    if (mapOk(prev)) {
      const { rs, ns, unv } = kept(prev);
      const { unverified: _u, ...rest } = prev;
      out.snapshot = { ...rest, refs: rs, names: ns, ...(unv.length ? { unverified: unv } : {}) };
    }
  } else if (refs && pageUrl && !(partial && claudeNav)) {
    const bound = { ...refs };
    for (const r of Object.keys(bound)) if (bound[r] != null && !keys.every((k) => bindable(h, k, r, label.get(r)))) bound[r] = null;
    if (partial) {
      const { rs: merged, ns: mergedNames, unv } = samePage ? kept(prev) : { rs: {}, ns: {}, unv: [] };
      addPiece(merged, mergedNames, unv);
      const sigOut = samePage ? prev.sig ?? pieceSig : pieceH1 ? pieceSig : (prev && prev.url === pageUrl && typeof prev.sig === "string" ? prev.sig : null) ?? pieceSig ?? sig;
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
  // sicurezza 2: limiti in byte di mappa e storia (mai troncate: oltre il limite la mappa è inutilizzabile)
  const mapBytes = limits.mapBytes ?? MAP_MAX_BYTES;
  const histBytes = limits.histBytes ?? HISTORY_MAX_BYTES;
  let unusable = false;
  if (JSON.stringify(h).length > histBytes) {
    for (const k of keys) h.tabs[k] = { l: {}, full: true };
    unusable = true;
  }
  if (mapOk(out.snapshot) && JSON.stringify(out.snapshot).length > mapBytes) unusable = true;
  if (unusable && out.snapshot) out.snapshot = { obs: out.snapshot.obs ?? obs, url: out.snapshot.url ?? null, tab: out.snapshot.tab ?? null, ts, refs: {}, names: {}, unusable: true };
  const browser = key ? settlePending(out, key, cleared.flatMap((c) => c.pend)) : out;
  return { browser, hist: h };
}

function writeDb(ws, customer, scope, doc, errors, now) {
  return import("../../scripts/kb/db.mjs").then(async ({ openDb }) => {
    const { assignSeq, formatCode } = await import("../../scripts/kb/assign-seq.mjs");
    mkdirSync(join(ws, "customers", customer), { recursive: true });
    const db = openDb(join(ws, "customers", customer, "knowledge.db"));
    try {
      return db.transaction(() => {
        const key = { level: "L", customer, scope, type: "OBS" };
        const code = formatCode({ ...key, seq: assignSeq(db, key, { table: "observations" }) });
        const confirmed = doc.page_signature ? (db.prepare("select count(*) as n from observations where page_sig = ?").get(doc.page_signature).n + 1) : 1;
        doc.id = code;
        doc.confirmed_count = confirmed;
        const errs = [];
        for (const e of errors) {
          const hash = sha(`${e.category}|${e.code ?? ""}|${e.message.toLowerCase()}`).slice(0, 16);
          const raw_id = `ERR-RAW.${hash.slice(0, 8)}`;
          const row = db.prepare("select * from errors_raw where hash = ?").get(hash);
          const ts = now.toISOString();
          if (row) {
            const sessions = [...new Set([...JSON.parse(row.sessions), doc.session])];
            db.prepare("update errors_raw set last_seen=?, count=count+1, sessions=?, last_obs=? where hash=?").run(ts, JSON.stringify(sessions), code, hash);
            errs.push({ ...e, hash, raw_id, file: row.file, count: row.count + 1, first_seen: row.first_seen, sessions, repeat: true });
          } else {
            const file = `customers/${customer}/kb/scopes/${scope}/errors/_raw/${stamp(now)}${errs.length ? `-${errs.length}` : ""}.yaml`;
            db.prepare(`insert into errors_raw(hash,raw_id,customer,scope,message,code,category,kind,blocking,lang,page_sig,file,first_seen,last_seen,count,sessions,last_obs)
              values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,1,?,?)`).run(hash, raw_id, customer, scope, e.message, e.code, e.category, e.kind, e.blocking ? 1 : 0, e.lang, doc.page_signature, file, ts, ts, JSON.stringify([doc.session]), code);
            errs.push({ ...e, hash, raw_id, file, count: 1, first_seen: ts, sessions: [doc.session], repeat: false });
          }
        }
        doc.errors = errs.map((e) => ({ raw_id: e.raw_id, code: e.code, category: e.category, kind: e.kind, count: e.count }));
        const payload = JSON.stringify(doc);
        db.prepare("insert into observations(code, session, scope, page_sig, payload, confirmed_count) values (?,?,?,?,?,?)")
          .run(code, doc.session, scope, doc.page_signature, payload, confirmed);
        return { code, errs, payload };
      }).immediate();
    } finally { db.close(); }
  });
}

function writeErrFile(ws, e, doc, scope, now) {
  const abs = join(ws, ...e.file.split("/"));
  mkdirSync(join(abs, ".."), { recursive: true });
  const body = {
    raw_id: e.raw_id, type: "ERR", status: "grezzo", scope,
    message: { [e.lang]: e.message, [e.lang === "it" ? "en" : "it"]: null },
    code: e.code, category: e.category, kind: e.kind, blocking: e.blocking,
    page_signature: doc.page_signature,
    trigger: { plan: doc.at_step?.plan ?? null, step: doc.at_step?.n ?? null, tool: doc.tool },
    observed: { first: e.first_seen, last: now.toISOString(), count: e.count, sessions: e.sessions, last_obs: doc.id },
    hash: e.hash,
    note: "ERR grezzo scritto da observe-append (§20.6.2): il digester dello scope lo completa (meaning, resolution, related) e ne assegna il codice.",
  };
  writeFileAtomic(abs, toYaml(body));
}

// Correzione 1 dopo la revisione (27/10/2026): Chrome DevTools non ha letture a pezzi; sulle pagine pesanti l'agente salva
// lo snapshot in un file (take_snapshot { filePath }) e lo legge a pezzi con Read. observe-append legge QUEL file e lo tratta
// come una lettura COMPLETA in linea (legame, nomi, record del registro), con le stesse regole: marcatore di pagina
// (RootWebArea), conteggi dei ref, storia.
// Sicurezza 1 (il modello potrebbe scrivere il file e forgiare una pagina): si legge solo il file che lo strumento ha scritto
// in QUESTA chiamata — filePath assoluto, .txt, nella cartella customers/<C>/.sessions/<sid>/snapshots/ (che Write, Edit e la
// shell non possono scrivere: guard-scope) dopo il realpath; risposta riuscita che nomina esattamente quel file ("Saved
// snapshot to <file>.", chrome-devtools-mcp); marcatore della chiamata scritto da guard-environment in PreToolUse
// (session.browser.snapshot_calls[<tool_use_id>]: percorso, ora, mtime precedente) e file modificato dopo; al più
// SNAPSHOT_FILE_MAX_BYTES. Ogni discordanza ⇒ la risposta resta quella dello strumento: nessuna lettura, nessun legame.
export const SNAPSHOT_FILE_MAX_BYTES = 32 * 1024 * 1024;
export const snapshotsDir = (ws, customer, sid) => join(ws, "customers", customer, ".sessions", sid, "snapshots");
const SELECTED_NOTE = /^Note: there is a selected element[^\n]*\n[^\n]*\n\n/;
const WINFS = process.platform === "win32";
const foldP = (p) => (WINFS ? p.toLowerCase() : p);
export function snapshotFileResponse({ ws, customer, sid, call, resp, state = "ok", marker = null, now = Date.now() }) {
  if (call?.family !== "chrome-devtools" || call.op !== "take_snapshot" || !Array.isArray(call.outputs) || call.outputs.length !== 1) return null;
  if (state !== "ok" || (Array.isArray(call.unknownKeys) && call.unknownKeys.length)) return null;
  const raw = call.outputs[0];
  if (typeof raw !== "string" || !raw.trim() || /[\u0000-\u001f\u007f\u0085\u2028\u2029]/.test(raw)) return null;
  if (!isAbsolute(raw) || (WINFS && !/^([A-Za-z]:[\\/]|[\\/]{2})/.test(raw)) || !/\.txt$/i.test(raw)) return null;
  const abs = resolve(raw);
  const text0 = responseText(resp);
  if (/^## Latest page snapshot\s*$/m.test(text0)) return null;   // già in linea
  // la risposta riuscita nomina esattamente quel file
  const saved = [...text0.matchAll(/^Saved snapshot to (.+)\.\s*$/gm)].map((m) => m[1]);
  if (saved.length !== 1 || foldP(resolve(saved[0])) !== foldP(abs)) return null;
  // marcatore di questa chiamata (PreToolUse, guard-environment): stesso file, scritto dopo
  if (!marker || typeof marker !== "object" || typeof marker.path !== "string" || foldP(resolve(marker.path)) !== foldP(abs) || !Number.isFinite(marker.ts)) return null;
  let real;
  let dir;
  try { real = realpathSync(abs); dir = realpathSync(snapshotsDir(ws, customer, sid)); } catch { return null; }
  if (!foldP(real).startsWith(foldP(dir.endsWith(sep) ? dir : dir + sep))) return null;
  let st;
  try { st = statSync(real); } catch { return null; }
  if (!st.isFile() || st.size > SNAPSHOT_FILE_MAX_BYTES) return null;
  if (st.mtimeMs < marker.ts - 1000 || (Number.isFinite(marker.before) && st.mtimeMs <= marker.before) || st.mtimeMs - now > 60000) return null;
  let body;
  try { body = readFileSync(real, "utf8"); } catch { return null; }
  body = body.replace(/^\s*## Latest page snapshot\s*\n/, "").replace(SELECTED_NOTE, "");
  const block = { type: "text", text: `## Latest page snapshot\n${body}` };
  if (Array.isArray(resp)) return [...resp, block];
  if (resp && typeof resp === "object" && Array.isArray(resp.content)) return { ...resp, content: [...resp.content, block] };
  return [{ type: "text", text: text0 }, block];
}

export async function record(input, env = process.env, { now = new Date() } = {}) {
  const tool = String(input.tool_name ?? "");
  if (!isBrowserTool(tool)) return null;
  const st = loadHookState(input, env);
  if (!st.jvc || !st.session || !st.sessionFile) return null;
  const call = classify(tool, input.tool_input);
  // correzione 1 e sicurezza 1: take_snapshot di DevTools con filePath ⇒ il file scritto dallo strumento in questa chiamata
  let resp = input.tool_response;
  const callKey0 = callKey(input);
  const marker = st.session.browser?.snapshot_calls?.[callKey0] ?? null;
  try {
    let st0;
    try { st0 = responseState(resp); } catch { st0 = "unknown"; }
    resp = snapshotFileResponse({ ws: st.ws, customer: st.customer, sid: st.sid, call, resp, state: st0, marker, now: now.getTime() }) ?? resp;
  } catch { resp = input.tool_response; }
  let state;
  try { state = responseState(resp); } catch { state = "unknown"; }
  const warn = [];
  // soluzione A: stato PRIMA di questa chiamata (nome del bersaglio di un click, pagina di partenza)
  const prevSnap = st.session.browser?.snapshot ?? null;
  const prevSig = st.session.ledger?.observe?.last_page_sig ?? null;

  // 1. origine osservata (prima di tutto: è ciò che leggono i guard)
  if (st.session.env) {
    try {
      updateSessionFile(st.sessionFile, (s) => {
        const b = s.browser ?? {};
        const prev = { url: typeof b.current_url === "string" && b.current_url ? b.current_url : null, tab: b.tab ?? null };
        let next;
        try { next = nextObserved(prev, call, state, resp); } catch { next = { url: null, tab: null }; }
        if (next.url === prev.url && (next.tab ?? null) === (prev.tab ?? null)) return s;
        s.browser = { ...b, current_url: next.url, tab: next.tab ?? null, updated_by: "observe-append" };
        return s;
      });
    } catch (err) { resetOrigin(st.sessionFile); warn.push(`origine azzerata (${String(err.message).slice(0, 80)})`); }
  }

  // 2. osservazione
  const { doc, errors, scope, cfgObject, refs, pageUrl, mode, labels, labelLoc, asked, text, names, page, verified, find, confirmedUrl, pieceSig: pSig, pieceH1 } = await buildObservation({ ws: st.ws, customer: st.customer, session: st.session, call, state, resp, ti: input.tool_input, env, now });
  const { code, errs, payload } = await writeDb(st.ws, st.customer, scope, doc, errors, now);
  const dir = join(st.ws, "customers", st.customer, "observations");
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, `${code}.yaml`), toYaml({ id: code, ...doc }));
  for (const e of errs) writeErrFile(st.ws, e, doc, scope, now);

  // 3. registro di sessione: ultima osservazione, spreco (snapshot ripetuti senza azione)
  let waste = false;
  let newSnap = null;
  const key = callKey(input);
  // storia del browser del cliente (sopravvive alla sessione: la mappa dei ref dell'estensione sopravvive a lei)
  const histFile = historyFile(join(st.ws, "customers", st.customer, ".sessions"));
  const pendFile = pendingFile(join(st.ws, "customers", st.customer, ".sessions"));
  // schede azzerate: navigate riuscito (marcatore positivo di arrivo) a un nuovo documento, o chiusura della scheda
  const cleared = clearedBy(call, { ok: state === "ok", landedTab: labelLoc?.tab ?? observedLocation(call.family, text, { asked, resp })?.tab ?? null,
    landed: (a) => !!landedUrl(call.family, text, { asked: a.tab ?? null, resp }) });
  const obsKindForLedger = doc.kind === "navigate" || doc.kind === "action" ? "action" : doc.kind;
  // esplorazione libera: un pezzo della pagina porta la firma della mappa a cui si somma (i click che seguono partono da lì)
  const pieceSig = () => (mode === "partial" && newSnap?.partial && newSnap.obs === code && typeof newSnap.sig === "string" ? newSnap.sig : null);
  updateSessionFile(st.sessionFile, (s) => {
    const o = s.ledger.observe ?? {};
    if (doc.kind === "snapshot" && doc.page_signature) {
      if (o.snapshot_sig === doc.page_signature) {
        waste = true;
        s.ledger.waste = [...(Array.isArray(s.ledger.waste) ? s.ledger.waste : []), { kind: "repeated-snapshot", page_sig: doc.page_signature, obs: code, at: doc.ts, ...(doc.at_step ? { plan: doc.at_step.plan, step: doc.at_step.n } : {}) }];
      }
      o.snapshot_sig = doc.page_signature;
    } else if (obsKindForLedger === "action" || doc.kind === "error") o.snapshot_sig = null;
    // ultimo snapshot osservato: vale solo per la pagina (URL) e la scheda su cui è stato preso (esplorazione libera:
    // i pezzi della stessa pagina si sommano, una lettura completa basta ovunque); WP07 giro 5: storia dei
    // ref per scheda nel file della sessione, aggiornata sotto lo stesso lock di session.json, e chiusura della voce
    // obs_pending di questa chiamata (se questa scrittura non avviene, la voce resta e i guard non legano)
    // lock della storia dentro quello di session.json (stesso ordine per tutte le sessioni del cliente)
    s.browser = withFileLock(`${histFile}.lock`, () => {
      const r = nextBinding(s.browser ?? {}, loadHistory(histFile), { call, obs: code, ts: doc.ts, envType: s.env?.type ?? null, mode, refs, pageUrl, labels, labelLoc, asked, cleared, key, names, verified, find, sig: doc.page_signature ?? null, confirmedUrl, sessionMode: s.mode ?? null, pieceSig: pSig, pieceH1 });
      newSnap = r.browser.snapshot ?? null;
      if (labels.length || cleared.length || labelLoc?.url) saveHistory(histFile, r.hist);
      // WP08: il marcatore del cliente si chiude qui, sotto gli stessi lock (ordine: session.json → storia → marcatore)
      withFileLock(`${pendFile}.lock`, () => {
        const p = loadPending(pendFile);
        savePending(pendFile, settlePending(p.corrupt ? { obs_pending: {}, obs_done: [] } : p, key, cleared.flatMap((c) => c.pend)));
      });
      return r.browser;
    });
    if (cfgObject) s.snapshots = [...(Array.isArray(s.snapshots) ? s.snapshots : []), { ...cfgObject, ts: doc.ts, obs: code, source: "observe-append", ...(doc.url ? { page: doc.url } : {}) }].slice(-20);
    // WP09b giro 2: anello delle OBS di questa sessione (prova di autenticità per kb snapshot): session.json è protetto,
    // il DB no; una riga del DB vale solo se codice, page_sig, ts e sha256 del payload coincidono con una voce qui
    s.obs_ring = [...(Array.isArray(s.obs_ring) ? s.obs_ring : []), { code, page_sig: doc.page_signature ?? null, ts: doc.ts, sha256: sha(payload) }].slice(-OBS_RING_MAX);
    s.ledger.observe = { ...o, last_obs: code, last_kind: doc.kind, last_page_sig: pieceSig() ?? doc.page_signature ?? null, count: (o.count ?? 0) + 1 };
    // il marcatore del file di snapshot vale una volta sola
    if (s.browser?.snapshot_calls && Object.hasOwn(s.browser.snapshot_calls, callKey0)) {
      const { [callKey0]: _m, ...restCalls } = s.browser.snapshot_calls;
      s.browser.snapshot_calls = restCalls;
    }
    return s;
  });
  try {
    appendFileSync(join(sessionDir(st.ws, st.customer, st.sid), "observations.jsonl"), `${JSON.stringify({ kind: obsKindForLedger, page_sig: doc.page_signature, obs: code, ts: doc.ts })}\n`);
  } catch { /* il registro jsonl è di comodo per self-check --observations */ }

  // 4. soluzione A (spec §A1): registro di sola struttura per atlas-build — fail-open, mai un blocco
  try {
    const file = atlasLogFile(st.ws, st.customer, st.sid);
    const envS = secretEnv(env);
    const lastPage = join(dirname(file), "last-page.json");
    let full = false;
    // prima i click (si riferiscono alla pagina precedente), poi la pagina di questa risposta; revisione finale (I4): un
    // click su un elemento dentro un record (riga, cella) della pagina precedente non si registra
    // revisione 05/10/2026 (I5): con una risposta d'errore o non riconosciuta l'azione con effetto potrebbe essere
    // avvenuta comunque: si registra marcata uncertain (solo quelle con effetto; i click di navigazione no)
    const ok = state === "ok";
    const acts = call.actions ?? [call];
    const clicked = acts.filter((a) => a.kind === "click" && !a.submits && Array.isArray(a.targets) && a.targets.length);
    // esplorazione completa (05/10/2026): ogni click si registra; un click su un record (riga, cella) è marcato record —
    // dato, mai percorso né selettore — e lo è anche quando non si sa (ref dei record di un altro snapshot); un click su
    // un'etichetta con effetto, un Invio o la conferma di un dialogo sono marcati effect (elenco delle azioni con effetto)
    if (clicked.length) {
      let lp = null;
      try { lp = JSON.parse(readFileSync(lastPage, "utf8")); } catch { lp = null; }
      const rec = new Set(lp?.record_refs ?? []);
      const same = !!lp && !!prevSnap?.obs && lp.obs === prevSnap.obs;
      for (const a of clicked) {
        const ref = String(a.targets[0]);
        const name = prevSnap?.names?.[ref];
        if (!name) continue;
        const effect = EFFECT_LABEL.test(name);
        if (!ok && !effect) continue;
        full = appendAtlasLog(file, clickRecord({ fromSig: prevSig, name, ts: doc.ts, record: !same || rec.has(ref), effect, uncertain: !ok })) === "full" || full;
      }
    }
    for (const a of acts.filter((x) => x.submits)) {
      full = appendAtlasLog(file, clickRecord({ fromSig: prevSig, name: a.kind === "dialog" ? "(conferma del dialogo)" : "(Invio)", ts: doc.ts, effect: true, uncertain: !ok })) === "full" || full;
    }
    if (state === "ok" && mode === "complete" && pageUrl && page) {
      full = appendAtlasLog(file, pageRecord(page, { pageSig: doc.page_signature, profile: doc.redaction.profile, env: envS, ts: doc.ts })) === "full" || full;
    }
    // esplorazione libera (26/10/2026): anche un pezzo della pagina (non un find: risultati di una ricerca) scrive un record
    // marcato partial, con la firma della mappa a cui si somma; atlas-build unisce i pezzi consecutivi in una visita
    const piece = state === "ok" && mode === "partial" && !find && pageUrl && page && newSnap?.partial && newSnap.obs === code;
    if (piece) full = appendAtlasLog(file, pageRecord(page, { pageSig: pieceSig() ?? doc.page_signature, profile: doc.redaction.profile, env: envS, ts: doc.ts, partial: true })) === "full" || full;
    // ogni snapshot che lega i ref (lettura completa o risposta di un'azione con la pagina intera) aggiorna i ref dei record;
    // un pezzo che si somma alla mappa aggiunge i suoi a quelli della mappa
    if (state === "ok" && page && refs && pageUrl && (mode !== "partial" || newSnap?.obs === code)) {
      let base = [];
      const merged = mode === "partial" && newSnap?.partial && prevSnap?.obs && prevSnap.url === newSnap.url && (prevSnap.tab ?? null) === (newSnap.tab ?? null) && (prevSnap.family ?? null) === (newSnap.family ?? null);
      if (merged) {
        try { const lp0 = JSON.parse(readFileSync(lastPage, "utf8")); if (lp0?.obs === prevSnap.obs && prevSnap.url === newSnap.url) base = Array.isArray(lp0.record_refs) ? lp0.record_refs : []; } catch { base = []; }
      }
      writeFileAtomic(lastPage, JSON.stringify({ obs: code, record_refs: [...new Set([...base, ...recordRefs(page)])] }));
    }
    if (full && fullWarningOnce(dirname(file))) warn.push("registro dell'esplorazione pieno (20 MB): pagine non registrate da qui in poi");
  } catch (err) { warn.push(`registro dell'esplorazione non scritto (${String(err?.message ?? err).slice(0, 80)})`); }

  const errTag = errs.length ? errs.map((e) => e.code ?? e.raw_id).join(",") : "—";
  const line = `OBS ${code} · surprise:${doc.surprise} novelty:${doc.novelty} · ERR:${errTag}${waste ? " · spreco: snapshot ripetuto della stessa pagina senza azione" : ""}`;
  return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: line }, ...(warn.length ? { systemMessage: `[jvc:observe-append] avviso: ${warn.join("; ")}` } : {}) };
}

export function resetOrigin(file) {
  try {
    const s = JSON.parse(readFileSync(file, "utf8"));
    if (s.browser?.current_url == null && s.browser?.tab == null) return;
    updateSessionFile(file, (x) => { x.browser = { ...(x.browser ?? {}), current_url: null, tab: null, updated_by: "observe-append" }; });
  } catch { /* stato illeggibile: i guard negano comunque */ }
}

// Guasto dell'hook: prima di avvisare, azzera l'origine (mai un'origine non confermata).
export function resetOnFailure(input, env = process.env) {
  try {
    const st = loadHookState(input, env);
    if (st.jvc && st.sessionFile) resetOrigin(st.sessionFile);
  } catch { /* nulla da fare */ }
}
