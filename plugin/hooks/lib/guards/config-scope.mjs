// guard-config-scope (PreToolUse, FAIL-CLOSED) — §28.1, §29.6, §52.2, §44.4.
//
// Strumenti MCP del browser: attivo quando il passo attivo del piano ha verbo
// SAVE|SUBMIT|TOGGLE|UPLOAD|DELETE o classe ACT-CFG-CHANGE|SUBMIT|APPROVE|TRANSMIT|
// PUBLISH|BULK|CREATE|UPDATE|CLOSE|UPLOAD|DELETE e la chiamata ha un effetto (input,
// click, upload, invio, dialog accettato; script e strumenti non classificati
// durante un passo con effetto ⇒ deny). Richiede, nell'ordine:
//   (c) perimetro (ACT-CFG-CHANGE): livello DT-007 del passo in config_levels
//       dell'ambiente (rosso in prod solo per oggetti in prod_allowed_red) e
//       oggetto/area elencati in remediation-scope.yaml a quel livello;
//   (a) compensazione registrata per i passi CREATE/UPDATE/SUBMIT/BULK/DELETE che salvano o cancellano (§29.6); per
//       ACT-DELETE deve essere un restore con ref alla lettura completa dell'oggetto salvata nel run (spec 2026-10-06 §3.7);
//   (b) ACT-CFG-CHANGE: snapshot degli oggetti governati negli ultimi 60 s;
//   (d) approvazioni per livello e ambiente — sandbox/preprod: verde 1 (A1) ·
//       giallo 2 (A1 + A3 del passo, §57.2) · rosso 3 (A1 + A2 + A3); prod: sempre
//       3A; azioni R2 sui dati: il "sì" alla richiesta del passo; ACT-BULK: A1 + A3;
//       ogni approvazione confermata nel transcript (messaggio dell'utente);
//   (e) il token del passo (A3 o action) consumato qui, monouso, quando consente.
// Senza piano attivo in modalità config: ogni azione con effetto è negata.
//
// Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit: nega le scritture su
// approvals.jsonl, session.json, .jvc/** e sul transcript (e la sua cartella),
// per la sessione principale e per i sub-agenti, riusando l'analisi dei comandi
// di guard-scope (shellWriteTargets). Unica eccezione: `node <plugin>/scripts/…`
// senza metacaratteri di shell. Rischio residuo documentato: un interprete che
// costruisce il nome del file a runtime (node -e con stringhe calcolate) sfugge
// all'analisi; per questo il token vale solo se la frase è anche nel transcript.
import { dirname, resolve, join, basename, sep, isAbsolute } from "node:path";
import { readFileSync, statSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { intersects, resolveTarget, bases, PathPolicyError } from "../paths.mjs";
import { guarded, denyAudited, targetsOf, allRels, shellWriteTargets, subtree, SHELL_TOOLS } from "./common.mjs";
import { browserGuarded, declaredEnv, claudeEffectRefusal } from "./browser.mjs";
import { activeStep } from "./plan-step.mjs";
import { ACT, envColumn, stepLevel, stepRisk } from "../act-classes.mjs";
import { approvalsFile, readApprovals, windowState, confirmInTranscript, consumeStepToken, phraseOf, exploreRecord, EXPLORE_PHRASE } from "../../../scripts/admin/approvals.mjs";
import { appendAudit } from "../audit.mjs";
import { confirmedAutonomyLevel } from "../autonomy.mjs";
import { updateSessionFile as updateSessionFast } from "../session-state.mjs";
import { pendingRefusal, mergedPending, loadPending, pendingFile } from "../ref-history.mjs";
import { simpleNodeCall } from "../exact-argv.mjs";

const G = "guard-config-scope";
export const COMMIT_VERBS = new Set(["SAVE", "SUBMIT", "TOGGLE", "UPLOAD", "DELETE"]);
export const GUARDED_CLASSES = new Set(["ACT-CFG-CHANGE", "ACT-SUBMIT", "ACT-APPROVE", "ACT-TRANSMIT", "ACT-PUBLISH", "ACT-BULK", "ACT-CREATE", "ACT-UPDATE", "ACT-CLOSE", "ACT-UPLOAD", "ACT-DELETE"]);
const COMP_CLASSES = new Set(["ACT-CREATE", "ACT-UPDATE", "ACT-SUBMIT", "ACT-BULK", "ACT-DELETE"]);
const R2_DATA = new Set(["ACT-SUBMIT", "ACT-APPROVE", "ACT-TRANSMIT", "ACT-PUBLISH", "ACT-UPLOAD", "ACT-CLOSE"]);
const SNAPSHOT_MS = 60000;
export const isEffectful = (a) => ["input", "click", "upload", "script", "other"].includes(a.kind) || (a.kind === "dialog" && a.submits) || a.submits === true;

// Approvazioni richieste per il passo → { a1, a2, a3, action }. Esportata per step-check (K6.1),
// che chiede le approvazioni (pending.approvals) PRIMA del passo con la stessa regola del guard.
// Ops veloce (spec 2026-10-06 §2.2, §3.4): dipende dal livello di autonomia; senza livello vale "basso" (= regole di prima).
export function requiredApprovals(cls, step, env, level, autonomy = "basso") {
  const none = { a1: false, a2: false, a3: false, action: false };
  if (env.type === "prod") {
    if (ACT[cls]?.prod !== "approval") return none;
    const second = env.policy?.second_approver_required ?? true;
    return { a1: true, a2: second, a3: true, action: false };
  }
  const sandbox = env.type !== "preprod";
  if (cls === "ACT-CFG-CHANGE") {
    if (autonomy === "alto") return { ...none, a1: true, a2: !!env.policy?.second_approver_required };
    const n = env.policy?.approvals?.[`config_${level}`] ?? 3;
    return { a1: n >= 1, a2: n >= 3, a3: n >= 2, action: false };
  }
  if (cls === "ACT-BULK") return autonomy === "alto" ? none : { ...none, a1: true, a3: true };
  if (cls === "ACT-DELETE") return autonomy === "alto" ? { ...none, a1: true } : { ...none, a1: true, a3: true };
  if (R2_DATA.has(cls) && ["R2", "R3"].includes(stepRisk(step))) {
    if (autonomy === "basso") return { ...none, action: true };
    return sandbox ? none : { ...none, a1: true };
  }
  return none;
}

// WP09b: oggetti governati di un passo di configurazione (config.object + config.governs, senza duplicati).
export function governedObjects(step) {
  const c = step?.config ?? {};
  return [...new Set([c.object, ...(Array.isArray(c.governs) ? c.governs : [])].filter((x) => typeof x === "string" && x))];
}
// Una voce di session.snapshots copre il passo se elenca tutti i suoi oggetti governati, ciascuno con un'osservazione
// verificata (giro 1, C1): observe-append (un oggetto, l'OBS che ha legato la pagina al SEL del passo) o kb snapshot
// (un'OBS verificata sul DB per ogni oggetto). Un passo di sola area vale solo con una voce di observe-append per l'area
// (scritta sulla pagina che mostra l'elemento del passo): uno snapshot di sola area di kb snapshot non registra stato.
const OBS_CODE = /^L\.[A-Z0-9]{4}\.[A-Z0-9]{3}\.OBS\.\d{4}$/;
function observed(entry) {
  const objs = Array.isArray(entry?.objects) ? entry.objects : [];
  if (entry?.source === "observe-append") return typeof entry.obs === "string" && OBS_CODE.test(entry.obs) && objs.length <= 1;
  if (entry?.source === "kb-snapshot") return objs.length >= 1 && Array.isArray(entry.obs) && entry.obs.length === objs.length && entry.obs.every((o) => OBS_CODE.test(String(o)));
  return false;
}
export function snapshotCovers(entry, step) {
  if (!observed(entry)) return false;
  const governed = governedObjects(step);
  if (governed.length) return governed.every((o) => entry.objects.includes(o));
  const area = step?.config?.area;
  return !!area && entry.source === "observe-append" && Array.isArray(entry.areas) && entry.areas.includes(area);
}

// Nessun piano attivo (giro di correzione 1, I2): ogni azione con effetto è
// negata in ogni ambiente. Unica eccezione la modalità `esplorazione` (use mode),
// solo in sandbox: click e input consentiti e in audit; invio, salvataggio,
// upload, conferma di dialog, script e strumenti non classificati mai.
// Soluzione B (30/09/2026, richiesta dell'utente): in pre-produzione, con ESPLORA PREPROD, solo click e solo su
// elementi dell'ultimo snapshot completo della pagina corrente il cui nome non è un'azione con effetto.
import { EFFECT_LABEL, DELETE_LABEL, isDeleteLabel, isDeleteQuestion } from "../effect-labels.mjs";
export { EFFECT_LABEL, DELETE_LABEL };
function preprodClickRefusal(ctx) {
  const snap = ctx.session?.browser?.snapshot;
  for (const a of ctx.actions.filter(isEffectful)) {
    if (a.kind !== "click" || a.submits) return `esplorazione in pre-produzione: consentiti solo click, mai input, invio, salvataggio, upload, conferma di dialog, script (${a.op ?? a.tool ?? ctx.tool})`;
    const refs = Array.isArray(a.targets) ? a.targets : [];
    if (!refs.length || a.untargeted) return `esplorazione in pre-produzione: click senza uid dell'ultimo snapshot (${a.op ?? a.tool ?? ctx.tool})`;
    if (!snap || !snap.names || typeof snap.names !== "object") return "esplorazione in pre-produzione: nessuno snapshot completo della pagina: esegui take_snapshot prima del click";
    if (!ctx.session.browser.current_url || snap.url !== ctx.session.browser.current_url) return "esplorazione in pre-produzione: l'ultimo snapshot non è della pagina corrente: rifai take_snapshot";
    if (String(snap.tab ?? "") !== String(a.tab ?? "")) return "esplorazione in pre-produzione: l'ultimo snapshot è di un'altra scheda: rifai take_snapshot";
    for (const r of refs) {
      const name = Object.hasOwn(snap.names, r) ? String(snap.names[r] ?? "") : null;
      if (!name || !name.trim()) return `esplorazione in pre-produzione: l'elemento ${r} non ha un nome nell'ultimo snapshot (assente o senza etichetta): non si può verificare che sia senza effetto`;
      if (EFFECT_LABEL.test(name)) return `esplorazione in pre-produzione: "${name}" è un'azione con effetto (salva, invia, conferma, approva…): mai senza un piano approvato`;
    }
  }
  return null;
}

// Esplorazione completa (ESPLORA <AMBIENTE> COMPLETA, sandbox e pre-produzione): click, input (valori di prova), invio,
// salvataggio, conferma dei dialoghi; MAI cancellazioni (etichetta dell'ultimo snapshot), upload di file, script o
// strumenti non classificati. Un click deve avere un uid con nome nell'ultimo snapshot della pagina corrente (un'icona
// senza nome potrebbe essere un cestino).
// Revisione di sicurezza (05/10/2026): C1 nomi completi normalizzati, anche dei campi compilati e trascinati; I1 testo
// del dialogo e finestre di conferma di una cancellazione; I6 osservazioni del browser non registrate ⇒ nessuna azione.
const YES = /^\s*(s[iì]|yes|ok)\s*$/i;
const SAFE_EXIT = /^\s*(annulla|no|chiudi|indietro|cancel|close|back|x)\s*$/i;
function fullExploreRefusal(ctx) {
  const b = ctx.session?.browser ?? {};
  const snap = b.snapshot;
  const names = snap?.names && typeof snap.names === "object" ? snap.names : null;
  const deleteQuestion = names ? Object.values(names).some((n) => isDeleteQuestion(n)) : false;
  for (const a of ctx.actions.filter(isEffectful)) {
    if (["upload", "script", "other"].includes(a.kind)) return `esplorazione completa: ${a.kind === "upload" ? "il caricamento di file" : a.kind === "script" ? "gli script nella pagina" : "gli strumenti non classificati"} restano vietati (${a.op ?? a.tool ?? ctx.tool})`;
    ctx.pendingFile ??= loadPending(pendingFile(join(ctx.ws, "customers", ctx.customer, ".sessions")));
    const pend = pendingRefusal(mergedPending(b, ctx.pendingFile), a.family ?? ctx.call?.family, a.tab);
    if (pend) return `esplorazione completa: ${pend}`;
    if (a.kind === "dialog") {
      if (isDeleteLabel(ctx.ti?.promptText)) return "esplorazione completa: il testo del dialogo conferma una cancellazione: vietato";
      if (a.submits && deleteQuestion) return "esplorazione completa: la pagina chiede di confermare una cancellazione: non si accetta il dialogo";
      continue;
    }
    if (a.kind === "input" && a.submits && deleteQuestion) return "esplorazione completa: la pagina chiede di confermare una cancellazione: niente Invio";
    if (a.kind !== "click" && a.kind !== "input") continue;
    const refs = Array.isArray(a.targets) ? a.targets : [];
    if (a.kind === "click") {
      if (!refs.length || a.untargeted) return `esplorazione completa: click senza uid dell'ultimo snapshot (${a.op ?? a.tool ?? ctx.tool})`;
      if (!names) return "esplorazione completa: nessuno snapshot completo della pagina: esegui take_snapshot prima del click";
      if (!b.current_url || snap.url !== b.current_url) return "esplorazione completa: l'ultimo snapshot non è della pagina corrente: rifai take_snapshot";
      if (String(snap.tab ?? "") !== String(a.tab ?? "")) return "esplorazione completa: l'ultimo snapshot è di un'altra scheda: rifai take_snapshot";
    }
    const unverified = Array.isArray(snap?.unverified) ? snap.unverified : [];
    for (const r of refs) {
      // revisione di sicurezza (rilievo 1): un ref non verificato nella mappa (ripetuto, o dentro un valore fra virgolette)
      if (unverified.includes(String(r))) return `esplorazione: l'elemento ${r} non è verificato nell'ultimo snapshot (ref ripetuto o dentro un valore fra virgolette): non si clicca né si compila`;
      const name = names && Object.hasOwn(names, r) ? String(names[r] ?? "") : null;
      if (a.kind === "click" && (!name || !name.trim())) return `esplorazione completa: l'elemento ${r} non ha un nome nell'ultimo snapshot: potrebbe essere un'icona di cancellazione, non si clicca`;
      if (name && isDeleteLabel(name)) return `esplorazione completa: "${name}" è una cancellazione: vietata anche in esplorazione completa`;
      if (a.kind === "click" && deleteQuestion && name && !SAFE_EXIT.test(name) && (EFFECT_LABEL.test(name) || YES.test(name))) return `esplorazione completa: la pagina chiede di confermare una cancellazione: "${name}" non si preme (usa Annulla o chiudi)`;
    }
  }
  return null;
}

function noPlan(ctx, no) {
  const s = ctx.session;
  const bad = ctx.actions.filter(isEffectful).find((a) => !["click", "input"].includes(a.kind) || a.submits);
  const explore = s.mode === "esplorazione" && ["sandbox", "preprod"].includes(s.env?.type);
  // K5 giro 2 (N2): la modalità vale solo se l'ha aperta l'utente con ESPLORA SANDBOX
  // (record nella catena, consumato dal cambio di modalità, per questo ambiente,
  // confermato nel transcript).
  if (explore) {
    const reg = readApprovals(approvalsFile(ctx.ws, ctx.customer, ctx.sid));
    const found = reg.ok ? exploreRecord(reg.records, s.mode_approval, s.env.id) : null;
    const rec = found && (found.env_type ?? "sandbox") === s.env.type ? found : null;
    const phrase = `${s.env.type === "preprod" ? "ESPLORA PREPROD" : EXPLORE_PHRASE}[ COMPLETA]`;
    if (!rec) return no(`modalità esplorazione non aperta dall'utente: serve la sua frase \`${phrase}\`, poi /use mode esplorazione (registro ${reg.ok ? "senza il record" : `corrotto: ${reg.reason}`})`);
    const conf = confirmInTranscript(ctx.input.transcript_path, [rec]);
    if (!conf.ok) return no(`modalità esplorazione non confermata dal transcript dell'utente (${conf.reason})`);
    if (rec.full === true) {
      const refusal = fullExploreRefusal(ctx);
      if (refusal) return no(refusal);
      try {
        appendAudit(ctx.ws, { session: ctx.sid, customer: ctx.customer, scope: s.scope ?? null, kind: "decision", actor: `hook:${G}`,
          payload: { decision: "allow", mode: "esplorazione-completa", tool: ctx.tool, kinds: ctx.actions.map((a) => a.kind) } });
      } catch { /* l'audit non cambia la decisione */ }
      return null;
    }
    if (s.env.type === "preprod") {
      const refusal = preprodClickRefusal(ctx);
      if (refusal) return no(refusal);
    }
  }
  if (explore && !bad) {
    try {
      appendAudit(ctx.ws, { session: ctx.sid, customer: ctx.customer, scope: s.scope ?? null, kind: "decision", actor: `hook:${G}`,
        payload: { decision: "allow", mode: "esplorazione", tool: ctx.tool, kinds: ctx.actions.map((a) => a.kind) } });
    } catch { /* l'audit non cambia la decisione */ }
    return null;
  }
  if (explore) return no(`esplorazione senza piano: consentiti solo click e input, mai invio, salvataggio, upload, conferma di dialog, script (${bad.tool ?? ctx.tool})`);
  return no(`nessun piano attivo: ogni azione con effetto sul browser richiede un piano attivo (step-check)${s.mode === "esplorazione" ? "; la modalità esplorazione vale solo in sandbox" : "; per esplorare in sandbox: /use mode esplorazione"}`);
}

// spec 2026-10-06 §3.8: si carica solo il file compilato del run attivo, con l'impronta dichiarata nel passo UPLOAD.
// Fail-closed: passo diverso da UPLOAD, file mancante/non classificato, più di un file, percorso fuori dal run (anche via
// .. o symlink: si confronta il realpath), non file regolare, impronta diversa ⇒ rifiuto. Limite noto: fra questo controllo
// e la lettura del browser il file potrebbe cambiare (TOCTOU); il run è scrivibile solo da Claude sotto i guard di scrittura.
const WIN = process.platform === "win32";
const fold = (p) => (WIN ? p.toLowerCase() : p);
const inside = (child, dir) => fold(child).startsWith(fold(dir.endsWith(sep) ? dir : dir + sep));
function uploadRefusal(ctx, step, ap, a) {
  if (step.verb !== "UPLOAD" || !step.file || typeof step.file.path !== "string" || !/^[0-9a-f]{64}$/i.test(String(step.file.sha256))) return "caricamento di file solo in un passo UPLOAD con file { path, sha256 } nel piano";
  if (typeof ap.run !== "string" || !ap.run) return "il piano attivo non ha un run: il file da caricare dev'essere del run attivo";
  const runDir = resolve(ctx.ws, "customers", ctx.customer, "runs", ap.run);
  const expected = resolve(ctx.ws, "customers", ctx.customer, step.file.path);
  if (!inside(expected, runDir)) return "il file del passo non è nel run attivo";
  const files = Array.isArray(a.files) ? a.files : [];
  if (files.length !== 1 || typeof files[0] !== "string" || !files[0]) return "un caricamento alla volta, del solo file del passo (percorso mancante o non classificato)";
  let real; let realExpected; let realRun;
  // il server MCP del browser risolve i percorsi relativi nella SUA cartella corrente, non in quella di Claude: il guard
  // calcolerebbe l'impronta di un file e il server ne caricherebbe un altro. Solo percorsi assoluti.
  if (!isAbsolute(files[0]) || (WIN && !/^([A-Za-z]:[\\/]|[\\/]{2})/.test(files[0]))) return `percorso relativo non ammesso (${files[0]}): il server del browser lo risolverebbe in una cartella diversa; usa il percorso assoluto del file del run`;
  try { real = realpathSync(files[0]); } catch { return `file da caricare inesistente: ${files[0]}`; }
  try { realExpected = realpathSync(expected); realRun = realpathSync(runDir); } catch { return "il file compilato del passo non esiste nel run attivo"; }
  if (!inside(realExpected, realRun)) return "il file del passo (dopo la risoluzione dei collegamenti) esce dal run attivo";
  if (fold(real) !== fold(realExpected)) return `si carica solo ${step.file.path} (fuori dal run o file diverso: ${files[0]})`;
  let buf;
  try { if (!statSync(real).isFile()) return "il file da caricare non è un file regolare"; buf = readFileSync(real); } catch { return "file da caricare illeggibile"; }
  if (createHash("sha256").update(buf).digest("hex") !== String(step.file.sha256).toLowerCase()) return "il file è cambiato dopo il piano (impronta diversa): ricompila il file e ricomponi il piano";
  return null;
}

const TARGETED = new Set(["input", "click", "upload"]);
const SEL_CODE = /^[SCL]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.SEL\.\d{4}(\.v\d+)?$/;
// spec 2026-10-06 §3.8: un passo FILL con fields: [{ target, value }] compila più campi della pagina in una chiamata (fill_form).
// L'insieme ammesso è l'elenco dei SEL di fields (tutti SEL dell'Atlas, senza ripetizioni, almeno uno); ogni ref della chiamata
// deve legarsi a uno di essi e ciascun SEL di fields si lega al più UNA volta nella chiamata (due elementi dello stesso SEL,
// o lo stesso ref due volte, riempirebbero due volte lo stesso campo). Un `fields` presente ma malformato ⇒ rifiuto.
function allowedSels(step) {
  if (step.fields === undefined) return { allowed: typeof step.target === "string" && SEL_CODE.test(step.target) ? [step.target] : null, multi: false };
  const f = step.fields;
  if (!Array.isArray(f) || !f.length) return { err: "il passo ha fields vuoto o non valido: input, click e upload non si possono legare al passo" };
  const t = f.map((x) => x?.target);
  if (t.some((x) => typeof x !== "string" || !SEL_CODE.test(x))) return { err: "i fields del passo non hanno tutti come target un SEL dell'Atlas: input, click e upload non si possono legare al passo" };
  if (new Set(t).size !== t.length) return { err: "i fields del passo ripetono lo stesso SEL: input, click e upload non si possono legare al passo" };
  return { allowed: t, multi: true };
}
export function bindingRefusal(ctx, step) {
  const b = ctx.session?.browser ?? {};
  const bound = new Map();   // SEL di fields → quante volte legato nella chiamata
  for (const a of ctx.actions) {
    if (!TARGETED.has(a.kind)) continue;
    const al = allowedSels(step);
    if (al.err) return al.err;
    if (!al.allowed) return "il passo non ha come target un SEL dell'Atlas: input, click e upload non si possono legare al passo";
    const shown = al.multi ? `a uno dei SEL del passo (fields: ${al.allowed.join(", ")})` : `al SEL del passo ${step.target}`;
    const refs = Array.isArray(a.targets) ? a.targets : [];
    if (!refs.length || a.untargeted) return `azione senza uid/ref (${a.op ?? a.tool}): non si può legare ${shown}; usa l'uid o il ref dell'ultimo snapshot`;
    // WP07 giro 5 (I-A', regola 5): una chiamata precedente su questa scheda che observe-append non ha registrato
    // (fallito, scaduto) ⇒ la storia dei ref della scheda è inaffidabile: nessun legame finché la scheda non naviga
    // WP08: anche il marcatore del cliente (customers/<C>/.sessions/ref-pending.json), che sopravvive alla sessione
    ctx.pendingFile ??= loadPending(pendingFile(join(ctx.ws, "customers", ctx.customer, ".sessions")));
    const pend = pendingRefusal(mergedPending(b, ctx.pendingFile), a.family ?? ctx.call?.family, a.tab);
    if (pend) return pend;
    const snap = b.snapshot;
    if (!snap || !snap.refs || typeof snap.refs !== "object") return "nessuno snapshot osservato della pagina: esegui take_snapshot / read_page / browser_snapshot prima dell'azione";
    if (!b.current_url || snap.url !== b.current_url) return "l'ultimo snapshot osservato non è della pagina corrente: rifai lo snapshot";
    if ((snap.tab ?? null) !== (a.tab ?? null)) return "l'ultimo snapshot osservato è di un'altra scheda: rifai lo snapshot in questa scheda";
    for (const r of refs) {
      const sel = Object.hasOwn(snap.refs, r) ? snap.refs[r] : undefined;
      if (typeof sel !== "string" || !al.allowed.includes(sel)) return `l'elemento ${r} non corrisponde ${shown} (nell'ultimo snapshot: ${Object.hasOwn(snap.refs, r) ? snap.refs[r] ?? "nessuna voce dell'Atlas" : "assente"})`;
      if (al.multi) {
        bound.set(sel, (bound.get(sel) ?? 0) + 1);
        if (bound.get(sel) > 1) return `più di un elemento della chiamata legato allo stesso campo ${sel} dei fields del passo: ogni campo si compila una sola volta per chiamata`;
      }
    }
  }
  return null;
}

// Un passo DELETE vale UNA cancellazione di UN elemento (spec 2026-10-06 §3.7): il legame al SEL è per etichetta/ruolo, quindi
// in una lista ogni riga ha lo stesso "Elimina" con lo stesso SEL. Istanza ambigua (più di un uid dell'ultimo snapshot
// legato al SEL del passo) o più di un click nella stessa chiamata ⇒ rifiuto. Usata anche da guard-destructive (deleteStepSel).
export function deleteInstanceRefusal(ctx, step, clicks = (ctx.actions ?? []).filter((x) => x.kind === "click")) {
  if (clicks.length > 1) return "più click nella stessa chiamata: un passo DELETE cancella un solo elemento";
  const refs = ctx.session?.browser?.snapshot?.refs;
  if (!refs || typeof refs !== "object") return "nessuno snapshot osservato: non si può verificare l'istanza da cancellare";
  // esplorazione libera (26/10/2026): una mappa fatta di pezzi (letture parziali sommate) non mostra tutte le istanze
  if (ctx.session.browser.snapshot.partial === true) return "la mappa della pagina viene da letture parziali (pezzi): per una cancellazione serve una lettura completa della pagina, che mostri tutte le istanze del SEL";
  const n = Object.values(refs).filter((v) => v === step.target).length;
  if (n !== 1) return `istanza ambigua: ${n} elementi dell'ultimo snapshot corrispondono al SEL ${step.target} (una cancellazione vale per UN elemento: usa uno snapshot in cui il SEL è un solo elemento)`;
  return null;
}

// Cancellazione eseguita: il marcatore active_plan.delete_done = { plan_id, step } vale solo per quel passo (step-check lo
// riscrive a ogni attivazione di un altro passo). Si registra solo quando il guard consente, atomicamente sotto il lock di
// session.json (due chiamate parallele: una sola vince).
function claimDelete(ctx, claim) {
  let won = false;
  try {
    updateSessionFast(ctx.sessionFile, (x) => {
      const ap = x.active_plan;
      if (!ap || ap.plan_id !== claim.plan_id || ap.step !== claim.step) return;
      if (ap.delete_done?.plan_id === claim.plan_id && ap.delete_done?.step === claim.step) return;
      ap.delete_done = { plan_id: claim.plan_id, step: claim.step, at: new Date().toISOString() };
      won = true;
    });
  } catch { return false; }
  return won;
}

async function browserDecide(ctx, no) {
  const r = await browserDecideCore(ctx, no);
  if (r !== null || !ctx.deleteClaim) return r;
  return claimDelete(ctx, ctx.deleteClaim) ? null : no("passo DELETE: la cancellazione di questo passo è già stata eseguita (una sola per passo)");
}

async function browserDecideCore(ctx, no) {
  if (!ctx.actions.some(isEffectful)) return null;
  const s = ctx.session;
  if (!s) return null;   // senza sessione guard-environment nega già ogni strumento del browser
  // WP08 (decisione del controllore su WP07): il legame ref ↔ SEL del browser di Claude vale solo in sandbox
  const ce = claudeEffectRefusal(ctx, s.env?.type ?? null);
  if (ce) return no(ce);
  if (!s.active_plan) return noPlan(ctx, no);
  const st = await activeStep(ctx);
  if (st.reason) return no(st.reason);
  const { step, ap } = st;
  const cls = step.action_class;
  const at0 = `passo ${step.n} (${step.verb}, ${cls ?? "senza classe"}) del piano ${ap.plan_id}`;
  // WP07 giro 1 (C2 d): invio (Enter/submit) e dialog accettato sotto un passo di classe di lettura, in ogni ambiente
  if ((!ACT[cls] || ACT[cls].effect === "read") && ctx.actions.some((a) => a.submits === true || (a.kind === "dialog" && a.submits))) {
    return no(`${at0}: invio (Enter/submit) o conferma di un dialog sotto un passo di classe di lettura: negato in ogni ambiente`);
  }
  // revisione finale (minore): fuori da un passo ACT-DELETE un dialog non si accetta se il suo testo (promptText) è una
  // cancellazione o se la pagina chiede di confermare una cancellazione (come l'esplorazione completa) — in ogni ambiente
  if (cls !== "ACT-DELETE" && ctx.actions.some((a) => a.kind === "dialog" && a.submits)) {
    const names = s.browser?.snapshot?.names && typeof s.browser.snapshot.names === "object" ? Object.values(s.browser.snapshot.names) : [];
    if (isDeleteLabel(ctx.ti?.promptText)) return no(`${at0}: il testo del dialogo conferma una cancellazione: solo dentro un passo ACT-DELETE del piano`);
    if (names.some((n) => isDeleteQuestion(n))) return no(`${at0}: la pagina chiede di confermare una cancellazione: il dialogo non si accetta fuori da un passo ACT-DELETE del piano (usa Annulla)`);
  }
  // WP07 giro 1 (C2 c): ogni uid/ref di input, click e upload deve essere, nell'ultimo snapshot osservato della pagina
  // corrente, l'elemento del SEL del passo attivo (mappa di observe-append: ref → atlas_match)
  const bind = bindingRefusal(ctx, step);
  if (bind) return no(`${at0}: ${bind}`);
  // spec 2026-10-06 §3.8: ogni upload (in ogni ambiente) solo del file del run attivo con l'impronta del passo UPLOAD
  const ups = ctx.actions.filter((x) => x.kind === "upload");
  if (ups.length > 1) return no(`${at0}: più di un upload nella stessa chiamata (${ups.length}): un caricamento alla volta, del solo file del passo`);
  for (const a of ups) { const u = uploadRefusal(ctx, step, ap, a); if (u) return no(`${at0}: ${u}`); }
  // spec 2026-10-06 §3.7: un click su un'etichetta di cancellazione vale solo dentro un passo DELETE del piano
  // (verbo DELETE, classe ACT-DELETE; il legame al SEL del passo l'ha già verificato bindingRefusal)
  if (cls === "ACT-DELETE" && step.verb === "DELETE") {
    // un passo DELETE vale UNA cancellazione di UN elemento: istanza non ambigua e un solo click, una sola volta
    const clicks = ctx.actions.filter((x) => x.kind === "click");
    if (clicks.length) {
      const amb = deleteInstanceRefusal(ctx, step, clicks);
      if (amb) return no(`${at0}: ${amb}`);
      if (s.active_plan.delete_done?.plan_id === ap.plan_id && s.active_plan.delete_done?.step === step.n) {
        return no(`${at0}: la cancellazione di questo passo è già stata eseguita (un passo DELETE vale una sola cancellazione): per un'altra serve un altro passo`);
      }
      ctx.deleteClaim = { plan_id: ap.plan_id, step: step.n };
    }
  } else {
    const names = s.browser?.snapshot?.names && typeof s.browser.snapshot.names === "object" ? s.browser.snapshot.names : {};
    for (const a of ctx.actions.filter((x) => x.kind === "click" || x.kind === "input")) {
      for (const r of Array.isArray(a.targets) ? a.targets : []) {
        const name = Object.hasOwn(names, r) ? String(names[r] ?? "") : "";
        if (name && isDeleteLabel(name)) return no(`${at0}: "${name}" è una cancellazione: solo dentro un passo DELETE del piano`);
      }
    }
  }
  if (!COMMIT_VERBS.has(step.verb) && !GUARDED_CLASSES.has(cls)) return null;
  const at = `passo ${step.n} (${step.verb}, ${cls ?? "senza classe"}) del piano ${ap.plan_id}`;
  if (ctx.actions.some((a) => a.kind === "script" || a.kind === "other")) return no(`script o strumento non classificato durante il ${at}: non verificabile, negato`);
  const { env, reason } = declaredEnv(ctx, { withRemediation: true });
  if (!env) return no(reason);
  const info = ACT[cls];
  if (!info) return no(`${at}: classe di azione fuori catalogo`);
  if (env.type === "prod" && info.effect === "write" && env.policy?.write_data !== true) return no(`${at}: in produzione le scritture sono spente per l'ambiente ${env.id} (policy.write_data: false in environments.yaml)`);
  if (info[envColumn(env.type)] === "never") return no(`${at}: ${cls} non è ammessa in ${env.type} (§29.4)`);
  // revisione finale (Ruling F6): con policy.write_data false, in QUALUNQUE ambiente (es. una pre-produzione copia dei dati
  // reali), niente import massivi né cancellazioni
  if ((cls === "ACT-BULK" || cls === "ACT-DELETE") && env.policy?.write_data === false) return no(`${at}: l'ambiente ${env.id} ha policy.write_data: false (environments.yaml): niente import massivi né cancellazioni finché l'utente non accende write_data`);

  // (c) perimetro
  let level = null;
  if (cls === "ACT-CFG-CHANGE") {
    const cfg = step.config ?? {};
    if (!cfg.object && !cfg.area) return no(`${at}: passo di configurazione senza oggetto né area CL-CFG (config)`);
    level = stepLevel(step);
    const levels = env.policy?.config_levels ?? [];
    const redOk = env.type === "prod" && level === "rosso" && !!cfg.object && (env.policy?.prod_allowed_red ?? []).includes(cfg.object);
    if (!levels.includes(level) && !redOk) {
      return no(`${at}: livello ${level} non ammesso nell'ambiente ${env.id} (config_levels: ${levels.join(", ") || "—"})${env.type === "prod" && level === "rosso" ? "; in produzione il rosso solo per oggetti in prod_allowed_red" : ""}`);
    }
    const L = env.remediation?.levels?.[level];
    if (!env.remediation) return no(`${at}: remediation-scope.yaml assente: il perimetro delle correzioni non è dichiarato`);
    if (!((cfg.object && L?.objects?.includes(cfg.object)) || (cfg.area && L?.areas?.includes(cfg.area)))) {
      return no(`${at}: fuori perimetro di remediation-scope.yaml per il livello ${level}: ${[cfg.object, cfg.area].filter(Boolean).join(" / ")}`);
    }
  }
  // (a) compensazione
  if (COMP_CLASSES.has(cls) && COMMIT_VERBS.has(step.verb)) {
    const comps = Array.isArray(s.pending?.compensations) ? s.pending.compensations : [];
    if (!comps.some((c) => c && typeof c === "object" && c.plan === ap.plan_id && c.step === step.n)) {
      return no(`${at}: compensazione non registrata (close/cancel/deactivate/restore) prima del passo che crea, modifica, invia o cancella (§29.6)`);
    }
    if (cls === "ACT-DELETE" && !comps.some((c) => c?.plan === ap.plan_id && c.step === step.n && c.kind === "restore" && c.ref)) {
      return no(`${at}: prima di cancellare serve la lettura completa dell'oggetto salvata nel run (compensazione restore con ref)`);
    }
    // revisione finale (Ruling F1): in produzione un import di configurazione (config_import non false) vuole la restore
    // con l'istantanea dei dati attuali, registrata da step-check dopo averla verificata nel run
    if (env.type === "prod" && cls === "ACT-BULK" && st.plan?.config_import !== false && !comps.some((c) => c?.plan === ap.plan_id && c.step === step.n && c.kind === "restore" && c.ref)) {
      return no(`${at}: in produzione un import di configurazione richiede l'istantanea dei dati attuali nel run (compensazione restore con ref; compose-plan --istantanea)`);
    }
  }
  const now = Date.now();
  // (b) snapshot — WP09b: UNO snapshot degli ultimi 60 s che copra TUTTI gli oggetti governati del passo (config.object
  // + config.governs, S.STD.ADM.CHK.0051); un passo con la sola area vuole uno snapshot che dichiari l'area. Uno snapshot
  // di un'altra pagina o di altri oggetti non basta (WP07 security minor 1).
  if (cls === "ACT-CFG-CHANGE") {
    const governed = governedObjects(step);
    const fresh = (Array.isArray(s.snapshots) ? s.snapshots : []).filter((x) => { const age = now - Date.parse(x?.ts ?? ""); return age <= SNAPSHOT_MS && age >= -5000; });
    if (!fresh.some((x) => snapshotCovers(x, step))) {
      const best = fresh.map((x) => governed.filter((o) => !(Array.isArray(x.objects) && x.objects.includes(o)))).sort((a, b) => a.length - b.length)[0];
      const what = governed.length ? governed.join(", ") : `area ${step.config?.area ?? "?"}`;
      return no(`${at}: serve uno snapshot degli oggetti governati (${what}) negli ultimi 60 s prima della modifica (§28.1)${best?.length && fresh.length ? `; lo snapshot più recente non copre ${best.join(", ")} (kb snapshot ${governed.join(" ")})` : ""}`);
    }
  }
  // (d) approvazioni
  const file = approvalsFile(ctx.ws, ctx.customer, ctx.sid);
  const reg = readApprovals(file);
  if (!reg.ok) return no(`registro delle approvazioni corrotto (${reg.reason}): nessuna approvazione è valida`);
  // revisione finale (Ruling F5): una frase d'autonomia che ALZA il livello vale solo se è nel transcript (prompt vero
  // dell'utente), come ogni altra approvazione; altrimenti vale il livello del cliente o il predefinito
  const aut = confirmedAutonomyLevel({ ws: ctx.ws, customer: ctx.customer, records: reg.records, envType: env.type,
    confirm: (rec) => confirmInTranscript(ctx.input.transcript_path, [rec]).ok });
  const req = requiredApprovals(cls, step, env, level, aut.level);
  if (!req.a1 && !req.a2 && !req.a3 && !req.action) {
    if (GUARDED_CLASSES.has(cls)) {
      try { appendAudit(ctx.ws, { session: ctx.sid, customer: ctx.customer, scope: s.scope ?? null, kind: "decision", actor: `hook:${G}`, payload: { decision: "allow", tool: ctx.tool, plan: ap.plan_id, step: step.n, autonomy: aut.level, autonomy_source: aut.source } }); } catch { /* l'audit non cambia la decisione */ }
    }
    return null;
  }
  const second = env.policy?.second_approver_required ?? env.type === "prod";
  const envPolicy = { ...env.policy, second_approver_required: second };
  const w = windowState(null, ap.plan_id, envPolicy, now, { records: reg.records });
  const P = ap.plan_id;
  const who = second ? " DA <Nome Cognome>" : "";
  if (req.a1 || req.a2 || req.a3) {
    if (!w.a1) return no(`${at}: manca A1 — l'utente deve scrivere \`APPROVO PIANO ${P}${who}\` (§52.2)`);
    if (w.expired) return no(`${at}: finestra 3A scaduta (${w.windowMs / 60000} min da A1): si riparte da \`APPROVO PIANO ${P}${who}\``);
    if (w.a1.plan_sha256 && w.a1.plan_sha256 !== st.sha256) return no(`${at}: il piano è cambiato dopo A1: serve una nuova \`APPROVO PIANO ${P}\``);
  }
  if (req.a2 && !w.a2) return no(`${at}: manca A2 — l'utente deve scrivere \`APPROVO PROVA ${P}${who}\`${second ? " (persona diversa da A1)" : ""} (§52.2)`);
  const tok = req.a3 ? w.tokenForStep(step.n) : null;
  if (req.a3 && !tok) return no(`${at}: manca il token del passo (monouso) — l'utente deve scrivere \`APPROVO PASSO ${step.n} ${P}\`${env.type === "prod" ? " (in produzione ogni passo che modifica o carica si approva prima)" : ""}`);
  const act = req.action ? w.actionFor(step.n) : null;
  if (req.action && !act) return no(`${at}: azione R2 senza approvazione — il manager mostra importo, stato di arrivo e compensazione e l'utente risponde \`sì\` (§57.2)`);
  const recs = [req.a1 ? w.a1 : null, req.a2 ? w.a2 : null, tok, act].filter(Boolean);
  const conf = confirmInTranscript(ctx.input.transcript_path, recs);
  if (!conf.ok) return no(`${at}: approvazione non confermata dal transcript dell'utente (${conf.reason})`);
  // (e) consumo monouso
  const consumed = [];
  for (const [t, kind] of [[tok, "A3"], [act, "action"]]) {
    if (!t) continue;
    const c = consumeStepToken(file, P, step.n, { envPolicy, now, kind });
    if (!c) return no(`${at}: il token ${phraseOf(t)} è già stato usato (vale una volta sola)`);
    consumed.push(c);
  }
  if (consumed.length) {
    try {
      const recsNow = readApprovals(file).records.slice(-consumed.length);
      updateSessionFast(ctx.sessionFile, (x) => { x.approvals = [...(Array.isArray(x.approvals) ? x.approvals : []), ...recsNow.map((r) => ({ ts: r.ts, kind: r.kind, plan: r.plan, step: r.step, hash: r.hash }))]; });
    } catch { /* lo specchio è informativo: il registro è già aggiornato */ }
    try {
      appendAudit(ctx.ws, { session: ctx.sid, customer: ctx.customer, scope: s.scope ?? null, kind: "decision", actor: `hook:${G}`,
        payload: { decision: "allow", tool: ctx.tool, plan: P, step: step.n, consumed: consumed.map((c) => ({ kind: c.kind, hash: c.hash })) } });
    } catch { /* l'audit non cambia la decisione */ }
  }
  return null;
}

// ---- scritture protette (Bash|PowerShell|Write|Edit|MultiEdit|NotebookEdit) ----
const ALM_CONFIG_WHY = "la configurazione del cliente (customers/<C>/config/**: environments, xray, remediation-scope…) la modifica solo l'utente, a mano, fuori sessione: decide host, credenziali e deroghe";
const ALM_FILES_WHY = "la configurazione del cliente la modifica solo l'utente; payload, esecuzioni e pubblicazioni Xray (runs/**/xray-*.json) e la coda offline (customers/<C>/queue/**) li scrivono solo gli script del plugin";
// WP09c giro 1: testo in minuscolo con le barre normalizzate (interpreti, script eseguiti, codice scritto)
const ALM_TEXT = /customers\/[^\s'"`]*\/(config|queue)(\/|['"`\s]|$)|\/queue\/q\.|xray-(payload|published|executions)\.json|(^|[/'"`\s])(xray|environments|remediation-scope)\.ya?ml/;
const PROTECTED = [
  ["**/approvals.jsonl", "il registro delle approvazioni lo scrive solo l'hook approval-capture (dalle frasi dell'utente)"],
  ["**/session.json", "session.json si modifica solo con /use, env-check e gli hook del plugin"],
  [".jvc/**", "lo stato di sessione si modifica solo con /use e con gli hook del plugin"],
  // WP07 giro 2 (N-3): la ripresa (--resume) si fonda sui checkpoint: li scrive solo step-check (script del plugin);
  // giro 3 (I-B): a ogni profondità sotto runs/ (un --run annidato non è più ammesso, ma i file non si scrivono comunque)
  ["**/runs/**/checkpoints/**", "i checkpoint dei piani li scrive solo step-check (script del plugin): la ripresa di un piano si fonda su di essi"],
  // WP09b giro 2: gli esiti dei piani li scrive solo step-check: la promozione (3 run coerenti) e la corsia compilata
  // (≥ 3 verdi) li contano
  ["**/runs/**/results/**", "gli esiti dei piani li scrive solo step-check (script del plugin): la promozione dei casi e la corsia compilata li contano"],
  ["**/runs/**/result.yaml", "gli esiti dei piani li scrive solo step-check (script del plugin): la promozione dei casi e la corsia compilata li contano"],
  // WP08: storia dei ref e marcatore "inaffidabile" del cliente (li scrivono solo browser-origin e observe-append)
  ["customers/*/.sessions/ref-history.json*", "la storia dei ref del browser la scrivono solo gli hook browser-origin e observe-append: forgiarla legherebbe ref a SEL"],
  ["customers/*/.sessions/ref-pending.json*", "il marcatore delle osservazioni mancate lo scrivono solo gli hook browser-origin e observe-append"],
  // WP09b giro 1 (I2): le OBS le scrive solo observe-append; kb snapshot si fonda su di esse (lo stato prima di una modifica)
  ["customers/*/observations/**", "le osservazioni (OBS) le scrive solo l'hook observe-append: una OBS forgiata renderebbe valido uno snapshot di configurazione (§28.1)"],
  // WP08 giro 1 (I2): l'audit è append-only e lo scrive solo audit-append (T8): nemmeno >> o una troncatura dalla shell
  ["customers/*/audit/**", "l'audit è append-only e lo scrive solo l'hook audit-append (T8): niente append, troncature o copie dalla shell"],
  [".jvc/audit/**", "l'audit è append-only e lo scrive solo l'hook audit-append (T8): niente append, troncature o copie dalla shell"],
  // WP09c giro 1 (C1 a): la configurazione del cliente (environments, xray, remediation-scope…) decide host, credenziali
  // e deroghe; (I1) payload, mappa delle esecuzioni, pubblicazioni Xray e coda offline li scrivono solo gli script
  // WP09c giro 2: a ogni profondità (un workspace "senza sessione" dentro il workspace non è una scorciatoia)
  ["**/customers/*/config/**", ALM_CONFIG_WHY],
  ["**/runs/**/xray-*.json", ALM_FILES_WHY],
  ["**/customers/*/queue/**", ALM_FILES_WHY],
  // WP10d: il registro di controllo dell'utente sugli agenti e lo stato degli agenti (guard-control) — sessione
  // principale e sub-agenti, strumenti di file, comandi di shell e script che li scrivono (in coda: gli indici
  // PROTECTED[3] e [4] sono citati nei messaggi)
  ["customers/*/.sessions/*/control.jsonl", "il registro di controllo degli agenti lo scrive solo approval-capture, dalle frasi dell'utente (PAUSA/RIPRENDI/FERMA, PASSO PASSO, SBLOCCA SCOPE, LIMITI DISPATCH)"],
  ["customers/*/.sessions/*/agents/**", "lo stato degli agenti (legame al compito, chiamate) lo scrive solo guard-control"],
  // giro 1: offset della scansione incrementale del transcript (spostarlo avanti impedirebbe una conferma dell'utente)
  ["customers/*/.sessions/*/control-scan.json", "l'offset di scansione del transcript lo scrivono solo gli hook del plugin (conferma dei controlli dell'utente)"],
];
const TREE = PROTECTED.map(([a, why]) => [a === "**/session.json" ? "customers/*/.sessions/*/session.json" : a === "**/approvals.jsonl" ? "customers/*/.sessions/*/approvals.jsonl" : a, why]);
const WRITE_FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

// `node <plugin>/scripts/…/*.mjs <argomenti>`: UNA invocazione semplice (tokenizzatore condiviso hooks/lib/exact-argv.mjs,
// WP08 giro 1 C1 — PowerShell valuta ( … ), @( … ), , prima di avviare node), argomenti di forma semplice.
function pluginScript(cmd, ctx) {
  const call = simpleNodeCall(cmd, ctx.cwd);
  if (!call || !/\.mjs$/i.test(call.scriptToken)) return false;
  const inside = bases(join(ctx.plugin, "scripts")).some((b) => { const a = resolveTarget(call.script, { cwd: ctx.cwd, ws: ctx.ws }).abs; return [...a].every((x) => x.startsWith(`${b}/`)); });
  if (!inside || call.args.some((a) => /^(-e|-p|--eval|--print|--import|-r|--require)$/.test(a))) return null;
  return { script: call.scriptToken, args: call.args, rest: call.args.join(" ") };   // K5 giro 3: gli argomenti si controllano a parte
}

// WP08 giro 1 (I1): i generatori del pacchetto (integrity build, build-deny-rules, build-session-validator,
// build-error-patterns) riscrivono integrity.json o hooks/lib/generated/: mai da una sessione; restano ammessi
// `integrity verify` e le verifiche --check / --help che non scrivono.
// WP10a giro 1 (minore 4): per nome — ogni build-*.mjs è un generatore del pacchetto (deny di default, anche uno nuovo non
// ancora classificato) salvo quelli dichiarati NON generatori (producono report e payload del workspace).
export const GENERATOR_NAMES = Object.freeze(["build-deny-rules.mjs", "build-session-validator.mjs", "build-error-patterns.mjs"]);
export const NON_GENERATORS = Object.freeze(["build-report.mjs", "build-payload.mjs"]);
export const isGenerator = (name) => GENERATOR_NAMES.includes(name) || (/^build-[\w-]+\.mjs$/.test(name) && !NON_GENERATORS.includes(name));
const GENERATORS = { has: isGenerator };
function generatorRefusal(script) {
  const name = basename(script.script).toLowerCase();
  const a = script.args;
  if (name === "integrity.mjs") return a[0] === "verify" && !a.includes("--root") ? null : a.length === 1 && a[0] === "--help" ? null : "integrity.mjs build (o --root) riscrive il manifesto d'integrità: si esegue solo nel repository del plugin, per una release (T9)";
  // WP10a: solo i generatori del pacchetto (build-report.mjs e build-payload.mjs producono report e payload del
  // workspace, non moduli del plugin: /nrt report e gli RPT degli agenti li usano)
  if (GENERATORS.has(name)) return a.every((x) => x === "--check" || x === "--help") && a.length ? null : `${name} riscrive i moduli generati del plugin: si esegue solo nel repository del plugin (T9)`;
  return null;
}

function transcriptDirs(ctx) {
  const tp = ctx.input.transcript_path;
  if (typeof tp !== "string" || !tp) return { dirs: [], name: null };
  return { dirs: bases(dirname(tp)), name: basename(tp).toLowerCase() };
}
const under = (abs, dirs) => dirs.some((d) => abs === d || abs.startsWith(`${d}/`));

// ---- K5 giro 3: PROTECTED_CONFIG e codice del plugin ----
// Impostazioni di Claude Code (possono spegnere i guard: env come NODE_OPTIONS o
// JVC_WORKSPACE, disableAllHooks, hook, plugin, server MCP): <workspace>/.claude/**,
// <workspace>/.mcp.json, ogni .claude/** (anche ~/.claude/**, settings*.json,
// plugins/**) e ~/.claude.json; e il codice del plugin (${CLAUDE_PLUGIN_ROOT}/**):
// un guard modificato vale dalla chiamata successiva. Negati a sessione e sub-agenti
// con gli strumenti di file, con i comandi di shell che li citano (anche one-liner
// d'interprete, copy/curl/git/link) e con il contenuto di script che li scrivono.
const SETTINGS_WHY = "le impostazioni di Claude Code (.claude/**, ~/.claude/**, ~/.claude.json, .mcp.json) le modifica solo l'utente, a mano, fuori sessione: possono spegnere i guard del plugin";
const PLUGIN_WHY = "il codice del plugin (${CLAUDE_PLUGIN_ROOT}/**) è in sola lettura durante una sessione JVC: un guard modificato varrebbe dalla chiamata successiva";
const CONFIG_TEXT = /(^|[^\w.-])\.claude(?=$|[.\\/\s'"`;|&)(,:])|(^|[^\w])claude~\d|\.mcp\.json/i;
const CONFIG_ABS = /(^|\/)\.claude(\/|$)|(^|\/)\.claude\.json$|(^|\/)\.mcp\.json$|(^|\/)claude~\d(\/|$)/;
const CLAUDE_ADMIN = /(^|[\s'"])(plugins?|config|mcp)(?=$|[\s'"])/i;
const WRITE_ANY = /appendfile|writefile|createwritestream|opensync|writeall|\[io\.file\]|copyfile|renamesync|\bfs\.|add-content|set-content|out-file|new-item|\bni\b|\btee\b|>|\bcp\b|\bmv\b|\bcopy\b|robocopy|xcopy|copy-item|move-item|rename|\bdel\b|\brm\b|remove-item|\bcurl\b|\bwget\b|invoke-webrequest|\biwr\b|\birm\b|\bgit\s+(checkout|restore|apply|reset|stash|mv|rm|am)\b|mklink|\bln\b|\bsed\s+-[a-z]*i|\bperl\s+-[a-z]*i|\binstall\b|\brsync\b|\bdd\b|\.write\s*\(|\bopen\s*\(/i;
const LINK_CMD = /\bmklink\b|\bln\b|\bjunction\b|symboliclink|hardlink|symlink|createsymbolic/;
const RUNS_SEG = /(^|[/\s'"=:(])runs($|[/\s'"),;&|])/;
const flatOf = (s) => String(s).replace(/\\/g, "/").toLowerCase();
function mentionsPlugin(ctx, text) {
  const f = flatOf(text);
  return /claude_plugin_root/.test(f) || bases(ctx.plugin).some((b) => f.includes(b));
}
const underPlugin = (ctx, abs) => bases(ctx.plugin).some((b) => abs === b || abs.startsWith(`${b}/`));

// Script locali eseguiti da un interprete (node x.mjs, python x.py, pwsh x.ps1, …):
// il guard legge il file (≤ 256 KB) e applica gli stessi controlli del contenuto
// scritto con Write/Edit. Un file illeggibile o assente non si esegue comunque.
const SCRIPT_FILE = /(?:^|[\s'"])([^\s'"]+\.(?:mjs|cjs|js|ts|py|ps1|psm1|sh|bash|rb|pl|php|cmd|bat))(?=$|[\s'"])/gi;
function scriptContentRefusal(ctx, cmd) {
  if (!INTERP.test(cmd) && !/(^|[\s;&|])(bash|sh|cmd|\.\/)/i.test(cmd)) return null;
  for (const m of cmd.matchAll(SCRIPT_FILE)) {
    let text;
    try {
      const f = resolve(ctx.cwd, m[1]);
      if (statSync(f).size > 256 * 1024) return `script troppo grande per l'analisi del guard: ${m[1]}`;
      text = readFileSync(f, "utf8");
    } catch { continue; }
    if (!CODE_WRITE.test(text) && !WRITE_ANY.test(text)) continue;
    if (STATE.test(text)) return `lo script ${m[1]} scrive file e cita il registro delle approvazioni o lo stato di sessione`;
    // WP09b giro 3: gli esiti dei run hanno la stessa protezione dello stato di sessione
    const flatText = text.split(String.fromCharCode(92)).join("/").toLowerCase();
    if (ALM_TEXT.test(flatText)) return `lo script ${m[1]} scrive file e cita la configurazione del cliente, la coda o i file Xray del run — ${ALM_FILES_WHY}`;
    if (RESULTS.test(flatText) || RESULTS_SEG.test(flatText)) return `lo script ${m[1]} scrive file e cita gli esiti dei run — ${PROTECTED[4][1]}`;
    if (CONFIG_TEXT.test(text)) return `lo script ${m[1]} scrive file e cita le impostazioni di Claude Code — ${SETTINGS_WHY}`;
    if (KB_TEXT.test(flatText) && CODE_WRITE.test(text)) return `lo script ${m[1]} scrive file e cita la conoscenza — ${KB_WHY}`;
    if (mentionsPlugin(ctx, text)) return `lo script ${m[1]} scrive file e cita il plugin — ${PLUGIN_WHY}`;
  }
  return null;
}

function checkTarget(ctx, T, tree, tr) {
  if (T.plugin?.size) return `${PLUGIN_WHY}: ${[...T.plugin][0] || "."}`;
  for (const a of T.abs) {
    if (underPlugin(ctx, a) || (tree && bases(ctx.plugin).some((b) => b.startsWith(`${a}/`)))) return `${PLUGIN_WHY}: ${a}`;
    if (CONFIG_ABS.test(a)) return `${SETTINGS_WHY}: ${a}`;
  }
  for (const p of allRels(T)) {
    for (const [area, why] of PROTECTED) if (intersects(p, area)) return `${why}: ${p}`;
    if (tree) for (const [area, why] of TREE) if (intersects(subtree(p), area)) return `${why} (la cartella lo contiene): ${p || "."}`;
  }
  for (const a of T.abs) {
    if (/(^|\/)(approvals\.jsonl|session\.json)$/.test(a)) return `${PROTECTED[/approvals/.test(a) ? 0 : 1][1]}: ${a}`;
    if (/(^|\/)runs\/(.+\/)?checkpoints(\/|$)/.test(a)) return `${PROTECTED[3][1]}: ${a}`;
    if (/(^|\/)runs\/(.+\/)?(results(\/|$)|result\.yaml$)/.test(a)) return `${PROTECTED[4][1]}: ${a}`;
    if (under(a, tr.dirs) || (tree && tr.dirs.some((d) => d.startsWith(`${a}/`)))) return `il transcript della sessione (e la sua cartella) non si scrive: ${a}`;
  }
  return null;
}

// ---- canali di falsificazione dei token (giro di correzione 1, I4) ----
// (a) una frase di approvazione in un input di strumento: solo l'utente la scrive;
// (b) la CLI di Claude in modalità headless o di ripresa (-p/--print, -r/--resume,
//     -c/--continue, anche via npx o node …/claude-code/cli.js): un prompt così
//     passerebbe da approval-capture e finirebbe nel transcript come dell'utente;
// (c) nomi costruiti a runtime: il registro citato insieme a una primitiva di
//     scrittura, o uno script non del plugin i cui argomenti citano lo stato.
const PHRASE = /APPROVO\s+(PIANO|PROVA|PASSO|PURGE|PROMOZIONE|RETENTION)/i;
const CLAUDE_BIN = /(^|[\s;&|(`'"=\\/])(claude(\.exe|\.cmd|\.ps1)?|@anthropic-ai[\\/]claude-code(@[\w.-]+)?|claude-code[\\/](dist[\\/])?cli\.m?js)(?=$|[\s;&|)`'"])/i;
const CLAUDE_FLAGS = /(^|[\s'"])(-p|--print|-r|--resume|-c|--continue)(?=$|[\s=;'"])|(^|\s)-[a-z]*[prc][a-z]*(?=[\s'"]|$)/i;
// WP09b giro 2: esiti dei run (testo in minuscolo con le barre normalizzate)
const RESULTS = /result\.ya?ml|runs\/[^\s'"`]*\/results(\/|['"`\s]|$)/;
const STATE = /approvals|session\.json|\.sessions[\\/]|\.jvc|current-session|invocations\.jsonl|compact-summary/i;
const WRITE_PRIM = /appendfile|writefile|createwritestream|opensync|\bfs\.|add-content|set-content|out-file|\btee\b|>|\bopen\s*\(|\bcp\b|\bmv\b|copy-item|move-item|\.write\s*\(|\bac\b|\bsc\b/i;
// WP09c (riporto WP09b): pathlib write_text/write_bytes sono primitive di scrittura (uno script che scrive solo così
// era escluso dall'analisi del contenuto)
const CODE_WRITE = /appendfile|writefile|createwritestream|opensync|add-content|set-content|out-file|\bopen\s*\(|\.write\s*\(|\.write_(text|bytes)\s*\(|copyfile|renamesync|\brename\s*\(/i;
// WP09c (riporto WP09b): /results/ nudo — il percorso costruito da una variabile di cartella (d + "/results/P.yaml");
// vale solo insieme a un interprete e a una primitiva di scrittura
const RESULTS_SEG = /\/results\//;
// Correzione mirata finale (§29.6, T9): la conoscenza (product/**, customers/*/kb/**) la scrivono solo gli script del
// plugin dopo validazione. Un interprete non del plugin che la CITA insieme a una primitiva di scrittura nel codice è
// negato (le letture, es. readFileSync, restano: CODE_WRITE non le riconosce).
const KB_TEXT = /(^|[\s'"`=(\/,:])(product\/|customers\/[^\/\s'"`]+\/kb\/)/;
const KB_WHY = "la conoscenza (product/, customers/<C>/kb/) la scrivono solo gli script del plugin dopo la validazione (§29.6); la promozione a S vuole APPROVO PROMOZIONE";
const INTERP = /(^|[\s;&|(`'"\\/])(node|nodejs|deno|bun|python3?|py|perl|ruby|pwsh|powershell|php)(\.exe)?(?=$|[\s;&|)`'"])/i;
function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) strings(x, out);
  else if (v && typeof v === "object") for (const x of Object.values(v)) strings(x, out);
  return out;
}

// WP07 giro 1 (C2): un sub-agente esegue step-check solo su un piano già attivo (active_plan.file) o già approvato
// dall'utente (A1 nel registro); attivare un piano nuovo è della sessione principale. --close è sempre ammesso.
function subAgentStepCheck(ctx, rest) {
  const t = [...String(rest).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  if (t.includes("--close")) return null;
  const i = t.indexOf("--plan");
  const plan = i >= 0 ? t[i + 1] : null;
  const ap = ctx.session?.active_plan;
  if (plan && ap && ap.file === plan) return null;
  if (plan && ctx.customer) {
    let id = null;
    try { const txt = readFileSync(join(ctx.ws, "customers", ctx.customer, plan), "utf8"); id = /"plan_id"\s*:\s*"([^"]+)"|^plan_id:\s*["']?([^"'\s]+)/m.exec(txt)?.slice(1).find(Boolean) ?? null; } catch { id = null; }
    const reg = id ? readApprovals(approvalsFile(ctx.ws, ctx.customer, ctx.sid)) : null;
    if (id && reg?.ok && reg.records.some((r) => r.kind === "A1" && r.plan === id)) return null;
  }
  return "un sub-agente esegue step-check solo su un piano già attivo o approvato dall'utente: l'attivazione di un piano è della sessione principale";
}

const protectWrites = guarded(G, (ctx) => {
  const tr = transcriptDirs(ctx);
  const no = (why) => denyAudited(ctx, G, `scrittura negata — ${why}`);
  const texts = strings(ctx.ti);
  if (texts.some((t) => PHRASE.test(t))) return no("l'input contiene una frase di approvazione (APPROVO PIANO/PROVA/PASSO/PURGE/PROMOZIONE/RETENTION): le approvazioni le scrive solo l'utente nel prompt, mai uno strumento");
  if (WRITE_FILE_TOOLS.has(ctx.tool)) {
    if (texts.some((t) => STATE.test(t) && CODE_WRITE.test(t))) return no("il contenuto scrive su file e cita il registro delle approvazioni o lo stato di sessione: codice che può falsificare i token");
    if (texts.some((t) => ALM_TEXT.test(t.replace(/\\/g, "/").toLowerCase()) && CODE_WRITE.test(t))) return no(`il contenuto è codice che scrive la configurazione del cliente, la coda o i file Xray del run — ${ALM_FILES_WHY}`);
    if (texts.some((t) => RESULTS.test(t.replace(/\\/g, "/").toLowerCase()) && CODE_WRITE.test(t))) return no(`il contenuto è codice che scrive gli esiti dei run — ${PROTECTED[4][1]}`);
    if (texts.some((t) => CONFIG_TEXT.test(t) && CODE_WRITE.test(t))) return no(`il contenuto è codice che scrive le impostazioni di Claude Code — ${SETTINGS_WHY}`);
    if (texts.some((t) => mentionsPlugin(ctx, t) && CODE_WRITE.test(t))) return no(`il contenuto è codice che scrive nel plugin — ${PLUGIN_WHY}`);
    const r = checkTarget(ctx, targetsOf(ctx), false, tr);
    return r ? no(r) : null;
  }
  const cmd = ctx.ti.command;
  if (typeof cmd !== "string" || !cmd.trim()) return null;
  if (cmd.includes("\0")) throw new PathPolicyError("comando con byte NUL");
  if (CLAUDE_BIN.test(cmd) && CLAUDE_FLAGS.test(cmd)) return no("la CLI di Claude in modalità headless o di ripresa (-p/--print, -r/--resume, -c/--continue) non si invoca da una sessione JVC: produrrebbe prompt 'dell'utente'");
  if (CLAUDE_BIN.test(cmd) && CLAUDE_ADMIN.test(cmd)) return no(`i sottocomandi claude plugin|config|mcp cambiano plugin, impostazioni e server MCP — ${SETTINGS_WHY}`);
  const script = pluginScript(cmd, ctx);
  if (script && ctx.agentId && /(^|[\\/])step-check\.mjs$/i.test(script.script)) {
    const r = subAgentStepCheck(ctx, script.rest);
    if (r) return no(r);
  }
  if (script) {
    const gen = generatorRefusal(script);
    if (gen) return no(gen);
    // anche uno script del plugin non riceve come argomento un percorso delle impostazioni
    if (CONFIG_TEXT.test(script.rest)) return no(`argomento verso le impostazioni di Claude Code — ${SETTINGS_WHY}`);
    return null;
  }
  if (CONFIG_TEXT.test(cmd)) return no(`il comando cita le impostazioni di Claude Code (.claude, ~/.claude.json, .mcp.json) — ${SETTINGS_WHY}; si leggono con Read`);
  if (mentionsPlugin(ctx, cmd) && (INTERP.test(cmd) || WRITE_ANY.test(cmd))) return no(`il comando cita il plugin insieme a un interprete o a una primitiva di scrittura — ${PLUGIN_WHY}`);
  const sc = scriptContentRefusal(ctx, cmd);
  if (sc) return no(sc);
  const flat = cmd.replace(/\\/g, "/").toLowerCase();
  // WP07 giro 3 (I-B): niente link simbolici, giunzioni o hard link sotto runs/ (step-check verifica comunque il realpath)
  if (LINK_CMD.test(flat) && RUNS_SEG.test(flat)) return no("il comando crea un collegamento (link simbolico, giunzione, hard link) e cita runs/: le cartelle dei run e i loro checkpoint non si ridirigono");
  if (/approvals\.json/.test(flat)) return no("il comando cita approvals.json(l): il registro delle approvazioni si legge con Read o con `approvals.mjs status`, non si tocca dalla shell");
  if (/approvals/.test(flat) && WRITE_PRIM.test(flat)) return no("il comando cita 'approvals' insieme a una primitiva di scrittura: nome del registro costruito a runtime");
  // WP09b giri 2-3: gli esiti dei run (results/, result.yaml) li scrive solo step-check: come per lo stato di sessione,
  // un interprete non del plugin che li CITA è negato (write_text, open(…, "w"), nomi costruiti: nessuna primitiva richiesta)
  if (INTERP.test(cmd) && RESULTS.test(flat)) return no(`${PROTECTED[4][1]}: uno script non del plugin con argomenti o codice che li citano`);
  if (INTERP.test(cmd) && ALM_TEXT.test(flat)) return no(`uno script non del plugin con argomenti o codice che citano la configurazione del cliente, la coda o i file Xray del run — ${ALM_FILES_WHY}`);
  if (INTERP.test(cmd) && RESULTS_SEG.test(flat) &&(CODE_WRITE.test(cmd) || WRITE_PRIM.test(cmd))) return no(`${PROTECTED[4][1]}: codice d'interprete che scrive e cita /results/`);
  if (INTERP.test(cmd) && STATE.test(cmd)) return no("uno script non del plugin con argomenti o codice che citano il registro delle approvazioni o lo stato di sessione: solo gli script del plugin toccano lo stato");
  if (INTERP.test(cmd) && KB_TEXT.test(flat) && CODE_WRITE.test(cmd)) return no(`codice d'interprete che scrive e cita la conoscenza — ${KB_WHY}`);
  if (tr.name && (flat.includes(tr.name) || tr.dirs.some((d) => flat.includes(d)))) return no("il comando cita il transcript della sessione");
  for (const { tok, cwds, tree, soft } of shellWriteTargets(ctx, cmd)) {
    for (const cwd of cwds) {
      let T;
      try { T = resolveTarget(tok, { cwd, ws: ctx.ws }); } catch (err) { if (soft && err instanceof PathPolicyError) continue; throw err; }
      const r = checkTarget(ctx, T, tree, tr);
      if (r) return no(r);
    }
  }
  return null;
}, { tools: new Set([...WRITE_FILE_TOOLS, ...SHELL_TOOLS]) });

const browser = browserGuarded(G, browserDecide);

export function decide(input, env = process.env) {
  const tool = String(input.tool_name ?? "");
  if (WRITE_FILE_TOOLS.has(tool) || SHELL_TOOLS.has(tool)) return protectWrites(input, env);
  return browser(input, env);
}

