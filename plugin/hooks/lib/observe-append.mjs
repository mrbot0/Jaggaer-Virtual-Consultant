// observe-append (K6.2, §20.1, §20.6, §29.6, §44.4, §54.2): PostToolUse sugli strumenti MCP del browser.
// Ogni risultato del browser diventa un'OBS (una per chiamata, non omissibile): codice L.<C>.<S>.OBS.nnnn
// dal SEQ del DB, firma della pagina, elementi visti con atlas_match, messaggi, surprise/novelty rispetto
// all'expect del passo attivo (stesso confronto di step-check), errori della piattaforma ⇒ ERR grezzo in
// kb/scopes/<S>/errors/_raw/ + riga errors_raw (count a ogni ripetizione), redazione ALLA CATTURA.
// Mantiene session.browser.current_url dalla pagina OSSERVATA (hooks/lib/observed-origin.mjs, fail-closed).
// Spreco (§29.10): snapshot della stessa pagina senza azione in mezzo ⇒ voce in session.ledger.waste.
// Non è un guard: fail-OPEN con avviso, mai un blocco; ma un guasto azzera l'URL corrente (mai
// un'origine non confermata). additionalContext: `OBS <code> · surprise:<n> novelty:<n> · ERR:<code?>`.
import { mkdirSync, appendFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { loadHookState, sessionDir } from "./workspace.mjs";
import { classify, isBrowserTool } from "./browser-tools.mjs";
import { responseState, landedUrl } from "./browser-origin.mjs";
import { tabKey, callKey, settlePending, historyFile, loadHistory, saveHistory, clearedBy, updateHistory, bindable, pendingFile, loadPending, savePending } from "./ref-history.mjs";
import { nextObserved, observedLocation } from "./observed-origin.mjs";
import { isPageTextOp } from "./origin-markers.mjs";
import { updateSessionFile } from "./session-state.mjs";
import { writeFileAtomic, withFileLock } from "./fsx.mjs";
import { parseSnapshot, responseText, responseHasImage, normLabel } from "../../scripts/chrome/snapshot-parse.mjs";
import { compareExpect } from "../../scripts/chrome/expect-compare.mjs";
import { resolveSel, atlasIndex, atlasMatch, fieldSensitivity } from "../../scripts/chrome/atlas.mjs";
import { detectErrors } from "../../scripts/chrome/errors.mjs";
import { profileFor, redactText, freeText } from "../../scripts/chrome/redact.mjs";
import { toYaml } from "../../scripts/lib/yaml-lite.mjs";
import { pageRecord, clickRecord, appendAtlasLog, atlasLogFile, recordRefs } from "./atlas-log.mjs";

const SNAPSHOT_OPS = new Set(["take_snapshot", "read_page", "get_page_text", "find", "browser_snapshot", "browser_find"]);
const SCREENSHOT_OPS = new Set(["take_screenshot", "browser_take_screenshot", "upload_image"]);
const MAX_ELEMENTS = 60;
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
//               nota di troncamento; take_snapshot di DevTools con sole chiavi previste; browser_snapshot di Playwright
//               senza target né depth;
//  "partial"  — find di Claude e di Playwright, letture ristrette o troncate, chiavi non previste, ogni browser_batch
//               che legge l'albero: non legano MAI e azzerano la mappa della pagina;
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
// Etichetta di un ref per la storia della pagina (ruolo + nome normalizzato), compatta.
const labelKey = (e) => sha(`${e.role ?? ""}\u0001${normLabel(e.name ?? "")}`).slice(0, 16);
const ONE_READ_ENVS = new Set(["sandbox", "dev"]);
const LABELS_MAX = 2000;

// Costruisce l'OBS (senza codice) dalla chiamata: pura rispetto al file system tranne Atlas e piano.
export async function buildObservation({ ws, customer, session, call, state, resp, ti = null, env = process.env, now = new Date() }) {
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
  const seen = (cmp?.elements_seen ?? (hasPage ? compareExpect({ expect: {} }, page, { atlas, profile }).elements_seen : [])).slice(0, MAX_ELEMENTS).map((e) => {
    const m = e.atlas_match ? atlas.find((a) => a.code === e.atlas_match) : atlasMatch(atlas, { name: e.label, role: e.role });
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
    labels = (page.elements ?? []).filter((e) => e.ref != null && e.ref !== "").slice(0, LABELS_MAX).map((e) => [String(e.ref), labelKey(e)]);
    if (labels.length) labelLoc = loc ?? observedLocation(call.family, text, { asked, resp });
  }
  // F0.1: nome (redatto, ≤ 80 caratteri) di ogni ref della risposta, per guard-destructive: il bersaglio di un click
  // o di un input si riconosce anche quando la chiamata nomina solo l'uid/ref (dato, mai istruzione)
  const names = {};
  if (page && state === "ok") {
    for (const e of page.elements ?? []) {
      if (e.ref == null || e.ref === "" || Object.keys(names).length >= 300) continue;
      if (typeof e.name === "string" && e.name.trim()) names[String(e.ref)] = ft(e.name).slice(0, 80);
    }
  }
  const binds = mode === "complete" || (mode === null && call.family !== "claude-browser");
  if (binds && loc?.url && (page.elements ?? []).some((e) => e.ref)) {
    pageUrl = loc.url;
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
    const unbound = (r) => {
      const re = tokenRe(r);
      if (Math.max(count[r] ?? 0, (text.match(re) ?? []).length) !== 1) return true;
      return quoted.some((q) => { re.lastIndex = 0; return re.test(q); });
    };
    refs = {};
    for (const e of page.elements) {
      if (!e.ref || Object.keys(refs).length >= 300) continue;
      refs[String(e.ref)] = page.formatMismatch || unbound(String(e.ref)) ? null : atlasMatch(atlas, e, { page: doc.page_signature })?.code ?? null;
    }
  }
  return { doc, errors, scope, profile, cfgObject, refs, pageUrl, mode, labels, labelLoc, asked, text, names, page };
}

// Nuovo stato del legame ref ↔ SEL in session.browser e della storia dei ref dopo la chiamata (puro: copie).
// WP07 giro 4 (I-A):
//  - lettura parziale, find, batch di lettura, navigazione o cambio di scheda di Claude ⇒ mappa della pagina azzerata
//    ({}), catena rotta;
//  - Claude in prod/preprod (e ambiente ignoto): un ref si lega solo se due letture complete CONSECUTIVE della stessa
//    pagina e scheda lo associano allo stesso SEL (cand della lettura precedente); in sandbox/dev basta una lettura.
// WP07 giro 5 (I-A'): la storia delle etichette è PER SCHEDA e persistente (hooks/lib/ref-history.mjs), in tutte e tre
// le famiglie: si azzera solo con un navigate a un nuovo documento o la chiusura di quella scheda; un ref visto con
// un'altra etichetta, o la prima volta fuori da una lettura completa, non si lega più; la voce obs_pending della
// chiamata (scritta da browser-origin) si chiude qui, nella stessa scrittura.
// Firma del giro 4 nextBinding(b, opts) → browser ancora accettata (storia vuota); altrimenti → { browser, hist }.
export function nextBinding(b, hist, opts) {
  if (opts === undefined && hist && typeof hist === "object" && "call" in hist) return nextBinding(b, null, hist).browser;
  const { call, obs, ts, envType, mode, refs, pageUrl, labels = [], labelLoc = null, asked = null, cleared = [], key = null, names = null } = opts;
  const out = { ...b };
  delete out.ref_labels;   // storia del giro 4 (un solo posto in session.json): sostituita dal file per scheda
  const tab = asked != null ? String(asked) : null;
  const claudeNav = call.family === "claude-browser" && (call.actions ?? [call]).some((a) => a.kind === "navigate" || a.switches);
  if (mode === "partial" || claudeNav) {
    if (out.snapshot) out.snapshot = { obs: out.snapshot.obs, url: out.snapshot.url ?? null, tab: out.snapshot.tab ?? null, ts, refs: {}, cleared_by: String(call.op ?? call.tool ?? "") };
  }
  // schede della storia: quella chiesta e quella del marcatore del server (se diverse, entrambe); nessuna ⇒ ignota
  const tabs = [...new Set([tab, labelLoc?.tab != null ? String(labelLoc.tab) : null].filter((t) => t != null))];
  const keys = tabs.length ? tabs.map((t) => tabKey(call.family, t)) : [tabKey(call.family, null)];
  const complete = !!(refs && pageUrl);
  const h = updateHistory(hist ?? { v: 1, tabs: {} }, { cleared: cleared.map((c) => c.key), keys, labels, complete, url: labelLoc?.url ?? null });
  if (refs && pageUrl) {
    const label = new Map();
    for (const [r, k] of labels) label.set(r, label.has(r) && label.get(r) !== k ? "!" : k);
    const bound = { ...refs };
    for (const r of Object.keys(bound)) if (bound[r] != null && !keys.every((k) => bindable(h, k, r, label.get(r)))) bound[r] = null;
    if (call.family === "claude-browser") {
      const cand = Object.fromEntries(Object.entries(bound).filter(([, v]) => v != null));
      if (!ONE_READ_ENVS.has(envType)) {
        const prev = out.snapshot;
        const chain = prev && prev.family === "claude-browser" && prev.cand && typeof prev.cand === "object" && prev.url === pageUrl && (prev.tab ?? null) === tab ? prev.cand : null;
        for (const r of Object.keys(bound)) if (bound[r] != null && (!chain || chain[r] !== bound[r])) bound[r] = null;
      }
      out.snapshot = { obs, url: pageUrl, tab, ts, refs: bound, family: "claude-browser", cand };
    } else {
      out.snapshot = { obs, url: pageUrl, tab, ts, refs: bound };
    }
    if (names && typeof names === "object") out.snapshot.names = Object.fromEntries(Object.entries(names).filter(([r]) => Object.hasOwn(bound, r)));
  }
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

export async function record(input, env = process.env, { now = new Date() } = {}) {
  const tool = String(input.tool_name ?? "");
  if (!isBrowserTool(tool)) return null;
  const st = loadHookState(input, env);
  if (!st.jvc || !st.session || !st.sessionFile) return null;
  const call = classify(tool, input.tool_input);
  const resp = input.tool_response;
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
  const { doc, errors, scope, cfgObject, refs, pageUrl, mode, labels, labelLoc, asked, text, names, page } = await buildObservation({ ws: st.ws, customer: st.customer, session: st.session, call, state, resp, ti: input.tool_input, env, now });
  const { code, errs, payload } = await writeDb(st.ws, st.customer, scope, doc, errors, now);
  const dir = join(st.ws, "customers", st.customer, "observations");
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, `${code}.yaml`), toYaml({ id: code, ...doc }));
  for (const e of errs) writeErrFile(st.ws, e, doc, scope, now);

  // 3. registro di sessione: ultima osservazione, spreco (snapshot ripetuti senza azione)
  let waste = false;
  const key = callKey(input);
  // storia del browser del cliente (sopravvive alla sessione: la mappa dei ref dell'estensione sopravvive a lei)
  const histFile = historyFile(join(st.ws, "customers", st.customer, ".sessions"));
  const pendFile = pendingFile(join(st.ws, "customers", st.customer, ".sessions"));
  // schede azzerate: navigate riuscito (marcatore positivo di arrivo) a un nuovo documento, o chiusura della scheda
  const cleared = clearedBy(call, { ok: state === "ok", landedTab: labelLoc?.tab ?? observedLocation(call.family, text, { asked, resp })?.tab ?? null,
    landed: (a) => !!landedUrl(call.family, text, { asked: a.tab ?? null, resp }) });
  const obsKindForLedger = doc.kind === "navigate" || doc.kind === "action" ? "action" : doc.kind;
  updateSessionFile(st.sessionFile, (s) => {
    const o = s.ledger.observe ?? {};
    if (doc.kind === "snapshot" && doc.page_signature) {
      if (o.snapshot_sig === doc.page_signature) {
        waste = true;
        s.ledger.waste = [...(Array.isArray(s.ledger.waste) ? s.ledger.waste : []), { kind: "repeated-snapshot", page_sig: doc.page_signature, obs: code, at: doc.ts, ...(doc.at_step ? { plan: doc.at_step.plan, step: doc.at_step.n } : {}) }];
      }
      o.snapshot_sig = doc.page_signature;
    } else if (obsKindForLedger === "action" || doc.kind === "error") o.snapshot_sig = null;
    // ultimo snapshot osservato: vale solo per la pagina (URL) e la scheda su cui è stato preso (WP07 giro 4: letture
    // parziali e find azzerano la mappa, due letture consecutive per Claude in prod/preprod); WP07 giro 5: storia dei
    // ref per scheda nel file della sessione, aggiornata sotto lo stesso lock di session.json, e chiusura della voce
    // obs_pending di questa chiamata (se questa scrittura non avviene, la voce resta e i guard non legano)
    // lock della storia dentro quello di session.json (stesso ordine per tutte le sessioni del cliente)
    s.browser = withFileLock(`${histFile}.lock`, () => {
      const r = nextBinding(s.browser ?? {}, loadHistory(histFile), { call, obs: code, ts: doc.ts, envType: s.env?.type ?? null, mode, refs, pageUrl, labels, labelLoc, asked, cleared, key, names });
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
    s.ledger.observe = { ...o, last_obs: code, last_kind: doc.kind, last_page_sig: doc.page_signature ?? null, count: (o.count ?? 0) + 1 };
    return s;
  });
  try {
    appendFileSync(join(sessionDir(st.ws, st.customer, st.sid), "observations.jsonl"), `${JSON.stringify({ kind: obsKindForLedger, page_sig: doc.page_signature, obs: code, ts: doc.ts })}\n`);
  } catch { /* il registro jsonl è di comodo per self-check --observations */ }

  // 4. soluzione A (spec §A1): registro di sola struttura per atlas-build — fail-open, mai un blocco
  try {
    const file = atlasLogFile(st.ws, st.customer, st.sid);
    const lastPage = join(dirname(file), "last-page.json");
    let full = false;
    // prima i click (si riferiscono alla pagina precedente), poi la pagina di questa risposta; revisione finale (I4): un
    // click su un elemento dentro un record (riga, cella) della pagina precedente non si registra
    const clicked = state === "ok" ? (call.actions ?? [call]).filter((a) => a.kind === "click" && !a.submits && Array.isArray(a.targets) && a.targets.length) : [];
    if (clicked.length) {
      let rec = new Set();
      try { rec = new Set(JSON.parse(readFileSync(lastPage, "utf8")).record_refs ?? []); } catch { /* nessuna pagina registrata */ }
      for (const a of clicked) {
        const ref = String(a.targets[0]);
        const name = prevSnap?.names?.[ref];
        if (name && !rec.has(ref)) full = appendAtlasLog(file, clickRecord({ fromSig: prevSig, name, ts: doc.ts })) === "full" || full;
      }
    }
    if (state === "ok" && mode === "complete" && pageUrl && page) {
      full = appendAtlasLog(file, pageRecord(page, { pageSig: doc.page_signature, profile: doc.redaction.profile, env, ts: doc.ts })) === "full" || full;
      writeFileAtomic(lastPage, JSON.stringify({ record_refs: recordRefs(page) }));
    }
    if (full) warn.push("registro dell'esplorazione pieno (20 MB): pagine non registrate");
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
