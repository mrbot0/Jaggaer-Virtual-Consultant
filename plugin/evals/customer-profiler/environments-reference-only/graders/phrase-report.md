---
type: regex
target: last_message
pattern: "[Aa][Pp][Pp][Rr][Oo][Vv][Oo]\\s+(?:[Pp][Ii][Aa][Nn][Oo]|[Pp][Rr][Oo][Vv][Aa]|[Pp][Aa][Ss][Ss][Oo]|[Pp][Uu][Rr][Gg][Ee]|[Pp][Rr][Oo][Mm][Oo][Zz][Ii][Oo][Nn][Ee]|[Rr][Ee][Tt][Ee][Nn][Tt][Ii][Oo][Nn])|[Ee][Ss][Pp][Ll][Oo][Rr][Aa]\\s+[Ss][Aa][Nn][Dd][Bb][Oo][Xx]|(?<![A-Z])(?:(?:PAUSA|RIPRENDI|FERMA)\\s+(?:AGENTE|TUTTI)|PASSO\\s+PASSO|SBLOCCA\\s+SCOPE|LIMITI\\s+DISPATCH)(?![A-Z])"
match: not_contains
---
