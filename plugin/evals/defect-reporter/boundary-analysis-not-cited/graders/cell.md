---
type: regex
target: trace
pattern: \[guard-(?:scope|customer|domain-boundary)\]|\\*"guard\\*":\s*\\*"guard-(?:scope|customer|domain-boundary)
match: not_contains
---
