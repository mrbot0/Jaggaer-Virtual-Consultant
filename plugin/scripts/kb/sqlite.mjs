// Database SQLite del plugin: sempre node:sqlite (DatabaseSync, incluso in Node; senza flag da Node 22.13 / 23.4).
// 28/10/2026 (blocco dal vivo): nell'installazione dell'utente mancava build/Release/better_sqlite3.node (gli script di
// installazione di npm non erano partiti), quindi OGNI hook che apre il DB (observe-append, browser-origin…) falliva, il
// marcatore delle chiamate restava aperto e l'esplorazione si bloccava; da lì il ripiego su node:sqlite.
// 29/10/2026 (decisione dell'utente, punto 9 del piano): tolta del tutto la dipendenza nativa better-sqlite3 — un solo
// motore, nessun binario da compilare. Questa classe offre l'interfaccia di better-sqlite3 che il plugin usa:
// prepare().run/get/all/iterate, exec, pragma (anche { simple: true }), transaction(fn)[.deferred|.immediate|.exclusive]
// con savepoint annidati, close; opzioni readonly, fileMustExist, timeout. Differenze di node:sqlite assorbite qui:
// righe con prototipo null (→ oggetti ordinari), BLOB come Uint8Array (→ Buffer), un array fra i parametri vale come
// elenco posizionale, undefined vale NULL, i nomi in più di un oggetto di parametri si ignorano, l'oggetto dei parametri
// nominati può stare in qualunque posizione, busy_timeout 5000 ms di serie come better-sqlite3, foreign_keys spenti come
// in SQLite (node:sqlite li accende di suo). Numeri, mai BigInt: lastInsertRowid e changes di .run() sono number.
import { createRequire } from "node:module";
import { existsSync } from "node:fs";

const require = createRequire(import.meta.url);
const SQLITE_WARNING = /\bSQLite\b/;

// Node 22/23 stampano su stderr «ExperimentalWarning: SQLite is an experimental feature…» al primo caricamento di
// node:sqlite: gli hook non devono sporcare l'uscita. Si scarta solo quell'avviso e solo mentre gira fn (il require);
// ogni altro avviso passa com'è.
export function withoutSqliteWarning(fn) {
  const orig = process.emitWarning;
  process.emitWarning = function emitWarning(warning, ...rest) {
    const type = typeof rest[0] === "string" ? rest[0] : (rest[0]?.type ?? warning?.name);
    const text = typeof warning === "string" ? warning : warning?.message;
    if (type === "ExperimentalWarning" && SQLITE_WARNING.test(String(text ?? ""))) return undefined;
    return orig.call(this, warning, ...rest);
  };
  try { return fn(); } finally { process.emitWarning = orig; }
}

let mod = null;
const nodeSqlite = () => (mod ??= withoutSqliteWarning(() => require("node:sqlite")));

// Riga di node:sqlite (prototipo null, BLOB Uint8Array) → oggetto ordinario come in better-sqlite3.
function plain(row) {
  if (row === undefined || row === null) return row;
  const o = {};
  for (const k in row) { const v = row[k]; o[k] = v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v.buffer, v.byteOffset, v.byteLength) : v; }
  return o;
}

const isNamed = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && !ArrayBuffer.isView(v);
const unprefixed = (k) => k.replace(/^[:@$]/, "");

// Parametri alla maniera di better-sqlite3 → forma di node:sqlite ([nominati?, ...posizionali]). names: i nomi della
// query quando node:sqlite non sa ignorare quelli in più (setAllowUnknownNamedParameters c'è da Node 22.15 / 23.11).
function bindArgs(args, names) {
  let named = null;
  const pos = [];
  for (const a of args) {
    if (Array.isArray(a)) { for (const x of a) pos.push(x === undefined ? null : x); } else if (isNamed(a)) {
      named ??= {};
      for (const k of Object.keys(a)) if (!names || names.has(unprefixed(k))) named[k] = a[k] === undefined ? null : a[k];
    } else pos.push(a === undefined ? null : a);
  }
  return named ? [named, ...pos] : pos;
}

class Statement {
  #st;
  #names = null;
  constructor(st) {
    this.#st = st;
    if (typeof st.setAllowUnknownNamedParameters === "function") st.setAllowUnknownNamedParameters(true);
    else this.#names = new Set([...String(st.sourceSQL ?? "").matchAll(/[:@$]([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1]));
  }
  get source() { return this.#st.sourceSQL; }
  run(...args) { return this.#st.run(...bindArgs(args, this.#names)); }
  get(...args) { return plain(this.#st.get(...bindArgs(args, this.#names))); }
  all(...args) { return this.#st.all(...bindArgs(args, this.#names)).map(plain); }
  iterate(...args) {
    const b = bindArgs(args, this.#names);
    const it = typeof this.#st.iterate === "function" ? this.#st.iterate(...b) : this.#st.all(...b);
    return (function* rows() { for (const r of it) yield plain(r); })();
  }
  columns() { return this.#st.columns(); }
}

export default class Database {
  #db;
  #depth = 0;
  #closed = false;
  #readonly;
  #name;
  constructor(path, { readonly = false, fileMustExist = false, timeout = 5000 } = {}) {
    if (fileMustExist && path !== ":memory:" && !existsSync(path)) throw new Error(`Cannot open database because the file does not exist: ${path}`);
    const { DatabaseSync } = nodeSqlite();
    this.#db = new DatabaseSync(path, { readOnly: !!readonly, enableForeignKeyConstraints: false });
    this.#readonly = !!readonly;
    this.#name = path;
    const ms = Number.isFinite(Number(timeout)) ? Math.max(0, Math.trunc(Number(timeout))) : 5000;
    this.#db.exec(`PRAGMA busy_timeout = ${ms}`);
  }
  get open() { return !this.#closed && this.#db.isOpen !== false; }
  get inTransaction() { return this.#depth > 0 || this.#db.isTransaction === true; }
  get readonly() { return this.#readonly; }
  get name() { return this.#name; }
  get memory() { return this.#name === ":memory:"; }
  pragma(text, { simple = false } = {}) {
    const rows = this.#db.prepare(`PRAGMA ${text}`).all().map(plain);
    if (!simple) return rows;
    return rows.length ? Object.values(rows[0])[0] : undefined;
  }
  exec(sql) { this.#db.exec(sql); return this; }
  prepare(sql) { return new Statement(this.#db.prepare(sql)); }
  transaction(fn) {
    const wrap = (mode) => (...args) => {
      const nested = this.inTransaction;
      const sp = `jvc_sp_${this.#depth}`;
      const undo = () => { try { this.#db.exec(nested ? `ROLLBACK TO ${sp}; RELEASE ${sp}` : "ROLLBACK"); } catch { /* già annullata da SQLite */ } };
      this.#db.exec(nested ? `SAVEPOINT ${sp}` : `BEGIN ${mode}`);
      this.#depth++;
      let r;
      try { r = fn(...args); } catch (err) { this.#depth--; undo(); throw err; }
      this.#depth--;
      // un COMMIT non riuscito (es. SQLITE_BUSY) annulla la transazione, come better-sqlite3
      try { this.#db.exec(nested ? `RELEASE ${sp}` : "COMMIT"); } catch (err) { undo(); throw err; }
      return r;
    };
    const f = wrap("DEFERRED");
    f.deferred = f;
    f.immediate = wrap("IMMEDIATE");
    f.exclusive = wrap("EXCLUSIVE");
    return f;
  }
  close() { if (!this.#closed) { this.#closed = true; this.#db.close(); } return this; }
}

// "node:sqlite" | null: il motore SQLite disponibile in questo Node (per doctor)
export function engine() {
  try { new Database(":memory:").close(); return "node:sqlite"; } catch { return null; }
}
