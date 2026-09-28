// promotion (F7, §27.3): macchina a stati dei casi NRT candidate → shadow → promoted | quarantine, con budget di flakiness.
//
//   decide(caso, { results, openCtr = [], lint = [], window = 10, flakyBudget = 1 }) → { from, to, reason, evidence }
//     results: esiti dei run del piano PLAN.<caso> in ordine di tempo ({ run, status green|yellow|stopped|…, plan_hash });
//     - flakiness: nella finestra degli ultimi `window` esiti del piano PLAN.<caso>, i cambi di esito fra run
//       consecutivi (verde ↔ non verde) oltre `flakyBudget` ⇒ quarantine (da shadow o promoted): esiti incoerenti
//       non sono un segnale; un solo passaggio a rosso resta un segnale (regressione), non flakiness;
//     - candidate → shadow: caso valido, lint-spec e lint-scope puliti;
//     - (giro 1, I3) contano solo gli esiti con l'impronta della versione attuale del caso (scripts/lib/fingerprint.mjs);
//     - shadow → promoted: 3 run coerenti (gli ultimi 3 esiti verdi del piano: il piano può differire fra run solo per i
//       dati del run, come il prefisso NRT-<data>-<run>; le modifiche del caso le sorveglia lint-spec --against), 1 se il soggetto era
//       consolidato con precedente di suite verde (epistemic_at_generation.green_precedent); mai con una contraddizione
//       (CTR) aperta sul soggetto; un NEG promosso dichiara expected_errors;
//     - quarantine → shadow: solo a mano (reason), dopo la riparazione.
//   apply(ws, { customer, file, decision, now }) → scrive lo stato nel file del caso e una riga in
//     customers/<C>/tests/promotion-log.jsonl (mai in kb/: i casi stanno in tests/).
//
// CLI: node scripts/run/promotion.mjs evaluate --case <file> [--apply] [--customer C] [--workspace <dir>] [--json]
//      node scripts/run/promotion.mjs release --case <file> --reason <testo>      (quarantine → shadow, a mano)
// Exit: 0 ok · 1 argomenti · 2 errore di sistema.
import { readFileSync, existsSync, readdirSync, appendFileSync, mkdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { runResults } from "../lib/run-results.mjs";
import { validateCase } from "../kb/validate-schema.mjs";
import { lintCase } from "../compile/lint-spec.mjs";
import { lintScope } from "../compile/lint-scope.mjs";
import { workspaceCustomer } from "./fixtures.mjs";
import { caseFingerprint } from "../lib/fingerprint.mjs";
export { caseFingerprint };

export const PROMOTE_AFTER = 3;
const green = (r) => r?.status === "green" || r?.status === "pass";

export function flakiness(results, { window = 10 } = {}) {
  if (!results.length) return 0;
  const w = results.slice(-window);
  let flips = 0;
  for (let i = 1; i < w.length; i++) if (green(w[i]) !== green(w[i - 1])) flips++;
  return flips;
}

export function decide(caso, { results: all = [], fingerprint = null, greenPrecedent = false, openCtr = [], lint = [], window = 10, flakyBudget = 1 } = {}) {
  const from = caso.state;
  // WP09b giro 1 (I3): con l'impronta contano solo gli esiti della versione attuale del caso
  const results = fingerprint ? all.filter((r) => r.fingerprint === fingerprint) : all;
  const stay = (reason) => ({ from, to: from, reason });
  const subjects = new Set([...(caso.derivation?.from ?? []), caso.epistemic_at_generation?.subject].filter(Boolean));
  const flips = flakiness(results, { window });
  if ((from === "shadow" || from === "promoted") && flips > flakyBudget) {
    return { from, to: "quarantine", reason: `esiti incoerenti: ${flips} cambi fra run consecutivi (budget di flakiness ${flakyBudget})`, evidence: results.slice(-window).map((r) => `${r.run}:${r.status}`) };
  }
  if (from === "candidate") {
    const v = validateCase(caso);
    if (!v.ok) return stay(`caso non valido: ${v.errors.join("; ")}`);
    if (lint.length) return stay(`lint da risolvere: ${lint.map((x) => x.rule).join(", ")}`);
    return { from, to: "shadow", reason: "caso valido e lint puliti: in shadow (esecuzioni che non contano per il verdetto)" };
  }
  if (from === "shadow") {
    const ctr = openCtr.filter((c) => subjects.has(c.a_code) || subjects.has(c.b_code) || subjects.has(c.subject));
    if (ctr.length) return stay(`contraddizione aperta sul soggetto (${ctr.map((c) => c.code).join(", ")}): mai promuovere`);
    if (caso.genre === "NEG" && !(caso.expected_errors ?? []).length) return stay("un NEG si promuove solo con gli errori attesi (ERR) dichiarati");
    // il precedente verde si ricava dai risultati (greenPrecedent), mai dalla dichiarazione del caso stesso
    const fast = caso.epistemic_at_generation?.shape === "consolidato" && greenPrecedent === true;
    const need = fast ? 1 : PROMOTE_AFTER;
    const tail = results.slice(-need);
    if (tail.length === need && tail.every(green)) return { from, to: "promoted", reason: `${need} run coerenti verdi${fast ? " (consolidato con precedente verde: una basta)" : ""}`, evidence: tail.map((r) => r.run) };
    return stay(`servono ${need} run verdi coerenti (ne ha ${tail.filter(green).length} fra gli ultimi ${tail.length})`);
  }
  return stay(from === "quarantine" ? "in quarantena: si riporta in shadow solo a mano dopo la riparazione" : "promosso: resta finché gli esiti sono coerenti");
}

export function openContradictions(ws, customer) {
  const dir = join(ws, "customers", customer, "contradictions");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) { try { const c = YAML.parse(readFileSync(join(dir, f), "utf8")); if (c && !["risolta", "resolved", "closed", "chiusa"].includes(String(c.status ?? "open").toLowerCase())) out.push({ code: c.id ?? c.code ?? f, a_code: c.a_code ?? null, b_code: c.b_code ?? null, subject: c.subject ?? null }); } catch { /* ignorato */ } }
  return out;
}

// Precedente di suite verde (§27.3): un ALTRO caso promosso sullo stesso soggetto il cui ultimo esito (con la sua impronta
// attuale) è verde. Letto dai risultati, mai dal caso che chiede la promozione.
export function greenPrecedentOf(ws, customer, caso) {
  const subject = caso.epistemic_at_generation?.subject ?? caso.derivation?.from?.[0];
  const dir = join(ws, "customers", customer, "tests", "cases", caso.scope ?? "");
  if (!subject || !existsSync(dir)) return false;
  for (const f of readdirSync(dir).filter((x) => /\.ya?ml$/.test(x))) {
    let o; try { o = YAML.parse(readFileSync(join(dir, f), "utf8")); } catch { continue; }
    if (!o?.id || o.id === caso.id || o.state !== "promoted") continue;
    if (!(o.derivation?.from ?? []).includes(subject) && o.epistemic_at_generation?.subject !== subject) continue;
    const fp = caseFingerprint(o);
    const last = runResults(ws, customer, { planIds: [`PLAN.${o.id}`] }).filter((r) => r.fingerprint === fp).at(-1);
    if (green(last)) return true;
  }
  return false;
}

export function evaluateCase(ws, customer, caso) {
  const results = runResults(ws, customer, { planIds: [`PLAN.${caso.id}`] });
  const lint = caso.state === "candidate" ? [...lintCase(caso, { ws, customer }), ...lintScope(caso, { ws, customer })] : [];
  return decide(caso, { results, fingerprint: caseFingerprint(caso), greenPrecedent: greenPrecedentOf(ws, customer, caso), openCtr: openContradictions(ws, customer), lint });
}

export function apply(ws, { customer, file, caso, decision, now = new Date(), by = "promotion" }) {
  if (decision.to === decision.from) return false;
  const next = { ...caso, state: decision.to };
  const v = validateCase(next);
  if (!v.ok) throw new Error(`stato ${decision.to} non applicabile: ${v.errors.join("; ")}`);
  writeFileAtomic(file, YAML.stringify(next));
  const log = join(ws, "customers", customer, "tests", "promotion-log.jsonl");
  mkdirSync(join(log, ".."), { recursive: true });
  appendFileSync(log, `${JSON.stringify({ ts: now.toISOString(), case: caso.id, from: decision.from, to: decision.to, reason: decision.reason, evidence: decision.evidence ?? [], by })}\n`);
  return true;
}

const HELP = `uso: node scripts/run/promotion.mjs evaluate --case <file> [--apply] [--customer C] [--workspace <dir>] [--json]
       node scripts/run/promotion.mjs release --case <file> --reason <testo>
Macchina candidate → shadow → promoted | quarantine (§27.3): 3 run coerenti (1 se consolidato con precedente verde),
budget di flakiness, mai con una CTR aperta sul soggetto. release: quarantine → shadow a mano.
Exit code: 0 ok · 1 argomenti · 2 errore di sistema.`;

export function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv, { flags: ["apply"] });
  const asJson = !!opts.json;
  const [cmd] = positional;
  if (opts.help || !cmd) { console.log(HELP); return opts.help ? 0 : 1; }
  if (!opts.case) return fail(asJson, 1, "richiesto --case <file>");
  const { ws, customer } = workspaceCustomer(opts, env);
  const file = resolvePath(opts.case);
  try {
    const caso = YAML.parse(readFileSync(file, "utf8"));
    const cust = customer ?? caso?.id?.split(".")[1];
    if (!cust || cust === "STD") return fail(asJson, 1, "cliente non determinato: --customer <C>");
    if (cmd === "evaluate") {
      const d = evaluateCase(ws, cust, caso);
      const applied = opts.apply ? apply(ws, { customer: cust, file, caso, decision: d }) : false;
      console.log(asJson ? JSON.stringify({ ok: true, case: caso.id, ...d, applied }) : `${caso.id}: ${d.from} → ${d.to} (${d.reason})${applied ? " — applicato" : ""}`);
      return 0;
    }
    if (cmd === "release") {
      if (caso.state !== "quarantine") return fail(asJson, 1, `${caso.id} non è in quarantena`);
      if (!opts.reason) return fail(asJson, 1, "richiesto --reason (la riparazione fatta)");
      apply(ws, { customer: cust, file, caso, decision: { from: "quarantine", to: "shadow", reason: opts.reason }, by: "manuale" });
      console.log(asJson ? JSON.stringify({ ok: true, case: caso.id, from: "quarantine", to: "shadow" }) : `${caso.id}: quarantine → shadow`);
      return 0;
    }
    return fail(asJson, 1, `comando sconosciuto: ${cmd}`);
  } catch (err) {
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
