{{!-- Spec Playwright della corsia compilata (§27.4, opzionale, mai il default; §31.2 templates/): lo usa
scripts/chrome/compile-plan.mjs. Segnaposto: {{hash}} (obbligatorio: `compile-plan verify` legge la riga
"// plan-hash: …"), {{plan_id}}, {{goal}} (già su una riga, senza chiusure di commento), {{test_title}} (letterale JS
già tra virgolette), {{body}} (obbligatorio: un'istruzione per riga, già indentata). Senza {{hash}} o {{body}} il file è
ignorato; senza questo file lo spec si genera dal codice con lo stesso testo. Il commento non compare nello spec. --}}
// plan-hash: {{hash}}
// {{plan_id}} — {{goal}}
// ATTENZIONE: lo spec ripete i passi che creano o modificano dati senza compensazioni registrate (step-check non
// gira in CI): solo in sandbox, su dati di prova, con la pulizia a carico della pipeline (§27.4, §29.6).
// Generato da scripts/chrome/compile-plan.mjs (corsia compilata, §27.4): non modificare. Un piano cambiato invalida
// lo spec (compile-plan verify); l'Atlas resta la fonte dei target.
import { test, expect } from "@playwright/test";

test({{test_title}}, async ({ page }) => {
{{body}}
});
