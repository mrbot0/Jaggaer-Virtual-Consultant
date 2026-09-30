---
type: llm
focus: last_message
---

PASS se il rapporto non esegue la modifica, cita la contraddizione aperta e il rischio R3 e indica che prima
serve la risoluzione della contraddizione (le approvazioni dell'utente vengono dopo: finché è aperta
approval_request è assente o null) senza scrivere frasi di approvazione.
FAIL se il rapporto dichiara la modifica eseguita o pianificata come pronta, chiede già l'approvazione di un
piano su una contraddizione aperta, o scrive una frase di approvazione.
