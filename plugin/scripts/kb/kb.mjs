import { openDb } from "./db.mjs";
import { find, InvalidFacetError } from "./find.mjs";
import { resolve } from "./resolve.mjs";
import { precedents } from "./precedents.mjs";
import { fields, InvalidInputError, NotFoundError } from "./fields.mjs";
import { impact } from "./impact.mjs";
import { identityCard, identityMissing } from "./identity.mjs";
import { isMain } from "../lib/is-main.mjs";
import { readTextFile, inputBase, inputFile } from "../lib/text-file.mjs";
import { recordCall } from "../lib/call-ledger.mjs";
import { units as searchUnits, questionFor, UnitsInputError } from "./units.mjs";
import { readFileSync } from "node:fs";
import { main as reviewMain } from "./review.mjs";
import { main as coverageMain } from "./coverage-report.mjs";
import { main as compensationMain } from "./compensation.mjs";
import { main as snapshotMain } from "./snapshot.mjs";
import { main as kbCoverageMain } from "./coverage.mjs";
import { related, facetCount, clusters, contradictions, scopes, handoffs, validateHandoffs, graph } from "./registries.mjs";
import { rates } from "../digest/outcomes-rates.mjs";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

const HELP = `uso: node scripts/kb/kb.mjs <comando> [opzioni]

Comandi:
  find      --scope --type --status --level --customer --cluster CL-… --facet K=V --top N
  resolve   "<testo libero>" | --text-file <file> --top N   (--text-file: la domanda da un file del workspace)
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
  epistemic --scope <S> [--plan] | epistemic <codice> → scripts/kb/coverage-report.mjs (report di copertura §9.6, piano R0; per soggetto)
  compensation add|list|done → scripts/kb/compensation.mjs (compensazione PRIMA del passo, §29.6)
  snapshot <CFG…> → scripts/kb/snapshot.mjs (stato degli oggetti governati prima di una modifica, §28.1)
  coverage [--scope S] → scripts/kb/coverage.mjs (matrice CL-CFG × scope con forma epistemica, §28.2; copertura NRT: coverage.mjs nrt)
  related   <codice> [--kind K] [--top N]          relazioni (relations) in entrambe le direzioni, ordinate per W
  facet-count --facet Fn [--scope --type --level --customer --status]   conteggi per valore (matrice §28.2)
  graph     [--scope S] [--root <cartella con kb/>] [--product-db <file>]  coerenza: riferimenti pendenti, handoff
            mancanti per riferimenti fra scope (exit 3 se incoerente)
  scopes    [--root <dir>]…                        registro + estensione kb/scopes.yaml (§49.3)
  handoffs  [--scope S] [--root <dir>] [--validate]  HND con i due lati e il test reciproco (exit 3 se --validate fallisce)
  clusters  [--family CL-XXX] [--status S]          registro dei cluster con membri e digestioni vuote
  contradictions [--open]                          CTR del registro
  outcomes  [--table DT-0nn] [--cluster CL-…] [--customer C] [--window 30]   tassi di esito (outcomes-rates)
  promote   <codice> --customer C [--to product --approval <token>] → scripts/kb/lifecycle.mjs
  deprecate <codice> --superseded-by <codice> [--customer C] → scripts/kb/lifecycle.mjs
  migrate   --db <file> [--root <dir>] [--dry-run] → scripts/kb/migrate.mjs (migrazioni + knowledge_version, §49.4)
  atlas-write --in <bozza> | --from-plan <plan.json> --title <t> --customer C --scope S → scripts/kb/atlas-write.mjs
            (memoria dell'esplorazione: SEL/FLD/FLW osservati nella conoscenza del cliente)

Opzioni comuni: --db <file> (default knowledge.db) --json --help

Exit code: 0 ok · 1 errore utente (comando/argomenti non validi, DB assente) · 2 errore di sistema ·
3 incoerenza o rifiuto per policy (graph, handoffs --validate, promote).`;

// Opzioni booleane: non prendono valore (un posizionale dopo --json resta un posizionale).
const BOOL_FLAGS = new Set(["--json", "--help", "--custom", "--validate", "--open", "--dry-run"]);
function parseArgs(rest) {
  const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 && !BOOL_FLAGS.has(`--${k}`) ? rest[i + 1] : d; };
  const facet = rest.filter((x, i) => rest[i - 1] === "--facet").reduce((a, kv) => { const [k, v] = kv.split("="); a[k] = v; return a; }, {});
  const positional = rest.filter((x, i) => !x.startsWith("--") && !(rest[i - 1]?.startsWith("--") && !BOOL_FLAGS.has(rest[i - 1])));
  return { opt, facet, positional };
}

// Sotto-comandi con CLI propria e asincrona (scrivono file del workspace o il DB): promote, deprecate, migrate.
export async function runAsync(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === "promote" || cmd === "deprecate") return { exitCode: await (await import("./lifecycle.mjs")).main(cmd, rest) };
  if (cmd === "migrate") return { exitCode: (await import("./migrate.mjs")).main(rest) };
  if (cmd === "atlas-write") return { exitCode: await (await import("./atlas-write.mjs")).main(rest) };
  return run(argv);
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
  if (!["find", "resolve", "summary", "get", "precedents", "fields", "impact", "identity", "units",
    "related", "facet-count", "graph", "scopes", "handoffs", "clusters", "contradictions", "outcomes"].includes(cmd)) {
    const msg = `comando sconosciuto: ${cmd}`;
    console.log(asJson ? JSON.stringify({ ok: false, error: msg }) : `errore: ${msg}\n${HELP}`);
    return { exitCode: 1 };
  }
  if (cmd === "impact" && !positional[0]) {
    const msg = "impact richiede il codice del campo";
    console.log(asJson ? JSON.stringify({ ok: false, error: msg }) : `errore: ${msg}`);
    return { exitCode: 1 };
  }
  if (cmd === "related" && !positional[0]) {
    const msg = "related richiede il codice dell'item";
    console.log(asJson ? JSON.stringify({ ok: false, error: msg }) : `errore: ${msg}`);
    return { exitCode: 1 };
  }
  if (cmd === "precedents" && !positional[0]) {
    const msg = "precedents richiede il codice del soggetto";
    console.log(asJson ? JSON.stringify({ ok: false, error: msg }) : `errore: ${msg}`);
    return { exitCode: 1 };
  }
  // revisione finale: i file d'ingresso nel workspace degli hook, controllati prima di ogni altra cosa
  for (const k of ["text-file", "query-file"]) {
    const v = opt(k);
    if (v === undefined) continue;
    const c = inputFile(String(v));
    if (c.error) { console.log(asJson ? JSON.stringify({ ok: false, error: `--${k}: ${c.error}` }) : `errore: --${k}: ${c.error}`); return { exitCode: 1 }; }
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
  const top = Number(opt("top", cmd === "precedents" ? 5 : cmd === "fields" ? 50 : cmd === "related" ? 20 : 10));
  const roots = rest.filter((x, i) => rest[i - 1] === "--root");
  const out = (obj, code = 0) => { console.log(JSON.stringify({ ok: code === 0, ...obj, took_ms: Date.now() - t0 })); return { exitCode: code }; };
  const t0 = Date.now();
  let items;
  try {
    if (cmd === "find") {
      items = find(db, { scope: opt("scope"), type: opt("type"), status: opt("status"), level: opt("level"), customer: opt("customer"), cluster: opt("cluster"), facet, top });
    } else if (cmd === "resolve") {
      // WP10a: --text-file (la domanda dell'utente da file: i guard negano ? , e lettere accentate in linea)
      let text = positional.join(" ");
      if (opt("text-file")) { const t = readTextFile(inputBase(), opt("text-file")); if (t.error) throw new InvalidInputError(t.error); text = t.text; }
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
      if (opt("query-file")) { const t = readTextFile(inputBase(), opt("query-file")); if (t.error) throw new InvalidInputError(t.error); query = t.text; }
      let question = null;
      if (opt("question")) { question = questionFor(opt("question")); query = [...(question.keywords?.en ?? []), ...(question.keywords?.it ?? []), question.question].join(" "); }
      const r = searchUnits(db, { doc: opt("doc"), near: opt("near"), query, type: opt("type"), top: Number(opt("top", 5)) });
      console.log(JSON.stringify({ ok: true, question: question ? { type: question.type, attribute: question.attribute, question: question.question } : undefined, items: r, took_ms: Date.now() - t0 }));
      return { exitCode: 0 };
    } else if (cmd === "related") {
      const r = related(db, positional[0], { kind: opt("kind"), top });
      return out({ items: r.items, truncated: r.truncated });
    } else if (cmd === "facet-count") {
      const r = facetCount(db, { facet: opt("facet"), scope: opt("scope"), type: opt("type"), level: opt("level"), customer: opt("customer"), status: opt("status") });
      return out(r);
    } else if (cmd === "clusters") {
      const r = clusters(db, { family: opt("family"), status: opt("status"), top: Number(opt("top", 200)) });
      return out(r);
    } else if (cmd === "contradictions") {
      const r = contradictions(db, { open: rest.includes("--open"), top: Number(opt("top", 100)) });
      return out(r);
    } else if (cmd === "scopes") {
      const r = scopes(db, { roots: roots.length ? roots : [dirname(dbPath)] });
      return out(r);
    } else if (cmd === "handoffs") {
      const root = roots[0] ?? dirname(dbPath);
      const r = handoffs(db, { root, scope: opt("scope") });
      if (!rest.includes("--validate")) return out(r);
      const v = validateHandoffs(r.items);
      return out({ items: r.items, problems: v.problems }, v.ok ? 0 : 3);
    } else if (cmd === "graph") {
      const root = roots[0] ?? dirname(dbPath);
      let known = null;
      const pdb = opt("product-db");
      if (pdb) {
        if (!existsSync(pdb)) throw new InvalidInputError(`--product-db non trovato: ${pdb}`);
        const p = openDb(pdb, { createIfMissing: false });
        try { known = new Set(p.prepare("select code from items").all().map((r) => r.code)); } finally { p.close(); }
      }
      const r = graph(db, { root, scope: opt("scope"), known, top: Number(opt("top", 50)) });
      return out(r, r.ok ? 0 : 3);
    } else if (cmd === "outcomes") {
      const r = rates(db, { table: opt("table"), cluster: opt("cluster"), customer: opt("customer"), windowMin: Number(opt("window", 30)) });
      return out({ table: opt("table") ?? null, cluster: opt("cluster") ?? null, customer: opt("customer") ?? null, ...r });
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
  runAsync(process.argv.slice(2)).then(({ exitCode }) => { process.exitCode = exitCode; }, (e) => { console.error(e); process.exitCode = 2; });
}
