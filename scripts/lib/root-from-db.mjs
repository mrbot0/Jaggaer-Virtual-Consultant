// WP10b: cartella del cliente quando --root manca, dedotta dal DB. I sub-agenti non citano in un comando una cartella
// antenata della cella (guard-scope nega `--root customers/<C>`): gli script che scrivono la DEC o validano le
// lezioni la ricavano dal --db. Giro 1 (I2): SOLO se il DB è `customers/<X>/knowledge.db` e <X> è il --customer
// dichiarato (senza distinzione di maiuscole) — mai product/, mai kb/, mai un altro cliente: lì --root è
// obbligatorio, e un --root esplicito lo vedono i guard. Con --root esplicito vince --root.
import { basename, dirname, resolve } from "node:path";

export function rootFromDb(opts = {}) {
  if (opts.root) return opts.root;
  if (typeof opts.db !== "string" || basename(opts.db) !== "knowledge.db") return null;
  if (typeof opts.customer !== "string" || !opts.customer.trim()) return null;
  const dir = dirname(resolve(opts.db));
  if (basename(dirname(dir)).toLowerCase() !== "customers") return null;
  return basename(dir).toUpperCase() === opts.customer.trim().toUpperCase() ? dir : null;
}
