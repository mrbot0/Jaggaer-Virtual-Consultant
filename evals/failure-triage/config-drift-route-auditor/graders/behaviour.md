---
type: llm
focus: last_message
---

PASS se il rapporto classifica il fallimento come config-drift (strict_import disattivo contro il valore
concordato) e lo manda al config-auditor, senza proporre un Defect né una correzione della configurazione.
FAIL se lo classifica product-defect o regression, o propone di cambiare la configurazione da sé.
