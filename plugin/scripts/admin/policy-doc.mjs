// admin policy-doc (29/10/2026, decisione dell'utente: regole da una fonte unica). Genera docs/POLICY.md da
// hooks/lib/policy-profiles.json: la tabella delle capacità per profilo che agenti, skill e manuale citano invece di
// ripeterla. --check: exit 3 se docs/POLICY.md non è allineato (lo usa il test).
//   node scripts/admin/policy-doc.mjs [--check] [--help]
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "../lib/is-main.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const POLICY_DOC = join(ROOT, "docs", "POLICY.md");

export function render(policy = JSON.parse(readFileSync(join(ROOT, "hooks", "lib", "policy-profiles.json"), "utf8"))) {
  const profiles = Object.keys(policy.profiles);
  const out = [
    "# Policy dei guard — capacità per profilo",
    "",
    "<!-- generato da scripts/admin/policy-doc.mjs da hooks/lib/policy-profiles.json: non modificare a mano -->",
    "",
    "Il profilo della sessione lo decide il codice (`hooks/lib/policy.mjs`): produzione se l'ambiente è di tipo prod; piano se c'è un piano attivo; esplorazione se la modalità è esplorazione in sandbox o pre-produzione; altrimenti standard.",
    "",
    "| Profilo | Quando |",
    "|---|---|",
    ...profiles.map((p) => `| ${p} | ${policy.profiles[p].quando} |`),
    "",
    `| Capacità | ${profiles.join(" | ")} |`,
    `|---|${profiles.map(() => "---").join("|")}|`,
    ...Object.entries(policy.capabilities).map(([c, d]) => `| \`${c}\` — ${d} | ${profiles.map((p) => (policy.profiles[p][c] === true ? "sì" : "no")).join(" | ")} |`),
    "",
  ];
  return out.join("\n");
}

if (isMain(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) { console.log("uso: node scripts/admin/policy-doc.mjs [--check] [--help]\n\nGenera docs/POLICY.md da hooks/lib/policy-profiles.json; --check: exit 3 se non è allineato."); process.exit(0); }
  const text = render();
  if (args.includes("--check")) {
    const ok = existsSync(POLICY_DOC) && readFileSync(POLICY_DOC, "utf8").replace(/\r\n/g, "\n") === text;
    console.log(ok ? "docs/POLICY.md allineato" : "docs/POLICY.md non allineato: node scripts/admin/policy-doc.mjs");
    process.exit(ok ? 0 : 3);
  }
  writeFileSync(POLICY_DOC, text);
  console.log("docs/POLICY.md scritto");
}
