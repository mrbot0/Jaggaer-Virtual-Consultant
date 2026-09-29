// learn patterns (§56.7, §1.1, F8) — WP09d. Clustering dei ticket importati per FIRMA DEL SINTOMO: messaggio
// normalizzato (senza numeri, date, token, testo fra virgolette) + modulo + codice d'errore → gruppi; per ogni gruppo
// con almeno --min ticket la catena causale (chain.mjs) → un PAT e il suo PBK (playbook) nel dominio analitico del
// cliente (customers/<C>/analysis/patterns|playbooks), codice dal DB, schema e confine controllati prima di scrivere.
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { chain } from "./chain.mjs";
import { writeAnalysisItem, facetsFor, AnalysisError } from "./common.mjs";
import { REGISTRY } from "../kb/codes.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";

export const MIN_SIZE = 2;

export function normalizeMessage(s) {
  return String(s ?? "").split(/\r?\n/)[0].normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/\b(?:cust|pers|supp|mail|docn|rif|tkt|val)-[0-9a-f]{10}\b/g, "#")
    .replace(/(["'«»“”])[^"'«»“”]*\1/g, "…")
    .replace(/\b\d{4}-\d{2}-\d{2}(t[\d:.]+z?)?\b/g, "#").replace(/\b[0-9a-f]{8,}\b/g, "#").replace(/\d+([.,]\d+)?/g, "#")
    .replace(/[^a-z#…]+/g, " ").replace(/\s+/g, " ").trim();
}

export function signature(t) {
  const module = t.module ? String(t.module).trim().toLowerCase() : null;
  const code = t.error_code ? String(t.error_code).trim().toUpperCase() : null;
  const message = normalizeMessage(t.summary ?? t.description);
  const hash = createHash("sha256").update(`${module ?? ""}|${code ?? ""}|${message}`).digest("hex").slice(0, 12);
  return { hash, module, error_code: code, message };
}

export function clusterTickets(tickets, { min = MIN_SIZE } = {}) {
  const groups = new Map();
  for (const t of tickets) {
    const sig = signature(t);
    if (!sig.message) continue;
    if (!groups.has(sig.hash)) groups.set(sig.hash, { signature: sig, tickets: [] });
    groups.get(sig.hash).tickets.push(t);
  }
  return [...groups.values()].filter((g) => g.tickets.length >= min).map((g) => ({ ...g, count: g.tickets.length, chain: chain(g.tickets) }))
    .sort((a, b) => b.count - a.count || a.signature.hash.localeCompare(b.signature.hash));
}

// Playbook dalla catena: riconoscere il sintomo, verificare la causa immediata, rimuovere la causa radice, risolvere.
export function playbookSteps(c) {
  const steps = [{ n: 1, action: `Riconoscere il sintomo: ${c.symptom.value ?? "(ignoto)"}` }];
  if (c.immediate_cause.value) steps.push({ n: steps.length + 1, action: `Verificare la causa immediata: ${c.immediate_cause.value}` });
  if (c.root_cause.value) steps.push({ n: steps.length + 1, action: `Controllare la causa radice: ${c.root_cause.value}` });
  steps.push({ n: steps.length + 1, action: c.resolution.value ? `Applicare la risoluzione: ${c.resolution.value}` : "Risoluzione ignota: raccogliere evidenze e chiedere al supporto" });
  return steps;
}

export function writePatterns(ws, customer, groups, { scope = "XSC", period = null } = {}) {
  const written = [];
  for (const g of groups) {
    const sc = g.tickets.find((t) => REGISTRY.scopes.includes(t.scope))?.scope ?? scope;
    const pat = writeAnalysisItem(ws, { level: "C", customer, scope: sc, type: "PAT" }, (code) => ({
      id: code, type: "PAT", title: `Pattern: ${g.chain.symptom.value ?? g.signature.message}`.slice(0, 140),
      summary: `${g.count} ticket con la stessa firma del sintomo${g.signature.module ? ` nel modulo ${g.signature.module}` : ""}${g.signature.error_code ? ` (${g.signature.error_code})` : ""}.`,
      facets: facetsFor("PAT"), sources: [{ tickets: g.count, import: "learn tickets" }],
      signature: g.signature, symptom: g.chain.symptom.value ?? g.signature.message, occurrences: g.count, chain: g.chain,
      tickets: g.tickets.map((t) => t.id).filter((x) => /^TKT-[0-9a-f]{10}$/.test(x)), ...(period ? { period } : {}),
      modules: [...new Set(g.tickets.map((t) => t.module).filter(Boolean))],
    }));
    const pbk = writeAnalysisItem(ws, { level: "C", customer, scope: sc, type: "PBK" }, (code) => ({
      id: code, type: "PBK", title: `Playbook: ${g.chain.symptom.value ?? g.signature.message}`.slice(0, 140),
      summary: `Passi per riconoscere e risolvere il pattern ${pat.code}.`, facets: facetsFor("PBK"), sources: [{ pattern: pat.code }],
      pattern: pat.code, steps: playbookSteps(g.chain), resolution: g.chain.resolution.value, confidence: g.chain.confidence,
    }));
    written.push({ pattern: pat.code, playbook: pbk.code, count: g.count, scope: sc });
  }
  return written;
}

function latestImport(ws, customer) {
  const dir = join(ws, "customers", customer, "analysis", "_import");
  if (!existsSync(dir)) return null;
  const f = readdirSync(dir).filter((x) => x.endsWith(".json")).sort().at(-1);
  return f ? join(dir, f) : null;
}

export const HELP = `uso: learn patterns --customer <C> [--input <import.json>] [--min 2] [--scope S] [--write] [--workspace <dir>] [--json]

Raggruppa i ticket importati (learn tickets --write; default: l'ultima importazione) per firma del sintomo, calcola la
catena causale a 4 livelli e, con --write, scrive un PAT e un PBK per gruppo (≥ --min ticket) in customers/<C>/analysis/.

Exit code: 0 ok · 1 errore d'uso · 2 errore di sistema · 3 confine dei domini violato.`;

export function run(argv, env = process.env) {
  const { opts } = parseArgs(argv, { flags: ["write"] });
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.customer || !/^[A-Z0-9]{4}$/.test(opts.customer)) return fail(asJson, 1, "richiesto --customer <C>");
  const ws = resolve(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  const file = opts.input ?? latestImport(ws, opts.customer);
  if (!file) return fail(asJson, 1, "nessuna importazione di ticket: learn tickets <file> --customer <C> --write");
  let data;
  try { data = JSON.parse(readFileSync(file, "utf8")); } catch (e) { return fail(asJson, 1, `importazione illeggibile: ${e.message}`); }
  try {
    const groups = clusterTickets(data.tickets ?? [], { min: opts.min ? Number(opts.min) : MIN_SIZE });
    const written = opts.write ? writePatterns(ws, opts.customer, groups, { scope: opts.scope ?? "XSC" }) : [];
    console.log(JSON.stringify({ ok: true, tickets: (data.tickets ?? []).length, groups: groups.map((g) => ({ signature: g.signature, count: g.count, chain: g.chain })), written }));
    return 0;
  } catch (err) {
    if (err instanceof AnalysisError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exitCode = run(process.argv.slice(2));
