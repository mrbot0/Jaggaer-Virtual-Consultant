// Confronto fra lo snapshot osservato e l'`expect` del passo (§10.5, §13.1–13.5, §20.1): funzione
// pura, condivisa da step-check (K6.1) e observe-append (K6.2) — un solo confronto, nessuna copia.
// Nessun modulo esterno: è sul percorso caldo di observe-append. La classificazione compatibile /
// incompatibile (DT-016) la fa step-check: qui si nominano solo le divergenze.
//
//   compareExpect(step, page, { resolve, atlas, why, elapsedMs, timings, result })
//     → { page_signature, divergences: [{ kind, what, expected, observed, target?, priority? }],
//         novelties: [{ role, label }], confirmations: [], elements_seen: [], messages_seen: [], primary }
//
// Tipi di divergenza (§13.2 / DT-016): elemento-assente · stato-diverso · attributo-diverso ·
// elemento-in-piu · messaggio-inatteso · tempo-fuori-norma.
import { normLabel, pageSignature, normalizePath, slug, FIELD_ROLES } from "./snapshot-parse.mjs";
import { atlasMatch, roleCompatible, SEL_RE } from "./atlas.mjs";

export const DIVERGENCE_KINDS = ["elemento-assente", "stato-diverso", "attributo-diverso", "elemento-in-piu", "messaggio-inatteso", "tempo-fuori-norma"];
// Ordine per il tipo principale: il più grave secondo i pesi di DT-016.
const SEVERITY = ["elemento-assente", "stato-diverso", "messaggio-inatteso", "attributo-diverso", "tempo-fuori-norma", "elemento-in-piu"];
const MESSAGE_LIKE = new Set(["alert", "status", "alertdialog", "dialog", "log"]);
const SEEN_ROLES = new Set([...FIELD_ROLES, "button", "link"]);
const ATTRS = ["required", "disabled", "checked"];

// Target di un riferimento del piano: codice SEL → voce dell'Atlas; SEL non risolto o testo → letterale.
export function targetOf(ref, resolve) {
  if (ref && typeof ref === "object") {
    const base = ref.sel ? targetOf(ref.sel, resolve) : { label: ref.label ?? null, role: ref.role ?? null, code: null };
    return { ...base, ...(ref.label ? { label: ref.label } : {}), ...(ref.role ? { role: ref.role } : {}), spec: ref };
  }
  if (typeof ref !== "string") return { label: null, role: null, code: null };
  if (SEL_RE.test(ref)) {
    const e = resolve?.(ref) ?? null;
    return e ? { label: e.label, role: e.role, code: ref } : { label: ref, role: null, code: ref, unresolved: true };
  }
  return { label: ref, role: null, code: null };
}

// N1 (27/10/2026): nome normalizzato di ogni elemento, calcolato una volta per elenco di elementi (pagine di decine di
// migliaia di elementi: findElement, novità ed elementi visti non lo ricalcolano a ogni confronto). Si ricalcola se
// l'elenco cambia lunghezza.
const NORMS = new WeakMap();
export function elementNorms(page) {
  const els = Array.isArray(page?.elements) ? page.elements : null;
  if (!els) return [];
  const c = NORMS.get(els);
  if (c && c.length === els.length) return c;
  const out = els.map((e) => normLabel(e?.name));
  NORMS.set(els, out);
  return out;
}

export function findElement(page, t) {
  if (!t?.label) return null;
  const n = normLabel(t.label);
  const els = page?.elements ?? [];
  const ns = elementNorms(page);
  let any = null;
  for (let i = 0; i < els.length; i++) {
    if (ns[i] !== n) continue;
    if (roleCompatible(t.role, els[i].role)) return els[i];
    any ??= els[i];
  }
  return any;
}
const findMessage = (page, label) => {
  const n = normLabel(label);
  if (!n) return null;
  return (page?.messages ?? []).find((m) => normLabel(m.text).includes(n))
    ?? (() => { const els = page?.elements ?? []; const ns = elementNorms(page); const i = els.findIndex((e, j) => MESSAGE_LIKE.has(e.role) && ns[j].includes(n)); return i >= 0 ? els[i] : null; })();
};
const observedValue = (e) => (e.role === "checkbox" || e.role === "switch" || e.role === "radio" ? String(e.checked === true) : String(e.value ?? ""));
const sameValue = (exp, obs) => normLabel(String(exp)) === normLabel(String(obs));

export function matchPageSig(expected, page) {
  if (typeof expected !== "string" || !expected) return true;
  const [ePath, eFrag] = expected.split("#");
  const oPath = page?.url ? normalizePath(page.url) : null;
  if (oPath == null) return false;
  const p = ePath.replace(/^\/+|\/+$/g, "").toLowerCase();
  if (p && oPath !== p && !oPath.endsWith(`/${p}`)) return false;
  if (!eFrag) return true;
  const want = slug(eFrag);
  return (page.headings ?? []).some((h) => slug(h.text) === want || slug(h.text).startsWith(want));
}

// Parti verificabili di una voce di would_change_my_mind: testo fra virgolette, codici SEL, o la frase.
function wcmTokens(entry, resolve) {
  const s = String(entry ?? "");
  const out = [...s.matchAll(/"([^"]{3,})"|“([^”]{3,})”|«([^»]{3,})»/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  for (const c of s.match(/\b[SCL]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.SEL\.\d{4}\b/g) ?? []) { const e = resolve?.(c); if (e?.label) out.push(e.label); }
  return out.length ? out : [s];
}

export function compareExpect(step, page, { resolve = () => null, atlas = null, why = null, elapsedMs = null, timings = null, result, profile = "strict" } = {}) {
  const expect = step?.expect ?? {};
  const divergences = [];
  // WP07 giro 1 (spec I2): un attributo che il formato dello snapshot non espone è IGNOTO: si salta e si segnala
  const exposes = Array.isArray(page?.exposes) ? new Set(page.exposes) : null;
  const unverified = [];
  const known = (attr, el, label) => {
    const a = attr === "value" && el && ["checkbox", "switch", "radio"].includes(el.role) ? "checked" : attr;
    if (!exposes || exposes.has(a)) return true;
    unverified.push({ target: label ?? null, attr: a, format: page.format });
    return false;
  };
  const confirmations = [];
  const expectedLabels = new Set();
  const perLabel = new Map();
  const add = (d) => { divergences.push(d); if (d.target) perLabel.set(normLabel(d.target), d); };

  if (expect.page_sig !== undefined) {
    if (matchPageSig(expect.page_sig, page)) confirmations.push(`page_sig:${expect.page_sig}`);
    else add({ kind: "stato-diverso", what: "page_sig", expected: expect.page_sig, observed: pageSignature(page) });
  }

  for (const ref of Array.isArray(expect.elements) ? expect.elements : []) {
    const t = targetOf(ref, resolve);
    if (t.label) expectedLabels.add(normLabel(t.label));
    const spec = t.spec ?? {};
    const el = findElement(page, t) ?? (MESSAGE_LIKE.has(t.role) ? findMessage(page, t.label) : null);
    if (spec.present === false) {
      if (el) add({ kind: "elemento-in-piu", what: "element", expected: "assente", observed: t.label, target: t.label });
      continue;
    }
    if (!el) { add({ kind: "elemento-assente", what: "element", expected: t.code ?? t.label, observed: null, target: t.label }); continue; }
    let ok = true;
    for (const a of ATTRS) {
      if (spec[a] === undefined || !known(a, el, t.label)) continue;
      const obs = el[a] === true;
      if (Boolean(spec[a]) !== obs) { ok = false; add({ kind: "attributo-diverso", what: a, expected: Boolean(spec[a]), observed: obs, target: t.label }); }
    }
    if (spec.value !== undefined && known("value", el, t.label) && !sameValue(spec.value, observedValue(el))) { ok = false; add({ kind: "stato-diverso", what: "value", expected: spec.value, observed: observedValue(el), target: t.label }); }
    if (ok) confirmations.push(t.code ?? t.label);
  }

  const target = step?.target !== undefined && typeof step.target === "string" ? targetOf(step.target, resolve) : null;
  if (target?.label) expectedLabels.add(normLabel(target.label));
  if (expect.value !== undefined) {
    const el = target ? findElement(page, target) : null;
    if (!el) add({ kind: "elemento-assente", what: "value", expected: target?.code ?? target?.label ?? null, observed: null, target: target?.label ?? "target" });
    else if (!known("value", el, target.label)) { /* ignoto nel formato */ }
    else if (!sameValue(expect.value, observedValue(el))) add({ kind: "stato-diverso", what: "value", expected: expect.value, observed: observedValue(el), target: target.label });
    else confirmations.push(`${target.code ?? target.label}=${expect.value}`);
  }

  if (Array.isArray(expect.options)) {
    const opts = (page?.elements ?? []).filter((e) => e.role === "option").map((e) => e.name);
    const want = expect.options.map(String);
    for (const o of opts) if (!want.some((w) => sameValue(w, o))) add({ kind: "elemento-in-piu", what: "option", expected: want, observed: o, target: target?.label ?? "options" });
    for (const w of want) if (!opts.some((o) => sameValue(w, o))) add({ kind: "elemento-assente", what: "option", expected: w, observed: null, target: w });
  }

  // messaggi: attesi (messages, toast) e osservati; ogni messaggio non previsto è una divergenza
  const expMsgs = (Array.isArray(expect.messages) ? expect.messages : []).map((m) => targetOf(m, resolve).label).filter(Boolean);
  const toast = expect.toast !== undefined ? targetOf(expect.toast, resolve) : null;
  const observed = (page?.messages ?? []).map((m) => m.text);
  const covers = (exp, msg) => { const a = normLabel(exp); const b = normLabel(msg); return a && b && (b.includes(a) || a.includes(b)); };
  for (const m of observed) {
    if (!expMsgs.some((e) => covers(e, m)) && !(toast?.label && covers(toast.label, m))) add({ kind: "messaggio-inatteso", what: "message", expected: expMsgs, observed: m });
  }
  for (const e of expMsgs) if (!observed.some((m) => covers(e, m))) add({ kind: "elemento-assente", what: "message", expected: e, observed: null });
  if (toast) {
    if (toast.label && (observed.some((m) => covers(toast.label, m)) || findMessage(page, toast.label))) confirmations.push(`toast:${toast.code ?? toast.label}`);
    else add({ kind: "elemento-assente", what: "toast", expected: toast.code ?? toast.label, observed: null });
  }

  if (expect.result !== undefined) {
    if (result == null) add({ kind: "elemento-assente", what: "result", expected: expect.result, observed: null });
    else if (!sameValue(expect.result, result)) add({ kind: "stato-diverso", what: "result", expected: expect.result, observed: result });
    else confirmations.push(`result:${result}`);
  }

  const limit = Number.isFinite(expect.max_ms) ? expect.max_ms : Number.isFinite(step?.timeout_ms) ? step.timeout_ms : null;
  const took = Number.isFinite(elapsedMs) ? elapsedMs : Number.isFinite(timings?.load_ms) ? timings.load_ms : null;
  if (limit != null && took != null && took > limit) add({ kind: "tempo-fuori-norma", what: "timing", expected: limit, observed: took });

  // would_change_my_mind (§17.5): l'osservazione che ribalterebbe la decisione ⇒ sorpresa prioritaria
  const pool = [...elementNorms(page), ...[...observed, ...(page?.texts ?? [])].map(normLabel)];
  for (const entry of Array.isArray(why?.would_change_my_mind) ? why.would_change_my_mind : []) {
    const hit = wcmTokens(entry, resolve).map(normLabel).find((tok) => tok.length >= 4 && pool.some((p) => p.includes(tok)));
    if (hit) {
      const inMsg = observed.map(normLabel).some((m) => m.includes(hit));
      divergences.unshift({ kind: inMsg ? "messaggio-inatteso" : "elemento-in-piu", what: "would_change_my_mind", expected: entry, observed: hit, priority: true });
    }
  }

  // novità (§13.5): campi mai menzionati — né nell'expect né nell'Atlas dello scope
  // N1: un solo passaggio sugli elementi con il nome normalizzato una volta; le novità per etichetta in un Set
  const els = page?.elements ?? [];
  const ns = elementNorms(page);
  const novelties = [];
  const novel = new Set();
  if (Array.isArray(atlas)) {
    for (let i = 0; i < els.length; i++) {
      const e = els[i];
      if (!FIELD_ROLES.has(e.role) || !e.name) continue;
      if (expectedLabels.has(ns[i]) || atlasMatch(atlas, e, { norm: ns[i] })) continue;
      novelties.push({ role: e.role, label: e.name });
      novel.add(ns[i]);
    }
  }

  const elements_seen = [];
  for (let i = 0; i < els.length; i++) {
    const e = els[i];
    if (!SEEN_ROLES.has(e.role) || !e.name) continue;
    const m = Array.isArray(atlas) ? atlasMatch(atlas, e, { norm: ns[i] }) : null;
    const d = perLabel.get(ns[i]);
    const o = { role: e.role, label: e.name };
    for (const a of ATTRS) if (e[a] !== undefined) o[a] = e[a];
    if (e.value !== undefined) o.value = e.value;
    o.atlas_match = m?.code ?? null;
    if (d) { o.expected = d.expected; o.surprise = true; o.divergence = d.kind; }
    if (novel.has(ns[i])) o.novelty = true;
    elements_seen.push(o);
  }

  const primary = divergences.find((d) => d.priority) ?? [...divergences].sort((a, b) => SEVERITY.indexOf(a.kind) - SEVERITY.indexOf(b.kind))[0] ?? null;
  return { page_signature: pageSignature(page, { profile }), unverified, divergences, novelties, confirmations, elements_seen, messages_seen: observed, primary };
}
