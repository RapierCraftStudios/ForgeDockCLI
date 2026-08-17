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
    ["-e", "process.stdout.write('out'); process.stderr.write('err')"],
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
  assert.deepEqual(events.filter((event) => event.output).map((event) => event.output?.channel).sort(), ["stderr", "stdout"]);
  observer.close();
});
