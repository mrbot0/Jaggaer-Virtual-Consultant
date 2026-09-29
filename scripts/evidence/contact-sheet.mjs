// contact-sheet (F5, §27.5 sink `desk`): foglio dei provini HTML per release → scope → caso dai metadati EVD, file
// offline con link relativi alle immagini; la cartella "desk" ha la forma <desk>/<release>/<scope>/<caso>/.
// Entrano solo le evidenze della lista desk di evidence select (pubblicabili: mascherate con certezza, §54.2); le
// immagini si COPIANO nella cartella del caso (gli originali restano nel dossier del run). Nessuna risorsa esterna,
// nessuno script: testo con escape HTML.
//
//   buildDesk(ws, { customer, release, runs[], desk? }) → { index, cases, images }   scrive <desk>/<release>/index.html
//     e <desk>/<release>/<scope>/<caso>/<nn>.<ext>; più run della stessa release si sommano (caso per caso)
//
// CLI: node scripts/evidence/contact-sheet.mjs --release <R> --run <RUN> [--run <RUN>…] [--desk <dir>] [--customer C]
//      [--workspace <dir>] [--json]      desk di default: customers/<C>/evidence/desk
// Exit: 0 ok · 1 argomenti · 2 errore di sistema.
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { join, resolve as resolvePath, extname, relative } from "node:path";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { selectEvidence, EvidenceError } from "./select.mjs";
import { workspaceCustomer } from "../run/fixtures.mjs";
import { loadTemplate, fillOrWarn } from "../lib/templates.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const safe = (s) => String(s ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "x";
const RELEASE_RE = /^[A-Za-z0-9._-]{1,40}$/;

// Il foglio HTML. WP10a: templates/contact-sheet.html (§31.2) se presente e con {{sections}}; altrimenti lo stesso testo
// dal codice. Ogni valore passa dall'escape HTML prima del template. template: undefined = il file di templates/, null =
// dal codice, stringa = quel template (test).
export const SHEET_TEMPLATE = "contact-sheet.html";
export function renderContactSheet({ release, customer, runs, tree }, { template, warnings = null } = {}) {
  const S = [];
  for (const scope of Object.keys(tree).sort()) {
    S.push(`<h2>Scope ${esc(scope)}</h2>`);
    for (const caseId of Object.keys(tree[scope]).sort()) {
      S.push(`<h3>${esc(caseId)}</h3>`);
      const items = tree[scope][caseId];
      if (!items.length) { S.push("<p>(nessuna evidenza pubblicabile)</p>"); continue; }
      for (const it of items.sort((a, b) => (a.step ?? 0) - (b.step ?? 0))) {
        S.push(`<figure class="k-${esc(it.kind)}"><a href="${esc(it.href)}"><img src="${esc(it.href)}" alt="${esc(`${it.kind} passo ${it.step ?? "?"}`)}"></a><figcaption>passo ${esc(it.step ?? "?")} · ${esc(it.kind)} · ${esc(it.run)}<br>${esc(it.caption)}</figcaption></figure>`);
      }
    }
  }
  const tpl = template === undefined ? loadTemplate(SHEET_TEMPLATE) : template;
  const fromTpl = fillOrWarn(SHEET_TEMPLATE, tpl, { release: esc(release), customer: esc(customer), runs: runs.map(esc).join(", "), sections: S.join("\n") }, ["sections"], warnings);
  if (fromTpl != null) return fromTpl;
  const L = ["<!doctype html>", '<html lang="it"><head><meta charset="utf-8">', `<title>Evidenze ${esc(release)} — ${esc(customer)}</title>`,
    "<style>body{font-family:sans-serif;margin:1.5rem}h2{border-bottom:1px solid #ccc}figure{display:inline-block;margin:.5rem;width:260px;vertical-align:top}img{max-width:100%;border:1px solid #999}figcaption{font-size:.8rem}.k-failure{outline:3px solid #c00}</style>",
    "</head><body>", `<h1>Evidenze — release ${esc(release)} · ${esc(customer)}</h1>`, `<p>Run: ${runs.map(esc).join(", ")}. Solo evidenze pubblicabili (mascherate); gli originali restano nel dossier del run.</p>`];
  L.push(...S);
  L.push("</body></html>", "");
  return L.join("\n");
}

export function buildDesk(ws, { customer, release, runs, desk = null }) {
  if (!RELEASE_RE.test(String(release ?? ""))) throw new EvidenceError(1, `release non valida: ${release}`);
  const root = desk ? resolvePath(desk) : join(ws, "customers", customer, "evidence", "desk");
  const relDir = join(root, safe(release));
  const tree = {};
  let images = 0;
  for (const run of runs) {
    const sel = selectEvidence(ws, { customer, run });
    for (const [caseId, c] of Object.entries(sel.cases)) {
      const dir = join(relDir, safe(c.scope), safe(caseId));
      mkdirSync(dir, { recursive: true });
      const node = ((tree[c.scope] ??= {})[caseId] ??= []);
      for (const e of c.desk) {
        const src = join(ws, e.file);
        if (!existsSync(src)) continue;
        const name = `${safe(run)}-${safe(e.id)}${extname(src).toLowerCase()}`;
        copyFileSync(src, join(dir, name));
        images++;
        node.push({ run, id: e.id, kind: e.kind, step: e.step, caption: e.caption, href: relative(relDir, join(dir, name)).replace(/\\/g, "/") });
      }
    }
  }
  const index = join(relDir, "index.html");
  mkdirSync(relDir, { recursive: true });
  const warnings = [];
  writeFileAtomic(index, renderContactSheet({ release, customer, runs, tree }, { warnings }));
  writeFileAtomic(join(relDir, "index.yaml"), YAML.stringify({ release, customer, runs, tree }));
  return { index, cases: Object.values(tree).reduce((a, s) => a + Object.keys(s).length, 0), images, warnings };
}

const HELP = `uso: node scripts/evidence/contact-sheet.mjs --release <R> --run <RUN> [--run <RUN>…] [--desk <dir>] [--customer C]
       [--workspace <dir>] [--json] [--help]

Foglio dei provini HTML (release → scope → caso) con link relativi alle immagini copiate in <desk>/<release>/<scope>/<caso>/.
Solo evidenze pubblicabili (lista desk di evidence select, DT-009). File offline, nessuna risorsa esterna.

Exit code: 0 ok · 1 argomenti · 2 errore di sistema.`;

export function run(argv, env = process.env) {
  const runs = [];
  const rest = [];
  for (let i = 0; i < argv.length; i++) { if (argv[i] === "--run" && argv[i + 1]) runs.push(argv[++i]); else rest.push(argv[i]); }
  const { opts } = parseArgs(rest);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!opts.release || !runs.length) return fail(asJson, 1, "richiesti --release e almeno un --run");
  const { ws, customer } = workspaceCustomer(opts, env);
  if (!customer) return fail(asJson, 1, "cliente non determinato: --customer <C>");
  try {
    const r = buildDesk(ws, { customer, release: opts.release, runs, desk: opts.desk ?? null });
    for (const w of r.warnings) console.error(`avviso: ${w}`);
    console.log(asJson ? JSON.stringify({ ok: true, ...r }) : `${r.images} evidenze di ${r.cases} casi → ${r.index}`);
    return 0;
  } catch (err) {
    if (err instanceof EvidenceError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
