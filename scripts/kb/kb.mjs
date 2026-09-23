import { existsSync } from "node:fs";
import { openDb } from "./db.mjs";
import { find } from "./find.mjs";
import { resolve } from "./resolve.mjs";
import { isMain } from "../lib/is-main.mjs";

const HELP = `uso: node scripts/kb/kb.mjs <comando> [opzioni]

Comandi:
  find      --scope --type --status --level --customer --facet K=V --top N
  resolve   "<testo libero>" --top N
  summary   <codice>
  get       <codice>

Opzioni comuni: --db <file> (default knowledge.db) --json --help

Exit code: 0 ok · 1 errore utente (comando/argomenti non validi, DB assente) · 2 errore di sistema.`;

function parseArgs(rest) {
  const opt = (k, d) => { const i = rest.indexOf(`--${k}`); return i >= 0 ? rest[i + 1] : d; };
  const facet = rest.filter((x, i) => rest[i - 1] === "--facet").reduce((a, kv) => { const [k, v] = kv.split("="); a[k] = v; return a; }, {});
  const positional = rest.filter((x, i) => !x.startsWith("--") && !rest[i - 1]?.startsWith("--"));
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
  if (!["find", "resolve", "summary", "get"].includes(cmd)) {
    const msg = `comando sconosciuto: ${cmd}`;
    console.log(asJson ? JSON.stringify({ ok: false, error: msg }) : `errore: ${msg}\n${HELP}`);
    return { exitCode: 1 };
  }
  if (!existsSync(dbPath)) {
    const msg = `database non trovato: ${dbPath}`;
    console.log(asJson ? JSON.stringify({ ok: false, error: msg }) : `errore: ${msg}`);
    return { exitCode: 1 };
  }
  const db = openDb(dbPath);
  const top = Number(opt("top", 10));
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
    }
  } catch (err) {
    const msg = String(err?.message ?? err);
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
