// Revisione di sicurezza del commit 1245530 (WP09a-A): il lettore ZIP non si fida delle dimensioni dichiarate
// nell'intestazione. Archivi SINTETICI generati qui (nessuna "bomba" reale su disco): limite di uscita a
// inflateRawSync, lunghezza effettiva = dichiarata, tetto per voce e per archivio, rapporto di compressione,
// numero di voci, nomi con attraversamento di percorso; harvest manda il file al residuo, non si ferma.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openZip, ZipError, LIMITS } from "../../scripts/ingest/lib/zip.mjs";
import { harvest } from "../../scripts/ingest/harvest.mjs";
import { parseDocx } from "../../scripts/ingest/parse-docx.mjs";
import { ParseError } from "../../scripts/ingest/lib/parsed.mjs";
import { makeZip } from "../helpers/zip-write.mjs";

// Sposta i campi "dimensione non compressa" dell'intestazione locale e della directory centrale della prima voce.
function patchUsize(zip, usize) {
  const b = Buffer.from(zip);
  b.writeUInt32LE(usize, 22);                                   // intestazione locale
  const cd = b.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  b.writeUInt32LE(usize, cd + 24);                              // directory centrale
  return b;
}

test("limiti documentati: 64 MB per voce, 256 MB per archivio, 10.000 voci, rapporto 200:1 oltre 1 MB", () => {
  assert.equal(LIMITS.maxEntryBytes, 64 * 1024 * 1024);
  assert.equal(LIMITS.maxTotalBytes, 256 * 1024 * 1024);
  assert.equal(LIMITS.maxEntries, 10000);
  assert.equal(LIMITS.maxRatio, 200);
  assert.equal(LIMITS.ratioFloorBytes, 1024 * 1024);
});

test("rapporto di compressione > 200:1 su una voce oltre 1 MB ⇒ ZipError (bomba), prima di decomprimere", () => {
  const bomb = makeZip([{ name: "word/document.xml", data: Buffer.alloc(4 * 1024 * 1024, 0x41) }]);
  const z = openZip(bomb);
  assert.throws(() => z.read("word/document.xml"), (e) => e instanceof ZipError && /rapporto di compressione/.test(e.message));
});

test("dimensione dichiarata falsa: più piccola del reale ⇒ l'uscita è limitata e la differenza è un ZipError; più grande del tetto ⇒ rifiuto", () => {
  const real = makeZip([{ name: "a.xml", data: Buffer.from("x".repeat(5000)) }]);
  const liar = patchUsize(real, 100);
  assert.throws(() => openZip(liar).read("a.xml"), (e) => e instanceof ZipError);
  const huge = patchUsize(real, LIMITS.maxEntryBytes + 1);
  assert.throws(() => openZip(huge).read("a.xml"), (e) => e instanceof ZipError && /troppo grande/.test(e.message));
  const bigger = patchUsize(real, 6000);
  assert.throws(() => openZip(bigger).read("a.xml"), (e) => e instanceof ZipError && /dimensione/.test(e.message));
});

test("tetto per archivio e numero di voci (limiti passabili per il test); nomi con attraversamento di percorso ⇒ ZipError", () => {
  const z = openZip(makeZip([{ name: "a", data: "12345" }, { name: "b", data: "67890" }]), { maxTotalBytes: 8 });
  z.read("a");
  assert.throws(() => z.read("b"), (e) => e instanceof ZipError && /archivio/.test(e.message));
  const many = makeZip(Array.from({ length: 6 }, (_, i) => ({ name: `f${i}`, data: "x" })));
  assert.throws(() => openZip(many, { maxEntries: 5 }), (e) => e instanceof ZipError && /voci/.test(e.message));
  for (const name of ["../evil.xml", "word/../../evil.xml", "/abs.xml", "C:/win.xml", "..\\back.xml"]) {
    assert.throws(() => openZip(makeZip([{ name, data: "x" }])), (e) => e instanceof ZipError && /percorso/.test(e.message), name);
  }
});

test("un DOCX-bomba non ferma né il parser (ParseError) né harvest (residuo con motivo)", () => {
  const bomb = makeZip([{ name: "word/document.xml", data: Buffer.alloc(3 * 1024 * 1024, 0x20) }]);
  assert.throws(() => parseDocx(bomb, { id: "b" }), (e) => e instanceof ParseError && e.residue === "unsupported");
  const dir = mkdtempSync(join(tmpdir(), "jvc-zipbomb-"));
  writeFileSync(join(dir, "bomba.docx"), bomb);
  writeFileSync(join(dir, "ok.txt"), "Testo normale.");
  const r = harvest(dir, { write: false });
  const b = r.manifest.find((m) => m.path === "bomba.docx");
  assert.equal(b.status, "residue");
  assert.equal(b.residue.class, "unsupported");
  assert.match(b.residue.reason, /ZIP rifiutato|rapporto di compressione/);
  assert.equal(r.manifest.find((m) => m.path === "ok.txt").status, "parsed");
});
