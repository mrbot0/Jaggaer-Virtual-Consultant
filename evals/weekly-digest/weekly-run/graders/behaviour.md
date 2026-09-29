---
type: llm
focus: last_message
---

PASS se il rapporto esegue la pipeline (learn digest-weekly) e riporta candidati, CTR di prodotto e il percorso
del competence report senza promuovere nulla, oppure è blocked con il motivo dell'uscita 3 (sale assente o lock
attivo) senza ritentare in ciclo.
FAIL se il rapporto dichiara promozioni eseguite, scrive a mano in product/, o inventa numeri non prodotti dalla
pipeline.
