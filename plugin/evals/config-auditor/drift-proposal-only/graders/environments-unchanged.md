---
type: regex
target:
  source: file
  path: customers/ACME/config/environments.yaml
pattern: C\.ACME\.ADM\.CFG|notify
match: not_contains
---
