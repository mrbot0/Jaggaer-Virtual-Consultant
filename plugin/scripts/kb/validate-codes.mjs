// validate-codes (§44.5, plan K0.2): CLI sottile sulla validazione dei codici già esistente (scripts/kb/codes.mjs,
// la stessa che validate-schema applica all'id). Per ogni file YAML di item nei percorsi dati:
//  - il codice è valido per livello, cliente, scope e tipo (registro §5.3);
//  - il codice è il nome del file (§5: "il codice è il nome del file");
//  - nessun codice è rivendicato da due file (SEQ già usato da un'altra entità — Review Focus 3: fallisce, niente
//    sovrascrittura; nel DB lo stesso vincolo è la PRIMARY KEY di assign-seq).
// I casi NRT.* hanno la loro grammatica (validate-schema) e qui si saltano.
//
// CLI: node scripts/kb/validate-codes.mjs <file|cartella>… [--json] [--help]
// I percorsi sono file d'ingresso: si risolvono nel workspace degli hook (confinati, scripts/lib/text-file.mjs).
// Exit: 0 tutto valido · 1 codici non validi o argomenti · 2 errore di sistema.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import YAML from "yaml";
import { isValidCode } from "./codes.mjs";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { inputFile } from "../lib/text-file.mjs";

const YAML_RE = /\.ya?ml$/i;

function* yamlFiles(p) {
  const st = statSync(p);
  if (st.isFile()) { if (YAML_RE.test(p)) yield p; return; }
  for (const e of readdirSync(p, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const f = join(p, e.name);
    if (e.isDirectory()) yield* yamlFiles(f);
    else if (e.isFile() && YAML_RE.test(e.name)) yield f;
  }
}

// → { checked, errors: [{ file, id, error }] }
export function validateCodes(paths) {
  const errors = [];
  const byCode = new Map();
  let checked = 0;
  for (const p of paths) {
    for (const file of yamlFiles(p)) {
      let obj;
      try { obj = YAML.parse(readFileSync(file, "utf8")); } catch (e) { errors.push({ file, id: null, error: `YAML illeggibile (${String(e.message).split("\n")[0]})` }); continue; }
      const id = obj?.id;
      if (typeof id !== "string" || /^NRT\./.test(id)) continue;
      checked++;
      if (!isValidCode(id)) { errors.push({ file, id, error: `${id}: codice non valido per livello/cliente/scope/tipo (§5.2, §5.3)` }); continue; }
      if (basename(file).replace(YAML_RE, "") !== id) errors.push({ file, id, error: `${id}: il nome del file (${basename(file)}) non è il codice (§5)` });
      if (byCode.has(id)) errors.push({ file, id, error: `${id}: codice già usato da ${byCode.get(id)} (SEQ di un'altra entità)` });
      else byCode.set(id, file);
    }
  }
  return { checked, errors };
}

const HELP = `uso: node scripts/kb/validate-codes.mjs <file|cartella>… [--json] [--help]

Valida i codici degli item YAML (§5): validi per livello/cliente/scope/tipo, uguali al nome del file, nessun codice
rivendicato da due file. I percorsi stanno nel workspace (file d'ingresso confinati).

Exit code: 0 tutto valido · 1 codici non validi o argomenti · 2 errore di sistema.`;

export function run(argv, env = process.env) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  if (!positional.length) return fail(asJson, 1, "serve almeno un file o una cartella di item");
  const paths = [];
  for (const p of positional) {
    const c = inputFile(p, { env, dir: true });
    const f = c.error && /non è una cartella/.test(c.error) ? inputFile(p, { env }) : c;
    if (f.error) return fail(asJson, 1, f.error);
    try { statSync(f.abs); } catch { return fail(asJson, 1, `percorso inesistente: ${p}`); }
    paths.push(f.abs);
  }
  try {
    const r = validateCodes(paths);
    const ok = r.errors.length === 0;
    if (asJson) console.log(JSON.stringify({ ok, ...r }));
    else if (ok) console.log(`${r.checked} codici validi`);
    else console.error(r.errors.map((e) => `✗ ${e.error} — ${e.file}`).join("\n"));
    return ok ? 0 : 1;
  } catch (err) { return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`); }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
