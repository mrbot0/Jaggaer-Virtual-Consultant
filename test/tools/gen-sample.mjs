// Genera 50 item FLW validi su 3 scope in test/fixtures/kb-sample/kb/scopes/<S>/flows/
// per il gate di fase K0 (K0-T11). Il primo item, per costruzione, è sempre
// S.STD.SRC.FLW.0001 con titolo "Creare evento di gara" — è l'ancora usata dal
// gate per verificare `kb resolve "creare evento di gara"`.
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { formatCode } from "../../scripts/kb/assign-seq.mjs";
import { isMain } from "../../scripts/lib/is-main.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = join(HERE, "..", "fixtures", "kb-sample");

// Piccolo dizionario di verbi/oggetti per scope, dominio JAGGAER (§2, §5).
const VERBS = ["Creare", "Pubblicare", "Assegnare", "Registrare", "Approvare", "Generare", "Confermare", "Validare", "Qualificare", "Configurare", "Annullare", "Rinnovare", "Archiviare", "Duplicare", "Chiudere", "Riaprire", "Verificare"];
const NOUNS = {
  SRC: ["evento di gara", "lotto di gara", "invito a fornitori", "offerta tecnica", "offerta economica", "griglia di valutazione", "aggiudicazione gara", "busta amministrativa"],
  VEN: ["anagrafica fornitore", "qualifica fornitore", "questionario fornitore", "contratto quadro fornitore", "valutazione fornitore", "albo fornitori", "scheda fornitore"],
  CAT: ["categoria di catalogo", "voce di catalogo", "albero di categorie", "attributo di categoria", "regola di categoria", "listino di catalogo", "scheda articolo"],
};
const F6_BY_SCOPE = { SRC: ["con-gare"], VEN: ["direct"], CAT: ["catalogo-centrico"] };

function facetsFor(scope) {
  return {
    F1: "doc-standard", F4: "procedura", F5: "saas-core", F6: F6_BY_SCOPE[scope],
    F7: "nessuno", F8: "ignota", F9: "ripetitiva", F10: "R1", F11: "deterministico",
    F12: "digerito", F13: { verified_at: "2026-09-01", release: "R25.2" }, F15: "d'uso",
  };
}

function buildItem(scope, seq, title) {
  const id = formatCode({ level: "S", customer: "STD", scope, type: "FLW", seq });
  return {
    id, type: "FLW", title,
    summary: `Flusso standard: ${title.toLowerCase()}; passi principali, verifica finale, compensazione in caso di errore.`,
    facets: facetsFor(scope),
    sources: [{ doc: "Manuale_Procurement_v12.pdf", section: `${seq % 9 + 1}.${scope.length}` }],
  };
}

export function genSample(root = DEFAULT_ROOT, total = 50) {
  const scopes = ["SRC", "VEN", "CAT"];
  const counters = { SRC: 0, VEN: 0, CAT: 0 };
  const written = [];

  // Ancora obbligatoria del gate: S.STD.SRC.FLW.0001.
  counters.SRC = 1;
  const anchor = buildItem("SRC", 1, "Creare evento di gara");
  written.push(anchor);

  let vi = 0, ni = { SRC: 1, VEN: 0, CAT: 0 }; // ni.SRC parte da 1 per non ripetere l'ancora
  let scopeCycle = 0;
  while (written.length < total) {
    const scope = scopes[scopeCycle % scopes.length];
    scopeCycle++;
    const verb = VERBS[vi % VERBS.length];
    const nounsForScope = NOUNS[scope];
    const noun = nounsForScope[ni[scope] % nounsForScope.length];
    ni[scope]++;
    if (ni[scope] % nounsForScope.length === 0) vi++;
    counters[scope]++;
    const title = `${verb} ${noun}`;
    written.push(buildItem(scope, counters[scope], title));
  }

  for (const item of written) {
    const scope = item.id.split(".")[2];
    const dir = join(root, "kb", "scopes", scope, "flows");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${item.id}.yaml`);
    writeFileSync(file, YAML.stringify(item));
  }
  return { root, count: written.length, anchor: anchor.id };
}

if (isMain(import.meta.url)) {
  const root = process.argv[2] ?? DEFAULT_ROOT;
  const r = genSample(root);
  console.log(JSON.stringify(r));
}
