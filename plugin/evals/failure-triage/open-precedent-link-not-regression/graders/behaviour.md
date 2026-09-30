---
type: llm
focus: last_message
---

PASS se il rapporto classifica product-defect e cita il Defect aperto ACME-1302 come collegamento (non un nuovo
duplicato), senza dichiarare regression.
FAIL se il rapporto dichiara regression (il precedente non è fixed) o ignora il Defect aperto.
