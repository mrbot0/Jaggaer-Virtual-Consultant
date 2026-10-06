// Etichette dei pulsanti con effetto e di cancellazione (italiano e inglese): condivise da guard-config-scope (esplorazione),
// observe-append (registro delle azioni con effetto) e atlas-write/atlas-build. Modulo senza dipendenze: è sul percorso
// caldo di observe-append.
export const EFFECT_LABEL = /\b(salva|salvare|salvataggio|memorizza|registra|invia|inviare|inoltra|trasmetti|conferma|confermare|approva|approvare|autorizza|rifiuta|respingi|pubblica|pubblicare|firma|assegna|aggiudica|emetti|chiudi|annulla|revoca|ritira|attiva|disattiva|sospendi|blocca|sblocca|importa|carica|genera|esegui|applica|completa|finalizza|procedi|avanti|termina|save|submit|send|forward|transmit|confirm|approve|authori[sz]e|reject|decline|publish|sign|assign|award|issue|close|cancel|revoke|withdraw|activate|deactivate|suspend|lock|unlock|import|upload|generate|execute|run|apply|complete|finali[sz]e|finish|proceed|place\s+order|checkout|ok)\b/i;
export const DELETE_LABEL = /\b(elimina\w*|eliminazion\w*|cancella|cancellare|cancellazion\w*|rimuovi|rimuovere|rimozion\w*|svuota|svuotare|distruggi|scarta|scartare|scollega|dissocia|cestino|purge|delete|deletion|remove|removal|erase|destroy|wipe|trash|bin|discard|unlink|detach|clear)\b/i;

// Revisione di sicurezza (05/10/2026, C1): nomi tecnici ("btnDelete", "ico_delete", "row-remove") spezzati in parole
// prima del confronto, così \b vede "Delete" anche dentro camelCase, trattini bassi, trattini e punti.
export function normalizeLabel(name) {
  return String(name ?? "").replace(/([a-z\u00e0-\u00ff])([A-Z])/g, "$1 $2").replace(/[_\-.\/]+/g, " ");
}
export const isDeleteLabel = (name) => DELETE_LABEL.test(normalizeLabel(name));
// I1: finestra di conferma di una cancellazione (parola di cancellazione + domanda) — dentro, anche "Conferma"/"OK" cancellano.
const QUESTION = /\?|\bsei\s+sicur|\bvuoi\b|\bare\s+you\s+sure\b|\bdo\s+you\s+want\b|\bconfermi\b/i;
export const isDeleteQuestion = (text) => isDeleteLabel(text) && QUESTION.test(String(text ?? ""));
