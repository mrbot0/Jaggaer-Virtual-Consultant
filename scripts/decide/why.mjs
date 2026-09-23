// Contratto di spiegazione (§17.5) e `/vc why <codice>`.
//  - buildWhy(esito di dt-eval): because = i tre contributi più pesanti ("label valore (peso × punteggio)"),
//    did_not_choose = l'esito che il punteggio avrebbe dato oltre il bordo di banda più vicino, con lo
//    scarto; su un override l'alternativa è l'esito del solo punteggio (scarto non numerico).
//  - explain(db, codice): DEC (file decisions/<codice>.yaml o riga del DB, esito verificato, esito atteso,
//    why ricostruito dai componenti), item (riga del DB + catena di provenienza dal file, §19), RPT.
import { readFileSync, existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import YAML from "yaml";
import { evaluate, loadTable } from "./dt-eval.mjs";
import { parseCode } from "../kb/codes.mjs";
import { openDb } from "../kb/db.mjs";
import { validateWith } from "../lib/schemas.mjs";
import { isMain } from "../lib/is-main.mjs";
import { parseArgs, fail } from "../lib/args.mjs";

export class WhyNotFoundError extends Error { constructor(m) { super(m); this.name = "WhyNotFoundError"; } }

const round6 = (x) => Math.round(x * 1e6) / 1e6;
const has = (o, k) => o != null && Object.prototype.hasOwnProperty.call(o, k);
const matches = (when, values) => Object.entries(when).every(([k, v]) => has(values, k) && (Array.isArray(v) ? v.some((x) => String(x) === String(values[k])) : String(v) === String(values[k])));
const inBand = (s, from, to) => s >= from && (s < to || (to === 1 && s <= 1));

// Esito che la tabella darebbe a un punteggio dato, senza override (selettori, poi banda).
function outcomeAt(table, values, score) {
  const sel = (table.outcome_selectors ?? []).find((s) => inBand(score, s.from, s.to) && matches(s.when, values));
  if (sel) return sel.outcome;
  const band = table.thresholds.find((b) => inBand(score, b.from, b.to));
  return band ? band.outcome ?? String(values[band.outcome_from]) : null;
}

function labelOf(table, name) {
  return [...table.inputs, ...table.priors].find((x) => x.name === name)?.label ?? name;
}

export function runnerUp(table, result) {
  const values = result.inputs;
  if (String(result.rule).startsWith("override")) {
    const i = Number(/\d+/.exec(result.rule)?.[0] ?? -1);
    const alt = outcomeAt(table, values, result.score);
    if (alt && alt !== result.outcome) return { option: alt, score_gap: null, reason: `override: ${table.overrides?.[i]?.source ?? result.rule} (il punteggio ${result.score} darebbe ${alt})` };
    return null;
  }
  const edges = [...new Set(table.thresholds.flatMap((b) => [b.from, b.to]).filter((e) => e > 0 && e < 1))];
  const candidates = edges.map((e) => ({ edge: e, gap: round6(Math.abs(result.score - e)), probe: e > result.score ? e : round6(e - 1e-6) }))
    .sort((a, b) => a.gap - b.gap || a.edge - b.edge);
  for (const c of candidates) {
    const alt = outcomeAt(table, values, c.probe);
    if (alt && alt !== result.outcome) {
      return { option: alt, score_gap: c.gap, reason: `punteggio ${result.score} a ${c.gap} dal bordo ${c.edge} (${alt} ${c.edge > result.score ? "sopra" : "sotto"})` };
    }
  }
  return null;
}

export function buildWhy(result, { table, assumed = [], would_change_my_mind, did_not_choose } = {}) {
  const t = table ?? loadTable(result.table);
  const top = [...(result.components ?? [])].map((c, i) => ({ ...c, i })).filter((c) => c.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution || a.i - b.i).slice(0, 3);
  const because = top.map((c) => `${labelOf(t, c.name)} ${c.value} (${c.weight} × ${c.score})`);
  if (!because.length) because.push(`punteggio ${result.score}: nessun input con contributo (${result.rule})`);
  const alt = did_not_choose ?? [runnerUp(t, result)].filter(Boolean);
  const wcm = would_change_my_mind?.length ? would_change_my_mind
    : [top[0] ? `un'osservazione che cambi "${labelOf(t, top[0].name)}" (oggi ${top[0].value})` : `un input che porti il punteggio oltre la banda di ${result.outcome}`];
  const why = { decision: result.outcome, because, assumed: [...assumed], would_change_my_mind: wcm, did_not_choose: alt };
  const v = validateWith("why.schema.json", why);
  if (!v.ok) throw new Error(`why non valido: ${v.errors.join("; ")}`);
  return why;
}

// ——— /vc why <codice> ———
function readYamlIf(file) {
  try { return file && existsSync(file) ? YAML.parse(readFileSync(file, "utf8")) : null; } catch { return null; }
}

const PROVENANCE_KEYS = ["sources", "provenance", "promoted_from", "superseded_by", "derives_from", "deviations", "confirmed_by_observation",
  "units", "back_check", "extracted_by", "digested_by", "validated_by"];

export function explain(db, code, { root } = {}) {
  const p = parseCode(code);
  if (!p) throw new WhyNotFoundError(`codice non valido: ${code}`);
  if (p.type === "DEC") {
    const row = db.prepare("select * from decisions where code=?").get(code);
    const file = root ? join(root, "decisions", `${code}.yaml`) : null;
    const doc = readYamlIf(file);
    if (!row && !doc) throw new WhyNotFoundError(`DEC non trovato: ${code}`);
    const table = loadTable(doc?.table ?? row.table_code);
    const inputs = doc?.inputs ?? JSON.parse(row?.inputs ?? "{}");
    const priorsUsed = doc?.priors ?? JSON.parse(row?.priors ?? "[]");
    let result;
    if (doc?.components) {
      result = { table: table.id, outcome: doc.outcome, score: doc.score, rule: doc.rule, components: doc.components, inputs };
    } else {
      const priors = Object.fromEntries(priorsUsed.map((x) => [x.name, x.value]));
      result = evaluate(table, inputs, { priors });
      result.outcome = row.outcome ?? result.outcome;
    }
    const verified = db.prepare("select result, verified_at, verified_by, evidence_code as evidence, note from outcomes where decision_code=?").get(code) ?? null;
    const expected = db.prepare("select expect from expected_outcomes where decision_code=?").get(code)?.expect ?? null;
    return {
      code, kind: "DEC", table: table.id, table_version: doc?.table_version ?? table.version, decision: table.decision,
      agent: doc?.agent ?? row?.agent ?? null, session: doc?.session ?? row?.session ?? null, subject: doc?.subject ?? row?.subject_code ?? null,
      strategy: doc?.strategy ?? row?.strategy ?? null, at: doc?.at ?? row?.at ?? null,
      inputs, priors: priorsUsed, score: result.score, outcome: result.outcome, rule: result.rule, expected, verified,
      why: buildWhy(result, { table }),
    };
  }
  const item = db.prepare("select * from items where code=?").get(code);
  if (!item) throw new WhyNotFoundError(`codice non trovato: ${code}`);
  const path = item.path && (isAbsolute(item.path) ? item.path : root ? join(root, item.path) : item.path);
  const doc = readYamlIf(path) ?? {};
  const provenance = Object.fromEntries(PROVENANCE_KEYS.filter((k) => doc[k] !== undefined).map((k) => [k, doc[k]]));
  const facets = (() => { try { return JSON.parse(item.facets); } catch { return {}; } })();
  const out = {
    code, kind: p.type === "RPT" ? "RPT" : "item", type: item.type, title: item.title, summary: item.summary, status: item.status,
    confidence: item.confidence, quality: item.quality, weight: item.weight, verified_at: item.verified_at, release: item.release_ref,
    origin: facets.F1 ?? doc.facets?.F1 ?? null, provenance,
  };
  if (p.type === "RPT") out.report = Object.fromEntries(Object.entries(doc).filter(([k]) => !["id", "type", "title", "summary"].includes(k)));
  return out;
}

function renderText(w) {
  const lines = [`${w.code} — ${w.kind}`];
  if (w.kind === "DEC") {
    lines.push(`${w.table} v${w.table_version}: ${w.decision}`, `esito: ${w.outcome} (punteggio ${w.score}, ${w.rule})${w.strategy ? ` · strategia ${w.strategy}` : ""}`);
    lines.push(`perché: ${w.why.because.join(" · ")}`);
    if (w.why.did_not_choose.length) lines.push(`non scelto: ${w.why.did_not_choose.map((d) => `${d.option} (${d.reason})`).join(" · ")}`);
    lines.push(`would_change_my_mind (cosa mi farebbe cambiare idea): ${w.why.would_change_my_mind.join(" · ")}`);
    lines.push(`esito atteso: ${w.expected ?? "—"} · verificato: ${w.verified ? `${w.verified.result} (${w.verified.verified_by})` : "no"}`);
  } else {
    lines.push(`${w.type} · ${w.status} · confidenza ${w.confidence} · ${w.title}`, w.summary);
    for (const [k, v] of Object.entries(w.provenance)) lines.push(`${k}: ${JSON.stringify(v)}`);
  }
  return lines.join("\n");
}

const HELP = `uso: node scripts/decide/why.mjs <codice> --db <knowledge.db> [--root <cartella del cliente>] [--json] [--help]

Spiega un codice (/vc why, §17.5): una DEC (tabella, input, priori, strategia, esito, esito atteso e
verificato, blocco why con i tre input più pesanti, l'alternativa scartata e lo scarto), un item (catena di
provenienza, §19) o un report RPT.

Exit code: 0 ok · 1 errore utente (codice ignoto o non valido, DB assente) · 2 errore di sistema.`;

export function run(argv) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!positional[0]) return fail(asJson, 1, "codice mancante");
  if (!opts.db) return fail(asJson, 1, "richiesto --db");
  let db;
  try { db = openDb(opts.db, { createIfMissing: false }); } catch (e) { return fail(asJson, 1, String(e.message ?? e)); }
  try {
    const w = explain(db, positional[0], { root: opts.root });
    console.log(asJson ? JSON.stringify({ ok: true, ...w }) : renderText(w));
    return 0;
  } catch (e) {
    if (e instanceof WhyNotFoundError) return fail(asJson, 1, e.message);
    return fail(asJson, 2, `errore di sistema: ${e.message ?? e}`);
  } finally { db.close(); }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
