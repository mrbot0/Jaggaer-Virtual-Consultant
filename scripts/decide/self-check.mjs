// Auto-verifica prima del risultato (§17.1): non un prompt, uno script che legge il messaggio in
// preparazione, la sessione, l'audit, il piano e la lezione, e blocca l'invio se un controllo fallisce.
//
//   1  ogni codice citato esiste                                         blocco
//   2  nessuna lettura fuori cella (dall'audit)                          blocco + segnalazione
//   3  ogni entità creata ha compensazione registrata                    blocco
//   4  ogni decisione con effetti ha una DEC con tabella e strategia;    blocco
//      esteso (§10.5): ogni passo del piano ha un `expect`
//   5  ogni DEC con effetti ha un esito atteso dichiarato                blocco
//   6  le sorprese di sessione sono tutte in CTR                         blocco
//   7  forma epistemica iniziale e finale registrate                     blocco
//   8  risultato in YAML compatto con codici, non prosa (≤ 60 parole)    riformatta
//   9  la lezione esiste, otto sezioni, §7 non vuota                     blocco
//  10  esito ok con open_questions non marcate non bloccanti             riclassifica partial
//  11  ogni azione ha un report (RPT) (§29.6)                            blocco
//  12  spreco: stessa query kb ripetuta nel compito (§29.10)             blocco ("Controllo fallito")
//  13  spreco: snapshot della stessa pagina senza azione in mezzo        blocco ("Controllo fallito")
// Profondità rapida (§10.4): auto-verifica ridotta ai controlli 1, 3, 9 (più #11, obbligatorio per §29.6).
import { readFileSync } from "node:fs";
import YAML from "yaml";
import { parseLesson, sectionEmpty, ITEM_CODE_RE } from "../kb/lesson.mjs";
import { parseCode } from "../kb/codes.mjs";
import { extractReport } from "../admin/agent-report.mjs";
import { matchGlob } from "../../hooks/lib/paths.mjs";
import { openDb } from "../kb/db.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { CONTROLS, controlsFor, reportedControlsFor } from "./self-check-controls.mjs";

export { CONTROLS, SELF_CHECK_CONTROLS } from "./self-check-controls.mjs";
// §29.10: i due rilevatori di spreco sono "Controllo fallito" e §17.1 blocca l'invio se un controllo
// fallisce: bloccano (azione di default). Solo #8 riformatta (§29.10 "Riformattazione, non rigetto")
// e #10 riclassifica (§17.1).
const ACTION = { 8: "reformat", 10: "reclassify" };
const SHAPES = new Set(["consolidato", "libresco", "empirico", "ignoto", "contraddittorio"]);
const PERSISTING_VERBS = new Set(["SAVE", "SUBMIT", "UPLOAD"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead"]);
const MAX_WORDS = 60;

const codesIn = (v) => [...new Set(JSON.stringify(v ?? null).match(ITEM_CODE_RE) ?? [])];
const asList = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);
const parseSummary = (s) => { try { return typeof s === "string" ? JSON.parse(s) : s ?? {}; } catch { return {}; } };

function strings(v, out = []) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => strings(x, out));
  else if (v && typeof v === "object") Object.values(v).forEach((x) => strings(x, out));
  return out;
}

// Percorso relativo al workspace (customers/… o product/…) da un percorso qualunque; null = fuori dalle celle.
function cellPath(p) {
  if (typeof p !== "string") return null;
  const s = p.replace(/\\/g, "/");
  const m = /(?:^|\/)((?:customers|product)\/.*)$/i.exec(s);
  return m ? m[1] : null;
}

// kbExists e getDecision arrivano dal DB (CLI: --db obbligatorio). Senza kbExists i controlli che
// verificano l'esistenza dei codici (1, 11) falliscono come "non eseguiti": mai un passaggio a vuoto.
export function selfCheck({ report, session = {}, audit = [], plan = null, lesson = null, kbExists = null, getDecision = () => null,
  observations, depth, agentId, contradictions = [] } = {}) {
  const failed = [];
  const signals = [];
  const fail1 = (n, reason) => failed.push({ n, control: CONTROLS[n], reason, action: ACTION[n] ?? "block" });
  const run = controlsFor(depth);
  const rep = report && typeof report === "object" && !Array.isArray(report) ? report : null;
  const trace = rep?.cognitive_trace ?? {};
  const output = rep?.output && typeof rep.output === "object" ? rep.output : {};
  const steps = Array.isArray(plan?.steps) ? plan.steps : [];
  const parsedLesson = typeof lesson === "string" ? parseLesson(lesson) : lesson;
  const mine = (e) => !agentId || e?.payload?.agent_id === undefined || e.payload.agent_id === agentId;
  const events = asList(audit).filter(mine);

  const taskEffects = asList(output.effects).length > 0 || asList(output.created).length > 0 || steps.some((s) => PERSISTING_VERBS.has(s.verb));
  const decs = asList(trace.decisions).filter((d) => typeof d === "string");
  const decInfo = (d) => getDecision(d) ?? null;
  // Effetti di una DEC: citata in output.effects → sì (prevale su effects:false registrato); registrata
  // con effetti → sì; effetti ignoti (NULL, dt-eval senza --effects) → quelli del compito; registrata
  // senza effetti in un compito con effetti → resta senza, ma la contraddizione è segnalata.
  const effectDecs = decs.filter((d) => {
    const info = decInfo(d);
    const listed = asList(output.effects).some((e) => e?.decision === d);
    if (listed) {
      if (info?.effects === false) signals.push({ control: 4, reason: `${d}: registrata senza effetti ma citata in output.effects — trattata con effetti` });
      return true;
    }
    if (info?.effects === true) return true;
    if (info?.effects === false) {
      if (taskEffects) signals.push({ control: 4, reason: `${d}: registrata senza effetti in un compito con effetti — verificare` });
      return false;
    }
    return taskEffects;
  });

  const checks = {
    1: () => {
      if (typeof kbExists !== "function") { fail1(1, "verifica dei codici non eseguita: nessun accesso al DB (kbExists)"); return; }
      const missing = [...codesIn(rep), ...codesIn(plan)].filter((c, i, a) => a.indexOf(c) === i && !kbExists(c));
      if (missing.length) fail1(1, `codici inesistenti: ${missing.join(", ")}`);
    },
    2: () => {
      const allowed = asList(session.allowed_paths);
      const outside = [];
      for (const e of events) {
        const p = e.payload ?? {};
        if (e.kind === "guard" && p.decision === "deny") { signals.push({ control: 2, reason: `tentativo negato da ${e.actor}: ${p.tool}` }); continue; }
        if (e.kind !== "tool" || !READ_TOOLS.has(p.tool) || p.ok === false) continue;
        const s = parseSummary(p.input_summary);
        const rel = cellPath(s.file_path ?? s.notebook_path ?? s.path);
        if (rel && allowed.length && !matchGlob(rel, allowed)) outside.push(rel);
      }
      if (outside.length) fail1(2, `letture fuori cella: ${[...new Set(outside)].join(", ")}`);
    },
    3: () => {
      const comps = [...asList(session.pending?.compensations), ...asList(plan?.compensations), ...asList(output.compensations)];
      const key = (c) => (typeof c === "string" ? [c] : [c?.entity, c?.for, c?.id, c?.ref].filter(Boolean));
      const covered = new Set(comps.flatMap(key));
      const created = asList(output.created).map((c) => (typeof c === "string" ? c : c?.id ?? c?.entity)).filter(Boolean);
      const missing = created.filter((c) => !covered.has(c));
      const creating = steps.filter((s) => /CREATE|SUBMIT/.test(String(s.action_class ?? "")) || s.verb === "SUBMIT");
      const stepCovered = (s) => comps.some((c) => c?.step === s.n);
      if (missing.length) fail1(3, `entità create senza compensazione: ${missing.join(", ")}`);
      else if (creating.length && !comps.length) fail1(3, `passi che creano senza compensazione registrata: ${creating.map((s) => s.n).join(", ")}`);
      else if (creating.some((s) => !stepCovered(s)) && !created.length && comps.every((c) => c?.step !== undefined)) {
        fail1(3, `passi che creano senza compensazione: ${creating.filter((s) => !stepCovered(s)).map((s) => s.n).join(", ")}`);
      }
    },
    4: () => {
      const reasons = [];
      if (taskEffects && decs.length === 0) reasons.push("compito con effetti senza DEC");
      for (const d of effectDecs) {
        const info = decInfo(d);
        if (!info) reasons.push(`${d}: DEC non trovata`);
        else if (!info.table || !info.strategy) reasons.push(`${d}: DEC senza ${!info.table ? "tabella" : "strategia"}`);
      }
      const noExpect = steps.filter((s) => !s || typeof s.expect !== "object" || s.expect === null || !Object.keys(s.expect).length);
      for (const s of noExpect) reasons.push(`passo ${s?.n ?? "?"} senza expect (traccia attesa, §10.5)`);
      if (reasons.length) fail1(4, reasons.join("; "));
    },
    5: () => {
      const declared = new Set([
        ...asList(parsedLesson?.frontmatter?.expected_outcomes), ...asList(session.pending?.expected_outcomes), ...asList(output.expected_outcomes),
      ].filter((e) => e && typeof (e.expect ?? e.expected) === "string" && (e.expect ?? e.expected).trim()).map((e) => e.decision ?? e.dec));
      const missing = effectDecs.filter((d) => !declared.has(d));
      if (missing.length) fail1(5, `DEC con effetti senza esito atteso: ${missing.join(", ")}`);
    },
    6: () => {
      const traceSurprises = asList(trace.surprises);
      const ctrOf = (x) => (typeof x === "string" ? (/(?:^|[^A-Z])((?:[SCL]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.)?CTR\.\d{4})/.exec(x)?.[1] ?? null) : x?.ctr ?? null);
      const reasons = [];
      traceSurprises.forEach((x, i) => { if (!ctrOf(x)) reasons.push(`sorpresa ${typeof x === "string" ? x : x?.obs ?? i + 1} senza CTR`); });
      for (const s of asList(session.surprises)) {
        if (s.task && rep?.task_id && s.task !== rep.task_id) continue;
        const inTrace = traceSurprises.some((x) => ctrOf(x) && (typeof x === "string" ? (s.obs && x.includes(s.obs)) : x?.obs === s.obs));
        const inCtr = asList(contradictions).some((c) => [c.a_code, c.b_code].includes(s.obs) && [c.a_code, c.b_code].includes(s.item));
        if (!s.ctr && !inTrace && !inCtr) reasons.push(`sorpresa di sessione ${s.obs ?? s.item ?? s.at} senza CTR`);
      }
      if (reasons.length) fail1(6, [...new Set(reasons)].join("; "));
    },
    7: () => {
      const ep = trace.epistemic ?? {};
      const miss = ["shape_before", "shape_after"].filter((k) => !SHAPES.has(ep[k]));
      if (miss.length) fail1(7, `forma epistemica non registrata: ${miss.join(", ")}`);
    },
    8: () => {
      if (!rep) { fail1(8, "il risultato non è un blocco YAML"); return; }
      if (typeof rep.output === "string") { fail1(8, "output in prosa: usa YAML compatto con codici"); return; }
      const long = strings(output).filter((s) => s.trim().split(/\s+/).length > MAX_WORDS);
      if (long.length) fail1(8, `testo oltre ${MAX_WORDS} parole nell'output (${long.length}): riformatta in YAML compatto con codici`);
    },
    9: () => {
      if (!rep?.lesson) { fail1(9, "nessuna lezione nel risultato"); return; }
      if (!parsedLesson) { fail1(9, `lezione ${rep.lesson} non trovata`); return; }
      const reasons = [];
      if (parsedLesson.frontmatter?.id && parsedLesson.frontmatter.id !== rep.lesson) reasons.push(`la lezione è ${parsedLesson.frontmatter.id}, il risultato cita ${rep.lesson}`);
      const missingSections = [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => parsedLesson.sections?.[n] === undefined);
      if (missingSections.length) reasons.push(`sezioni mancanti: ${missingSections.join(", ")}`);
      else if (sectionEmpty(parsedLesson.sections[7])) reasons.push("sezione 7 vuota");
      if (reasons.length) fail1(9, reasons.join("; "));
    },
    10: () => {
      if (rep?.status !== "ok") return;
      const blocking = asList(rep.open_questions).filter((q) => !(q && typeof q === "object" && (q.blocking === false || q.non_blocking === true)));
      if (blocking.length) fail1(10, `esito ok con ${blocking.length} domande aperte non marcate come non bloccanti`);
    },
    11: () => {
      const hasAction = steps.length > 0 || taskEffects || asList(output.actions).length > 0;
      if (!hasAction) return;
      // K6.6: il codice del report è RPT.<CLIENTE>.<AAAAMMGG>.<SEQ> (§29.8, tabella reports); resta valido il formato item L.….RPT.nnnn
      const rpts = [...codesIn(rep).filter((c) => parseCode(c)?.type === "RPT"), ...new Set(JSON.stringify(rep ?? null).match(/\bRPT\.[A-Z0-9]{4}\.\d{8}\.\d{4}\b/g) ?? [])];
      if (!rpts.length) fail1(11, "azione senza report RPT (§29.6)");
      else if (typeof kbExists !== "function") fail1(11, `esistenza di ${rpts.join(", ")} non eseguita: nessun accesso al DB (kbExists)`);
      else if (!rpts.some((c) => kbExists(c))) fail1(11, `report inesistente: ${rpts.join(", ")}`);
    },
    12: () => {
      const seen = new Map();
      const dup = new Set();
      const note = (k) => { if (seen.has(k)) dup.add(k); seen.set(k, true); };
      for (const c of asList(session.ledger?.calls)) {
        if (c?.task && rep?.task_id && c.task !== rep.task_id) continue;
        if (c?.agent_id && agentId && c.agent_id !== agentId) continue;
        note(`${c.cmd ?? ""} ${c.args_hash ?? (typeof c.args === "string" ? c.args : JSON.stringify(c.args ?? ""))}`.trim());
      }
      for (const e of events) {
        const p = e.payload ?? {};
        if (e.kind !== "tool" || !["Bash", "PowerShell"].includes(p.tool)) continue;
        const cmd = parseSummary(p.input_summary).command;
        const m = typeof cmd === "string" ? /kb(?:\.mjs)?\s+((?:find|resolve|precedents|epistemic|get|summary|fields|related|facet-count)\b.*)$/.exec(cmd.trim()) : null;
        if (m) note(`kb ${m[1].replace(/\s+/g, " ").trim()}`);
      }
      if (dup.size) fail1(12, `query kb ripetuta con gli stessi argomenti: ${[...dup].join(" · ")} — usa il risultato precedente`);
    },
    13: () => {
      const obs = asList(observations ?? session.observations);
      const repeated = new Set();
      let last = null;
      for (const o of obs) {
        if (o?.kind === "action") { last = null; continue; }
        if (o?.kind !== "snapshot") continue;
        if (last && o.page_sig && o.page_sig === last) repeated.add(o.page_sig);
        last = o.page_sig ?? null;
      }
      // K6.2: le voci di spreco che observe-append scrive nel registro di sessione (session.ledger.waste)
      for (const w of asList(session.ledger?.waste)) if (w?.kind === "repeated-snapshot" && w.page_sig) repeated.add(w.page_sig);
      if (repeated.size) fail1(13, `snapshot ripetuti della stessa pagina senza azione in mezzo: ${[...repeated].join(", ")}`);
    },
  };
  for (const n of run) checks[n]();

  const failedNs = new Set(failed.map((f) => f.n));
  const blocked = failed.some((f) => f.action === "block");
  const reclassify = failed.some((f) => f.action === "reclassify");
  let status = rep?.status ?? "partial";
  if (status === "ok" && (blocked || reclassify)) status = "partial";
  // giro 1 WP10b (I3): i controlli che `passed` conta per la profondità (rapida 1, 3, 9, 11; altrimenti 1–10)
  const base = reportedControlsFor(depth);
  return {
    passed: run.filter((n) => !failedNs.has(n)).length,
    passed_controls: run.filter((n) => !failedNs.has(n)),
    failed,
    blocked,
    status_effective: status,
    controls_run: run,
    signals,
    // per cognitive_trace.self_check: `passed` sui controlli della profondità (reportedControlsFor, ≤ 10), `failed` con
    // OGNI controllo fallito 1–13, perché il manager (Review Focus 4) veda anche #11–#13.
    trace_self_check: { passed: base.filter((n) => !failedNs.has(n)).length, failed: [...failedNs].sort((a, b) => a - b) },
  };
}

// ——— CLI ———
function readReport(file) {
  const text = readFileSync(file, "utf8");
  const fromMessage = extractReport(text);
  if (fromMessage) return fromMessage;
  const v = YAML.parse(text);
  return v && typeof v === "object" ? v : null;
}
const readYaml = (file) => YAML.parse(readFileSync(file, "utf8"));
const readJsonl = (file) => readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

const HELP = `uso: node scripts/decide/self-check.mjs --report <messaggio|yaml> --session <session.json> --audit <file.jsonl[,…]>
       --db <knowledge.db> [--plan <piano.yaml>] [--lesson <lezione.md>] [--observations <file.jsonl>]
       [--depth rapida|standard|profonda] [--agent-id <id>] [--json] [--help]

Auto-verifica prima del risultato (§17.1): i dieci controlli, #11 (ogni azione ha un RPT, §29.6) e i
rilevatori di spreco di §29.10 (controlli falliti, bloccanti). --db è obbligatorio: i codici si verificano
nel DB e le DEC (tabella, strategia, effetti) si leggono da decisions/decision_context. Stampa { passed, failed[{n, control, reason, action}],
blocked, status_effective, trace_self_check }.

Exit code: 0 nessun blocco (anche con riformattazione o riclassificazione) · 1 errore utente (file
illeggibili, argomenti) · 2 errore di sistema · 3 bloccato: il risultato non va inviato.`;

export function run(argv) {
  const { opts } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.report || !opts.session || !opts.audit || !opts.db) return fail(asJson, 1, "richiesti --report, --session, --audit, --db");
  let input;
  let db = null;
  try {
    input = {
      report: readReport(opts.report),
      session: JSON.parse(readFileSync(opts.session, "utf8")),
      audit: String(opts.audit).split(",").filter(Boolean).flatMap(readJsonl),
      plan: opts.plan ? readYaml(opts.plan) : null,
      lesson: opts.lesson ? readFileSync(opts.lesson, "utf8") : null,
      observations: opts.observations ? readJsonl(opts.observations) : undefined,
      depth: opts.depth, agentId: opts["agent-id"],
    };
    db = openDb(opts.db, { createIfMissing: false });
  } catch (e) { return fail(asJson, 1, `input illeggibile: ${e.message ?? e}`); }
  try {
    {
      const stmts = ["items", "decisions", "lessons", "observations", "contradictions", "reports"].map((t) => db.prepare(`select 1 from ${t} where code=?`));
      input.kbExists = (c) => stmts.some((s) => s.get(c));
      const dec = db.prepare(`select d.table_code, d.strategy, c.effects from decisions d left join decision_context c on c.decision_code=d.code where d.code=?`);
      input.getDecision = (c) => {
        const r = dec.get(c);
        return r ? { table: r.table_code, strategy: r.strategy, effects: r.effects === null || r.effects === undefined ? undefined : r.effects === 1 } : null;
      };
      input.contradictions = db.prepare("select code, a_code, b_code from contradictions").all();
    }
    const r = selfCheck(input);
    console.log(JSON.stringify(asJson ? { ok: !r.blocked, ...r } : r));
    return r.blocked ? 3 : 0;
  } catch (e) { return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`); } finally { db?.close(); }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
