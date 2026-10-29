// 29/10/2026 (decisione dell'utente, punto 3 del piano): il terzo diniego uguale (stesso guard, stesso motivo
// normalizzato) nella sessione porta in coda al motivo un suggerimento azionabile; motivi diversi no; un guasto del
// contatore (customers/<C>/.sessions/<sid>/deny-counts.json) non cambia né la decisione né il motivo.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { envWs, browserCall } from "../helpers/env-fixture.mjs";
import { decisionOf, reasonOf } from "../helpers/hook-env.mjs";
import { normalizeReason, adviceFor, denyFamily, ADVICE } from "../../hooks/lib/deny-hints.mjs";

const NAV = "mcp__chrome-devtools__navigate_page";
const nav = (ws, url) => browserCall("guard-environment", ws, NAV, { type: "url", url });
const COUNTS = (ws) => join(ws, "customers/ACME/.sessions/sess-1/deny-counts.json");
const HINT = /\(negato \d+ volte: [^)]*\)$/;
const auditDenies = (ws) => {
  const d = join(ws, "customers/ACME/audit");
  return readdirSync(d).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(d, f), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    .filter((e) => e.kind === "guard" && e.payload?.decision === "deny");
};

test("terzo diniego uguale (URL diversi, stesso motivo normalizzato) ⇒ suggerimento in coda; il motivo originale resta all'inizio; audit con repeat e hint", () => {
  const ws = envWs({ env: "sandbox", scope: "ADM" });
  const r1 = nav(ws, "https://evil.example.org/a");
  const r2 = nav(ws, "https://evil.example.org/b?id=42");
  const r3 = nav(ws, "https://evil.example.org/c/d");
  for (const r of [r1, r2, r3]) assert.equal(decisionOf(r), "deny");
  const base = reasonOf(r1);
  assert.match(base, /^\[guard-environment\] host non dichiarato: evil\.example\.org/);
  assert.doesNotMatch(base, HINT, "primo diniego: nessun suggerimento");
  assert.doesNotMatch(reasonOf(r2), HINT, "secondo diniego: nessun suggerimento");
  const r3reason = reasonOf(r3);
  assert.ok(r3reason.startsWith(base), "il motivo originale resta all'inizio, invariato");
  assert.equal(r3reason, `${base} (negato 3 volte: il manager invochi workspace-manager)`);
  assert.match(reasonOf(nav(ws, "https://evil.example.org/e")), /\(negato 4 volte: il manager invochi workspace-manager\)$/);
  const counts = JSON.parse(readFileSync(COUNTS(ws), "utf8"));
  assert.equal(counts.v, 1);
  assert.deepEqual(Object.values(counts.counts), [4]);
  const a = auditDenies(ws);
  assert.equal(a.length, 4);
  assert.ok(a.every((e) => !HINT.test(e.payload.reason)), "in audit il motivo senza suggerimento");
  assert.deepEqual(a.map((e) => e.payload.repeat ?? null), [null, null, 3, 4]);
  assert.equal(a[2].payload.hint, ADVICE.workspace);
});

test("motivi diversi (anche dallo stesso guard) ⇒ nessun suggerimento", () => {
  const ws = envWs({ env: "sandbox", scope: "ADM" });
  const rs = [
    nav(ws, "https://evil.example.org/a"),
    nav(ws, "ftp://acme-sbx.jaggaer.com/x"),
    nav(ws, "https://user:pw@acme-sbx.jaggaer.com/x"),
    nav(ws, "https://evil.example.org/b"),
    nav(ws, "https://altro.example.org/a"),
    nav(ws, "ftp://acme-sbx.jaggaer.com/y"),
  ];
  for (const r of rs) {
    assert.equal(decisionOf(r), "deny");
    assert.doesNotMatch(reasonOf(r), HINT, reasonOf(r));
  }
  const counts = JSON.parse(readFileSync(COUNTS(ws), "utf8")).counts;
  assert.ok(Object.values(counts).every((n) => n <= 2), JSON.stringify(counts));
});

test("guasto del contatore (file illeggibile o lock occupato) ⇒ decisione e motivo invariati, nessun suggerimento", () => {
  const ref = reasonOf(nav(envWs({ env: "sandbox", scope: "ADM" }), "https://evil.example.org/a"));
  // deny-counts.json è una cartella: lettura impossibile
  const ws = envWs({ env: "sandbox", scope: "ADM" });
  mkdirSync(COUNTS(ws));
  for (let i = 0; i < 3; i++) {
    const r = nav(ws, "https://evil.example.org/a");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(decisionOf(r), "deny");
    assert.equal(reasonOf(r), ref);
  }
  assert.equal(auditDenies(ws).length, 3, "l'audit registra comunque");
  // lock tenuto da un altro processo (mai scaduto durante il test): il contatore rinuncia entro pochi ms
  const ws2 = envWs({ env: "sandbox", scope: "ADM" });
  writeFileSync(`${COUNTS(ws2)}.lock`, "999999");
  const later = new Date(Date.now() + 3600000);
  utimesSync(`${COUNTS(ws2)}.lock`, later, later);
  for (let i = 0; i < 3; i++) {
    const r = nav(ws2, "https://evil.example.org/a");
    assert.equal(decisionOf(r), "deny");
    assert.equal(reasonOf(r), ref);
  }
  assert.equal(existsSync(COUNTS(ws2)), false);
  // JSON rovinato: non è un guasto, il contatore riparte da zero
  const ws3 = envWs({ env: "sandbox", scope: "ADM" });
  writeFileSync(COUNTS(ws3), "{rotto");
  const last = [1, 2, 3].map(() => nav(ws3, "https://evil.example.org/a")).at(-1);
  assert.match(reasonOf(last), /\(negato 3 volte: /);
});

test("motivo normalizzato e famiglia del consiglio", () => {
  assert.equal(normalizeReason("fuori cella (cella ACME×CAT): customers/acme/kb/scopes/adm/x.yaml non è in allowed_paths"), normalizeReason("fuori cella (cella ACME×CAT): customers/acme/kb/scopes/adm/altro/y.yaml non è in allowed_paths"));
  assert.equal(normalizeReason("passo 3 (click, ACT-OBS) del piano PLAN.0042: l'elemento 1_17 non corrisponde"), normalizeReason("passo 12 (click, ACT-OBS) del piano PLAN.0007: l'elemento e45 non corrisponde"));
  assert.equal(normalizeReason("[guard-x] URL https://a.example/x?y=1 negato (negato 4 volte: il manager invochi health-keeper)"), "URL <url> negato");
  assert.equal(normalizeReason("nessun piano attivo: /use env sandbox"), "nessun piano attivo: /use env sandbox", "i comandi /use non sono percorsi");
  assert.ok(normalizeReason("x".repeat(500)).length <= 120);
  assert.notEqual(normalizeReason("fuori cella (cella ACME×CAT): a/b"), normalizeReason("budget di sessione esaurito (10/20)"));
  // famiglie
  assert.equal(denyFamily("ambiente sandbox dichiarato ma non verificato: esegui env-check (impronta a ≥ 2 segnali)"), "workspace");
  assert.equal(denyFamily("environments.yaml è cambiato dopo /use env: in produzione serve /use env dell'utente"), "workspace");
  assert.equal(denyFamily("host non dichiarato: x.example (ambiente sandbox)"), "workspace");
  assert.equal(denyFamily("il server del browser scriverebbe un file fuori dalle cartelle di lavoro della sessione"), "workspace");
  assert.equal(denyFamily("Integrità del pacchetto fallita: reinstallare dalla release firmata (§58); non operare. Consentiti solo `doctor`"), "health");
  assert.equal(denyFamily("lock attivo su knowledge.lock: digestione in corso"), "health");
  assert.equal(denyFamily("indice KB non allineato al DB"), "health");
  assert.equal(denyFamily("fuori cella (cella ACME×CAT): customers/acme/kb/scopes/adm/x.yaml"), "other", "kb/ in un percorso non è un problema del DB");
  assert.equal(denyFamily("il piano PLAN.1 è stato modificato dopo l'attivazione (impronta diversa): riattivalo con step-check"), "other", "impronta del piano, non dell'ambiente");
  assert.equal(denyFamily("scrittura negata — area protetta (la cartella lo contiene): runs"), "other");
  assert.equal(adviceFor("budget di sessione esaurito (10/20)"), "non riprovare la stessa chiamata: riporta il motivo al manager");
});
