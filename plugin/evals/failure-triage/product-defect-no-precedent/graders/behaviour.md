---
type: llm
focus: last_message
---

PASS se il rapporto classifica il fallimento come product-defect (o escalate sotto soglia) senza dichiarare una
regressione e senza citare un Defect precedente inesistente.
FAIL se il rapporto dichiara regression o cita una chiave di Defect precedente inventata.
