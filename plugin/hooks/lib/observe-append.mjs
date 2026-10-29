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
import { parseSnapshot, responseText, responseHasImage, normLabel, stripDataUris, stripResponseDataUris } from "../../scripts/chrome/snapshot-parse.mjs";
import { compareExpect, elementNorms } from "../../scripts/chrome/expect-compare.mjs";
import { resolveSel, atlasIndex, atlasMatch, atlasByCode, fieldSensitivity } from "../../scripts/chrome/atlas.mjs";
import { detectErrors } from "../../scripts/chrome/errors.mjs";
import { profileFor, redactText, freeText, secretEnv } from "../../scripts/chrome/redact.mjs";
import { toYaml } from "../../scripts/lib/yaml-lite.mjs";
import { pageRecord, clickRecord, appendAtlasLog, atlasLogFile, recordRefs, fullWarningOnce } from "./atlas-log.mjs";
import { EFFECT_LABEL } from "./effect-labels.mjs";
import { allows } from "./policy.mjs";
// 29/10/2026 (punto 7): stadi di observe-append in moduli separati; riesportati per chi li importa da qui
import { readMode, isFindRead, tokenCounts, labelKey, TRUNCATED, nextBinding } from "./observe/binding.mjs";
import { writeDb, writeErrFile } from "./observe/store.mjs";
import { snapshotsDir, snapshotFileResponse } from "./observe/snapshot-file.mjs";
export { readMode, isFindRead, nextBinding, snapshotsDir, snapshotFileResponse };

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
  // robustezza (27/10/2026): le parti di sola registrazione (confronto con l'expect e novità, elementi visti, errori della
  // piattaforma, testi redatti dell'OBS) non devono mai impedire la scrittura della mappa e la chiusura del marcatore:
  // un loro guasto si annota in `soft` (avviso dell'hook) e l'OBS esce senza quella parte. Il legame (parser, Atlas, firma
  // della pagina, conteggi dei ref) resta com'è: un suo guasto fa fallire l'hook (marcatore aperto, nessun legame).
  const soft = [];
  const tryOr = (f, fb, what) => { try { return f(); } catch (err) { soft.push(`${what} (${String(err?.message ?? err).slice(0, 80)})`); return fb; } };
  let cmp = null;
  let cfgObject = null;
  if (hasPage && kind === "snapshot" && ap) try {
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
  } catch (err) { cmp = null; cfgObject = null; soft.push(`confronto con l'expect non fatto (${String(err?.message ?? err).slice(0, 80)})`); }
  const sensitiveCache = new Map();
  const sensitive = (m) => {
    if (!m?.field) return false;
    if (!sensitiveCache.has(m.field)) sensitiveCache.set(m.field, fieldSensitivity(ws, m.field, customer)?.sensitive === true);
    return sensitiveCache.get(m.field);
  };
  const masks = new Set();
  const ft = (s) => { const r = freeText(s, { profile, env }); r.masks.forEach((x) => masks.add(x)); return r.text; };
  const seen = tryOr(() => (cmp?.elements_seen ?? (hasPage ? compareExpect({ expect: {} }, page, { atlas, profile }).elements_seen : [])).map((e) => {
    const m = e.atlas_match ? atlasByCode(atlas, e.atlas_match) : atlasMatch(atlas, { name: e.label, role: e.role });
    const o = { ...e, label: ft(e.label) };
    if (e.value !== undefined) {
      if (sensitive(m)) { o.value = "[riservato]"; masks.add("fld-sensitivity"); } else o.value = ft(e.value);
    }
    return o;
  }), [], "elementi visti non registrati");
  const errors = tryOr(() => (hasPage ? detectErrors(page).map((e) => ({ ...e, message: redactText(e.message, { profile, env }).text })) : []), [], "errori della pagina non registrati");
  const doc = {
    type: "OBS",
    session: session.session_code ?? session.session_id,
    session_id: session.session_id,
    at_step: ap ? { plan: ap.plan_id, n: ap.step, run: ap.run ?? null } : null,
    tool: call.tool, family: call.family, kind,
    url: cleanUrl(page?.url, profile),
    page_signature: cmp?.page_signature ?? (hasPage ? (await import("../../scripts/chrome/snapshot-parse.mjs")).pageSignature(page, { profile }) : null),
    title: tryOr(() => (page?.title ? ft(page.title) : null), null, "titolo non registrato"),
    elements_seen: seen,
    messages_seen: tryOr(() => (page?.messages ?? []).map((m) => ft(m.text)), [], "messaggi non registrati"),
    // testo libero della pagina (fuori da elementi e messaggi): redatto e troncato a 40 caratteri (§54.2)
    texts_seen: tryOr(() => [...new Set((page?.texts ?? []).filter((t) => t && !(page.messages ?? []).some((m) => m.text.includes(t))))].slice(0, 20).map(ft), [], "testi non registrati"),
    divergences: tryOr(() => (cmp?.divergences ?? []).map((d) => ({ kind: d.kind, what: d.what, ...(d.target ? { target: ft(d.target) } : {}), ...(d.priority ? { priority: true } : {}) })), [], "divergenze non registrate"),
    surprise: cmp?.divergences?.length ?? 0,
    novelty: cmp?.novelties?.length ?? 0,
    errors: [],
    image: responseHasImage(resp),
    redaction: { profile, masks: [] },
    ts: now.toISOString(),
  };
  if (kind === "error") doc.error_text = tryOr(() => ft(text || "risposta d'errore dello strumento"), "risposta d'errore dello strumento", "testo dell'errore non registrato");
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
  return { soft, doc, errors, scope, profile, cfgObject, refs, pageUrl, mode, labels, labelLoc, asked, text, names, page, verified, find, confirmedUrl: loc?.url ?? null, pieceSig, pieceH1: !!pieceSig && pieceSig.includes("#") };
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
  const fromFile = resp !== input.tool_response;
  // guard sulla grandezza tolto (27/10/2026): data URI in base64 sostituiti PRIMA di ogni lettura (origine, parser,
  // redazione, legame, registro, OBS); i controlli del legame (conteggi dei token, valori fra virgolette) si fanno sullo
  // stesso testo. La chiave della chiamata (callKey) resta quella dell'input originale, come in browser-origin.
  try { resp = stripResponseDataUris(resp); } catch { /* risposta com'è */ }
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
  const { soft, doc, errors, scope, cfgObject, refs, pageUrl, mode, labels, labelLoc, asked, text, names, page, verified, find, confirmedUrl, pieceSig: pSig, pieceH1 } = await buildObservation({ ws: st.ws, customer: st.customer, session: st.session, call, state, resp, ti: input.tool_input, env, now });
  if (soft.length) warn.push(`OBS incompleta: ${soft.join("; ")}`);
  // robustezza (27/10/2026): un guasto del DB delle OBS o dei file dell'OBS non lascia il marcatore aperto né la mappa
  // vuota (fail-open solo per la registrazione): la mappa prende un identificativo locale della chiamata (nr:<chiave>),
  // l'anello delle OBS e il ledger non registrano un codice che il DB non ha
  let code = null;
  let errs = [];
  let payload = null;
  try {
    ({ code, errs, payload } = await writeDb(st.ws, st.customer, scope, doc, errors, now));
    const dir = join(st.ws, "customers", st.customer, "observations");
    mkdirSync(dir, { recursive: true });
    writeFileAtomic(join(dir, `${code}.yaml`), toYaml({ id: code, ...doc }));
    for (const e of errs) writeErrFile(st.ws, e, doc, scope, now);
  } catch (err) { warn.push(`OBS non registrata${code ? ` per intero (${code})` : ""} (${String(err?.message ?? err).slice(0, 80)})`); }
  const obsId = code ?? `nr:${callKey0}`;

  // 3. registro di sessione: ultima osservazione, spreco (snapshot ripetuti senza azione)
  let waste = false;
  let newSnap = null;
  let pieceInfo = null;
  const key = callKey(input);
  // storia del browser del cliente (sopravvive alla sessione: la mappa dei ref dell'estensione sopravvive a lei)
  const histFile = historyFile(join(st.ws, "customers", st.customer, ".sessions"));
  const pendFile = pendingFile(join(st.ws, "customers", st.customer, ".sessions"));
  // schede azzerate: navigate riuscito (marcatore positivo di arrivo) a un nuovo documento, o chiusura della scheda
  const cleared = clearedBy(call, { ok: state === "ok", landedTab: labelLoc?.tab ?? observedLocation(call.family, text, { asked, resp })?.tab ?? null,
    landed: (a) => !!landedUrl(call.family, text, { asked: a.tab ?? null, resp }),
    // 27/10/2026: navigate riuscito a un URL diverso da quello noto della scheda (storia della scheda, mappa della stessa
    // famiglia e scheda; nessuno noto ⇒ diverso) ⇒ le voci obs_pending della scheda si chiudono anche con un frammento
    moved: (a, k) => {
      const href = (u) => { try { return new URL(String(u)).href; } catch { return null; } };
      const to = href(landedUrl(call.family, text, { asked: a.tab ?? null, resp }));
      if (!to) return false;
      let known = [];
      try { known.push(loadHistory(histFile).tabs?.[k]?.url); } catch { /* storia illeggibile: nessun URL noto */ }
      if (prevSnap && (prevSnap.family ?? null) === call.family && tabKey(call.family, prevSnap.tab ?? null) === k) known.push(prevSnap.url);
      known = known.map(href).filter(Boolean);
      return !known.includes(to);
    } });
  const obsKindForLedger = doc.kind === "navigate" || doc.kind === "action" ? "action" : doc.kind;
  // esplorazione libera: un pezzo della pagina porta la firma della mappa a cui si somma (i click che seguono partono da lì)
  const pieceSig = () => (mode === "partial" && newSnap?.partial && newSnap.obs === obsId && typeof newSnap.sig === "string" ? newSnap.sig : null);
  updateSessionFile(st.sessionFile, (s) => {
    const o = s.ledger.observe ?? {};
    if (doc.kind === "snapshot" && doc.page_signature) {
      if (o.snapshot_sig === doc.page_signature) {
        waste = true;
        s.ledger.waste = [...(Array.isArray(s.ledger.waste) ? s.ledger.waste : []), { kind: "repeated-snapshot", page_sig: doc.page_signature, obs: obsId, at: doc.ts, ...(doc.at_step ? { plan: doc.at_step.plan, step: doc.at_step.n } : {}) }];
      }
      o.snapshot_sig = doc.page_signature;
    } else if (obsKindForLedger === "action" || doc.kind === "error") o.snapshot_sig = null;
    // ultimo snapshot osservato: vale solo per la pagina (URL) e la scheda su cui è stato preso (esplorazione libera:
    // i pezzi della stessa pagina si sommano, una lettura completa basta ovunque); WP07 giro 5: storia dei
    // ref per scheda nel file della sessione, aggiornata sotto lo stesso lock di session.json, e chiusura della voce
    // obs_pending di questa chiamata (se questa scrittura non avviene, la voce resta e i guard non legano)
    // lock della storia dentro quello di session.json (stesso ordine per tutte le sessioni del cliente)
    s.browser = withFileLock(`${histFile}.lock`, () => {
      const r = nextBinding(s.browser ?? {}, loadHistory(histFile), { call, obs: obsId, ts: doc.ts, envType: s.env?.type ?? null, mode, refs, pageUrl, labels, labelLoc, asked, cleared, key, names, verified, find, sig: doc.page_signature ?? null, confirmedUrl, sessionMode: s.mode ?? null, pieceSig: pSig, pieceH1 });
      newSnap = r.browser.snapshot ?? null;
      pieceInfo = r.piece ?? null;
      if (labels.length || cleared.length || labelLoc?.url) saveHistory(histFile, r.hist);
      // WP08: il marcatore del cliente si chiude qui, sotto gli stessi lock (ordine: session.json → storia → marcatore)
      withFileLock(`${pendFile}.lock`, () => {
        const p = loadPending(pendFile);
        savePending(pendFile, settlePending(p.corrupt ? { obs_pending: {}, obs_done: [] } : p, key, r.settled));
      });
      return r.browser;
    });
    if (cfgObject && code) s.snapshots = [...(Array.isArray(s.snapshots) ? s.snapshots : []), { ...cfgObject, ts: doc.ts, obs: code, source: "observe-append", ...(doc.url ? { page: doc.url } : {}) }].slice(-20);
    // WP09b giro 2: anello delle OBS di questa sessione (prova di autenticità per kb snapshot): session.json è protetto,
    // il DB no; una riga del DB vale solo se codice, page_sig, ts e sha256 del payload coincidono con una voce qui
    if (code && payload != null) s.obs_ring = [...(Array.isArray(s.obs_ring) ? s.obs_ring : []), { code, page_sig: doc.page_signature ?? null, ts: doc.ts, sha256: sha(payload) }].slice(-OBS_RING_MAX);
    s.ledger.observe = { ...o, last_obs: code, last_kind: doc.kind, last_page_sig: pieceSig() ?? doc.page_signature ?? null, count: (o.count ?? 0) + 1 };
    // il marcatore del file di snapshot vale una volta sola
    if (s.browser?.snapshot_calls && Object.hasOwn(s.browser.snapshot_calls, callKey0)) {
      const { [callKey0]: _m, ...restCalls } = s.browser.snapshot_calls;
      s.browser.snapshot_calls = restCalls;
    }
    return s;
  });
  try {
    appendFileSync(join(sessionDir(st.ws, st.customer, st.sid), "observations.jsonl"), `${JSON.stringify({ kind: obsKindForLedger, page_sig: doc.page_signature, obs: obsId, ts: doc.ts })}\n`);
  } catch { /* il registro jsonl è di comodo per self-check --observations */ }

  // 3bis. cattura integrale dell'esplorazione (28/10/2026): testo di ogni pagina, mappa del sito con i click, riassunto
  // compatto per il modello (hooks/lib/explore-capture.mjs) — fail-open, solo in modalità esplorazione
  let digest = null;
  let digestReplace = false;
  if (allows(st.session, "cattura_integrale")) {
    try {
      const cap = await import("./explore-capture.mjs");
      const acts0 = call.actions ?? [call];
      for (const a of acts0.filter((x) => x.kind === "click" && Array.isArray(x.targets) && x.targets.length)) {
        const name = prevSnap?.names?.[String(a.targets[0])];
        if (name) cap.captureClick({ ws: st.ws, customer: st.customer, fromSig: prevSig, name, ts: doc.ts });
      }
      const url = pageUrl ?? confirmedUrl ?? page?.url ?? null;
      if (state === "ok" && page && !find && (mode === "complete" || mode === "partial" || (mode === null && refs)) && url) {
        const sig = pieceSig() ?? doc.page_signature ?? url;
        const file = cap.capturePage({ ws: st.ws, customer: st.customer, sig, url, title: page.title ?? null, page, text, partial: mode === "partial", ts: doc.ts });
        // riassunto: per le letture da file (il modello non deve rileggerle a pezzi) e per le pagine grandi in linea
        if (mode !== "partial" && (fromFile || text.length > 20000)) {
          digest = cap.pageDigest(page, { file: file ? `customers/${st.customer}/${file}` : null });
          digestReplace = !fromFile && text.length > 60000;
        }
      }
    } catch (err) { warn.push(`cattura dell'esplorazione non scritta (${String(err?.message ?? err).slice(0, 80)})`); }
  }

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
    const piece = state === "ok" && mode === "partial" && !find && pageUrl && page && newSnap?.partial && newSnap.obs === obsId;
    // N5: un pezzo che apre una mappa nuova dopo un'azione è marcato after_action: atlas-build non lo unisce alla visita di prima
    if (piece) full = appendAtlasLog(file, pageRecord(page, { pageSig: pieceSig() ?? doc.page_signature, profile: doc.redaction.profile, env: envS, ts: doc.ts, partial: true, afterAction: pieceInfo?.afterAction === true })) === "full" || full;
    // ogni snapshot che lega i ref (lettura completa o risposta di un'azione con la pagina intera) aggiorna i ref dei record;
    // un pezzo che si somma alla mappa aggiunge i suoi a quelli della mappa
    if (state === "ok" && page && refs && pageUrl && (mode !== "partial" || newSnap?.obs === obsId)) {
      let base = [];
      // N5: solo se il pezzo si è davvero sommato alla mappa precedente (mai dopo un'azione)
      const merged = mode === "partial" && pieceInfo?.merged === true && newSnap?.partial && prevSnap?.obs && prevSnap.url === newSnap.url && (prevSnap.tab ?? null) === (newSnap.tab ?? null) && (prevSnap.family ?? null) === (newSnap.family ?? null);
      if (merged) {
        try { const lp0 = JSON.parse(readFileSync(lastPage, "utf8")); if (lp0?.obs === prevSnap.obs && prevSnap.url === newSnap.url) base = Array.isArray(lp0.record_refs) ? lp0.record_refs : []; } catch { base = []; }
      }
      writeFileAtomic(lastPage, JSON.stringify({ obs: obsId, record_refs: [...new Set([...base, ...recordRefs(page)])] }));
    }
    if (full && fullWarningOnce(dirname(file))) warn.push("registro dell'esplorazione pieno (20 MB): pagine non registrate da qui in poi");
  } catch (err) { warn.push(`registro dell'esplorazione non scritto (${String(err?.message ?? err).slice(0, 80)})`); }

  const errTag = errs.length ? errs.map((e) => e.code ?? e.raw_id).join(",") : "—";
  const line = `OBS ${code ?? "non registrata"} · surprise:${doc.surprise} novelty:${doc.novelty} · ERR:${errTag}${waste ? " · spreco: snapshot ripetuto della stessa pagina senza azione" : ""}`;
  // pagina grande in linea: l'uscita dello strumento MCP diventa il riassunto (il testo integrale è nel file della cattura)
  const hso = { hookEventName: "PostToolUse", additionalContext: digest ? `${line}\n${digest}` : line, ...(digestReplace ? { updatedMCPToolOutput: [{ type: "text", text: digest }] } : {}) };
  return { hookSpecificOutput: hso, ...(warn.length ? { systemMessage: `[jvc:observe-append] avviso: ${warn.join("; ")}` } : {}) };
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
