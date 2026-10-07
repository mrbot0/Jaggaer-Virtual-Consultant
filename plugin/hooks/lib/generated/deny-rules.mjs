// GENERATO da scripts/admin/build-deny-rules.mjs a partire da policy/deny-rules.yaml: non modificare.
export default {
  "sha256": "19209a2805e6cb7a57354afccf5eb337964669f85c5e076d12997ad9b6188d35",
  "version": 1,
  "sanctioned": [
    {
      "id": "DR-OK-001",
      "script": "scripts/admin/purge.mjs",
      "require_args": [
        "--approval-1",
        "--approval-2"
      ],
      "requires_if": {},
      "positional": [
        "^[A-Z0-9]{4}$"
      ],
      "flags": {
        "--execute": null,
        "--json": null,
        "--approval-1": "^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$",
        "--approval-2": "^[A-Za-z0-9][A-Za-z0-9._:-]{3,127}$",
        "--session": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
      },
      "approvals": {
        "kind": "purge",
        "tokens": [
          "--approval-1",
          "--approval-2"
        ],
        "target_arg": 0,
        "when": "--execute"
      },
      "reason": "customer purge è l'unica cancellazione del plugin (§54.4) e si esegue solo come `node <plugin>/scripts/admin/purge.mjs <ID> --execute --approval-1 <token> --approval-2 <token>`: le due approvazioni con frase le verifica lo script e le conferma il guard nel transcript"
    },
    {
      "id": "DR-OK-002",
      "script": "scripts/admin/retention.mjs",
      "require_args": [],
      "requires_if": {
        "--apply": [
          "--approval"
        ]
      },
      "positional": [
        "^[A-Z0-9]{4}$"
      ],
      "flags": {
        "--apply": null,
        "--json": null,
        "--approval": "^[0-9a-f]{12,64}$",
        "--session": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
      },
      "approvals": {
        "kind": "retention",
        "tokens": [
          "--approval"
        ],
        "target_arg": 0,
        "when": "--apply"
      },
      "reason": "la retention si applica solo come `node <plugin>/scripts/admin/retention.mjs <C> --apply --approval <token>` (una approvazione con frase, verificata dallo script e confermata dal guard nel transcript); senza --apply è una prova a secco"
    },
    {
      "id": "DR-OK-003",
      "script": "scripts/kb/kb.mjs",
      "first_arg": "promote",
      "allow_help": true,
      "require_args": [
        "--customer"
      ],
      "requires_if": {
        "--to": [
          "--approval"
        ]
      },
      "positional": [
        "^promote$",
        "^[CL]\\.[A-Z0-9]{4}\\.[A-Z0-9]{3}\\.[A-Z]{3}\\.\\d{4}(\\.v\\d+)?$"
      ],
      "flags": {
        "--customer": "^[A-Z0-9]{4}$",
        "--to": "^product$",
        "--approval": "^[0-9a-f]{12,64}$",
        "--session": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "--json": null,
        "--help": null
      },
      "approvals": {
        "kind": "promote",
        "tokens": [
          "--approval"
        ],
        "target_arg": 1,
        "when": "--to"
      },
      "reason": "kb promote si invoca solo come `node <plugin>/scripts/kb/kb.mjs promote <codice> --customer <C> [--to product --approval <token>]`; l'approvazione della promozione a S la conferma il guard nel transcript"
    },
    {
      "id": "DR-OK-004",
      "script": "scripts/kb/lifecycle.mjs",
      "first_arg": "promote",
      "allow_help": true,
      "require_args": [
        "--customer"
      ],
      "requires_if": {
        "--to": [
          "--approval"
        ]
      },
      "positional": [
        "^promote$",
        "^[CL]\\.[A-Z0-9]{4}\\.[A-Z0-9]{3}\\.[A-Z]{3}\\.\\d{4}(\\.v\\d+)?$"
      ],
      "flags": {
        "--customer": "^[A-Z0-9]{4}$",
        "--to": "^product$",
        "--approval": "^[0-9a-f]{12,64}$",
        "--session": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "--json": null,
        "--help": null
      },
      "approvals": {
        "kind": "promote",
        "tokens": [
          "--approval"
        ],
        "target_arg": 1,
        "when": "--to"
      },
      "reason": "lifecycle.mjs promote si invoca solo nella forma esatta (come kb promote); l'approvazione della promozione a S la conferma il guard nel transcript"
    },
    {
      "id": "DR-OK-005",
      "script": "scripts/digest/learn.mjs",
      "first_arg": "promote",
      "allow_help": true,
      "require_args": [
        "--customer",
        "--approval"
      ],
      "requires_if": {},
      "positional": [
        "^promote$",
        "^[CL]\\.[A-Z0-9]{4}\\.[A-Z0-9]{3}\\.[A-Z]{3}\\.\\d{4}(\\.v\\d+)?$"
      ],
      "flags": {
        "--customer": "^[A-Z0-9]{4}$",
        "--to": "^product$",
        "--approval": "^[0-9a-f]{12,64}$",
        "--session": "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$",
        "--json": null,
        "--help": null
      },
      "approvals": {
        "kind": "promote",
        "tokens": [
          "--approval"
        ],
        "target_arg": 1
      },
      "reason": "learn promote (sempre verso product/) si invoca solo come `node <plugin>/scripts/digest/learn.mjs promote <codice> --customer <C> --approval <token>`; l'approvazione la conferma il guard nel transcript"
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
          "re": "^(rd|rmdir|del|erase)(\\s.*)?\\s/([a-z]/)*s(\\s|/|$)",
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
      "reason": "cancellazione ricorsiva o massiva da un interprete o da una pipeline (rmSync con opzioni, shutil.rmtree, FileUtils.rm_rf, File::Path remove_tree, rimraf, cancellazioni in un ciclo, elenco | Remove-Item)",
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
          "re": "\\b(fs\\.|fs\\.promises\\.|\\.)?(rm|rmdir)(sync)?\\s*\\([^)]*,",
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
          "re": "\\bfileutils\\s*\\.\\s*(rm_rf|rm_r|rm_f|rm|remove_dir|remove_entry(_secure)?|rmtree|rmdir|remove)\\b",
          "flags": "iu"
        },
        {
          "re": "\\b(rm_rf|rm_r|remove_tree|remove_entry_secure|deltree)\\b",
          "flags": "iu"
        },
        {
          "re": "\\bfile::path\\b",
          "flags": "iu"
        },
        {
          "re": "\\b(get-childitem|gci|ls|dir|get-item|gi|resolve-path|select-string)\\b[^|\\n]*\\|\\s*(remove-item|ri|rm|del|erase|rd|rmdir)\\b",
          "flags": "iu"
        },
        {
          "re": "\\|\\s*(%|foreach-object|foreach)\\s*\\{[^}]*\\b(remove-item|ri|rm|del|erase|rd|rmdir)\\b",
          "flags": "iu"
        },
        {
          "re": "\\b(os\\.(remove|unlink|rmdir)|unlinksync|fs\\.unlink|file\\.delete|os\\.removedirs)\\b[\\s\\S]*\\b(for|foreach|map|listdir|scandir|readdir(sync)?|glob|walk|iterdir)\\b",
          "flags": "iu"
        },
        {
          "re": "\\b(for|foreach|listdir|scandir|readdir(sync)?|glob|walk|iterdir)\\b[\\s\\S]*\\b(os\\.(remove|unlink|rmdir)|unlinksync|fs\\.unlink|file\\.delete|os\\.removedirs)\\b",
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
          "re": "^(?=[\\s\\S]*\\bcustomers\\b)(?=[\\s\\S]*((^|[\\s;&|(){}`])(rm|del|erase|rd|rmdir|remove-item|ri|unlink|shred|rimraf|truncate)(\\.exe)?(\\s|$)|\\bgit\\s+rm\\b|\\s-delete\\b|\\b(unlinksync|rmsync|rmdirsync|rmtree|unlink|rmdir)\\s*\\(|\\bos\\.remove\\b|\\bfs\\.rm\\b|\\bfs\\.promises\\.rm\\b|\\bio\\.(file|directory)\\]::delete\\b|\\bfileutils\\b|\\b(rm_rf|rm_r|remove_tree|rmtree|deltree)\\b|\\bfile::path\\b|\\bshutil\\b|\\bfile\\.delete\\b))",
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
      "id": "DR-SHELL-006",
      "severity": "hard-deny",
      "reason": "nome del comando dinamico (jolly nel nome, Get-Command/gcm/Get-Alias, & ( … ), & $var, iex/Invoke-Expression, Start-Process) con argomenti che toccano customers/ o percorsi protetti: il comando eseguito non è verificabile",
      "applies_to": [
        "shell"
      ],
      "on": "text",
      "patterns": [
        {
          "re": "^(?=[\\s\\S]*(customers|\\.jvc|[\\\\/]audit([\\\\/]|\\b)|\\.claude|session\\.json|approvals|\\.env|\\.auth|claude_plugin_root|integrity\\.json|deny-rules))(?=[\\s\\S]*((^|[;&|\\n({]\\s*)[&.]\\s*[($]|\\b(iex|invoke-expression|invoke-command|icm|get-command|gcm|get-alias|gal|start-process|saps|invoke-item|ii)\\b|(^|[;&|\\n({]\\s*)((sudo|doas|env|command|exec|nohup)\\s+|[A-Za-z_]\\w*=\\S*\\s+)*[^\\s;&|()]*[*?\\[][^\\s;&|()]*(\\s|$)))",
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
      "id": "DR-SHELL-007",
      "severity": "hard-deny",
      "reason": "retention.mjs si invoca solo nella forma esatta `node <plugin>/scripts/admin/retention.mjs <C> [--apply --approval <token>]`, senza catene né espansioni (§54.4)",
      "applies_to": [
        "shell"
      ],
      "on": "text",
      "patterns": [
        {
          "re": "\\bretention\\.mjs\\b",
          "flags": "iu"
        }
      ]
    },
    {
      "id": "DR-SHELL-008",
      "severity": "hard-deny",
      "reason": "la promozione (kb.mjs / lifecycle.mjs / learn.mjs promote) si invoca solo nella forma esatta del plugin, senza catene né espansioni: la promozione a S richiede un'approvazione confermata nel transcript",
      "applies_to": [
        "shell"
      ],
      "on": "first_arg",
      "patterns": [
        {
          "re": "^promote$",
          "flags": "iu"
        }
      ],
      "scripts": [
        "kb.mjs",
        "lifecycle.mjs",
        "learn.mjs"
      ]
    },
    {
      "id": "DR-SHELL-009",
      "severity": "hard-deny",
      "reason": "uso programmatico dei moduli della promozione (import/require di kb.mjs, lifecycle.mjs o learn.mjs con promote): la promozione si invoca solo nella forma esatta del plugin",
      "applies_to": [
        "shell"
      ],
      "on": "text",
      "patterns": [
        {
          "re": "^(?=[\\s\\S]*\\b(kb|lifecycle|learn)\\.mjs\\b)(?=[\\s\\S]*\\b(import|require)\\b)(?=[\\s\\S]*\\bpromote\\b)",
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
          "re": "^git(\\s.*)?\\spush(\\s.*)?\\s(-[a-z]*f[a-z]*|--force(-with-lease|-if-includes)?(=\\S*)?|\\+\\S+|--mirror|--prune)(\\s|$)",
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
          "re": "^git(\\s.*)?\\s(checkout|switch)(\\s.*)?\\s(-f|--force|--discard-changes)(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^git(\\s.*)?\\supdate-ref(\\s.*)?\\s(-d|--delete)(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^git(\\s.*)?\\sreflog\\s+(expire|delete)(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "^git(\\s.*)?\\sgc(\\s.*)?\\s--prune(=\\S*)?(\\s|$)",
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
          "re": "\\bdelete\\s+from\\b[^;]*\\bwhere\\s+\\(?\\s*(1\\s*=\\s*1|0\\s*=\\s*0|true|1|not\\s+0|not\\s+false|'[^']*'\\s*=\\s*'[^']*')\\s*\\)?\\s*(;|$|\\)|\"|or\\b|and\\b)",
          "flags": "iu"
        },
        {
          "re": "\\bdelete\\s+from\\b[^;]*\\bor\\s+(1\\s*=\\s*1|true)\\b",
          "flags": "iu"
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
      "id": "DR-SHELL-051",
      "severity": "hard-deny",
      "reason": "un nome con caratteri jolly (* ? […]) che la shell può espandere in un file di segreti (.env*, .auth): non si leggono né si copiano (T7)",
      "applies_to": [
        "shell"
      ],
      "on": "glob",
      "patterns": [
        {
          "sample": ".env"
        },
        {
          "sample": ".env.local"
        },
        {
          "sample": ".env.production"
        },
        {
          "sample": ".env.development"
        },
        {
          "sample": ".envrc"
        },
        {
          "sample": ".auth"
        }
      ],
      "samples": [
        ".env",
        ".env.local",
        ".env.production",
        ".env.development",
        ".envrc",
        ".auth"
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
      "id": "DR-SHELL-071",
      "severity": "hard-deny",
      "reason": "variabili d'ambiente persistenti (setx, [Environment]::SetEnvironmentVariable, registro Environment, launchctl setenv): renderebbero stabile JVC_DEV o un'altra variabile che cambia i guard nei processi futuri",
      "applies_to": [
        "shell"
      ],
      "on": "text",
      "patterns": [
        {
          "re": "(^|[\\s;&|(])setx(\\.exe)?(\\s|$)",
          "flags": "iu"
        },
        {
          "re": "\\[\\s*(system\\.)?environment\\s*\\]\\s*::\\s*setenvironmentvariable",
          "flags": "iu"
        },
        {
          "re": "\\bsetenvironmentvariable\\b",
          "flags": "iu"
        },
        {
          "re": "(hkcu|hkey_current_user|hklm|hkey_local_machine)(:)?[\\\\/]+(system[\\\\/]+currentcontrolset[\\\\/]+control[\\\\/]+session manager[\\\\/]+)?environment\\b",
          "flags": "iu"
        },
        {
          "re": "\\breg(\\.exe)?\\s+(add|import|load|restore|copy)\\b",
          "flags": "iu"
        },
        {
          "re": "\\blaunchctl\\s+(setenv|config)\\b",
          "flags": "iu"
        }
      ]
    },
    {
      "id": "DR-SHELL-072",
      "severity": "hard-deny",
      "reason": "scrittura nei profili della shell (.bashrc, .zshrc, .profile, $PROFILE, …): impostano variabili per i processi futuri (JVC_*), anche con nomi costruiti a runtime",
      "applies_to": [
        "shell"
      ],
      "on": "text",
      "patterns": [
        {
          "re": "^(?=[\\s\\S]*((^|[\\s'\"=>/\\\\~:])(\\.bashrc|\\.bash_profile|\\.bash_login|\\.profile|\\.zshrc|\\.zshenv|\\.zprofile|\\.zlogin|\\.cshrc|\\.tcshrc|config\\.fish|\\.pam_environment)\\b|/etc/(environment|profile)\\b|\\$profile\\b|[\\w.-]*profile\\.ps1\\b))(?=[\\s\\S]*(>|\\btee\\b|add-content|set-content|out-file|\\bac\\b|\\bsc\\b|\\bcp\\b|\\bmv\\b|copy-item|move-item|new-item|\\bni\\b|\\bsed\\s+-[a-z]*i|\\bln\\b|writefile|appendfile|\\bopen\\s*\\(|\\bdd\\b|\\binstall\\b))",
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
      "id": "DR-WRITE-005",
      "severity": "hard-deny",
      "reason": "profili della shell e file d'ambiente del sistema: impostano variabili (JVC_*) per i processi futuri; li modifica solo l'utente, fuori sessione",
      "applies_to": [
        "write"
      ],
      "on": "path",
      "patterns": [
        {
          "glob": "**/.bashrc"
        },
        {
          "glob": "**/.bash_profile"
        },
        {
          "glob": "**/.bash_login"
        },
        {
          "glob": "**/.profile"
        },
        {
          "glob": "**/.zshrc"
        },
        {
          "glob": "**/.zshenv"
        },
        {
          "glob": "**/.zprofile"
        },
        {
          "glob": "**/.zlogin"
        },
        {
          "glob": "**/.cshrc"
        },
        {
          "glob": "**/.tcshrc"
        },
        {
          "glob": "**/config.fish"
        },
        {
          "glob": "**/.pam_environment"
        },
        {
          "glob": "**/*profile.ps1"
        },
        {
          "glob": "**/etc/environment"
        },
        {
          "glob": "**/etc/profile"
        }
      ]
    },
    {
      "id": "DR-BROWSER-001",
      "severity": "confirm",
      "reason": "etichetta ambigua (rimozione di una riga o di un allegato di una bozza) dentro un passo ACT-UPDATE, letta dall'Atlas o dallo snapshot osservato (mai da element/testo del modello): conferma dell'utente prima di premere",
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
      ],
      "trusted_labels_only": true
    },
    {
      "id": "DR-BROWSER-002",
      "severity": "hard-deny",
      "reason": "ACT-DELETE: cancellare vale solo dentro un passo DELETE del piano attivo, in sandbox o pre-produzione, e solo sull'elemento del SEL di quel passo (spec 2026-10-06 §3.7, che supera ADR-06 in sandbox/pre-produzione; in produzione mai); altrove usa la compensazione close/cancel (chiudi, annulla, disattiva) prevista dal piano",
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
      ],
      "allow_in_delete_step": true
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
  ],
  "command_vocabulary": [
    "rm",
    "rmdir",
    "rd",
    "del",
    "erase",
    "remove-item",
    "ri",
    "unlink",
    "shred",
    "rimraf",
    "trash",
    "truncate",
    "dd",
    "mkfs",
    "format",
    "diskpart",
    "find",
    "xargs",
    "mv",
    "move",
    "move-item",
    "cp",
    "copy",
    "robocopy",
    "rsync",
    "git",
    "chmod",
    "npm",
    "curl",
    "wget",
    "iwr",
    "irm",
    "iex",
    "invoke-expression",
    "invoke-webrequest",
    "sh",
    "bash",
    "zsh",
    "cmd",
    "powershell",
    "pwsh",
    "node",
    "python",
    "perl",
    "ruby",
    "sqlite3",
    "setx",
    "reg",
    "clear-content",
    "set-content",
    "add-content",
    "out-file",
    "tee",
    "cat",
    "type",
    "get-content",
    "gc",
    "select-string",
    "launchctl"
  ]
};
