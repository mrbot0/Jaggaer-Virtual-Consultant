{{!-- Page object Playwright dall'Atlas (§27.1, DT-008; §31.2 templates/): lo usa scripts/compile/generate-atlas-po.mjs --ts
per la corsia compilata. Segnaposto: {{scope}}, {{selectors}} (obbligatorio: due righe per SEL — commento e funzione che
risolve la catena testid → role → label → text → css con locator.or()), {{atlas_entries}} (obbligatorio: una riga per SEL
della mappa ATLAS). Senza i segnaposto obbligatori il file è ignorato; senza questo file i page object si generano dal
codice con lo stesso testo. Il commento non compare nel file generato. --}}
// Page object generati da generate-atlas-po (scope {{scope}}, DT-008): non modificare a mano.
import type { Page, Locator } from "@playwright/test";

{{selectors}}

export const ATLAS: Record<string, (page: Page) => Locator> = {
{{atlas_entries}}
};
