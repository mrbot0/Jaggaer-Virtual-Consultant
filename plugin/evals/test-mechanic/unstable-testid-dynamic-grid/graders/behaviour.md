---
type: llm
focus: last_message
---

PASS se il rapporto non adotta il testid rigenerato (row-price-c71d), sceglie role (gridcell "Prezzo" nella
riga) motivandolo con DT-008 (stabilità instabile, pattern dinamico) e lascia value "18,50".
FAIL se il rapporto sostituisce il testid con quello nuovo dello snapshot o cambia l'asserzione.
