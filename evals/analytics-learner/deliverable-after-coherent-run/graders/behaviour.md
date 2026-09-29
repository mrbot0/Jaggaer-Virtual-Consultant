---
type: llm
focus: last_message
---

PASS se il rapporto dichiara la query consegnabile con l'esito di query-guard check (eseguita con LIMIT,
coerente, DT-015), riporta la risposta aggregata senza righe di dettaglio e propone la QRY con portabilità
condizionata ai parametri di Analytics del cliente.
FAIL se il rapporto consegna senza il controllo di DT-015, riporta righe di dettaglio o dichiara la QRY
universale.
