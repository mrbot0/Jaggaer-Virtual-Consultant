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

1. Scrivi tu, da sola nel messaggio: `ESPLORA PREPROD` (solo click), oppure `ESPLORA PREPROD COMPLETA` per imparare tutto:
   compila con valori di prova, salva, invia, approva — mai cancellare. Con la completa verifica prima col cliente che
   la pre-produzione non invii davvero e-mail ai fornitori o dati all'ERP.
2. Entro 10 minuti: `/jaggaer-virtual-consultant:use mode esplorazione`
3. Poi, per esempio: `/jaggaer-virtual-consultant:ops esplora ordini` (oppure a parole: "esplora il modulo ordini e
   memorizza pagine, pulsanti e campi del nuovo ordine").

Cosa fa: clicca menu, schede, link, record e apre i moduli "Nuovo/Crea", apre le tendine per leggerne i valori. Con
`ESPLORA PREPROD` **non preme mai** Salva, Invia, Conferma, Approva, né scrive nei campi; con la completa sì, sempre con
valori di prova, e a fine giro ti mostra l'elenco di ciò che ha creato o modificato (puoi chiedere di annullarlo).
Elimina e affini restano sempre vietati. Registra struttura, valori di esempio dei campi e fino a 20 righe per tabella,
con e-mail, codici e altri dati riconoscibili oscurati. Ogni pagina viene
registrata da sola e, a fine giro, trasformata in mappa con `kb atlas-build` in `customers/<CODICE>/kb/scopes/<SCOPE>/selectors|fields/` (scope P2P per gli
ordini, CON per i contratti). Per vedere cosa ha imparato: `/jaggaer-virtual-consultant:kb find --type SEL --scope P2P --customer <CODICE>`.

La mappa si verifica da sola sulle pagine vere: dopo ogni giro l'agente controlla cosa manca ancora (tendine mai
aperte, campi senza etichetta, etichette ripetute, pagine raggiunte senza percorso, iframe, pulsante di salvataggio non
visto) e lo completa da solo, finché non manca più nulla o finisce il budget; ti riporta solo ciò che resta.

In esplorazione l'agente non ha tetti di azioni o di durata: va avanti finché c'è da imparare e finché c'è budget di
token nella sessione (`use budget` per alzarlo; `PAUSA TUTTI` / `FERMA TUTTI` per fermarlo).

## 4. Creare un ordine o un contratto

1. Torna in modalità operativa: `/jaggaer-virtual-consultant:use mode ops`
2. `/jaggaer-virtual-consultant:ops crea ordine fornitore <…>, articolo <…>, quantità <…>, centro di costo <…>`
   (se lo stesso modulo di creazione esiste in più moduli JAGGAER, aggiungi «nel modulo <nome>»: la mappa è organizzata
   per modulo, ricavato dalle briciole di pane o dal percorso di menu)
3. L'agente compone il piano dalla memoria e te lo mostra (campi e valori, come annullarlo); se mancano dati
   obbligatori te li chiede prima. Con **autonomia alta** (predefinita) un piano di sola creazione in pre-produzione parte
   da solo (in sandbox anche con invii); con autonomia media o bassa, o se il piano ha configurazione o cancellazioni (anche
   in sandbox) o, in pre-produzione, invii, scrivi `APPROVO PIANO <codice del piano>`. Il livello lo scegli tu: `AUTONOMIA ALTA` · `AUTONOMIA MEDIA` · `AUTONOMIA BASSA`
   (per la sessione) oppure `default:` in `customers/<CODICE>/config/autonomy.yaml`; `use show` ti dice quale vale.
4. Compila da solo, passo per passo, controllando ogni pagina (i campi della stessa pagina in un colpo solo). Con
   autonomia bassa, prima dell'invio finale ti chiede conferma: rispondi `sì`; con alta o media non te la chiede.
5. Se alla memoria manca una pagina o un pulsante, si ferma e ti chiede di esplorarla (sezione 3), poi ripropone il
   piano da riapprovare.
6. Al primo successo memorizza la procedura: dalla volta dopo il piano parte da lì e cambiano solo i dati.

Mentre lavora: `/jaggaer-virtual-consultant:vc agents` mostra cosa sta facendo; `PAUSA TUTTI` e `FERMA TUTTI` lo
fermano in qualsiasi momento.

## 5. Creare molti elementi insieme (import con template)

Per "crea 30 data element" il plugin non compila 30 maschere: usa il template di caricamento massivo dell'oggetto.

1. Se hai un template, mettilo in `customers/<CODICE>/templates-in/` e imparalo:
   `/jaggaer-virtual-consultant:kb template-learn --file customers/<CODICE>/templates-in/<file>.xlsx --object "<oggetto>" --scope <SCOPE> --page <firma della pagina di import> --tipo config --fonte utente` (`--tipo dati` per record di business).
   Se non ce l'hai, l'agente lo scarica dal tenant (pulsante "scarica template") e lo impara da solo.
2. Chiedi a parole: *"crea 30 data element …"* con i dati (o un file di righe). L'agente compila il file controllando
   ogni riga prima (obbligatori, valori ammessi, numeri); se ci sono errori te li riporta e non carica nulla.
3. Il piano carica **solo quel file** (con il suo sha256), poi legge l'esito: righe riuscite, fallite, codici creati. Le
   righe fallite si correggono e si reimportano, al massimo 2 volte; se il template è cambiato lo riscarica e lo reimpara
   una volta, poi ti chiede.
4. A fine lavoro ricevi l'elenco di ciò che è stato creato o importato.

In **produzione** l'import è possibile solo se hai attivato `write_data: true` per quell'ambiente (a mano, in
`environments.yaml`): poi servono `APPROVO PIANO` e `APPROVO PASSO <n>` prima del caricamento, e il plugin ti mostra file,
righe e oggetti toccati. Le **cancellazioni** (sandbox e pre-produzione) avvengono solo in un passo del piano, un elemento
alla volta, dopo aver salvato la lettura completa dell'oggetto; mai in produzione.

## Limiti da conoscere

- Il blocco dei pulsanti con effetto in esplorazione riconosce le **etichette** (italiano e inglese; anche "OK").
  Un elemento senza nome è bloccato; un pulsante che salva con un nome insolito ("Vai", "Fatto") no: in caso di
  dubbio `PAUSA TUTTI`.
- In alcuni moduli JAGGAER aprire "Nuovo" crea già una bozza vuota: controlla e chiudila a mano se serve.
- La memoria dell'esplorazione è marcata "osservata, non validata": la qualità dipende da quanto bene l'agente
  descrive le pagine.
- In produzione non si esplora con click; si scrive solo con `write_data: true`, piano approvato e approvazione di ogni passo
  (`APPROVO PASSO <n> <PLAN>`); `sì` non vale e non si cancella.
- L'autonomia alta in pre-produzione non chiede nulla per creare e importare (configurazione e cancellazioni chiedono comunque `APPROVO PIANO`, anche in sandbox): se il cliente non vuole sorprese, imposta
  `default: medio` nel suo `autonomy.yaml`.
