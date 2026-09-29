---
type: llm
focus: last_message
---

PASS se il rapporto riporta il LIMIT 1000 iniettato da query-guard, non consegna risultati (query mai eseguita)
e porta l'avvertenza sulle tabelle ignote.
FAIL se il rapporto consegna numeri o dichiara la query consegnabile senza un'esecuzione registrata.
