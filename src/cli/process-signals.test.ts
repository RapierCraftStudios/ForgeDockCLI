// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  installGracefulSignalHandlers,
  ProcessSignalAbortError,
  type GracefulTerminationSignal,
  type ProcessSignalHooks,
} from "./process-signals.js";

class TestSignalHooks implements ProcessSignalHooks {
  readonly listeners = new Map<GracefulTerminationSignal, Set<() => void>>();
  readonly exitCodes: number[] = [];
  readonly forcedExitCodes: number[] = [];

  on(signal: GracefulTerminationSignal, listener: () => void): void {
    const listeners = this.listeners.get(signal) ?? new Set();
    listeners.add(listener);
    this.listeners.set(signal, listeners);
  }

  off(signal: GracefulTerminationSignal, listener: () => void): void {
    this.listeners.get(signal)?.delete(listener);
  }

  setExitCode(code: number): void {
    this.exitCodes.push(code);
  }

  forceExit(code: number): void {
    this.forcedExitCodes.push(code);
  }

  emit(signal: GracefulTerminationSignal): void {
    for (const listener of [...(this.listeners.get(signal) ?? [])]) listener();
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  }
}

test("the first process signal aborts graceful work with its conventional exit code", () => {
  const hooks = new TestSignalHooks();
  const lifecycle = installGracefulSignalHandlers(hooks);

  hooks.emit("SIGTERM");

  assert.equal(lifecycle.signal.aborted, true);
  assert.ok(lifecycle.signal.reason instanceof ProcessSignalAbortError);
  assert.equal(lifecycle.interruption?.signal, "SIGTERM");
  assert.equal(lifecycle.interruption?.exitCode, 143);
  assert.deepEqual(hooks.exitCodes, [143]);
  assert.deepEqual(hooks.forcedExitCodes, []);
  lifecycle.dispose();
  assert.equal(hooks.listenerCount(), 0);
});

test("signal exit codes map to the conventional shell values", () => {
  for (const [signal, exitCode] of [["SIGHUP", 129], ["SIGINT", 130], ["SIGTERM", 143]] as const) {
    const hooks = new TestSignalHooks();
    const lifecycle = installGracefulSignalHandlers(hooks);
    hooks.emit(signal);
    assert.equal(lifecycle.interruption?.exitCode, exitCode);
    lifecycle.dispose();
  }
});

test("a second process signal forces termination after removing handlers", () => {
  const hooks = new TestSignalHooks();
  const lifecycle = installGracefulSignalHandlers(hooks);

  hooks.emit("SIGINT");
  hooks.emit("SIGTERM");

  assert.deepEqual(hooks.exitCodes, [130]);
  assert.deepEqual(hooks.forcedExitCodes, [130]);
  assert.equal(hooks.listenerCount(), 0);
  lifecycle.dispose();
});
