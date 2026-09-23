import { openDb } from "./db.mjs";
import { find, InvalidFacetError } from "./find.mjs";
import { resolve } from "./resolve.mjs";
import { precedents } from "./precedents.mjs";
import { fields, InvalidInputError, NotFoundError } from "./fields.mjs";
import { impact } from "./impact.mjs";
import { identityCard, identityMissing } from "./identity.mjs";
import { isMain } from "../lib/is-main.mjs";

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
  const { opt, facet, positional } = parseArgs(rest);
  const dbPath = opt("db", "knowledge.db");
  if (!["find", "resolve", "summary", "get", "precedents", "fields", "impact", "identity"].includes(cmd)) {
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
    } else if (cmd === "precedents") {
      const releases = opt("releases") ? String(opt("releases")).split(",").map((x) => x.trim()).filter(Boolean) : undefined;
      const context = { shape: opt("shape"), release: opt("release"), releases, cluster: opt("cluster") };
      items = precedents(db, positional[0], { top, customer: opt("customer"), context });
    }
  } catch (err) {
    const msg = String(err?.message ?? err);
    if (err instanceof InvalidFacetError || err instanceof InvalidInputError || err instanceof NotFoundError) {
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
