// Integrità del pacchetto (F0.3, §53.1): `build` scrive integrity.json (sha256 dei file di hooks/, scripts/,
// decision-tables/, strategies/, policy/, schemas/, mcp/, .mcp.json, .claude-plugin/plugin.json; a capo LF, ordinati)
// e, con --sign-key, la firma Ed25519 staccata integrity.json.sig; `verify` confronta il pacchetto con il manifesto.
// La verifica gira anche a ogni SessionStart (hooks/scripts/session-context.mjs): se fallisce, i guard FAIL-CLOSED
// negano tutto (hooks/lib/integrity-gate.mjs) tranne le letture del workspace e `doctor` / `integrity verify`.
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, fail } from "../lib/args.mjs";
import { isMain } from "../lib/is-main.mjs";
import { writeManifest, verifyPackage } from "../../hooks/lib/integrity.mjs";
import { activeWorkspace, isPluginDir, insideWorkspace } from "../lib/dev-only.mjs";

export const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const HELP = `uso: node scripts/admin/integrity.mjs build [--sign-key <chiave-privata-ed25519.pem>] [--root <plugin>] [--json]
     node scripts/admin/integrity.mjs verify [--root <plugin>] [--json]

build   scrive integrity.json nella radice del plugin: { version, generated_at, algorithm: sha256, files }
        (file di hooks/ scripts/ decision-tables/ strategies/ policy/ schemas/ mcp/ templates/ agents/ skills/ + .mcp.json e
        .claude-plugin/plugin.json, a capo normalizzati LF). --sign-key: firma Ed25519 staccata in
        integrity.json.sig (il percorso della chiave, mai la chiave, è l'argomento; la chiave pubblica va in
        .claude-plugin/signing-key.pem del pacchetto rilasciato).
verify  { ok, mismatched[], missing[], extra[], signature: ok|absent|invalid }. Con la chiave pubblica nel
        pacchetto la firma è obbligatoria.

Sviluppo del plugin: JVC_DEV=1 (variabile d'ambiente del processo di Claude Code, impostata dall'utente) salta il
gate di integrità dei guard; mai in un'installazione presso un cliente.

Exit code: 0 ok · 1 argomenti non validi · 2 errore di sistema · 3 integrità fallita (manifesto assente, file
alterati, mancanti o in più, firma invalida).`;

export function run(argv) {
  const { opts, positional } = parseArgs(argv);
  const asJson = !!opts.json;
  if (opts.help) { console.log(HELP); return 0; }
  const cmd = positional[0];
  const root = resolve(opts.root || PLUGIN_ROOT);
  try {
    // WP08 giro 1 (I1): --root solo verso una radice del plugin fuori da ogni workspace JVC
    if (opts.root !== undefined && (!isPluginDir(root) || insideWorkspace(root, root))) return fail(asJson, 1, `--root non è la radice di un plugin jaggaer-virtual-consultant fuori da un workspace: ${root}`);
    if (cmd === "build") {
      // il manifesto si rigenera solo nel repository del plugin, mai da dentro un workspace JVC (T9)
      const ws = activeWorkspace(root);
      if (ws) return fail(asJson, 3, `integrity build rifiutato: esecuzione dentro il workspace JVC ${ws}; il manifesto si rigenera solo nel repository del plugin, per una release`);
      const r = writeManifest(root, { signKeyFile: opts["sign-key"] ? resolve(opts["sign-key"]) : null });
      const out = { ok: true, file: join(root, "integrity.json"), files: r.files, signed: r.signed, version: r.manifest.version };
      console.log(asJson ? JSON.stringify(out) : `integrity.json: ${r.files} file${r.signed ? ", firmato" : ""} (versione ${r.manifest.version})`);
      return 0;
    }
    if (cmd === "verify") {
      const v = verifyPackage(root);
      if (asJson) console.log(JSON.stringify(v));
      else {
        console.log(v.ok ? `integrità ok (${v.version}; firma: ${v.signature})` : `integrità FALLITA (${v.status}${v.reason ? `: ${v.reason}` : ""}; firma: ${v.signature})`);
        for (const [k, list] of [["alterati", v.mismatched], ["mancanti", v.missing], ["in più", v.extra]]) if (list.length) console.log(`  ${k}: ${list.join(", ")}`);
      }
      return v.ok ? 0 : 3;
    }
    console.log(HELP);
    return 1;
  } catch (err) { return fail(asJson, 2, `errore di sistema: ${err?.message ?? err}`); }
}

if (isMain(import.meta.url)) process.exit(run(process.argv.slice(2)));
