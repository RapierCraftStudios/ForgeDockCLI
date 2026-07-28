#!/usr/bin/env bash
# checkbox-sections.test.sh — Regression tests for the close-path classifier.
#
# Usage: bash scripts/checkbox-sections.test.sh

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

extract_block() {
  awk '/^FENCE_COUNT=/{printing=1} printing{print} /^SUBISSUE_ITEMS=/{exit}' "$1"
}

extract_classifier() {
  awk '
    /^CHECKBOX_SECTIONS=.*awk .$/ { printing=1; next }
    printing && /^\047\)$/ { exit }
    printing { print }
  ' "$1"
}

CLOSE_BLOCK=$(extract_block "$ROOT/commands/work-on/close.md")
INLINE_BLOCK=$(extract_block "$ROOT/commands/work-on.md")
[[ "$CLOSE_BLOCK" == "$INLINE_BLOCK" ]] || {
  printf 'FAIL: mirrored classifier blocks differ\n' >&2
  exit 1
}

CLOSE_CLASSIFIER=$(extract_classifier "$ROOT/commands/work-on/close.md")
INLINE_CLASSIFIER=$(extract_classifier "$ROOT/commands/work-on.md")
[[ "$CLOSE_CLASSIFIER" == "$INLINE_CLASSIFIER" ]] || {
  printf 'FAIL: mirrored classifier implementations differ\n' >&2
  exit 1
}

SETEXT_BODY=$'Phase One\n=========\n- [x] complete\n\nPhase Two\n---------\n- [ ] remaining'
[[ "$(printf '%s\n' "$SETEXT_BODY" | awk "$CLOSE_CLASSIFIER")" == "2" ]] || {
  printf 'FAIL: setext phases must count as two sections\n' >&2
  exit 1
}

SINGLE_BODY=$'## Acceptance Criteria\n- [ ] complete this work'
[[ "$(printf '%s\n' "$SINGLE_BODY" | awk "$CLOSE_CLASSIFIER")" == "1" ]] || {
  printf 'FAIL: one checkbox-bearing section must remain single-phase\n' >&2
  exit 1
}

printf 'PASS: mirrored classifier supports setext section boundaries\n'
