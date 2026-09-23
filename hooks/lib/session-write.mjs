// Scrittura di session.json dagli hook sul percorso caldo (guard che consumano un
// token): read-modify-write sotto lock, validato con il validatore PRECOMPILATO
// (niente Ajv a runtime, ~100 ms), poi tmp + rename. Stesso contratto di
// updateSession di scripts/admin/session.mjs.
import { readFileSync } from "node:fs";
import { withFileLock, writeFileAtomic } from "./fsx.mjs";
import validate from "./generated/session-validate.mjs";

export function updateSessionFast(file, mutate) {
  return withFileLock(`${file}.lock`, () => {
    const s = JSON.parse(readFileSync(file, "utf8"));
    const r = mutate(s);
    const obj = { ...(r && typeof r === "object" ? r : s), updated_at: new Date().toISOString() };
    if (!validate(obj)) throw new Error(`session.json non valido: ${validate.errors.slice(0, 3).map((e) => `${e.instancePath || "/"} ${e.message}`).join("; ")}`);
    writeFileAtomic(file, `${JSON.stringify(obj, null, 2)}\n`);
    return obj;
  });
}
