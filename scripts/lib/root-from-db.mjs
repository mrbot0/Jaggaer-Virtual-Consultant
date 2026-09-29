// WP10b: cartella del cliente (o del prodotto) quando --root manca, dedotta dal DB `<cartella>/knowledge.db`. I
// sub-agenti non citano in un comando una cartella antenata della cella (guard-scope nega `--root customers/<C>`):
// gli script che scrivono la DEC o validano le lezioni la ricavano dal --db. Con --root esplicito vince --root.
import { basename, dirname, resolve } from "node:path";

export function rootFromDb(opts = {}) {
  if (opts.root) return opts.root;
  if (typeof opts.db === "string" && basename(opts.db) === "knowledge.db") return dirname(resolve(opts.db));
  return null;
}
