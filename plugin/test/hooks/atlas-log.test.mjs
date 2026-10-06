// Soluzione A (spec 2026-09-30 §A1): registro dell'esplorazione di sola struttura.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSnapshot } from "../../scripts/chrome/snapshot-parse.mjs";
import { pageRecord, clickRecord, appendAtlasLog } from "../../hooks/lib/atlas-log.mjs";

const SNAP = `## Latest page snapshot
uid=1_0 RootWebArea "Nuovo ordine - ACME PRE" url="https://acme-pre.jaggaer.com/p2p/po/new?supplier=77"
  uid=1_1 navigation "Menu"
    uid=1_2 link "Ordini"
  uid=1_3 heading "Nuovo ordine" level="1"
  uid=1_4 form
    uid=1_5 textbox "Descrizione " required value="Ordine per mario.rossi@example.com"
    uid=1_6 combobox "Divisa" value="EUR"
      uid=1_7 option "EUR"
      uid=1_8 option "USD"
    uid=1_9 button "Salva bozza"
  uid=1_10 table "Ultimi ordini"
    uid=1_11 row
      uid=1_12 columnheader "Fornitore"
    uid=1_13 row
      uid=1_14 cell "Arredi Rossi Srl"
      uid=1_15 link "PO-4500012345"
`;

test("pageRecord: solo struttura — niente valori, niente righe di tabella salvo le intestazioni, URL senza query", () => {
  const r = pageRecord(parseSnapshot(SNAP), { pageSig: "p2p/po/new#nuovo-ordine", profile: "strict", env: {}, ts: "2026-09-30T10:00:00.000Z" });
  assert.equal(r.kind, "page");
  assert.equal(r.url_path, "/p2p/po/new");
  assert.equal(r.page_sig, "p2p/po/new#nuovo-ordine");
  const names = r.elements.map((e) => e.name);
  assert.ok(names.includes("Ordini") && names.includes("Salva bozza") && names.includes("Fornitore"), JSON.stringify(names));
  assert.ok(names.includes("EUR") && names.includes("USD"), "opzioni della tendina");
  // esplorazione completa (05/10/2026, scelta dell'utente): le righe si registrano, marcate record (dati, non struttura)
  assert.ok(r.elements.filter((e) => /Arredi|PO-45/.test(e.name)).every((e) => e.record === true), "record della tabella marcati");
  assert.ok(r.elements.filter((e) => ["Ordini", "Salva bozza", "Fornitore"].includes(e.name)).every((e) => !e.record), "struttura non marcata");
  assert.ok(!JSON.stringify(r).includes("mario.rossi"), "nessun valore");
  assert.ok(r.elements.every((e) => !("value" in e)));
  assert.equal(r.elements.find((e) => e.name === "Descrizione").required, true);
  const opt = r.elements.find((e) => e.name === "USD");
  assert.equal(r.elements[opt.parent].role, "combobox", "parent = indice dell'antenato conservato");
});

test("pageRecord: nomi redatti; al più 300 elementi", () => {
  const pii = `uid=8_0 RootWebArea "X" url="https://h/x"\n  uid=8_1 link "Scrivi a mario.rossi@example.com"\n`;
  assert.ok(!JSON.stringify(pageRecord(parseSnapshot(pii), { pageSig: "x", profile: "strict", env: {} })).includes("mario.rossi"));
  const many = `uid=9_0 RootWebArea "X" url="https://h/x"\n${Array.from({ length: 400 }, (_, i) => `  uid=9_${i + 1} button "B${i}"`).join("\n")}\n`;
  assert.equal(pageRecord(parseSnapshot(many), { pageSig: "x", profile: "standard", env: {} }).elements.length, 300);
});

test("appendAtlasLog: righe jsonl; oltre il limite 'full' senza scrivere", () => {
  const dir = mkdtempSync(join(tmpdir(), "alog-"));
  const f = join(dir, "atlas", "pages.jsonl");
  assert.equal(appendAtlasLog(f, clickRecord({ fromSig: "a#b", name: "Ordini", ts: "t" })), "written");
  assert.deepEqual(JSON.parse(readFileSync(f, "utf8").trim()), { kind: "click", ts: "t", from_sig: "a#b", target: { name: "Ordini" } });
  writeFileSync(f, "x".repeat(50));
  assert.equal(appendAtlasLog(f, clickRecord({ fromSig: "a", name: "b", ts: "t" }), { maxBytes: 40 }), "full");
  assert.equal(readFileSync(f, "utf8").length, 50);
});
