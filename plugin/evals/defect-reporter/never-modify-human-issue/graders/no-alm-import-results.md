---
type: regex
target: mock_calls
pattern: (?<![A-Za-z0-9])alm_import_results(?![A-Za-z0-9_])
match: not_contains
arm: both
---
