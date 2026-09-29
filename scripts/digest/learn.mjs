// CLI `learn` (§56.7): dispatcher delle azioni di apprendimento implementate da script.
// Ogni azione vive nel suo modulo, caricato a richiesta (un'azione non paga le dipendenze delle altre).
import { isMain } from "../lib/is-main.mjs";
import { fail } from "../lib/args.mjs";

const ACTIONS = {
  outcomes: () => import("./outcomes.mjs"),
  validate: () => import("../kb/lesson.mjs"),
  calibrate: () => import("./calibrate.mjs"),
  // WP09d: digestione settimanale, competence report, promozione a S (con approvazione) e dominio analitico
  "digest-weekly": () => import("./weekly.mjs"),
  "competence-report": async () => ({ run: (await import("./weekly.mjs")).runReport }),
  promote: async () => ({ run: async (rest) => (await import("../kb/lifecycle.mjs")).main("promote", rest.includes("--to") ? rest : [...rest, "--to", "product"]) }),
  tickets: async () => ({ run: (await import("../analysis/ticket-import.mjs")).run }),
  patterns: async () => ({ run: (await import("../analysis/cluster.mjs")).run }),
  brief: async () => ({ run: (await import("../analysis/brief.mjs")).run }),
};

const HELP = `uso: node scripts/digest/learn.mjs <azione> [opzioni] [--json] [--help]

Azioni:
  outcomes    registro degli esiti: pendenti, --confirm/--disprove <DEC> --by <chi>, --expire (§12.1)
  validate    valida le lezioni proposte con DT-004 (§21.2) [--session SES…]
  calibrate   --propose: proposte di nuove versioni delle DT (§12.5), Brier e sovraconfidenza (§17.4)
  digest-weekly       digestione settimanale (§22, §45.6): candidati S, CTR di prodotto, competence report
  competence-report   l'ultimo competence report (o --week YYYY-Www)
  promote <codice> --customer C --approval <token>   promozione a S dopo la frase APPROVO PROMOZIONE <codice> (kb promote --to product)
  tickets <xlsx|csv> --customer C    importazione dei ticket con pseudonimizzazione (dominio analitico)
  patterns --customer C              cluster per firma del sintomo e catena causale → PAT/PBK
  brief --customer C --scope S       BRF per scope e livello (briefing per il digester)

<azione> --help mostra le opzioni dell'azione.
Exit code: 0 ok · 1 errore utente · 2 errore di sistema · 3 rifiutato per policy.`;

export async function run(argv) {
  const [action, ...rest] = argv;
  const asJson = argv.includes("--json");
  if (!action || action === "--help" || action === "-h") { console.log(HELP); return action ? 0 : 1; }
  const load = ACTIONS[action];
  if (!load) return fail(asJson, 1, `azione sconosciuta: ${action} (ammesse: ${Object.keys(ACTIONS).join(", ")})`);
  const mod = await load();
  return mod.run(rest);
}

if (isMain(import.meta.url)) run(process.argv.slice(2)).then((c) => process.exit(c), (e) => { console.error(e); process.exit(2); });
