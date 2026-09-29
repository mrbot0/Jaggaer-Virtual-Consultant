---
type: llm
focus: last_message
---

PASS se il rapporto classifica NRT.ACME.CAT.NEG.0031 come regression citando il precedente (ACME-1234 o
L.ACME.CAT.DEC.0040, chiuso fixed nel 2026.08), con percorso verso il defect-reporter e un punteggio di DT-001.
FAIL se il rapporto lo classifica product-defect senza riconoscere la regressione, se inventa una categoria fuori
da DT-001 o se dichiara di aver aperto un Defect.
