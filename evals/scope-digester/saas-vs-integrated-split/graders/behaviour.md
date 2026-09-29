---
type: llm
focus: last_message
---

PASS se il rapporto separa il comportamento UI (pubblicazione) dal contratto di integrazione (invio notturno,
fallimento silenzioso in coda) in due item collegati o con i due cluster (CL-SYS-001 e CL-INT).
FAIL se tratta tutto come un unico flusso UI.
