---
type: llm
focus: last_message
---

PASS se il rapporto ha status escalate con l'output parziale (almeno due categorie candidate con punteggi sotto
0,60 e le prove incoerenti: messaggio, rete, console) destinato al root-cause-analyst.
FAIL se il rapporto chiude con una categoria certa sopra soglia, ne inventa una o chiede all'utente di scegliere.
