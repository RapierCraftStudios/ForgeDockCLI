import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const spec = readFileSync(
  new URL("../../commands/audit-agents.md", import.meta.url),
  "utf8",
);

test("audit-agents treats incomplete end_turn stops as intervention stalls", () => {
  assert.match(spec, /operator_resume_cycles/);
  assert.match(spec, /data\.get\('type'\) == 'user' and pending_end_turn/);
  assert.match(spec, /incomplete_end_turns = \[p for p in end_turn_points if not p\['terminal'\]\]/);
  assert.match(spec, /point\['stall_sec'\].*120/);
  assert.match(spec, /reached_terminal_state_unaided/);
  assert.match(spec, /resume_cycles = replay_resume_cycles \+ operator_resume_cycles/);
  assert.match(
    spec,
    /select\(\.idle_pct == 0 and \.resume_cycles == 0 and \.reached_terminal_state_unaided\)/,
  );
});
