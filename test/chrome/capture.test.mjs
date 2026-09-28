// K6.3 — evidenze senza script nella pagina: prepare (regione, maschere per selettore e per contenuto,
// importi solo in strict), record (maschere e contorno sul PNG, sha256, metadati EVD, publishable),
// cleanup delle catture non registrate, annotate (sidecar e indice per la contact sheet).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import YAML from "yaml";
import { envWs, writePlan, writeSel, patchSession, browserCall, ROOT } from "../helpers/env-fixture.mjs";
import { demoAtlas, demoPlan } from "../helpers/k6-fixture.mjs";
import { prepare, record, cleanup } from "../../scripts/chrome/capture.mjs";
import { writeSidecar, buildIndex } from "../../scripts/chrome/annotate.mjs";
import { encodePng, decodePng, pixel } from "../../scripts/chrome/png.mjs";
import { classify } from "../../hooks/lib/browser-tools.mjs";

const PW = `### Page state
- Page URL: https://acme-sbx.jaggaer.com/p2p/requisition/edit/10045
- Page Title: Richiesta d'acquisto - ACME SBX
- Page Snapshot:
\`\`\`yaml
- heading "Richiesta d'acquisto" [level=1] [ref=e2] [box=10,5,300,30]
- form "Dati richiesta" [ref=e3] [box=0,40,400,200]:
  - textbox "Centro di costo" [ref=e4] [box=20,50,150,20]: IT-0442
  - textbox "Referente" [ref=e5] [box=20,80,150,20]: Mario Rossi
  - textbox "Contatto" [ref=e6] [box=20,110,150,20]: m.rossi@acme.it
  - textbox "Importo stimato" [ref=e7] [box=20,140,150,20]: € 1.250,00
  - button "Salva bozza" [ref=e8] [box=20,170,80,20]
\`\`\``;

function setup({ env = "sandbox" } = {}) {
  const ws = envWs({ env, scope: "P2P" });
  demoAtlas(ws);
  writeSel(ws, "C.ACME.P2P.SEL.0060", { role: "textbox", label: "Referente", effect: "write" });
  // il selettore punta al campo, il campo è dato personale (§19.20 identity.sensitivity)
  const selF = join(ws, "customers/ACME/kb/scopes/P2P/selectors/C.ACME.P2P.SEL.0060.yaml");
  writeFileSync(selF, `${readFileSync(selF, "utf8")}field: C.ACME.P2P.FLD.0077\n`);
  mkdirSync(join(ws, "customers/ACME/kb/scopes/P2P/fields"), { recursive: true });
  writeSel(ws, "C.ACME.P2P.SEL.0070", { role: "form", label: "Dati richiesta", effect: "read" });
  writeFileSync(join(ws, "customers/ACME/kb/scopes/P2P/fields/C.ACME.P2P.FLD.0077.yaml"), "id: C.ACME.P2P.FLD.0077\ntype: FLD\nidentity:\n  sensitivity:\n    class: personale\n    pii: true\n    commercial: false\n");
  const plan = demoPlan({ evidence: [{ at: 3, kind: "assertion", capture: "region", region: "C.ACME.P2P.SEL.0070", caption: "Bozza salvata con importo € 1.250,00", redact: "standard" }] });
  const file = writePlan(ws, plan, "RUN.ACME.20260922.1100.ADM");
  patchSession(ws, (s) => { s.active_plan = { plan_id: plan.plan_id, file, step: 3, run: "RUN.ACME.20260922.1100.ADM" }; });
  return { ws, file };
}
const white = (w = 400, h = 200) => encodePng({ width: w, height: h, channels: 3, data: Buffer.alloc(w * h * 3, 255) });

test("prepare strict: maschere per selettore (FLD pii) e per contenuto (e-mail, importo) con riquadro; nessuno script nella pagina", async () => {
  const { ws, file } = setup();
  const s = await prepare({ ws, sid: "sess-1", planFile: file, step: 3, region: "C.ACME.P2P.SEL.0070", profile: "strict", snapshot: PW, env: {} });
  assert.equal(s.profile, "strict");
  assert.equal(s.no_page_script, true);
  const by = Object.fromEntries(s.masks.map((m) => [m.label, m]));
  assert.equal(by.Referente.reason, "pii"); assert.equal(by.Referente.sel, "C.ACME.P2P.SEL.0060");
  assert.match(by.Contatto.reason, /email/);
  assert.match(by["Importo stimato"].reason, /importo/);
  assert.deepEqual(by["Importo stimato"].rect, { x: 20, y: 100, w: 150, h: 20 }, "riquadro relativo alla regione (il modulo)");
  assert.equal(by["Centro di costo"], undefined, "un codice di dominio non è un dato sensibile");
  assert.equal(s.region.ref, "e3");
  // ogni istruzione di scatto è una lettura per i guard, con output nelle cartelle del run
  for (const [fam, tool] of [["chrome-devtools", "mcp__chrome-devtools__take_screenshot"], ["playwright", "mcp__playwright__browser_take_screenshot"], ["claude-browser", "mcp__claude-in-chrome__computer"]]) {
    const c = classify(tool, s.screenshot[fam].params);
    assert.equal(c.kind, "read", `${fam}: ${JSON.stringify(c)}`);
  }
  const g = browserCall("guard-environment", ws, "mcp__playwright__browser_take_screenshot", s.screenshot.playwright.params);
  assert.equal(g.stdout.trim(), "", g.stdout);
  assert.ok(existsSync(join(ws, "customers/ACME/runs/RUN.ACME.20260922.1100.ADM/cases/PLAN.ACME.K6.0001/evidence/01.capture.json")));
});

test("prepare standard: gli importi non si mascherano; in pre-produzione il profilo è sempre strict", async () => {
  const { ws, file } = setup();
  const s = await prepare({ ws, sid: "sess-1", planFile: file, step: 3, profile: "standard", snapshot: PW, env: {} });
  assert.equal(s.profile, "standard");
  assert.ok(!s.masks.some((m) => /importo/.test(m.reason)));
  assert.ok(s.masks.some((m) => m.label === "Referente"));
  const pre = setup({ env: "preprod" });
  const p = await prepare({ ws: pre.ws, sid: "sess-1", planFile: pre.file, step: 3, profile: "standard", snapshot: PW, env: {} });
  assert.equal(p.profile, "strict");
  assert.ok(p.masks.some((m) => /importo/.test(m.reason)));
});

test("record: maschere applicate sui pixel, sha256 del file finale, metadati EVD, didascalia redatta; importi mascherati in strict", async () => {
  const { ws, file } = setup();
  const s = await prepare({ ws, sid: "sess-1", planFile: file, step: 3, region: "C.ACME.P2P.SEL.0070", profile: "strict", snapshot: PW, env: {} });
  const png = join(ws, s.file);
  writeFileSync(png, white());
  const ev = await record({ ws, sid: "sess-1", file: s.file, step: 3, kind: "assertion", caption: "Totale € 1.250,00 per m.rossi@acme.it", env: {} });
  const img = decodePng(readFileSync(png));
  const imp = s.masks.find((m) => m.label === "Importo stimato").rect;
  assert.deepEqual(pixel(img, imp.x + 5, imp.y + 5), [0, 0, 0], "importo mascherato");
  assert.deepEqual(pixel(img, 390, 190), [255, 255, 255], "fuori dalle maschere invariato");
  assert.equal(ev.sha256, createHash("sha256").update(readFileSync(png)).digest("hex"));
  assert.equal(ev.publishable, true);
  assert.ok(ev.masks.every((m) => m.applied));
  assert.doesNotMatch(ev.caption, /1\.250|acme\.it/);
  const meta = YAML.parse(readFileSync(join(ws, ev.metadata), "utf8"));
  assert.equal(meta.id, "EV-01"); assert.equal(meta.kind, "assertion"); assert.equal(meta.profile, "strict"); assert.equal(meta.sha256, ev.sha256);
});

test("record: una maschera richiesta senza riquadro ⇒ non pubblicabile; con --mask ⇒ pubblicabile", async () => {
  const { ws, file } = setup();
  // riquadri tolti ai campi (maschere senza riquadro), non alla regione: la scala resta misurabile (giro 2, I-2)
  const noBox = PW.split("\n").map((l) => (l.includes('form "Dati richiesta"') ? l : l.replace(/ \[box=[^\]]+\]/g, ""))).join("\n");
  const s = await prepare({ ws, sid: "sess-1", planFile: file, step: 3, profile: "strict", snapshot: noBox, env: {} });
  assert.ok(s.masks_without_rect.length >= 3);
  writeFileSync(join(ws, s.file), white());
  const bad = await record({ ws, sid: "sess-1", file: s.file, kind: "result", env: {} });
  assert.equal(bad.publishable, false); assert.match(bad.not_publishable_reason, /senza riquadro/);
  const s2 = await prepare({ ws, sid: "sess-1", planFile: file, step: 3, profile: "strict", snapshot: noBox, env: {} });
  writeFileSync(join(ws, s2.file), white());
  const ok = await record({ ws, sid: "sess-1", file: s2.file, kind: "result", masks: s2.masks.map((_, i) => ({ x: 10, y: 10 + i * 30, w: 50, h: 20 })), dpr: 1, env: {} });
  assert.equal(ok.publishable, true);
  await assert.rejects(record({ ws, sid: "sess-1", file: "customers/ACME/kb/x.png", kind: "result" }), /runs/);
  await assert.rejects(record({ ws, sid: "sess-1", file: s2.file, kind: "boh" }), /kind non valido/);
});

test("cleanup rimuove le catture non registrate; annotate scrive sidecar e indice per la contact sheet", async () => {
  const { ws, file } = setup();
  const s = await prepare({ ws, sid: "sess-1", planFile: file, step: 3, profile: "strict", snapshot: PW, env: {} });
  writeFileSync(join(ws, s.file), white());
  const ev = await record({ ws, sid: "sess-1", file: s.file, kind: "transition", caption: "Bozza salvata", env: {} });
  const stray = join(ws, "customers/ACME/runs/RUN.ACME.20260922.1100.ADM/cases/PLAN.ACME.K6.0001/evidence/02.png");
  writeFileSync(stray, white(10, 10));
  const c = cleanup({ ws, sid: "sess-1" });
  assert.deepEqual(c.removed, ["customers/ACME/runs/RUN.ACME.20260922.1100.ADM/cases/PLAN.ACME.K6.0001/evidence/02.png"]);
  assert.ok(existsSync(join(ws, s.file)));
  const side = writeSidecar(join(ws, ev.metadata));
  assert.match(readFileSync(side, "utf8"), /Bozza salvata\nEV-01 · PLAN\.ACME\.K6\.0001 passo 3 · transition/);
  const idx = buildIndex(ws, "ACME", "RUN.ACME.20260922.1100.ADM");
  assert.equal(idx.index.evidence, 1);
  assert.equal(idx.index.scopes.P2P["PLAN.ACME.K6.0001"][0].id, "EV-01");
});

test("browser-tools: browser_snapshot con boxes/depth/target è una lettura (riquadri per le maschere), una chiave ignota resta other", () => {
  assert.equal(classify("mcp__playwright__browser_snapshot", { boxes: true, depth: 4, target: "e3" }).kind, "read");
  assert.equal(classify("mcp__playwright__browser_snapshot", { boxes: true, script: "x" }).kind, "other");
});
