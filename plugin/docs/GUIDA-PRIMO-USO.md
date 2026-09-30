# Guida al primo uso: esplorare JAGGAER e poi creare ordini e contratti

Scenario: pre-produzione (o test) di un cliente, Chrome DevTools MCP. Prima uscita dal vivo: metti in conto la prima
ora per installazione, login e primi aggiustamenti. Il plugin non è ancora stato provato su un tenant reale.

## 1. Preparare (una volta)

1. Nella cartella del plugin (`plugin/` del repository):

   ```bash
   npm ci
   ```

2. Apri in Claude Code la cartella `knowledge/` del repository come workspace, con il plugin installato (marketplace
   `jaggaer-vc` del repository, oppure la cartella `plugin/` in locale; vedi README). La conoscenza del prodotto è già
   lì; quella del cliente nasce in `knowledge/customers/<CODICE>/` e si versiona con git (commit dei file YAML). Copia
   `templates/settings.template.json` del plugin in `.claude/settings.json` del workspace.
3. Controllo generale: `/jaggaer-virtual-consultant:vc doctor` → tutto verde (il browser resta giallo finché non
   lo usi).
4. Cliente: `/jaggaer-virtual-consultant:use customer <CODICE> --new` (4 caratteri, es. `ACME`).
5. **Fuori dalla sessione** (con un editor, non chiedendolo a Claude: i guard lo impediscono) compila
   `customers/<CODICE>/config/environments.yaml`. Modello minimo per la pre-produzione:

   ```yaml
   environments:
     - id: preprod
       type: preprod
       label: "<Cliente> Pre-produzione"
       base_url: "https://<tenant-pre>.jaggaer.com"
       allowed_hosts: ["<tenant-pre>.jaggaer.com", "<host del login SSO>", "<host CDN se le pagine lo usano>"]
       fingerprint: { title_pattern: "<inizio del titolo della pagina>", banner: { text_pattern: "<scritta PRE/TEST>" }, tenant_id: { value: "<id tenant>" } }
       policy:
         write_data: true
         write_data_requires_referent: true
         config_levels: [verde, giallo, rosso]
         approvals: { config_verde: 1, config_giallo: 2, config_rosso: 3 }
         evidence_profile: strict
         budget_multiplier: 0.8
       credentials_prefix: "NRT_PRE_"
   ```

   - `allowed_hosts`: tutti gli host che il browser apre (login SSO compreso), altrimenti la navigazione è negata.
   - `fingerprint`: almeno **due** segnali che coincidono sulla pagina reale (titolo, scritta del banner, id tenant).
     Aprili una volta a mano in Chrome e copia i valori veri.

## 2. Collegarsi

1. `/jaggaer-virtual-consultant:use env preprod`
2. Alla prima navigazione si apre la finestra Chrome di Chrome DevTools MCP: **fai tu il login** (SSO compreso) in
   quella finestra. Il plugin non inserisce mai credenziali. Il profilo di quella finestra di norma ricorda la
   sessione (da verificare al primo uso).
3. Chiedi: "verifica l'ambiente". L'agente apre `base_url`, salva lo snapshot ed esegue `env-check`: servono ≥ 2
   segnali. Finché l'ambiente non è verificato sono consentite solo navigazione e lettura.

## 3. Esplorare e memorizzare

1. Scrivi tu, da sola nel messaggio: `ESPLORA PREPROD`
2. Entro 10 minuti: `/jaggaer-virtual-consultant:use mode esplorazione`
3. Poi, per esempio: `/jaggaer-virtual-consultant:ops esplora ordini` (oppure a parole: "esplora il modulo ordini e
   memorizza pagine, pulsanti e campi del nuovo ordine").

Cosa fa: clicca menu, schede, link, record e apre i moduli "Nuovo/Crea", apre le tendine per leggerne i valori. **Non
preme mai** Salva, Invia, Conferma, Approva, Elimina…, né scrive nei campi: i guard lo negano. Ogni pagina viene
memorizzata con `kb atlas-write` in `customers/<CODICE>/kb/scopes/<SCOPE>/selectors|fields/` (scope P2P per gli
ordini, CON per i contratti). Per vedere cosa ha imparato: `/jaggaer-virtual-consultant:kb find --type SEL --scope P2P --customer <CODICE>`.

Esplora un modulo alla volta (ordini, poi contratti): il budget di un agente è limitato.

## 4. Creare un ordine o un contratto

1. Torna in modalità operativa: `/jaggaer-virtual-consultant:use mode ops`
2. `/jaggaer-virtual-consultant:ops crea ordine fornitore <…>, articolo <…>, quantità <…>, centro di costo <…>`
3. L'agente compone il piano dalla memoria e te lo mostra (campi e valori, come annullarlo). Se va bene scrivi
   `APPROVO PIANO <codice del piano>`.
4. Compila da solo, passo per passo, controllando ogni pagina. Prima dell'invio finale ti chiede conferma: rispondi
   `sì`.
5. Se alla memoria manca una pagina o un pulsante, si ferma e ti chiede di esplorarla (sezione 3), poi ripropone il
   piano da riapprovare.
6. Al primo successo memorizza la procedura: dalla volta dopo il piano parte da lì e cambiano solo i dati.

Mentre lavora: `/jaggaer-virtual-consultant:vc agents` mostra cosa sta facendo; `PAUSA TUTTI` e `FERMA TUTTI` lo
fermano in qualsiasi momento.

## Limiti da conoscere

- Il blocco dei pulsanti con effetto in esplorazione riconosce le **etichette** (italiano e inglese; anche "OK").
  Un elemento senza nome è bloccato; un pulsante che salva con un nome insolito ("Vai", "Fatto") no: in caso di
  dubbio `PAUSA TUTTI`.
- In alcuni moduli JAGGAER aprire "Nuovo" crea già una bozza vuota: controlla e chiudila a mano se serve.
- La memoria dell'esplorazione è marcata "osservata, non validata": la qualità dipende da quanto bene l'agente
  descrive le pagine.
- In produzione non si esplora con click e non si creano documenti.
