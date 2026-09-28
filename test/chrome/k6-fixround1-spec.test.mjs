// WP07 giro di correzione 1 — revisione di spec, Important 3–6 e il Minor di compile-plan (sicurezza):
//  3 firma della pagina senza dati personali (titolo redatto prima dello slug) e checkpoint redatti;
//  4 evidenza pubblicabile solo se verificata: testo statico con dati personali mascherato, strict senza snapshot
//    ⇒ non pubblicabile, geometria delle maschere verificata e scalata (devicePixelRatio);
//  5 intento senza azione riconosciuta ⇒ chiedi (casi fuori vocabolario);
//  6 errore atteso ma stato finale sbagliato ⇒ ERROR-BLOCKING (NEG.0031 di §29.8);
//  compile-plan: goal e plan_id non iniettano codice nello spec; l'intestazione dichiara che mancano le compensazioni.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import { envWs, writePlan, writeSel, patchSession, readSession, ROOT } from "../helpers/env-fixture.mjs";
import { demoAtlas, demoPlan, snap } from "../helpers/k6-fixture.mjs";
import { parseSnapshot, pageSignature } from "../../scripts/chrome/snapshot-parse.mjs";
import { check } from "../../scripts/decide/step-check.mjs";
import { prepare, record } from "../../scripts/chrome/capture.mjs";
import { encodePng, decodePng, pixel } from "../../scripts/chrome/png.mjs";
import { parseIntent } from "../../scripts/decide/intent.mjs";
import { classifyOutcome, toXrayStatus } from "../../scripts/report/outcome.mjs";
import { generateSpec, planHash } from "../../scripts/chrome/compile-plan.mjs";

const PII = /mario\.rossi|acme\.it|RSSMRA80A01H501U|rssmra80a01h501u/i;

test("I3: la firma della pagina non porta dati personali del titolo (sonda della revisione)", () => {
  const page = parseSnapshot('## Latest page snapshot\nuid=1_0 RootWebArea "Fornitore" url="https://acme-sbx.jaggaer.com/ven/supplier/view/77"\n  uid=1_1 heading "Mario Rossi - mario.rossi@acme.it RSSMRA80A01H501U" level="1"\n');
  const sig = pageSignature(page, { profile: "standard" });
  assert.doesNotMatch(sig, PII, sig);
  assert.match(sig, /^ven\/supplier\/view#/);
});

test("I3: i valori delle divergenze nei checkpoint sono redatti", async () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  demoAtlas(ws);
  const file = writePlan(ws, demoPlan(), "RUN.ACME.K6");
  await check({ ws, sid: "sess-1", planFile: file, step: 1 });
  await check({ ws, sid: "sess-1", planFile: file, step: 1, snapshot: snap("chrome-devtools", "ok").replace("/edit/10045", "/new") });
  const r = await check({ ws, sid: "sess-1", planFile: file, step: 2, snapshot: snap("chrome-devtools", "ok").replace('value="IT-0442"', 'value="mario.rossi@acme.it"') });
  assert.equal(r.kind, "stato-diverso");
  const cp = readFileSync(join(ws, "customers/ACME/runs/RUN.ACME.K6/checkpoints/2.json"), "utf8");
  assert.doesNotMatch(cp, PII, cp);
});

// ---- I4: evidenze ----
const FORM = (extra = "") => `### Page state
- Page URL: https://acme-sbx.jaggaer.com/p2p/requisition/edit/10045
- Page Title: Richiesta d'acquisto - ACME SBX
- Page Snapshot:
\`\`\`yaml
- heading "Richiesta d'acquisto" [level=1] [ref=e2] [box=10,5,300,30]
- form "Dati richiesta" [ref=e3] [box=0,40,400,200]:
  - textbox "Centro di costo" [ref=e4] [box=20,50,150,20]: IT-0442
  - paragraph [ref=e5] [box=20,80,300,20]: Referente mario.rossi@acme.it
  - textbox "Importo stimato" [ref=e7] [box=20,140,150,20]: € 1.250,00
  - button "Salva bozza" [ref=e8] [box=20,170,80,20]${extra}
- paragraph [ref=e9] [box=0,400,300,20]: fuori dalla regione m.bianchi@acme.it
\`\`\``;
function evWs(env = "sandbox") {
  const ws = envWs({ env, scope: "P2P" });
  demoAtlas(ws);
  writeSel(ws, "C.ACME.P2P.SEL.0070", { role: "form", label: "Dati richiesta", effect: "read" });
  const plan = demoPlan({ evidence: [{ at: 3, kind: "assertion", capture: "region", region: "C.ACME.P2P.SEL.0070", caption: "Bozza", redact: "standard" }] });
  const file = writePlan(ws, plan, "RUN.ACME.K6");
  patchSession(ws, (s) => { s.active_plan = { plan_id: plan.plan_id, file, step: 3, run: "RUN.ACME.K6" }; });
  return { ws, file };
}
const img = (w, h) => encodePng({ width: w, height: h, channels: 3, data: Buffer.alloc(w * h * 3, 255) });

test("I4 a: il testo statico con dati personali nella regione è una maschera; quello fuori dalla regione no", async () => {
  const { ws, file } = evWs();
  const s = await prepare({ ws, sid: "sess-1", planFile: file, step: 3, profile: "standard", snapshot: FORM(), env: {} });
  const texts = s.masks.filter((m) => m.kind === "text");
  assert.equal(texts.length, 1, JSON.stringify(s.masks));
  assert.deepEqual(texts[0].rect, { x: 20, y: 40, w: 300, h: 20 }, "riquadro relativo alla regione");
  assert.ok(!JSON.stringify(s).includes("m.bianchi"), "fuori dalla regione (e mai il valore in chiaro nello spec)");
  assert.doesNotMatch(JSON.stringify(s.masks), PII);
});

test("I4 b: in strict senza snapshot l'evidenza non è pubblicabile (contenuto non verificato)", async () => {
  const { ws, file } = evWs("preprod");
  const s = await prepare({ ws, sid: "sess-1", planFile: file, step: 3, profile: "strict", env: {} });
  writeFileSync(join(ws, s.file), img(400, 200));
  const r = await record({ ws, sid: "sess-1", file: s.file, kind: "result", env: {} });
  assert.equal(r.publishable, false); assert.match(r.not_publishable_reason, /contenuto non verificato/);
});

test("I4 c: geometria verificata — immagine 2× la regione ⇒ maschere scalate; proporzioni incoerenti ⇒ non pubblicabile", async () => {
  const { ws, file } = evWs();
  const s = await prepare({ ws, sid: "sess-1", planFile: file, step: 3, profile: "standard", snapshot: FORM(), env: {} });
  writeFileSync(join(ws, s.file), img(800, 400));   // devicePixelRatio 2
  const r = await record({ ws, sid: "sess-1", file: s.file, kind: "assertion", env: {} });
  assert.equal(r.publishable, true, r.not_publishable_reason);
  assert.equal(r.scale, 2);
  const im = decodePng(readFileSync(join(ws, s.file)));
  assert.deepEqual(pixel(im, 2 * 20 + 5, 2 * 40 + 5), [0, 0, 0], "testo del referente mascherato alla scala giusta");
  assert.deepEqual(pixel(im, 2 * 20 + 5, 2 * 10 + 5), [255, 255, 255]);
  const s2 = await prepare({ ws, sid: "sess-1", planFile: file, step: 3, profile: "standard", snapshot: FORM(), env: {} });
  writeFileSync(join(ws, s2.file), img(400, 50));    // non è la regione 400×200
  const bad = await record({ ws, sid: "sess-1", file: s2.file, kind: "assertion", env: {} });
  assert.equal(bad.publishable, false); assert.match(bad.not_publishable_reason, /scala|geometria/);
  // senza regione né devicePixelRatio dichiarato la scala non si verifica
  const s3 = await prepare({ ws, sid: "sess-1", planFile: file, step: 3, region: "C.ACME.P2P.SEL.0999", profile: "standard", snapshot: FORM(), env: {} });
  writeFileSync(join(ws, s3.file), img(800, 600));
  const nr = await record({ ws, sid: "sess-1", file: s3.file, kind: "assertion", env: {} });
  assert.equal(nr.publishable, false);
  const withDpr = await record({ ws, sid: "sess-1", file: s3.file, kind: "assertion", dpr: 2, env: {} });
  assert.equal(withDpr.publishable, true, withDpr.not_publishable_reason);
});

test("I5: nessuna azione riconosciuta ⇒ chiedi (casi fuori vocabolario della revisione)", () => {
  for (const t of ["Su ACME produzione aggiungi una riga all'ordine 4500012345", "Su ACME produzione svuota il carrello", "Su ACME sandbox distruggi la RdA NRT-20260923-B2C1-REQ-001"]) {
    const r = parseIntent(t, { customers: ["ACME"] });
    assert.equal(r.outcome, "chiedi", t); assert.ok(r.missing.includes("action"), t);
  }
});

test("I6: errore atteso ricevuto ma stato finale diverso dall'atteso ⇒ ERROR-BLOCKING (NEG.0031 di §29.8)", () => {
  const r = classifyOutcome({ expected: { error: { message: "messaggio in errore" }, state: "DRAFT" }, observed: { state: "SENT" },
    errors: [{ category: "validation", message: "Ordine inviato: messaggio in errore dal sistema" }], completed: true });
  assert.equal(r.outcome, "ERROR-BLOCKING"); assert.equal(toXrayStatus(r.outcome), "FAILED"); assert.equal(r.defect, true);
  assert.match(r.reason, /SENT/);
  const ok = classifyOutcome({ expected: { error: { message: "messaggio in errore" }, state: "DRAFT" }, observed: { state: "DRAFT" }, errors: [{ category: "validation", message: "messaggio in errore" }], completed: true });
  assert.equal(ok.outcome, "EXPECTED-ERROR-AS-SUCCESS");
});

test("compile-plan: goal e plan_id non escono dal commento dello spec; l'intestazione avverte che mancano le compensazioni", () => {
  const ws = envWs({ env: "sandbox", scope: "P2P" });
  demoAtlas(ws);
  const plan = { ...demoPlan(), goal: "x\nrequire('child_process').execSync('calc') // \u2028 */ evil()", steps: demoPlan().steps.slice(0, 1) };
  const { text } = generateSpec(ws, "ACME", plan);
  for (const line of text.split("\n").slice(0, 6)) assert.ok(line === "" || line.startsWith("//") || line.startsWith("import "), `riga fuori commento: ${line}`);
  assert.ok(!text.split("\n").some((l) => /^\s*require\(/.test(l)), "codice iniettato");
  assert.ok(!/\u2028|\u2029/.test(text));
  assert.match(text, /senza compensazioni/i);
  assert.equal(planHash(plan).length, 64);
  mkdirSync(join(ws, "x"), { recursive: true });
  assert.ok(readSession(ws));
  assert.ok(YAML);
});
