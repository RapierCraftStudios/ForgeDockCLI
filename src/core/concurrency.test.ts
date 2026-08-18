// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_REMOTE_READ_CONCURRENCY, mapWithConcurrency } from "./concurrency.js";

test("bounded remote reads preserve input order and cap in-flight work for 500 items", async () => {
  const values = Array.from({ length: 500 }, (_, index) => index + 1);
  let inFlight = 0;
  let maxInFlight = 0;
  const result = await mapWithConcurrency(values, async (value) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise<void>((resolve) => setTimeout(resolve, value % 3));
    inFlight -= 1;
    return value * 2;
  });

  assert.equal(maxInFlight, DEFAULT_REMOTE_READ_CONCURRENCY);
  assert.equal(inFlight, 0);
  assert.deepEqual(result, values.map((value) => value * 2));
});

test("bounded remote reads retain rejection behavior", async () => {
  await assert.rejects(
    () => mapWithConcurrency([1, 2, 3], async (value) => {
      if (value === 2) throw new Error("read failed");
      return value;
    }),
    /read failed/,
  );
});
