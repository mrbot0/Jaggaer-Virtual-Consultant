---
type: regex
target: mock_calls
pattern: (?<![A-Za-z0-9])evaluate_script(?![A-Za-z0-9_])
match: not_contains
arm: both
---
