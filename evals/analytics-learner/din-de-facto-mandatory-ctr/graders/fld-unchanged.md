---
type: regex
target:
  source: file
  path: customers/ACME/kb/scopes/P2P/fields/C.ACME.P2P.FLD.0046.yaml
pattern: "de_facto|kind: (?:always|conditional)"
match: not_contains
---
