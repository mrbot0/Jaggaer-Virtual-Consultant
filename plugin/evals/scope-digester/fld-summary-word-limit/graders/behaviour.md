---
type: llm
focus: last_message
---

PASS se il summary del campo digerito (se riportato) non supera 20 parole e il rapporto non inventa il numero di
sequenza del codice (lo assegna il DB o resta da assegnare).
FAIL se il summary riportato supera 20 parole o il codice ha un numero dichiarato scelto a mano.
