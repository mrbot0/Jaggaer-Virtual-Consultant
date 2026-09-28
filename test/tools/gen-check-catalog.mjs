// Genera il catalogo iniziale dei check (§62) in product/kb/scopes/<S>/checks/ (una tantum, WP09b B).
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";

const ROOT = process.argv[2];
const AREA = { "CL-CHK-002": "pre-modifica-config", "CL-CHK-003": "post-modifica-config", "CL-CHK-004": "salute-integrazioni", "CL-CHK-005": "qualita-anagrafiche",
  "CL-CHK-006": "permessi", "CL-CHK-007": "notifiche", "CL-CHK-008": "coerenza-workflow", "CL-CHK-010": "fixture-test", "CL-CHK-011": "ambiente-pronto" };
const C = [
  ["S.STD.ADM.CHK.0019", "Nessun workflow in stato 'In modifica' sull'oggetto", "precondition", { verb: "READ", target: "S.STD.ADM.SEL.0130", expect: "nessuna riga con stato 'In modifica'" }, "cheap", true, "before_config_change", "CFP con risk ≥ R2", "CL-CHK-002", "Un oggetto con un workflow in modifica non si configura: la modifica si sovrapporrebbe a una revisione aperta."],
  ["S.STD.ADM.CHK.0051", "Lo snapshot copre tutti gli oggetti governati dalla CFP", "precondition", { verb: "SCRIPT", script: "snapshot-coverage", expect: "lista completa" }, "cheap", true, "before_cfp", "ogni CFP", "CL-CHK-002", "Ogni oggetto governato ha uno stato registrato prima della modifica: senza, il ripristino non ha una base (§28.1)."],
  ["S.STD.ADM.CHK.0020", "Nessun documento in stato transitorio sul form che si modifica", "precondition", { verb: "READ", target: "S.STD.ADM.SEL.0131", expect: "conteggio 0" }, "medium", true, "before_config_change", "CL-CFG-005", "CL-CHK-002", "Un form con documenti in transito cambierebbe sotto documenti già aperti."],
  ["S.STD.ADM.CHK.0052", "Esiste una CFP di rollback provata negli ultimi 14 giorni", "precondition", { verb: "SCRIPT", script: "rollback-proven", expect: "codice RUN" }, "cheap", true, "A1", "CFP con risk ≥ R2", "CL-CHK-002", "Un rollback mai provato non è un rollback: la procedura inversa deve avere un run verde recente."],
  ["S.STD.XSC.CHK.0001", "L'ambiente dichiarato coincide con quello rilevato", "precondition", { verb: "ENV-CHECK", script: "env-verified", expect: "ok (≥ 2 segnali)" }, "cheap", true, "always", "sempre", "CL-CHK-002", "Si agisce solo sull'ambiente dichiarato e verificato con almeno due segnali (§51)."],
  ["S.STD.ADM.CHK.0044", "Il valore impostato è quello letto dopo il salvataggio", "postcondition", { verb: "READ", target: "S.STD.ADM.SEL.0132", expect: "uguale al valore impostato" }, "cheap", true, "after_save", "dopo ogni SAVE", "CL-CHK-003", "Il salvataggio è riuscito solo se la rilettura restituisce il valore impostato."],
  ["S.STD.ADM.CHK.0045", "Il verificatore NRT.*.CFG dell'oggetto è verde", "postcondition", { verb: "SCRIPT", script: "cfg-verifier-green", expect: "pass" }, "medium", true, "after_cfp", "dopo ogni CFP", "CL-CHK-003", "La configurazione è effettiva solo se il verificatore generato dalla CFP passa (§28.6)."],
  ["S.STD.ADM.CHK.0046", "Nessun nuovo errore sulle pagine governate nell'ora successiva", "postcondition", { verb: "OBS", script: "no-new-errors", expect: "0 ERR" }, "medium", true, "post_change", "post-modifica", "CL-CHK-003", "Una modifica che introduce errori sulle pagine governate va segnalata prima che arrivi agli utenti."],
  ["S.STD.XSC.CHK.0002", "Coda di uscita senza messaggi in errore più vecchi di 24 ore", "health", { verb: "READ", target: "S.STD.XSC.SEL.0001", expect: "0 messaggi" }, "cheap", true, "session_start, pre_release", "inizio sessione, pre-release", "CL-CHK-004", "Un messaggio in errore dimenticato è un documento che non è mai arrivato al controparte."],
  ["S.STD.XSC.CHK.0003", "Ultimo messaggio processato entro la latenza p95 dichiarata", "health", { verb: "READ", target: "S.STD.XSC.SEL.0002", expect: "entro la p95 dell'INT" }, "cheap", true, "pre_release", "pre-release", "CL-CHK-004", "Una coda ferma oltre la latenza dichiarata falsa ogni verifica della corsia integration."],
  ["S.STD.XSC.CHK.0004", "Stub inbound raggiungibile in sandbox", "precondition", { verb: "SCRIPT", script: "stub-reachable", expect: "200" }, "cheap", true, "before_integration_lane", "prima della integration lane", "CL-CHK-004", "Il livello L3 della corsia integration gira solo in sandbox e solo con lo stub dichiarato raggiungibile."],
  ["S.STD.XSC.CHK.0005", "Fixture strutturali presenti (lookup_or_fail per ognuna)", "precondition", { verb: "SCRIPT", script: "fixtures-present", expect: "tutte trovate" }, "cheap", true, "before_run", "prima di ogni run", "CL-CHK-005", "Un caso non crea le fixture strutturali: le trova o fallisce prima di iniziare."],
  ["S.STD.VEN.CHK.0001", "Nessun fornitore duplicato per partita IVA fra i creati da test", "data-quality", { verb: "QUERY", script: "duplicate-test-suppliers", expect: "0 duplicati", query: "fornitori NRT-* raggruppati per partita IVA con più di un elemento" }, "medium", true, "weekly", "settimanale", "CL-CHK-005", "I test non devono sporcare l'anagrafica fornitori con duplicati."],
  ["S.STD.XSC.CHK.0006", "Entità NRT-* più vecchie di 30 giorni: elenco, non cancellazione", "data-quality", { verb: "QUERY", script: "stale-test-entities", expect: "report" }, "cheap", true, "weekly", "settimanale", "CL-CHK-005", "Le entità di test vecchie si elencano per chiuderle o annullarle: mai cancellarle."],
  ["S.STD.ADM.CHK.0053", "Le persone di test hanno i ruoli attesi dal profilo", "permission", { verb: "READ", target: "S.STD.ADM.SEL.0133", expect: "ruoli uguali al profilo" }, "cheap", true, "session_start", "inizio sessione", "CL-CHK-006", "Un test eseguito con una persona dai ruoli sbagliati verifica altro da ciò che dichiara."],
  ["S.STD.XSC.CHK.0007", "In produzione le persone sono solo amministrative", "permission", { verb: "SCRIPT", script: "prod-personas-admin", expect: "ok" }, "cheap", true, "use_env_prod", "use env prod", "CL-CHK-006", "In produzione non esistono persone di business: non si creano documenti (§52.1)."],
  ["S.STD.ADM.CHK.0054", "I template di notifica referenziati dai workflow esistono", "health", { verb: "READ", target: "S.STD.ADM.SEL.0134", expect: "tutti presenti" }, "medium", true, "pre_release", "pre-release", "CL-CHK-007", "Un workflow che punta a un template mancante non notifica nessuno."],
  ["S.STD.ADM.CHK.0055", "Ogni livello di approvazione ha un approvatore attivo o una delega", "health", { verb: "READ", target: "S.STD.ADM.SEL.0135", expect: "ok per ogni livello" }, "medium", true, "pre_release, monthly", "pre-release, mensile", "CL-CHK-008", "Un livello senza approvatori attivi blocca i documenti in approvazione."],
  ["S.STD.XSC.CHK.0008", "storageState valido per ogni persona", "precondition", { verb: "SCRIPT", script: "storage-state-valid", expect: "ok" }, "cheap", true, "session_start", "inizio sessione", "CL-CHK-010", "Una sessione di test scaduta produce falsi fallimenti di login."],
  ["S.STD.XSC.CHK.0009", "Tenant raggiungibile, nessun banner di manutenzione", "health", { verb: "ENV-CHECK", expect: "ok" }, "cheap", true, "session_start", "inizio sessione", "CL-CHK-011", "Un tenant in manutenzione rende ogni esito un falso negativo ambientale (E2)."],
  ["S.STD.XSC.CHK.0010", "Budget di sessione residuo ≥ costo stimato del compito", "precondition", { verb: "SCRIPT", script: "budget-residual", expect: "ok" }, "cheap", true, "before_task", "prima di ogni compito", "CL-CHK-011", "Un compito che non sta nel budget residuo si ferma prima di cominciare (§29.10)."],
];

for (const [id, title, kind, how, cost, deterministic, frequency, when, cluster, invariant] of C) {
  const scope = id.split(".")[2];
  const item = {
    id, type: "CHK", title,
    summary: `${title}. ${invariant}`.split(/\s+/).slice(0, 55).join(" "),
    kind, how, cost, deterministic, frequency, when, cluster: [cluster], invariant,
    classification: { check_area: AREA[cluster] },
    facets: { F1: "doc-standard", F4: "check", F5: "saas-core", F6: [], F7: "nessuno", F8: "universale", F9: "ripetitiva", F10: "R0",
      F11: deterministic ? "deterministico" : "probabilistico", F12: "validato", F13: { verified_at: "2026-09-29", release: "spec-v8.0" }, F15: "tecnica" },
    sources: [{ doc: "jaggaer-virtual-consultant-architettura.md", section: "62" }, { doc: "jaggaer-virtual-consultant-architettura.md", section: "5.6" }],
  };
  const dir = join(ROOT, "product", "kb", "scopes", scope, "checks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${id}.yaml`), `# ${id} — check ripetitivo del catalogo iniziale (§62). Il codice è il nome del file.\n${YAML.stringify(item)}`);
}
console.log(C.length);
