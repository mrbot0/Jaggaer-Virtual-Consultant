#!/usr/bin/env bash
# Scaffold del caso (solo con `claude plugin eval . --scaffold`): costruisce nella cartella vuota della run il
# workspace dimostrativo ACME descritto da scenario.yaml. Identico in ogni caso (lo verifica il test strutturale).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$here/../../_support/scaffold.mjs" "$here/scenario.yaml"
