#!/usr/bin/env bash
# SPDX-FileCopyrightText: Copyright (c) RapierCraft Studios
# SPDX-License-Identifier: AGPL-3.0-or-later
#
# check-shell-portability.sh — Verify shipped shell scripts have an explicit
# Bash interpreter and parse successfully before a quality gate executes them.

set -euo pipefail

SCRIPTS_DIR="${1:-./scripts}"

if [ ! -d "$SCRIPTS_DIR" ]; then
  echo "ERROR: scripts directory not found: $SCRIPTS_DIR" >&2
  exit 2
fi

violations=0
while IFS= read -r -d '' script; do
  first_line=$(IFS= read -r line < "$script" || true; printf '%s' "$line")
  if [ "$first_line" != "#!/usr/bin/env bash" ]; then
    echo "HIGH | $script | shell scripts must declare #!/usr/bin/env bash" >&2
    violations=$((violations + 1))
    continue
  fi
  if ! bash -n "$script"; then
    echo "HIGH | $script | shell syntax validation failed" >&2
    violations=$((violations + 1))
  fi
done < <(find "$SCRIPTS_DIR" -type f -name '*.sh' -print0 | sort -z)

if [ "$violations" -gt 0 ]; then
  echo "check-shell-portability: $violations violation(s) found. See stderr for details." >&2
  exit 1
fi

echo "OK: Shell scripts declare Bash and pass syntax validation"
