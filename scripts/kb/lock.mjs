import { openSync, closeSync, readFileSync, unlinkSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export async function withLock(dir, name, ttlMs, fn) {
  const file = join(dir, `${name}.lock`);
  if (existsSync(file)) {
    const { expires } = JSON.parse(readFileSync(file, "utf8"));
    if (Date.now() < expires) throw new Error(`lock attivo: ${file}`);
    unlinkSync(file);
  }
  const fd = openSync(file, "wx");
  writeFileSync(fd, JSON.stringify({ pid: process.pid, expires: Date.now() + ttlMs }));
  closeSync(fd);
  try { return await fn(); } finally { if (existsSync(file)) unlinkSync(file); }
}
