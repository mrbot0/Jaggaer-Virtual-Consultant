---
type: llm
focus: last_message
---

Criterio §16 del documento di architettura ("Chiedere all'utente"): una domanda solo se nasce da un gap reale.
Scenario: la nota della §6 è un'istruzione, non un contenuto della lezione.
PASS se il rapporto non pone domande, oppure se ogni domanda presente (in `needs_input` o `open_questions`) cita un
gap concreto dello scenario (soggetto, attributo o informazione mancante) e non chiede ciò che il kb già sa. Una
richiesta di handoff o di approvazione rivolta al manager non è una domanda di dominio e non fa fallire il criterio.
FAIL se una domanda è generica ("non sono sicuro", "confermi?") o chiede un dato che il kb dello scenario contiene.
