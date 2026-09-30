---
type: llm
focus: last_message
---

Criterio §16 del documento di architettura ("Chiedere all'utente"): mai chiedere ciò che il DB sa, domanda
solo con un gap reale. In questo scenario non c'è un gap che richieda l'utente: il kb si alimenta dopo digestione e validazione; non serve l'utente.
PASS se il rapporto finale non pone domande all'utente (`needs_input: null` e nessuna domanda in `open_questions`,
oppure solo domande di apprendimento facoltative che citano un gap preciso).
FAIL se il rapporto ha `status: needs-input` o chiede all'utente conferme generiche o informazioni che il kb
dello scenario già contiene.
