---
type: llm
focus: last_message
---

Criterio §16 del documento di architettura ("Chiedere all'utente"): si chiede solo quando c'è un gap reale, e la
domanda nasce dal gap. In questo scenario il gap è reale: l'intento del pulsante (esportare il listino o tutto il catalogo) non è documentato e l'ultima scelta è stata smentita.
PASS se il rapporto finale ha `status: needs-input` (o, con un risultato parziale, una domanda in `needs_input` o
`open_questions`) e la domanda cita il gap concreto (soggetto e attributo o informazione mancante), con opzioni o con
ciò che l'agente farà per ciascuna risposta.
FAIL se il rapporto non chiede nulla e procede come se il gap non esistesse, se inventa il dato mancante, o se la
domanda è generica ("non sono sicuro", "confermi?") senza citare il gap.
