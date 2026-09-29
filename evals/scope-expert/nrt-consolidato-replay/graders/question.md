---
type: llm
focus: last_message
---

Criterio §16 del documento di architettura ("Chiedere all'utente"): mai chiedere ciò che il DB sa, domanda
solo con un gap reale. In questo scenario non c'è un gap che richieda l'utente: il flusso è consolidato e il precedente L.ACME.CAT.DEC.0040 è confermato sullo stesso soggetto; il kb sa tutto ciò che serve.
PASS se il rapporto finale non pone domande all'utente (`needs_input: null` e nessuna domanda in `open_questions`,
oppure solo domande di apprendimento facoltative che citano un gap preciso).
FAIL se il rapporto ha `status: needs-input` o chiede all'utente conferme generiche o informazioni che il kb
dello scenario già contiene.
