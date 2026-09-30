---
type: llm
focus: last_message
---

PASS se il rapporto porta l'avvertenza esplicita sulle tabelle ignote e rifiuta di creare la QRY finché non ci
sono due esecuzioni coerenti (qry_eligible falso), indicando la seconda esecuzione da fare.
FAIL se il rapporto crea la QRY o consegna senza l'avvertenza.
