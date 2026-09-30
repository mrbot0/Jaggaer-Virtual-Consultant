// Primitive di file system condivise da hook e script: scrittura atomica
// (tmp + rename nella stessa cartella), lock advisory sincrono con file `wx`,
// lettura dell'ultima riga di un file. Solo moduli built-in: gli hook devono
// caricarsi in pochi millisecondi.
import {
  openSync, closeSync, writeSync, writeFileSync, renameSync, unlinkSync, statSync, readSync, fstatSync,
} from "node:fs";
import { randomBytes } from "node:crypto";

const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));
export function sleepSync(ms) { Atomics.wait(SLEEP_CELL, 0, 0, Math.max(1, Math.floor(ms))); }

const RETRYABLE = new Set(["EPERM", "EACCES", "EBUSY"]);

// Scrive `data` in un temporaneo nella stessa cartella e lo rinomina sul
// file finale: un lettore vede sempre il vecchio contenuto o il nuovo, mai
// uno a metà. Su Windows il rename può fallire se il file è aperto altrove:
// si riprova con attesa breve.
export function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  writeFileSync(tmp, data);
  for (let attempt = 0; ; attempt++) {
    try { renameSync(tmp, file); return; } catch (err) {
      if (!RETRYABLE.has(err.code) || attempt >= 20) {
        try { unlinkSync(tmp); } catch { /* già rimosso */ }
        throw err;
      }
      sleepSync(10 + attempt * 5);
    }
  }
}

// Lock advisory: crea `lockPath` in modo esclusivo; se esiste ed è più vecchio
// di `staleMs` lo considera abbandonato. Sincrono di proposito (gli hook sono
// processi brevi senza concorrenza interna).
export function withFileLock(lockPath, fn, { timeoutMs = 2000, staleMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx");
      writeSync(fd, String(process.pid));
      closeSync(fd);
      break;
    } catch (err) {
      if (err.code !== "EEXIST" && !RETRYABLE.has(err.code)) throw err;
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > staleMs) { unlinkSync(lockPath); continue; }
      } catch { /* sparito nel frattempo: riprova */ }
      if (Date.now() > deadline) throw new Error(`lock non acquisito entro ${timeoutMs} ms: ${lockPath}`);
      sleepSync(3 + Math.random() * 12);
    }
  }
  try { return fn(); } finally { try { unlinkSync(lockPath); } catch { /* già rimosso */ } }
}

// Ultima riga non vuota di un file di testo, leggendo dalla coda (i file di
// audit crescono per mesi: non si legge mai tutto).
export function readLastLine(file) {
  let fd;
  try { fd = openSync(file, "r"); } catch (err) { if (err.code === "ENOENT") return null; throw err; }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    let chunk = 4096;
    for (;;) {
      const len = Math.min(chunk, size);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const text = buf.toString("utf8").replace(/\s+$/, "");
      const i = text.lastIndexOf("\n");
      if (i >= 0 || len === size) return (i >= 0 ? text.slice(i + 1) : text) || null;
      chunk *= 4;
    }
  } finally { closeSync(fd); }
}
