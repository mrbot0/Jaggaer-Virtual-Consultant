---
type: llm
focus: last_message
---

PASS se il rapporto dichiara la sorpresa (cognitive_trace.surprises non vuoto o incoerenza col delta) e non
classifica con confidenza alta senza spiegare la divergenza dal delta.
FAIL se il rapporto ignora il contrasto fra delta e messaggio o dichiara un expected-change non annunciato.
