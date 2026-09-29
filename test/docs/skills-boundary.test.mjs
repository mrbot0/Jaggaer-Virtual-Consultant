// WP10c — confine delle skill (brief wp10c-skills, §44.3 "la skill dice come, la conoscenza dice cosa"): nessuna skill
// porta contenuto di cliente o proprietario. Le regole dei codici analitici e dei test sono quelle di
// scripts/kb/validate-boundary.mjs (BOUNDARY_RULES, riusate, non riscritte: la regola "kb cita analysis/" è di cartella e
// non si applica alle skill, che il confine lo insegnano); in più nessuna cartella di un cliente concreto, nessun codice
// di item, run, sessione o report con un valore concreto (i fatti stanno in kb/ e product/), nessun cliente fittizio
// degli esempi della spec; nessun frammento di 8 parole del corpus JAGGAER DOC (solo in locale, come per evals/).
// Le 26 skill di metodo non contengono frasi dell'utente (le regole di guard-phrase): un sub-agente che le copiasse in un
// input di strumento verrebbe negato; solo agent-manager le mostra, perché è la sessione principale a presentarle.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, extname } from "node:path";
import { ROOT } from "../helpers/hook-env.mjs";
import { BOUNDARY_RULES } from "../../scripts/kb/validate-boundary.mjs";
import { PHRASES, CONTROL_PHRASES } from "../../hooks/lib/guards/phrase.mjs";
import { MANAGER, allSkills, fullText } from "../helpers/skills-md.mjs";

const CONTENT_RULES = BOUNDARY_RULES.filter((r) => !/analysis\\\//.test(r.re.source));
const EXTRA = [
  { re: /customers\/[A-Z0-9]{4}\b/, rule: "cartella di un cliente concreto (usa customers/<C>/)" },
  { re: /\b[SCL]\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.[A-Z]{3}\.\d{4}\b/, rule: "codice di item concreto (la conoscenza sta in kb/ e product/)" },
  { re: /\b(?:SES|RUN|RPT)\.[A-Z0-9]{4}\.\d/, rule: "codice di sessione, run o report di un cliente" },
  { re: /\bNRT\.[A-Z0-9]{3,4}\.[A-Z0-9]{3}\.[A-Z]{3}\.\d{4}\b/, rule: "codice di test concreto" },
  { re: /\b(?:ACME|BETA|GAMMA)\b/, rule: "cliente degli esempi della spec" },
];

test("le regole di validate-boundary sono riusate (codici analitici e di test) e nessuna skill le viola", () => {
  assert.ok(CONTENT_RULES.length >= 2, "BOUNDARY_RULES: regole di contenuto attese");
  const bad = [];
  for (const s of allSkills()) {
    const t = fullText(s);
    for (const r of [...CONTENT_RULES, ...EXTRA]) { const m = r.re.exec(t); if (m) bad.push(`${s.name}: ${r.rule} → "${m[0]}"`); }
  }
  assert.deepEqual(bad, []);
});

test("le 26 skill di metodo non contengono frasi dell'utente (approvazione, esplorazione, controllo) — solo agent-manager le presenta", () => {
  const bad = [];
  for (const s of allSkills().filter((x) => x.name !== MANAGER)) {
    const t = fullText(s);
    const a = PHRASES.exec(t);
    if (a) bad.push(`${s.name}: frase di approvazione o esplorazione "${a[0]}"`);
    const c = CONTROL_PHRASES.exec(t);
    if (c) bad.push(`${s.name}: frase di controllo "${c[2]}"`);
  }
  assert.deepEqual(bad, []);
  const m = allSkills().find((x) => x.name === MANAGER);
  assert.ok(PHRASES.test(fullText(m)) && CONTROL_PHRASES.test(fullText(m)), "agent-manager mostra le frasi all'utente");
});

// Frammenti di 8 parole delle skill contro il corpus di partenza (JAGGAER DOC/, gitignorato: solo in locale).
const SHINGLE = 8;
const words = (s) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);

test("confine: nessun frammento del corpus JAGGAER DOC nelle skill (8 parole consecutive)", async (t) => {
  const corpus = join(ROOT, "JAGGAER DOC");
  if (process.env.JVC_SKIP_CORPUS === "1") { t.skip("JVC_SKIP_CORPUS=1: controllo sul corpus saltato"); return; }
  if (!existsSync(corpus)) { t.skip("corpus JAGGAER DOC assente (gitignorato): controllo solo in locale"); return; }
  const mine = new Map();
  for (const s of allSkills()) {
    const w = words(fullText(s));
    for (let i = 0; i + SHINGLE <= w.length; i++) { const k = w.slice(i, i + SHINGLE).join(" "); if (!mine.has(k)) mine.set(k, s.name); }
  }
  const { parseDocx } = await import("../../scripts/ingest/parse-docx.mjs");
  const { parsePdf } = await import("../../scripts/ingest/parse-pdf.mjs");
  const hits = [];
  const walk = function* (d) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) yield* walk(p); else yield p; } };
  for (const f of walk(corpus)) {
    const x = extname(f).toLowerCase();
    let text;
    try {
      if ([".txt", ".xml", ".csv"].includes(x)) text = readFileSync(f, "utf8");
      else if (x === ".docx") text = JSON.stringify(parseDocx(readFileSync(f), { id: "C", title: "c" }));
      else if (x === ".pdf") text = JSON.stringify(parsePdf(readFileSync(f), { id: "C", title: "c" }));
      else continue;
    } catch { continue; }
    const w = words(text);
    for (let i = 0; i + SHINGLE <= w.length; i++) {
      const k = w.slice(i, i + SHINGLE).join(" ");
      // il frammento non si stampa (è testo proprietario): basta la skill che lo contiene
      if (mine.has(k)) { hits.push(`${mine.get(k)}: frammento del corpus (${k.split(" ").length} parole)`); mine.delete(k); }
    }
  }
  assert.deepEqual(hits, []);
});
