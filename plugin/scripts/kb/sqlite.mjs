// Database SQLite del plugin: better-sqlite3 se il suo binario nativo c'è, altrimenti node:sqlite (incluso in Node ≥ 22.5).
// 28/10/2026 (blocco dal vivo): nell'installazione dell'utente mancava build/Release/better_sqlite3.node (gli script di
// installazione di npm non erano partiti), quindi OGNI hook che apre il DB (observe-append, browser-origin…) falliva, il
// marcatore delle chiamate restava aperto e l'esplorazione si bloccava. Stessa interfaccia usata dal plugin:
// prepare().run/get/all, exec, pragma, transaction(fn)[.immediate], close.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import Better from "better-sqlite3";

const require = createRequire(import.meta.url);
const MISSING = /bindings file|better_sqlite3|NODE_MODULE_VERSION|was compiled against|invalid ELF|not a valid Win32/i;

class Compat {
  #db;
  #depth = 0;
  constructor(path, { readonly = false, fileMustExist = false } = {}) {
    if (fileMustExist && path !== ":memory:" && !existsSync(path)) throw new Error(`Cannot open database because the file does not exist: ${path}`);
    const { DatabaseSync } = require("node:sqlite");
    this.#db = new DatabaseSync(path, { readOnly: readonly });
  }
  get open() { return this.#db.isOpen !== false; }
  pragma(text) { return this.#db.prepare(`PRAGMA ${text}`).all(); }
  exec(sql) { this.#db.exec(sql); return this; }
  prepare(sql) { return this.#db.prepare(sql); }
  transaction(fn) {
    const wrap = (mode) => (...args) => {
      const nested = this.#depth > 0;
      const sp = `jvc_sp_${this.#depth}`;
      this.#db.exec(nested ? `SAVEPOINT ${sp}` : `BEGIN ${mode}`);
      this.#depth++;
      try {
        const r = fn(...args);
        this.#depth--;
        this.#db.exec(nested ? `RELEASE ${sp}` : "COMMIT");
        return r;
      } catch (err) {
        this.#depth--;
        try { this.#db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK"); } catch { /* già chiusa */ }
        throw err;
      }
    };
    const f = wrap("DEFERRED");
    f.deferred = f;
    f.immediate = wrap("IMMEDIATE");
    f.exclusive = wrap("EXCLUSIVE");
    return f;
  }
  close() { this.#db.close(); return this; }
}

export default class Database {
  constructor(path, opts) {
    if (process.env.JVC_SQLITE === "node") return new Compat(path, opts);   // forza il ripiego (prove)
    try { return new Better(path, opts); } catch (err) {
      if (!MISSING.test(String(err?.message ?? err))) throw err;
      return new Compat(path, opts);
    }
  }
}
// "better-sqlite3" | "node:sqlite" | null: quale motore si usa davvero (per doctor)
export function engine() {
  try { new Better(":memory:").close(); return "better-sqlite3"; } catch (err) {
    if (!MISSING.test(String(err?.message ?? err))) return null;
  }
  try { new Compat(":memory:").close(); return "node:sqlite"; } catch { return null; }
}
