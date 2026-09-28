// GENERATO da scripts/admin/build-deny-rules.mjs a partire da policy/deny-rules.yaml: non modificare.
export default {
  "sha256": "0bfb19be151eb6c201c6f8c61c6bef13a46f0ca77180f804efb4f6a453e48bde",
  "version": 1,
  "sanctioned": [
    {
      "id": "DR-OK-001",
      "script": "scripts/admin/purge.mjs",
      "require_args": [
        "--approval-1",
        "--approval-2"
      ],
      "reason": "customer purge è l'unica cancellazione del plugin (§54.4) e si esegue solo come `node <plugin>/scripts/admin/purge.mjs <ID> --execute --approval-1 <token> --approval-2 <token>`: le due approvazioni con frase le verifica lo script"
    }
  ],
  "rules": [
    {
      "id": "DR-SHELL-001",
      "severity": "hard-deny",
      "reason": "cancellazione ricorsiva (rm -r, rmdir /s, Remove-Item -Recurse, del /s): il plugin non cancella file; chiedi all'utente di farlo a mano",
      "applies_to": [
        "shell"
      ],
      "on": "command",
      "patterns": [
        {
          "re": "^rm(\\s.*)?\\s(-(?!force\\b)[a-z]*r[a-z]*|--recursive)(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^(remove-item|ri|rm|del|erase|rd|rmdir|rmd)(\\s.*)?\\s-r(e(c(u(r(s(e)?)?)?)?)?)?(\\s|$|:)",
          "flags": "iu"
        },
        {
          "re": "^(rd|rmdir|del|erase)(\\s.*)?\\s/s(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^(rimraf|del-cli|trash|trash-put)(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^find\\s.*\\s-delete(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^find\\s.*\\s-exec(dir)?\\s+(rm|shred|unlink|rmdir|del)(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^for\\s+/r\\s.*\\sdo\\s+(del|erase|rd|rmdir)(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^(rm|del|erase|remove-item|ri|unlink)\\s(.*\\s)?[^\\s-]*[*?]\\S*(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^xargs(\\s.*)?\\s(rm|del|unlink|shred|rmdir)(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^(mv|move|move-item)\\s.*\\s(/dev/null|nul|\\$null)(\\s|$)",
          "flags": "iu"
        }
      ]
    },
    {
      "id": "DR-SHELL-002",
      "severity": "hard-deny",
      "reason": "cancellazione ricorsiva da un interprete o da una pipeline (rmSync recursive, shutil.rmtree, rimraf, Get-ChildItem -Recurse | Remove-Item)",
      "applies_to": [
        "shell"
      ],
      "on": "text",
      "patterns": [
        {
          "re": "\\b(shutil\\.)?rmtree\\b",
          "flags": "iu"
        },
        {
          "re": "\\brimraf\\b",
          "flags": "iu"
        },
        {
          "re": "\\b(rm|rmdir)(sync)?\\s*\\([^)]*recursive",
          "flags": "iu"
        },
        {
          "re": "\\[(system\\.)?io\\.directory\\]::delete\\s*\\(",
          "flags": "iu"
        },
        {
          "re": "\\bdirectory\\.delete\\s*\\([^)]*,\\s*(\\$?true|1)\\s*\\)",
          "flags": "iu"
        },
        {
          "re": "\\b(get-childitem|gci|ls|dir)\\b[^|\\n]*\\s-r[a-z]*\\b[^|\\n]*\\|\\s*(remove-item|ri|rm|del|erase)\\b",
          "flags": "iu"
        }
      ]
    },
    {
      "id": "DR-SHELL-003",
      "severity": "hard-deny",
      "reason": "cancellazione sotto customers/: l'unica cancellazione ammessa è `admin customer purge` con due approvazioni (§54.4)",
      "applies_to": [
        "shell"
      ],
      "on": "text",
      "patterns": [
        {
          "re": "^(?=[\\s\\S]*\\bcustomers\\b)(?=[\\s\\S]*((^|[\\s;&|(){}`])(rm|del|erase|rd|rmdir|remove-item|ri|unlink|shred|rimraf|truncate)(\\.exe)?(\\s|$)|\\bgit\\s+rm\\b|\\s-delete\\b|\\b(unlinksync|rmsync|rmdirsync|rmtree|unlink|rmdir)\\s*\\(|\\bos\\.remove\\b|\\bfs\\.rm\\b|\\bfs\\.promises\\.rm\\b|\\bio\\.(file|directory)\\]::delete\\b))",
          "flags": "iu"
        }
      ]
    },
    {
      "id": "DR-SHELL-005",
      "severity": "hard-deny",
      "reason": "nome del comando calcolato a runtime ($VAR, $(…), backtick) con opzioni di cancellazione o forzatura: il comando eseguito non è verificabile",
      "applies_to": [
        "shell"
      ],
      "on": "text",
      "patterns": [
        {
          "re": "(^|[;&|\\n({]\\s*)(\\$\\{?[\\w:!#%/-]+\\}?|\\$\\([^)]*\\)|`[^`]*`)+\\S*(\\s+\\S+)*\\s+(-[a-z]*r[a-z]*f[a-z]*|-f[a-z]*r[a-z]*|-r|--recursive|--force|--hard|/s|-recurse|-delete)(\\s|$)",
          "flags": "iu"
        }
      ]
    },
    {
      "id": "DR-SHELL-004",
      "severity": "hard-deny",
      "reason": "purge.mjs si invoca solo nella forma esatta `node <plugin>/scripts/admin/purge.mjs <ID> --execute --approval-1 <token> --approval-2 <token>`, senza catene né espansioni",
      "applies_to": [
        "shell"
      ],
      "on": "text",
      "patterns": [
        {
          "re": "\\bpurge\\.mjs\\b",
          "flags": "iu"
        }
      ]
    },
    {
      "id": "DR-SHELL-010",
      "severity": "hard-deny",
      "reason": "git push forzato (--force, -f, --force-with-lease, +refspec) riscrive la storia remota",
      "applies_to": [
        "shell"
      ],
      "on": "command",
      "patterns": [
        {
          "re": "^git(\\s.*)?\\spush(\\s.*)?\\s(-[a-z]*f[a-z]*|--force(-with-lease|-if-includes)?(=\\S*)?|\\+\\S+)(\\s|$)",
          "flags": "iu"
        }
      ]
    },
    {
      "id": "DR-SHELL-011",
      "severity": "hard-deny",
      "reason": "git reset --hard, git clean -f, git branch -D, checkout/restore di tutto, stash drop/clear, push --delete, filter-branch distruggono lavoro non recuperabile",
      "applies_to": [
        "shell"
      ],
      "on": "command",
      "patterns": [
        {
          "re": "^git(\\s.*)?\\sreset(\\s.*)?\\s--hard(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^git(\\s.*)?\\s(checkout|restore)(\\s.*)?\\s(--\\s+)?\\.(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^git(\\s.*)?\\sstash\\s+(drop|clear)(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^git(\\s.*)?\\spush(\\s.*)?\\s(--delete|-d)(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^git(\\s.*)?\\spush\\s(.*\\s)?:[^\\s:]+(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^git(\\s.*)?\\s(filter-branch|filter-repo)(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^git(\\s.*)?\\sclean(\\s.*)?\\s(-[a-z]*f[a-z]*|--force)(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^git(\\s.*)?\\sbranch(\\s.*)?\\s(-[a-zA-Z]*D[a-zA-Z]*|--delete\\s(.*\\s)?--force|--force\\s(.*\\s)?--delete|-d\\s(.*\\s)?-f|-f\\s(.*\\s)?-d)(\\s|$)",
          "flags": "u"
        }
      ]
    },
    {
      "id": "DR-SHELL-020",
      "severity": "hard-deny",
      "reason": "formattazione, scrittura grezza su dispositivi, distruzione o troncamento di file (format, mkfs, dd of=, shred, truncate, diskpart)",
      "applies_to": [
        "shell"
      ],
      "on": "command",
      "patterns": [
        {
          "re": "^format(\\.com)?\\s+[a-z]:",
          "flags": "iu"
        },
        {
          "re": "^(mkfs|mke2fs|newfs)(\\.[a-z0-9]+)?(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^dd\\s(.*\\s)?of=",
          "flags": "iu"
        },
        {
          "re": "^shred(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^truncate(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^(diskpart|format-volume|clear-disk|initialize-disk|clear-content|clc|clear-recyclebin)(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^cipher(\\s.*)?\\s/w",
          "flags": "iu"
        },
        {
          "re": "^vssadmin(\\s.*)?\\sdelete(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^robocopy\\s.*\\s/(mir|purge)(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^rsync\\s.*\\s--(delete|delete-[a-z]+|remove-source-files)(\\s|$|=)",
          "flags": "iu"
        }
      ]
    },
    {
      "id": "DR-SHELL-030",
      "severity": "hard-deny",
      "reason": "SQL distruttivo (DROP, TRUNCATE, DELETE senza WHERE, ALTER TABLE … DROP): il DB della conoscenza si ricostruisce dai file con gli script, mai a mano",
      "applies_to": [
        "shell"
      ],
      "on": "text",
      "patterns": [
        {
          "re": "\\bdrop\\s+(table|database|schema|index|view|trigger|user|role|column)\\b",
          "flags": "iu"
        },
        {
          "re": "\\btruncate\\s+table\\b",
          "flags": "iu"
        },
        {
          "re": "\\btruncate\\s+[\\w.\"`\\[\\]]+\\s*(;|$)",
          "flags": "iu"
        },
        {
          "re": "\\bdelete\\s+from\\s+[^;]*",
          "flags": "iu",
          "unless": "\\bwhere\\b"
        },
        {
          "re": "\\balter\\s+table\\b[^;]*\\bdrop\\b",
          "flags": "iu"
        }
      ]
    },
    {
      "id": "DR-SHELL-040",
      "severity": "hard-deny",
      "reason": "esecuzione di codice scaricato o decodificato in una shell (curl | sh, iwr | iex, base64 -d | sh, bash <(curl …))",
      "applies_to": [
        "shell"
      ],
      "on": "text",
      "patterns": [
        {
          "re": "(^|[^|])\\|(?!\\|)\\s*(sudo\\s+)?(sh|bash|zsh|dash|ksh|fish|pwsh|powershell|iex|invoke-expression)(\\.exe)?(\\s|$|;|\\))",
          "flags": "iu"
        },
        {
          "re": "\\b(curl|wget|iwr|irm|invoke-webrequest|invoke-restmethod)\\b[^|\\n]*\\|\\s*(sudo\\s+)?(python3?|node|perl|ruby|php|cmd)(\\.exe)?\\b",
          "flags": "iu"
        },
        {
          "re": "\\b(iex|invoke-expression)\\b[\\s\\S]*\\b(iwr|irm|invoke-webrequest|invoke-restmethod|downloadstring|downloadfile|net\\.webclient)\\b",
          "flags": "iu"
        },
        {
          "re": "\\b(sh|bash|zsh|dash|ksh|source|\\.)\\s+(-\\w+\\s+)*<\\(",
          "flags": "iu"
        },
        {
          "re": "\\$\\(\\s*(curl|wget|iwr|irm)\\b",
          "flags": "iu"
        }
      ]
    },
    {
      "id": "DR-SHELL-050",
      "severity": "hard-deny",
      "reason": "file di segreti (.env, .env.*, .auth/): non si leggono né si copiano dalla shell (T7); le credenziali arrivano solo come variabili d'ambiente",
      "applies_to": [
        "shell"
      ],
      "on": "text",
      "patterns": [
        {
          "re": "(^|[\\s/\\\\'\"=:<>(|;&,])\\.env(\\.[\\w.-]+|-[\\w.-]+)?(?=$|[\\s'\"/\\\\;|&)<>,])",
          "flags": "iu"
        },
        {
          "re": "(^|[\\s/\\\\'\"=:<>(|;&,])\\.auth(?=$|[\\s'\"/\\\\;|&)<>,])",
          "flags": "iu"
        }
      ]
    },
    {
      "id": "DR-SHELL-060",
      "severity": "hard-deny",
      "reason": "pubblicazione di pacchetti (npm publish) e permessi ricorsivi aperti a tutti (chmod -R 777): fuori dal perimetro del plugin",
      "applies_to": [
        "shell"
      ],
      "on": "command",
      "patterns": [
        {
          "re": "^(npm|pnpm|yarn|bun)(\\s.*)?\\spublish(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^chmod(?=(\\s.*)?\\s(-[a-z]*r[a-z]*|--recursive)(\\s|$))(?=(\\s.*)?\\s0?777(\\s|$))",
          "flags": "iu"
        }
      ]
    },
    {
      "id": "DR-SHELL-070",
      "severity": "hard-deny",
      "reason": "JVC_DEV (sviluppo del plugin: salta l'integrità e la protezione del codice) è una variabile del processo di Claude Code impostata dall'utente fuori sessione: non si imposta né si cita dalla sessione",
      "applies_to": [
        "shell"
      ],
      "on": "text",
      "patterns": [
        {
          "re": "\\bJVC_DEV\\b",
          "flags": "iu"
        }
      ]
    },
    {
      "id": "DR-WRITE-001",
      "severity": "hard-deny",
      "reason": "l'audit è append-only e lo scrive solo l'hook audit-append (T8)",
      "applies_to": [
        "write"
      ],
      "on": "path",
      "patterns": [
        {
          "glob": "customers/*/audit/**"
        },
        {
          "glob": ".jvc/audit/**"
        }
      ]
    },
    {
      "id": "DR-WRITE-002",
      "severity": "hard-deny",
      "reason": "file di segreti (.env*, .auth/**): li gestisce solo l'utente, fuori sessione (T7)",
      "applies_to": [
        "write"
      ],
      "on": "path",
      "patterns": [
        {
          "glob": "**/.env*"
        },
        {
          "glob": "**/.auth/**"
        },
        {
          "glob": "**/.auth"
        }
      ]
    },
    {
      "id": "DR-WRITE-003",
      "severity": "hard-deny",
      "reason": "codice e politiche del plugin in sola lettura a runtime (T9): hooks/, scripts/, policy/, tabelle, strategie, schemi, manifest e integrity.json si cambiano solo con una release; lo sviluppo del plugin avviene nel suo repository",
      "applies_to": [
        "write"
      ],
      "on": "path",
      "patterns": [
        {
          "plugin_glob": "hooks/**"
        },
        {
          "plugin_glob": "scripts/**"
        },
        {
          "plugin_glob": "policy/**"
        },
        {
          "plugin_glob": "decision-tables/**"
        },
        {
          "plugin_glob": "strategies/**"
        },
        {
          "plugin_glob": "schemas/**"
        },
        {
          "plugin_glob": "mcp/**"
        },
        {
          "plugin_glob": ".claude-plugin/**"
        },
        {
          "plugin_glob": ".mcp.json"
        },
        {
          "plugin_glob": "integrity.json"
        },
        {
          "plugin_glob": "integrity.json.sig"
        }
      ],
      "unless_env": "JVC_DEV"
    },
    {
      "id": "DR-WRITE-004",
      "severity": "hard-deny",
      "reason": "JVC_DEV (sviluppo del plugin) è una variabile del processo di Claude Code impostata dall'utente fuori sessione: nessun file scritto in sessione la imposta",
      "applies_to": [
        "write"
      ],
      "on": "content",
      "patterns": [
        {
          "re": "\\bJVC_DEV\\b",
          "flags": "iu"
        }
      ]
    },
    {
      "id": "DR-BROWSER-001",
      "severity": "confirm",
      "reason": "etichetta ambigua (rimozione di una riga o di un allegato di una bozza) dentro un passo ACT-UPDATE: conferma dell'utente prima di premere",
      "applies_to": [
        "browser"
      ],
      "on": "label",
      "patterns": [
        {
          "re": "^\\s*(rimuovi|elimina|cancella|togli|remove|delete)\\s+(la\\s+|il\\s+|l'|the\\s+)?(riga|righe|linea|linee|row|rows|line|lines|posizione|posizioni|articolo|articoli|item|items|allegato|allegati|attachment|attachments)\\b",
          "flags": "iu"
        }
      ],
      "when_step_class": [
        "ACT-UPDATE"
      ],
      "supersedes": [
        "DR-BROWSER-002"
      ]
    },
    {
      "id": "DR-BROWSER-002",
      "severity": "hard-deny",
      "reason": "ACT-DELETE: cancellare non esiste nel vocabolario dei piani (§29.4, ADR-06); usa la compensazione close/cancel (chiudi, annulla, disattiva) prevista dal piano",
      "applies_to": [
        "browser"
      ],
      "on": "label",
      "patterns": [
        {
          "re": "\\b(elimina|eliminare|cancella|cancellare|rimuovi|rimuovere|svuota|svuotare|distruggi|purge|delete|remove|erase|destroy|wipe)\\b",
          "flags": "iu"
        },
        {
          "re": "\\b(elimina|cancella|rimuovi)\\s+tutt[oi]\\b",
          "flags": "iu"
        },
        {
          "re": "\\b(delete|remove)\\s+all\\b",
          "flags": "iu"
        }
      ]
    },
    {
      "id": "DR-BROWSER-003",
      "severity": "hard-deny",
      "reason": "amministrazione degli utenti (disattivazione, reset della password, cambio di ruolo, impersonificazione): solo dentro un passo di piano ACT-CFG-CHANGE approvato (§52)",
      "applies_to": [
        "browser"
      ],
      "on": "label",
      "patterns": [
        {
          "re": "\\b(disattiva|disattivare|disabilita|disabilitare|blocca|bloccare|sospendi)\\s+(l'\\s*|lo\\s+|gli\\s+|il\\s+)?(utente|utenti|account|user|users)\\b",
          "flags": "iu"
        },
        {
          "re": "\\b(deactivate|disable|lock|suspend)\\s+(the\\s+)?(user|users|account)\\b",
          "flags": "iu"
        },
        {
          "re": "\\b(reset|resetta|reimposta|reimpostare|azzera)\\s+(la\\s+|the\\s+)?password\\b",
          "flags": "iu"
        },
        {
          "re": "\\bpassword\\s+reset\\b",
          "flags": "iu"
        },
        {
          "re": "\\b(cambia|cambiare|modifica|modificare|assegna|assegnare|revoca|revocare)\\s+(il\\s+|i\\s+)?(ruolo|ruoli|permessi|profilo)\\b",
          "flags": "iu"
        },
        {
          "re": "\\b(change|assign|revoke)\\s+(the\\s+)?(role|roles|permissions)\\b",
          "flags": "iu"
        },
        {
          "re": "\\b(impersona|impersonate|accedi\\s+come|login\\s+as|log\\s+in\\s+as)\\b",
          "flags": "iu"
        }
      ],
      "unless_step_class": [
        "ACT-CFG-CHANGE"
      ]
    },
    {
      "id": "DR-BROWSER-004",
      "severity": "hard-deny",
      "reason": "azione massiva (Seleziona tutti + azione): solo dentro un passo di piano ACT-BULK approvato",
      "applies_to": [
        "browser"
      ],
      "on": "label",
      "patterns": [
        {
          "re": "\\b(seleziona|selezionare)\\s+tutt[io]\\b",
          "flags": "iu"
        },
        {
          "re": "\\bselect\\s+all\\b",
          "flags": "iu"
        },
        {
          "re": "\\b(azioni?|modifica|aggiornamento)\\s+(di\\s+)?mass[ai]v[ao]\\b",
          "flags": "iu"
        },
        {
          "re": "\\bbulk\\s+(action|actions|delete|update|edit|change)\\b",
          "flags": "iu"
        }
      ],
      "unless_step_class": [
        "ACT-BULK"
      ]
    },
    {
      "id": "DR-BROWSER-005",
      "severity": "confirm",
      "reason": "tasto Canc/Delete su un elemento selezionato può cancellare una riga o un record: conferma dell'utente",
      "applies_to": [
        "browser"
      ],
      "on": "key",
      "patterns": [
        {
          "re": "^\\s*((ctrl|control|cmd|meta|shift|alt)\\+)*(delete|del|canc|supr)\\s*$",
          "flags": "iu"
        }
      ]
    }
  ]
};
