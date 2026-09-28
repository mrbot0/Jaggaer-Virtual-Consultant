// Evidenze (K6.3, §27.5, §54.2, ADR-17): lo screenshot lo fa lo strumento MCP; lo script prepara e registra.
//
// Decisione K6 (vedi report, Deviazioni): NESSUNO script nella pagina. guard-environment nega evaluate_script,
// javascript_tool e browser_evaluate in ogni ambiente (K5, giro di correzione 1), e un'eccezione per lo
// "snippet di overlay" allargherebbe la superficie di sicurezza. Quindi:
//  - prepare: la REGIONE si cattura con i parametri di elemento degli strumenti (DevTools take_screenshot
//    uid · Playwright browser_take_screenshot ref · Claude computer zoom region), il contorno e le maschere
//    si applicano DOPO lo scatto sul file (annotate.applyOverlay); prepare calcola le maschere richieste —
//    campi con identity.sensitivity pii/commercial/redact_in_evidence (per selettore, Atlas → FLD) e, dallo
//    snapshot, valori che la redazione riconosce (e-mail, P.IVA, CF, IBAN, telefoni; importi solo in strict) —
//    con il riquadro in pixel quando lo snapshot lo porta (Playwright browser_snapshot boxes: true);
//  - record: applica maschere e contorno sul PNG (in place, atomico), calcola lo sha256 del file finale e
//    scrive i metadati EVD in runs/<RUN>/cases/<caso>/evidence/<nn>.yaml; una maschera richiesta senza
//    riquadro (o un PNG non supportato) ⇒ publishable: false (§54.2: ciò che non si maschera con certezza
//    non entra nelle evidenze pubblicate: resta nel dossier);
//  - cleanup: rimuove le catture non registrate (immagini senza metadati: potenzialmente non mascherate).
import { readFileSync, readdirSync, existsSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve as resolvePath, relative, basename, extname } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeFileAtomic } from "../../hooks/lib/fsx.mjs";
import { loadSession, resolveSessionId } from "../admin/session.mjs";
import { loadPlanFile } from "../admin/approvals.mjs";
import { parseSnapshot } from "./snapshot-parse.mjs";
import { findElement, targetOf } from "./expect-compare.mjs";
import { resolveSel, atlasIndex, atlasMatch, fieldSensitivity } from "./atlas.mjs";
import { profileFor, redactText, redact } from "./redact.mjs";
import { applyOverlay } from "./annotate.mjs";

export const KINDS = ["entry", "input", "transition", "assertion", "integration", "failure", "result"];
const IMG = new Set([".png", ".jpg", ".jpeg", ".webp"]);
export class CaptureError extends Error { constructor(code, msg) { super(msg); this.code = code; } }

const runFromPath = (rel) => /(?:^|\/)runs\/([^/]+)\//.exec(String(rel ?? "").replace(/\\/g, "/"))?.[1] ?? null;
const safeId = (s) => String(s ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 80) || "caso";

function ctxOf(ws, sid) {
  const { session, pointer } = loadSession(ws, sid);
  if (!session) throw new CaptureError(1, "nessuna sessione con cliente attivo");
  return { session, customer: pointer.customer };
}
// Il profilo non si abbassa: preprod/prod (e Jira) sono sempre strict.
export function effectiveProfile(requested, envType) {
  const envP = profileFor({ envType });
  return requested === "strict" || envP === "strict" ? "strict" : "standard";
}
function evidenceDir(ws, customer, run, caseId) { return join(ws, "customers", customer, "runs", run, "cases", safeId(caseId), "evidence"); }
function nextNn(dir) {
  let max = 0;
  try { for (const f of readdirSync(dir)) { const m = /^(\d+)\./.exec(f); if (m) max = Math.max(max, Number(m[1])); } } catch { /* vuota */ }
  return String(max + 1).padStart(2, "0");
}
const relBox = (b, region) => (b ? (region ? { x: b.x - region.x, y: b.y - region.y, w: b.w, h: b.h } : { ...b }) : null);

export async function prepare({ ws, sid, planFile, step, region, profile: requested = "standard", snapshot = null, caseId = null, run = null, env = process.env }) {
  const { session, customer } = ctxOf(ws, sid);
  const info = planFile ? await loadPlanFile(ws, customer, planFile) : null;
  if (planFile && !info) throw new CaptureError(1, `piano non trovato: ${planFile}`);
  const plan = info?.plan ?? null;
  const st = plan ? (plan.steps ?? []).find((s) => s.n === Number(step)) : null;
  const decl = plan?.evidence?.find((e) => e.at === Number(step)) ?? null;
  const profile = effectiveProfile(decl?.redact === "strict" ? "strict" : requested, session.env?.type ?? null);
  const regionRef = region ?? decl?.region ?? (typeof st?.target === "string" ? st.target : null);
  const resolve = (c) => resolveSel(ws, c, customer);
  const target = regionRef ? targetOf(regionRef, resolve) : null;
  const page = snapshot ? parseSnapshot(snapshot) : null;
  const regionEl = page && target ? findElement(page, target) : null;
  const atlas = atlasIndex(ws, customer, session.scope);
  const masks = [];
  const add = (m) => { if (!masks.some((x) => x.label === m.label)) masks.push(m); };
  // 1. per selettore: campi sensibili nella carta d'identità (§19.20)
  for (const a of atlas) {
    const sens = a.field ? fieldSensitivity(ws, a.field, customer) : null;
    if (!sens?.sensitive) continue;
    const el = page ? findElement(page, { label: a.label, role: a.role }) : null;
    add({ sel: a.code, label: a.label, reason: sens.pii ? "pii" : sens.commercial ? "commercial" : "redact_in_evidence", ref: el?.ref ?? null, rect: relBox(el?.box, regionEl?.box) });
  }
  // 2. per contenuto: valori che la redazione riconosce (importi solo in strict)
  for (const el of page?.elements ?? []) {
    const v = [el.value, el.role === "textbox" ? null : el.name].filter((x) => typeof x === "string" && x);
    const hits = v.flatMap((x) => redactText(x, { profile, env }).masks);
    if (!hits.length) continue;
    const m = atlasMatch(atlas, el);
    add({ sel: m?.code ?? null, label: el.name, reason: [...new Set(hits)].join("+"), ref: el.ref ?? null, rect: relBox(el.box, regionEl?.box) });
  }
  const r = run ?? session.active_plan?.run ?? runFromPath(planFile) ?? `RUN.${customer}.OPS`;
  const c = caseId ?? plan?.plan_id ?? "operazione";
  const dir = evidenceDir(ws, customer, r, c);
  mkdirSync(dir, { recursive: true });
  const nn = nextNn(dir);
  const fileAbs = join(dir, `${nn}.png`);
  const file = relative(ws, fileAbs).replace(/\\/g, "/");
  const ref = regionEl?.ref ?? null;
  const spec = {
    plan: plan?.plan_id ?? null, step: st?.n ?? (step != null ? Number(step) : null), profile, nn, file, run: r, case: safeId(c),
    region: target ? { sel: target.code ?? null, label: target.label ?? null, role: target.role ?? null, ref, found: !!regionEl, box: regionEl?.box ?? null } : null,
    no_page_script: true,
    screenshot: {
      "chrome-devtools": { tool: "take_screenshot", params: { ...(ref && page?.format === "chrome-devtools" ? { uid: ref } : {}), format: "png", filePath: fileAbs } },
      playwright: { tool: "browser_take_screenshot", params: { ...(ref && page?.format === "playwright" ? { ref, element: target?.label ?? "regione" } : {}), type: "png", filename: fileAbs } },
      "claude-browser": { tool: "computer", params: { action: regionEl?.box ? "zoom" : "screenshot", ...(regionEl?.box ? { region: [regionEl.box.x, regionEl.box.y, regionEl.box.x + regionEl.box.w, regionEl.box.y + regionEl.box.h] } : {}) }, note: "salva l'immagine nel file indicato" },
    },
    masks,
    masks_without_rect: masks.filter((m) => !m.rect).map((m) => m.label),
    outline: regionEl?.box && !ref ? { x: regionEl.box.x, y: regionEl.box.y, w: regionEl.box.w, h: regionEl.box.h } : null,
    caption_hint: decl?.caption ? redact(decl.caption, { profile, env }) : null,
  };
  writeFileAtomic(join(dir, `${nn}.capture.json`), `${JSON.stringify(spec, null, 2)}\n`);
  return spec;
}

export async function record({ ws, sid, file, step = null, kind, caption = "", specFile = null, masks: extraRects = [], outline = null, profile: requested = "standard", env = process.env, now = new Date() }) {
  if (!KINDS.includes(kind)) throw new CaptureError(1, `kind non valido: ${kind} (${KINDS.join(" · ")})`);
  const { session, customer } = ctxOf(ws, sid);
  const abs = resolvePath(ws, file);
  const rel = relative(join(ws, "customers", customer), abs).replace(/\\/g, "/");
  if (rel.startsWith("..") || !/^(runs|evidence)\//.test(rel)) throw new CaptureError(1, `il file dell'evidenza deve stare in customers/${customer}/runs/** o evidence/**: ${file}`);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new CaptureError(1, `file inesistente: ${file}`);
  const dir = join(abs, "..");
  const nn = /^(\d+)$/.exec(basename(abs, extname(abs)))?.[1] ?? nextNn(dir);
  const sf = specFile ? resolvePath(ws, specFile) : join(dir, `${nn}.capture.json`);
  const spec = existsSync(sf) ? JSON.parse(readFileSync(sf, "utf8")) : null;
  const profile = effectiveProfile(spec?.profile === "strict" ? "strict" : requested, session.env?.type ?? null);
  // --mask: in ordine, alle maschere richieste senza riquadro; le eccedenti sono maschere manuali
  let k = 0;
  const required = (spec?.masks ?? []).map((m) => ({ ...m, rect: m.rect ?? extraRects[k++] ?? null }));
  const extra = extraRects.slice(Math.min(k, extraRects.length)).map((r) => ({ label: null, reason: "manuale", rect: r }));
  const all = [...required, ...extra];
  const ov = applyOverlay(abs, { masks: all, outline: outline ?? spec?.outline ?? null });
  const applied = all.map((m, i) => ({ label: m.label ?? null, sel: m.sel ?? null, reason: m.reason, rect: m.rect ?? null, applied: !!ov.applied[i] }));
  const missing = applied.filter((m, i) => i < required.length && !m.applied);
  const publishable = ov.supported && missing.length === 0;
  const buf = readFileSync(abs);
  const ev = {
    id: `EV-${nn}`, type: "EVD", plan: spec?.plan ?? session.active_plan?.plan_id ?? null, step: step != null ? Number(step) : spec?.step ?? null,
    scope: session.scope ?? null, kind, caption: redact(caption, { profile, env }),
    file: relative(ws, abs).replace(/\\/g, "/"), sha256: createHash("sha256").update(buf).digest("hex"), bytes: buf.length,
    profile, masks: applied, outline: !!ov.outline, publishable,
    ...(publishable ? {} : { not_publishable_reason: !ov.supported ? `immagine non mascherabile (${ov.reason})` : `maschere senza riquadro: ${missing.map((m) => m.label).join(", ")}` }),
    session: session.session_code ?? session.session_id, ts: now.toISOString(),
  };
  const out = join(dir, `${nn}.yaml`);
  writeFileAtomic(out, YAML.stringify(ev));
  return { ...ev, metadata: relative(ws, out).replace(/\\/g, "/") };
}

export function cleanup({ ws, sid, run = null, caseId = null }) {
  const { session, customer } = ctxOf(ws, sid);
  const r = run ?? session.active_plan?.run;
  if (!r) throw new CaptureError(1, "run non risolto: --run <RUN>");
  const casesDir = join(ws, "customers", customer, "runs", r, "cases");
  const removed = [];
  const cases = caseId ? [safeId(caseId)] : existsSync(casesDir) ? readdirSync(casesDir) : [];
  for (const c of cases) {
    const d = join(casesDir, c, "evidence");
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!IMG.has(extname(f).toLowerCase())) continue;
      if (existsSync(join(d, `${basename(f, extname(f))}.yaml`))) continue;
      unlinkSync(join(d, f));
      removed.push(relative(ws, join(d, f)).replace(/\\/g, "/"));
    }
  }
  return { removed };
}

const rect = (s) => {
  const p = String(s).split(",").map(Number);
  if (p.length !== 4 || p.some((x) => !Number.isFinite(x))) throw new CaptureError(1, `riquadro non valido: ${s} (x,y,w,h)`);
  return { x: p[0], y: p[1], w: p[2], h: p[3] };
};

const HELP = `uso: node scripts/chrome/capture.mjs prepare --plan <file> --step <n> [--region <SEL>] [--profile standard|strict] [--snapshot <file>] [--case <id>] [--run <RUN>]
       node scripts/chrome/capture.mjs record --file <png> --kind <${KINDS.join("|")}> [--step n] [--caption <testo>] [--spec <NN.capture.json>] [--mask x,y,w,h …] [--outline x,y,w,h]
       node scripts/chrome/capture.mjs cleanup [--run <RUN>] [--case <id>]
       Opzioni comuni: [--session <id>] [--workspace <dir>] [--json] [--help]

prepare: parametri dello screenshot di regione per i tre server MCP (nessuno script nella pagina), maschere
richieste (campi sensibili per selettore; e-mail, P.IVA, CF, IBAN, telefoni; importi in strict) con riquadro se
lo snapshot lo porta. record: maschere e contorno applicati sul file, sha256, metadati EVD. cleanup: rimuove le
catture non registrate. Exit: 0 ok · 1 argomenti · 2 errore di sistema.`;

export async function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const ws = resolvePath(opts.workspace || env.JVC_WORKSPACE || env.CLAUDE_PROJECT_DIR || process.cwd());
  const masks = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--mask" && argv[i + 1]) masks.push(argv[i + 1]);
  try {
    const sid = resolveSessionId({ workspace: ws, arg: opts.session, env });
    if (!sid) return fail(asJson, 1, "nessuna sessione risolvibile: --session <id>");
    let out;
    if (positional[0] === "prepare") {
      if (!opts.plan || opts.step == null) return fail(asJson, 1, "prepare richiede --plan e --step");
      const snapshot = opts.snapshot ? readFileSync(resolvePath(opts.snapshot), "utf8") : null;
      out = await prepare({ ws, sid, planFile: opts.plan, step: Number(opts.step), region: opts.region, profile: opts.profile, snapshot, caseId: opts.case, run: opts.run, env });
    } else if (positional[0] === "record") {
      if (!opts.file || !opts.kind) return fail(asJson, 1, "record richiede --file e --kind");
      out = await record({ ws, sid, file: opts.file, step: opts.step, kind: opts.kind, caption: opts.caption ?? "", specFile: opts.spec, masks: masks.map(rect), outline: opts.outline ? rect(opts.outline) : null, profile: opts.profile, env });
    } else if (positional[0] === "cleanup") out = cleanup({ ws, sid, run: opts.run, caseId: opts.case });
    else { console.log(HELP); return 1; }
    console.log(asJson ? JSON.stringify({ ok: true, ...out }) : YAML.stringify(out));
    return 0;
  } catch (err) {
    if (err instanceof CaptureError) return fail(asJson, err.code, err.message);
    return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`);
  }
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
