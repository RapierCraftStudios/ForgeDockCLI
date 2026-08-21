import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  ExternalOperationError,
  ExternalOperationRetryError,
  classifyExternalFault,
  externalHttpError,
  withExternalOperationRetry,
  clearExternalOperationAdmission,
} from "./external-operation-retry.js";

describe("external-operation retry", () => {
  it("retries a transient fault and returns the eventual result", async () => {
    let calls = 0;
    const delays: number[] = [];
    const result = await withExternalOperationRetry(async () => {
      calls++;
      if (calls < 3) throw Object.assign(new Error("temporary socket reset"), { code: "ECONNRESET" });
      return "ok";
    }, { baseDelayMs: 10, maxDelayMs: 100, jitterRatio: 0, sleep: async (delay) => { delays.push(delay); } });
    assert.equal(result, "ok");
    assert.equal(calls, 3);
    assert.deepEqual(delays, [10, 20]);
  });

  it("bounds retries and preserves every original root cause", async () => {
    const first = Object.assign(new Error("dns temporary"), { code: "EAI_AGAIN" });
    const second = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    let calls = 0;
    await assert.rejects(
      withExternalOperationRetry(async () => {
        calls++;
        throw calls === 1 ? first : second;
      }, { maxAttempts: 2, jitterRatio: 0, sleep: async () => {} }),
      (error: unknown) => {
        assert.ok(error instanceof ExternalOperationRetryError);
        assert.equal(error.attempts, 2);
        assert.equal(error.cause, second);
        assert.deepEqual(error.failures, [first, second]);
        return true;
      },
    );
  });

  it("stops before another attempt when cancelled during backoff", async () => {
    const controller = new AbortController();
    const cancellation = new Error("caller cancelled");
    let calls = 0;
    await assert.rejects(
      withExternalOperationRetry(async () => {
        calls++;
        throw Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
      }, {
        signal: controller.signal,
        sleep: async () => controller.abort(cancellation),
      }),
      cancellation,
    );
    assert.equal(calls, 1);
  });

  it("does not retry an original non-transient error", async () => {
    const original = new Error("invalid request");
    let calls = 0;
    await assert.rejects(withExternalOperationRetry(async () => {
      calls++;
      throw original;
    }), original);
    assert.equal(calls, 1);
  });

  it("classifies retryable HTTP statuses and Retry-After", () => {
    const response = new Response("busy", { status: 429, headers: { "retry-after": "2" } });
    const error = externalHttpError(response);
    assert.deepEqual(classifyExternalFault(error), { kind: "http", status: 429, retryAfterMs: 2_000 });
    assert.equal(classifyExternalFault(new Error("HTTP 404 response")), undefined);
    assert.deepEqual(classifyExternalFault(Object.assign(new Error("TLS failure"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" })), { kind: "tls", code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });

  it("retries quota 403 but leaves permission 403 permanent", () => {
    const quota = externalHttpError({ status: 403, body: "secondary rate limit", headers: new Headers({ "retry-after": "1" }) });
    assert.deepEqual(classifyExternalFault(quota), { kind: "http", status: 403, retryAfterMs: 1_000 });
    const permission = externalHttpError({ status: 403, body: "Resource not accessible by integration", headers: new Headers() });
    assert.equal(classifyExternalFault(permission), undefined);
  });

  it("shares host admission backoff across concurrent callers", async () => {
    clearExternalOperationAdmission("test-host");
    let now = 0;
    let sleeps = 0;
    let calls = 0;
    const sleep = async (delay: number) => { sleeps++; now += delay; };
    const operation = async () => {
      calls++;
      if (calls <= 2) throw externalHttpError({ status: 429, headers: new Headers({ "retry-after": "2" }) });
      return "ok";
    };
    const options = { hostKey: "test-host", now: () => now, sleep, jitterRatio: 0, maxAttempts: 2 };
    assert.deepEqual(await Promise.all([withExternalOperationRetry(operation, options), withExternalOperationRetry(operation, options)]), ["ok", "ok"]);
    assert.ok(sleeps >= 2);
    clearExternalOperationAdmission("test-host");
  });

  it("classifies GitHub's exact connectivity guidance as transient network", () => {
    assert.deepEqual(
      classifyExternalFault(new Error("error connecting to api.github.com\\ncheck your internet connection or try again")),
      { kind: "network" },
    );
  });

  it("keeps the bounded final cause in exhaustion messages and cause chain", async () => {
    const final = new Error("HTTP 503: unavailable");
    await assert.rejects(
      withExternalOperationRetry(async () => { throw final; }, { maxAttempts: 3, jitterRatio: 0, sleep: async () => {} }),
      (error: unknown) => {
        assert.ok(error instanceof ExternalOperationRetryError);
        assert.match(error.message, /HTTP 503: unavailable/);
        assert.equal(error.cause, final);
        return true;
      },
    );
  });

  it("keeps a typed wrapper's root cause", () => {
    const original = new Error("socket");
    const error = new ExternalOperationError("socket failed", { kind: "network" }, { cause: original });
    assert.equal(error.cause, original);
    assert.deepEqual(classifyExternalFault(error), { kind: "network" });
  });
});
