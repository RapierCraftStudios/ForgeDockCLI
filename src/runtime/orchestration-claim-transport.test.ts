// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { test } from "node:test";
import { ClaimPromotionConflictError } from "../workflows/orchestrate/scheduler.js";
import {
  promoteOrchestrationClaims,
  promoteOrchestrationClaimsFromEnvironment,
  startOrchestrationClaimPromotionServer,
} from "./orchestration-claim-transport.js";

const identity = {
  orchestrationId: "dag_test",
  nodeId: "issue-1",
  attemptId: "attempt-1",
};

test("authenticated child claim promotion reaches the bound parent attempt", async () => {
  const received: string[][] = [];
  const server = await startOrchestrationClaimPromotionServer({
    identity,
    promoteClaims: async (claims) => { received.push([...claims]); },
  });
  try {
    assert.equal(await promoteOrchestrationClaimsFromEnvironment(["src/a.ts", "src/a.ts"], server.env), "promoted");
    assert.deepEqual(received, [["src/a.ts"]]);
  } finally {
    await server.close();
  }
});

test("in-process orchestration promotes claims through its direct controller boundary", async () => {
  const received: string[][] = [];
  assert.deepEqual(await promoteOrchestrationClaims(["src/a.ts"], {
    environment: {},
    local: async (claims) => { received.push([...claims]); },
  }), { transport: "not-configured", local: true });
  assert.deepEqual(received, [["src/a.ts"]]);
});

test("nested orchestration promotes through both transport and local controller boundaries", async () => {
  const transported: string[][] = [];
  const local: string[][] = [];
  const server = await startOrchestrationClaimPromotionServer({
    identity,
    promoteClaims: async (claims) => { transported.push([...claims]); },
  });
  try {
    assert.deepEqual(await promoteOrchestrationClaims(["src/shared.ts"], {
      environment: server.env,
      local: async (claims) => { local.push([...claims]); },
    }), { transport: "promoted", local: true });
    assert.deepEqual(transported, [["src/shared.ts"]]);
    assert.deepEqual(local, [["src/shared.ts"]]);
  } finally {
    await server.close();
  }
});

test("parent claim conflicts are reconstructed in the child controller", async () => {
  const server = await startOrchestrationClaimPromotionServer({
    identity,
    promoteClaims: async () => { throw new ClaimPromotionConflictError(identity.nodeId, ["issue-2"]); },
  });
  try {
    await assert.rejects(
      () => promoteOrchestrationClaimsFromEnvironment(["src/shared.ts"], server.env),
      (error: unknown) => error instanceof ClaimPromotionConflictError
        && error.itemId === identity.nodeId
        && error.conflicts[0] === "issue-2",
    );
  } finally {
    await server.close();
  }
});

test("claim promotion rejects stale attempt identity and partial transport configuration", async () => {
  const server = await startOrchestrationClaimPromotionServer({
    identity,
    promoteClaims: async () => undefined,
  });
  try {
    await assert.rejects(
      () => promoteOrchestrationClaimsFromEnvironment(["src/a.ts"], {
        ...server.env,
        FORGEDOCK_ORCHESTRATION_ATTEMPT: "stale-attempt",
      }),
      /identity does not match/i,
    );
    await assert.rejects(
      () => promoteOrchestrationClaimsFromEnvironment(["src/a.ts"], {
        FORGEDOCK_ORCHESTRATION_ID: identity.orchestrationId,
      }),
      /partially configured/i,
    );
  } finally {
    await server.close();
  }
});
