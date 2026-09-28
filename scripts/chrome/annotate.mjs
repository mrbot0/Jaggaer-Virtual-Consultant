// Annotazione delle evidenze (K6.3, ADR-17, §27.5): senza script nella pagina (negati da guard-environment
// in ogni ambiente), l'annotazione avviene sul file dopo lo scatto:
//  - applyOverlay(file, { masks, outline }): maschere piene e contorno della regione sul PNG (in place,
//    scrittura atomica) → { applied: [bool], outline: bool, supported };
//  - sidecar: `<nn>.caption.txt` con didascalia e metadati (per il dossier e la contact sheet);
//  - index: runs/<RUN>/evidence/index.yaml pronto per la contact sheet (scope → caso → evidenze).
// CLI: annotate sidecar --evidence <nn.yaml> | annotate index --run <RUN> [--customer C] [--json]
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import YAML from "yaml";
import { decodePng, encodePng, fillRect, strokeRect, PngError } from "./png.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";

export function applyOverlay(file, { masks = [], outline = null } = {}) {
  const rects = masks.map((m) => m?.rect ?? null);
  if (!rects.some(Boolean) && !outline) return { supported: true, applied: rects.map(() => false), outline: false };
  let img;
  try { img = decodePng(readFileSync(file)); } catch (err) {
    if (err instanceof PngError) return { supported: false, reason: err.message, applied: rects.map(() => false), outline: false };
    throw err;
  }
  const applied = rects.map((r) => (r ? fillRect(img, r) : false));
  const out = outline ? strokeRect(img, outline) : false;
  writeFileAtomic(file, encodePng(img));
  return { supported: true, applied, outline: out };
}

export function writeSidecar(evidenceYaml) {
  const ev = YAML.parse(readFileSync(evidenceYaml, "utf8"));
  const f = evidenceYaml.replace(/\.ya?ml$/, ".caption.txt");
  const lines = [
    ev.caption ?? "",
    `${ev.id} · ${ev.plan ?? "—"} passo ${ev.step ?? "—"} · ${ev.kind} · profilo ${ev.profile}${ev.publishable ? "" : " · NON pubblicabile"}`,
    `sha256 ${ev.sha256}`,
  ];
  writeFileSync(f, `${lines.join("\n")}\n`);
  return f;
}

export function buildIndex(ws, customer, run) {
  const base = join(ws, "customers", customer, "runs", run);
  const casesDir = join(base, "cases");
  const scopes = {};
  let n = 0;
  const cases = existsSync(casesDir) ? readdirSync(casesDir).sort() : [];
  for (const c of cases) {
    const evDir = join(casesDir, c, "evidence");
    if (!existsSync(evDir)) continue;
    for (const f of readdirSync(evDir).filter((x) => /^\d+\.ya?ml$/.test(x)).sort()) {
      const ev = YAML.parse(readFileSync(join(evDir, f), "utf8"));
      const scope = ev.scope ?? "XSC";
      ((scopes[scope] ??= {})[c] ??= []).push({ id: ev.id, file: ev.file, caption: ev.caption, kind: ev.kind, step: ev.step, sha256: ev.sha256, publishable: ev.publishable });
      n++;
    }
  }
  const index = { run, customer, generated_at: new Date().toISOString(), evidence: n, scopes };
  mkdirSync(join(base, "evidence"), { recursive: true });
  const out = join(base, "evidence", "index.yaml");
  writeFileSync(out, YAML.stringify(index));
  return { file: out, index };
}

const HELP = `uso: node scripts/chrome/annotate.mjs sidecar --evidence <runs/…/evidence/NN.yaml>
       node scripts/chrome/annotate.mjs index --run <RUN> [--customer <C>] [--workspace <dir>] [--json]

sidecar: didascalia e metadati accanto all'evidenza (NN.caption.txt). index: indice delle evidenze del run
(scope → caso), pronto per la contact sheet. Exit: 0 ok · 1 argomenti · 2 errore di sistema.`;

export async function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolvePath(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  try {
    if (positional[0] === "sidecar") {
      if (!opts.evidence) return fail(asJson, 1, "richiesto --evidence");
      const f = writeSidecar(resolvePath(ws, opts.evidence));
      console.log(asJson ? JSON.stringify({ ok: true, file: f }) : f);
      return 0;
    }
    if (positional[0] === "index") {
      if (!opts.run) return fail(asJson, 1, "richiesto --run");
      let customer = opts.customer;
      if (!customer) { const { resolveSessionId, loadSession } = await import("../admin/session.mjs"); customer = loadSession(ws, resolveSessionId({ workspace: ws, arg: opts.session, env })).pointer?.customer; }
      if (!customer) return fail(asJson, 1, "cliente non risolto: --customer <C>");
      const r = buildIndex(ws, customer, opts.run);
      console.log(asJson ? JSON.stringify({ ok: true, file: r.file, evidence: r.index.evidence }) : `${r.file} (${r.index.evidence} evidenze)`);
      return 0;
    }
    console.log(HELP);
    return 1;
  } catch (err) { return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`); }
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
