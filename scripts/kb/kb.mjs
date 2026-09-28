import { openDb } from "./db.mjs";
import { find, InvalidFacetError } from "./find.mjs";
import { resolve } from "./resolve.mjs";
import { precedents } from "./precedents.mjs";
import { fields, InvalidInputError, NotFoundError } from "./fields.mjs";
import { impact } from "./impact.mjs";
import { identityCard, identityMissing } from "./identity.mjs";
import { isMain } from "../lib/is-main.mjs";
import { recordCall } from "../lib/call-ledger.mjs";
import { units as searchUnits, questionFor, UnitsInputError } from "./units.mjs";
import { readFileSync } from "node:fs";
import { main as reviewMain } from "./review.mjs";
import { main as coverageMain } from "./coverage-report.mjs";
import { main as compensationMain } from "./compensation.mjs";
import { main as snapshotMain } from "./snapshot.mjs";
import { main as kbCoverageMain } from "./coverage.mjs";

const HELP = `uso: node scripts/kb/kb.mjs <comando> [opzioni]

Comandi:
  find      --scope --type --status --level --customer --facet K=V --top N
  resolve   "<testo libero>" --top N
  summary   <codice>
  get       <codice>
  precedents <soggetto> --top N [--customer ACME] [--shape <forma>] [--release R] [--releases R1,R2,…] [--cluster CL-…]
            decisioni passate con esito, ordinate per distanza di contesto (§12.3); le release (dalla più
            vecchia) danno l'età dei precedenti, altrimenti meta 'releases' del DB
  fields    [--doc requisition] [--mandatory-in STATO] [--company IT01] [--chain CL-FLD-CHAIN-nnn] [--custom]
            [--reason integration|workflow|legal|business|ui|derived] [--section S] [--top 50]
            codici FLD con summary di 20 parole (§19.6.5); --reason ui = obbligatori senza ragione a valle
  impact    <codice FLD> [--if "mandatory.kind = never" | --if removed]
            cosa si rompe a valle (mapping INT obbligatori, campi che lo richiedono, campi obbligatori a valle)
  identity  <codice FLD> | --doc <documento> --missing <blocco>
            carta d'identità compatta (§19.20) · i campi del documento senza il blocco
  units     [--doc <DOC>] [--near <soggetto>] [--query "<domanda>" | --query-file <file> | --question CFG.impacts]
            [--type <tipo di unità>] [--top 5]
            unità di significato (§19.9) per la digestione guidata (§19.11): FTS + prossimità di sezione del
            soggetto; --question prende la domanda dalla banca product/question-banks/<TIPO>.yaml
  review    → scripts/kb/review.mjs (coda stratificata e verbi accept/correct/reject, §19.19)
  epistemic --scope <S> [--plan] → scripts/kb/coverage-report.mjs (report di copertura §9.6, piano R0)
  compensation add|list|done → scripts/kb/compensation.mjs (compensazione PRIMA del passo, §29.6)
  snapshot <CFG…> → scripts/kb/snapshot.mjs (stato degli oggetti governati prima di una modifica, §28.1)
  coverage [--scope S] → scripts/kb/coverage.mjs (matrice CL-CFG × scope con forma epistemica, §28.2; copertura NRT: coverage.mjs nrt)

Opzioni comuni: --db <file> (default knowledge.db) --json --help

Exit code: 0 ok · 1 errore utente (comando/argomenti non validi, DB assente) · 2 errore di sistema.`;

// Opzioni booleane: non prendono valore (un posizionale dopo --json resta un posizionale).
const BOOL_FLAGS = new Set(["--json", "--help", "--custom"]);
function parseArgs(rest) {
  const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 && !BOOL_FLAGS.has(`--${k}`) ? rest[i + 1] : d; };
  const facet = rest.filter((x, i) => rest[i - 1] === "--facet").reduce((a, kv) => { const [k, v] = kv.split("="); a[k] = v; return a; }, {});
  const positional = rest.filter((x, i) => !x.startsWith("--") && !(rest[i - 1]?.startsWith("--") && !BOOL_FLAGS.has(rest[i - 1])));
  return { opt, facet, positional };
}

export function run(argv) {
  const [cmd, ...rest] = argv;
  const asJson = rest.includes("--json") || argv.includes("--json");
  if (!cmd || cmd === "--help" || rest.includes("--help")) {
    if (!asJson) console.log(HELP);
    return { exitCode: cmd ? 0 : 1 };
  }
  // WP09a: sotto-comandi con una CLI propria (radice del workspace, non il solo DB)
  if (cmd === "review") return { exitCode: reviewMain(rest) };
  if (cmd === "epistemic") return { exitCode: coverageMain(rest) };
  // WP09b: compensazioni e snapshot (stato della sessione e del run, non il solo DB)
  if (cmd === "compensation") return { exitCode: compensationMain(rest) };
  if (cmd === "snapshot") return { exitCode: snapshotMain(rest) };
  if (cmd === "coverage") return { exitCode: kbCoverageMain(rest) };
  const { opt, facet, positional } = parseArgs(rest);
  const dbPath = opt("db", "knowledge.db");
  if (!["find", "resolve", "summary", "get", "precedents", "fields", "impact", "identity", "units"].includes(cmd)) {
    const msg = `comando sconosciuto: ${cmd}`;
    console.log(asJson ? JSON.stringify({ ok: false, error: msg }) : `errore: ${msg}\n${HELP}`);
    return { exitCode: 1 };
  }
  if (cmd === "impact" && !positional[0]) {
    const msg = "impact richiede il codice del campo";
    console.log(asJson ? JSON.stringify({ ok: false, error: msg }) : `errore: ${msg}`);
    return { exitCode: 1 };
  }
  if (cmd === "precedents" && !positional[0]) {
    const msg = "precedents richiede il codice del soggetto";
    console.log(asJson ? JSON.stringify({ ok: false, error: msg }) : `errore: ${msg}`);
    return { exitCode: 1 };
  }
  // K6.7: ledger delle chiamate (spreco: la stessa query ripetuta nel compito ⇒ self-check #12)
  recordCall(`kb ${cmd}`, rest);
  let db;
  try {
    db = openDb(dbPath, { createIfMissing: false });
  } catch (err) {
    const msg = String(err?.message ?? err);
    console.log(asJson ? JSON.stringify({ ok: false, error: msg }) : `errore: ${msg}`);
    return { exitCode: 1 };
  }
  const top = Number(opt("top", cmd === "precedents" ? 5 : cmd === "fields" ? 50 : 10));
  const t0 = Date.now();
  let items;
  try {
    if (cmd === "find") {
      items = find(db, { scope: opt("scope"), type: opt("type"), status: opt("status"), level: opt("level"), customer: opt("customer"), facet, top });
    } else if (cmd === "resolve") {
      const text = positional.join(" ");
      items = resolve(db, text, { top });
    } else if (cmd === "summary") {
      items = db.prepare("select code,summary from items where code=?").all(positional[0]);
    } else if (cmd === "get") {
      items = db.prepare("select * from items where code=?").all(positional[0]);
    } else if (cmd === "fields") {
      const r = fields(db, { doc: opt("doc"), mandatoryIn: opt("mandatory-in"), company: opt("company"), chain: opt("chain"), custom: rest.includes("--custom"),
        reason: opt("reason"), section: opt("section"), top });
      console.log(JSON.stringify({ ok: true, items: r.items, truncated: r.truncated, total: r.total, took_ms: Date.now() - t0 }));
      return { exitCode: 0 };
    } else if (cmd === "impact") {
      const r = impact(db, positional[0], { if: opt("if") });
      console.log(JSON.stringify({ ok: true, ...r, took_ms: Date.now() - t0 }));
      return { exitCode: 0 };
    } else if (cmd === "identity") {
      items = opt("missing") !== undefined || !positional[0] ? identityMissing(db, { doc: opt("doc"), missing: opt("missing") }) : [identityCard(db, positional[0])];
    } else if (cmd === "units") {
      let query = opt("query");
      if (opt("query-file")) query = readFileSync(opt("query-file"), "utf8");
      let question = null;
      if (opt("question")) { question = questionFor(opt("question")); query = [...(question.keywords?.en ?? []), ...(question.keywords?.it ?? []), question.question].join(" "); }
      const r = searchUnits(db, { doc: opt("doc"), near: opt("near"), query, type: opt("type"), top: Number(opt("top", 5)) });
      console.log(JSON.stringify({ ok: true, question: question ? { type: question.type, attribute: question.attribute, question: question.question } : undefined, items: r, took_ms: Date.now() - t0 }));
      return { exitCode: 0 };
    } else if (cmd === "precedents") {
      const releases = opt("releases") ? String(opt("releases")).split(",").map((x) => x.trim()).filter(Boolean) : undefined;
      const context = { shape: opt("shape"), release: opt("release"), releases, cluster: opt("cluster") };
      items = precedents(db, positional[0], { top, customer: opt("customer"), context });
    }
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (err instanceof InvalidFacetError || err instanceof InvalidInputError || err instanceof NotFoundError || err instanceof UnitsInputError) {
      console.log(asJson ? JSON.stringify({ ok: false, error: msg }) : `errore: ${msg}`);
      return { exitCode: 1 };
    }
    console.log(asJson ? JSON.stringify({ ok: false, error: msg }) : `errore di sistema: ${msg}`);
    return { exitCode: 2 };
  }
  console.log(JSON.stringify({ ok: true, items, truncated: items.length >= top, took_ms: Date.now() - t0 }));
  return { exitCode: 0 };
}

if (isMain(import.meta.url)) {
  const { exitCode } = run(process.argv.slice(2));
  process.exit(exitCode);
}
