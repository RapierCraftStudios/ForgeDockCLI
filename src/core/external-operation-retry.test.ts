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
    const error = externalHttpError({ status: response.status, headers: response.headers, body: "API rate limit exceeded", source: "github" });
    assert.deepEqual(classifyExternalFault(error), { kind: "github-primary-rate-limit", status: 429, retryAfterMs: 2_000, reason: "primary" });
    assert.equal(classifyExternalFault(new Error("HTTP 404 response")), undefined);
    assert.deepEqual(classifyExternalFault(Object.assign(new Error("TLS failure"), { code: "ERR_TLS_CERT_ALTNAME_INVALID" })), { kind: "tls", code: "ERR_TLS_CERT_ALTNAME_INVALID" });
  });

  it("retries quota 403 but leaves permission 403 permanent", () => {
    const quota = externalHttpError({ status: 403, body: "secondary rate limit", headers: new Headers({ "retry-after": "1" }), source: "github" });
    assert.deepEqual(classifyExternalFault(quota), { kind: "github-secondary-rate-limit", status: 403, retryAfterMs: 1_000, reason: "secondary" });
    const permissionWithRetry = externalHttpError({ status: 403, body: "Resource not accessible by integration", headers: new Headers({ "retry-after": "1" }), source: "github" });
    assert.equal(classifyExternalFault(permissionWithRetry), undefined);

  });

  it("shares host admission backoff across concurrent callers", async () => {
    clearExternalOperationAdmission("test-host");
    let now = 0;
    let sleeps = 0;
    let calls = 0;
    const sleep = async (delay: number) => { sleeps++; now += delay; };
    const operation = async () => {
      calls++;
      if (calls <= 2) throw externalHttpError({ status: 429, headers: new Headers({ "retry-after": "2" }), source: "github" });
      return "ok";
    };
    const options = { hostKey: "test-host", now: () => now, sleep, jitterRatio: 0, maxAttempts: 2 };
    assert.deepEqual(await Promise.all([withExternalOperationRetry(operation, options), withExternalOperationRetry(operation, options)]), ["ok", "ok"]);
    assert.ok(sleeps >= 2);
    clearExternalOperationAdmission("test-host");
  });

  it("shares durable-style rate-limit admission and resumes after reset", async () => {
    let blockedUntil = 0;
    const coordinator = {
      readAdmission: (key: string, now = 0) => blockedUntil > now ? { blockedUntil, reason: "primary", updatedAt: now } : undefined,
      writeAdmission: (_key: string, state: { blockedUntil: number }) => { blockedUntil = state.blockedUntil; },
    };
    let now = 0;
    let calls = 0;
    const sleeps: number[] = [];
    const sleep = async (delay: number) => { sleeps.push(delay); now += delay; };
    await assert.rejects(withExternalOperationRetry(async () => {
      calls++;
      throw externalHttpError({ status: 429, headers: new Headers({ "retry-after": "2" }), source: "github" });
    }, { hostKey: "repo:a/b", coordinator, now: () => now, sleep, maxAttempts: 1 }));
    assert.equal(calls, 1);
    await withExternalOperationRetry(async () => { calls++; return "ok"; }, { hostKey: "repo:a/b", coordinator, now: () => now, sleep, maxAttempts: 1 });
    assert.equal(calls, 2);
    assert.ok(sleeps.some((delay) => delay >= 2_000));
  });

  it("classifies GraphQL CLI rate-limit text and redacts credentials", async () => {
    const error = new Error("gh api GraphQL: API rate limit exceeded for user ID 123 (token=ghp_secret-value) user@example.com");
    assert.equal(classifyExternalFault(error)?.kind, "github-primary-rate-limit");
    await assert.rejects(withExternalOperationRetry(async () => { throw error; }, { maxAttempts: 1 }), (caught: unknown) => {
      assert.ok(caught instanceof ExternalOperationRetryError);
      assert.doesNotMatch(caught.message, /ghp_secret|user@example\.com|user ID 123/);
      return true;
    });
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

  it("honors long server cooldowns beyond exponential max while bounding absurd values", async () => {
    const delays: number[] = [];
    let calls = 0;
    await assert.rejects(withExternalOperationRetry(async () => {
      calls++;
      throw externalHttpError({ status: 503, headers: new Headers({ "retry-after": "120" }) });
    }, { maxAttempts: 2, maxDelayMs: 5_000, jitterRatio: 0, sleep: async (delay) => { delays.push(delay); } }));
    assert.equal(calls, 2);
    assert.equal(delays[0], 120_000);
  });

  it("keeps authoritative cooldowns within their security ceiling despite jitter", async () => {
    const delays: number[] = [];
    await assert.rejects(withExternalOperationRetry(async () => {
      throw externalHttpError({ status: 503, headers: new Headers({ "retry-after": "900" }) });
    }, {
      maxAttempts: 2,
      maxDelayMs: 5_000,
      maxRetryAfterMs: 900_000,
      jitterRatio: 1,
      random: () => 1,
      sleep: async (delay) => { delays.push(delay); },
    }));
    assert.deepEqual(delays, [900_000]);
  });

  it("keeps a typed wrapper's root cause", () => {
    const original = new Error("socket");
    const error = new ExternalOperationError("socket failed", { kind: "network" }, { cause: original });
    assert.equal(error.cause, original);
    assert.deepEqual(classifyExternalFault(error), { kind: "network" });
  });
});
