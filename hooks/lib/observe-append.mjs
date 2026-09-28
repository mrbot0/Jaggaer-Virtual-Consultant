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
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadHookState, sessionDir } from "./workspace.mjs";
import { classify, isBrowserTool } from "./browser-tools.mjs";
import { responseState } from "./browser-origin.mjs";
import { nextObserved } from "./observed-origin.mjs";
import { updateSessionFile } from "./session-state.mjs";
import { writeFileAtomic } from "./fsx.mjs";
import { parseSnapshot, responseText, responseHasImage } from "../../scripts/chrome/snapshot-parse.mjs";
import { compareExpect } from "../../scripts/chrome/expect-compare.mjs";
import { resolveSel, atlasIndex, atlasMatch, fieldSensitivity } from "../../scripts/chrome/atlas.mjs";
import { detectErrors } from "../../scripts/chrome/errors.mjs";
import { profileFor, redactText, freeText } from "../../scripts/chrome/redact.mjs";
import { toYaml } from "../../scripts/lib/yaml-lite.mjs";

const SNAPSHOT_OPS = new Set(["take_snapshot", "read_page", "get_page_text", "find", "browser_snapshot", "browser_find"]);
const SCREENSHOT_OPS = new Set(["take_screenshot", "browser_take_screenshot", "upload_image"]);
const MAX_ELEMENTS = 60;
const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
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
export async function buildObservation({ ws, customer, session, call, state, resp, env = process.env, now = new Date() }) {
  const text = responseText(resp);
  const kind = obsKind(call, state, text);
  const profile = profileFor({ envType: session.env?.type ?? null });
  const page = text && kind !== "error" ? parseSnapshot(text) : null;
  const hasPage = !!page && (page.format !== "text" || kind === "snapshot");
  const scope = session.scope ?? "XSC";
  const atlas = hasPage ? atlasIndex(ws, customer, session.scope) : [];
  const ap = session.active_plan ?? null;
  let cmp = null;
  if (hasPage && kind === "snapshot" && ap) {
    const st = await activeStep(ws, customer, ap);
    if (st) cmp = compareExpect(st.step, page, { resolve: (c) => resolveSel(ws, c, customer), atlas });
  }
  const sensitiveCache = new Map();
  const sensitive = (m) => {
    if (!m?.field) return false;
    if (!sensitiveCache.has(m.field)) sensitiveCache.set(m.field, fieldSensitivity(ws, m.field, customer)?.sensitive === true);
    return sensitiveCache.get(m.field);
  };
  const masks = new Set();
  const ft = (s) => { const r = freeText(s, { profile, env }); r.masks.forEach((x) => masks.add(x)); return r.text; };
  const seen = (cmp?.elements_seen ?? (hasPage ? compareExpect({ expect: {} }, page, { atlas }).elements_seen : [])).slice(0, MAX_ELEMENTS).map((e) => {
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
    page_signature: cmp?.page_signature ?? (hasPage ? (await import("../../scripts/chrome/snapshot-parse.mjs")).pageSignature(page) : null),
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
  return { doc, errors, scope, profile };
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
        db.prepare("insert into observations(code, session, scope, page_sig, payload, confirmed_count) values (?,?,?,?,?,?)")
          .run(code, doc.session, scope, doc.page_signature, JSON.stringify(doc), confirmed);
        return { code, errs };
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
  const { doc, errors, scope } = await buildObservation({ ws: st.ws, customer: st.customer, session: st.session, call, state, resp, env, now });
  const { code, errs } = await writeDb(st.ws, st.customer, scope, doc, errors, now);
  const dir = join(st.ws, "customers", st.customer, "observations");
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, `${code}.yaml`), toYaml({ id: code, ...doc }));
  for (const e of errs) writeErrFile(st.ws, e, doc, scope, now);

  // 3. registro di sessione: ultima osservazione, spreco (snapshot ripetuti senza azione)
  let waste = false;
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
    s.ledger.observe = { ...o, last_obs: code, last_kind: doc.kind, last_page_sig: doc.page_signature ?? null, count: (o.count ?? 0) + 1 };
    return s;
  });
  try {
    appendFileSync(join(sessionDir(st.ws, st.customer, st.sid), "observations.jsonl"), `${JSON.stringify({ kind: obsKindForLedger, page_sig: doc.page_signature, obs: code, ts: doc.ts })}\n`);
  } catch { /* il registro jsonl è di comodo per self-check --observations */ }

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
