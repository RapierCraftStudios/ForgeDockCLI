// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { ControllerObservationAdapter } from "../observability/adapters.js";
import { ForgeDockObserver } from "../observability/observer.js";
import { SqliteObservationStore } from "../observability/sqlite-store.js";
import { executeController } from "./forgedock-tools.js";

test("controller adapter preserves stdout and stderr as separate observation channels", async () => {
  const observer = new ForgeDockObserver({
    store: new SqliteObservationStore(":memory:"),
    producer: { component: "controller-test", processInstanceId: "controller-test:1", pid: 1 },
  });
  const adapter = new ControllerObservationAdapter(observer, { identity: { controllerTaskId: "controller-1" } });
  const channels: string[] = [];
  const result = await executeController(
    process.execPath,
    ["-e", "process.stdout.write('api_key=controller-secret\\u009d52;c;'); process.stdout.write('clipboard\\u009ccontroller-out'); process.stderr.write('password=controller-error-secret')"],
    process.cwd(),
    undefined,
    () => undefined,
    {},
    (channel, text) => {
      channels.push(`${channel}:${text}`);
      adapter.output(channel, text);
    },
  );
  adapter.completed(result.code, result.truncated);
  await observer.flush();
  const events = await observer.query({ scopeKey: "controller-1" });
  assert.equal(result.code, 0);
  assert.ok(channels.some((value) => value.startsWith("stdout:")));
  assert.ok(channels.some((value) => value.startsWith("stderr:")));
  assert.deepEqual([...new Set(events.filter((event) => event.output).map((event) => event.output?.channel))].sort(), ["stderr", "stdout"]);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /controller-secret|controller-error-secret|clipboard|52;c/);
  assert.ok(events.some((event) => event.output?.text.includes("controller-out")));
  assert.equal(events.filter((event) => event.output).every((event) => event.output!.bytes === Buffer.byteLength(event.output!.text, "utf8")), true);
  assert.equal(events.filter((event) => event.output).every((event) => {
    const payload = event.payload as { bytes?: unknown };
    return typeof payload.bytes !== "number" || payload.bytes === event.output!.bytes;
  }), true);
  observer.close();
});
