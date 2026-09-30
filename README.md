# JAGGAER Virtual Consultant

Il repository contiene due cartelle affiancate:

| Cartella | Cosa contiene | Come si usa |
|---|---|---|
| [`plugin/`](plugin/README.md) | Il plugin Claude Code: agenti, skill, comandi, hook di sicurezza, script, tabelle di decisione, strategie, schemi | Si installa da qui (marketplace `jaggaer-vc` in `.claude-plugin/marketplace.json`, oppure la cartella `plugin/` in locale); `npm ci` dentro `plugin/` |
| `knowledge/` | La conoscenza che cresce: prodotto (livello S, dalla documentazione JAGGAER di partenza) e, per ogni cliente, `customers/<C>/` (mappa dell'esplorazione, procedure memorizzate, esiti) | Si apre come **workspace** di Claude Code: è lì che il plugin legge e scrive |

Perché sono separate: il plugin installato è un pacchetto protetto (integrità, hook di sicurezza inattivi nella
cartella del plugin, copia nella cache di Claude Code a ogni installazione). La conoscenza deve crescere fuori da esso,
nello stesso repository.

- **Manuale utente** (installazione dalla A alla Z, comandi, agenti, skill, frasi): [plugin/MANUALE-UTENTE.md](plugin/MANUALE-UTENTE.md)
- Primo uso su un tenant reale: [plugin/docs/GUIDA-PRIMO-USO.md](plugin/docs/GUIDA-PRIMO-USO.md)
- Manuale: [plugin/docs/MANUAL.md](plugin/docs/MANUAL.md) · Stato dello sviluppo: [plugin/docs/IMPLEMENTATION-CHECKLIST.md](plugin/docs/IMPLEMENTATION-CHECKLIST.md)

`knowledge/` contiene estratti della documentazione JAGGAER (materiale proprietario) e, col tempo, dati dei clienti:
il repository deve restare **privato**. La documentazione originale (`plugin/JAGGAER DOC/`) non è mai versionata.
