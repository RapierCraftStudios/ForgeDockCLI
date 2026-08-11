import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isGitHubAuthenticationFailure, refreshConfiguredGitHubApp } from "./github-auth.js";

describe("GitHub authentication recovery", () => {
  it("recognizes expired gh credentials without classifying ordinary failures", () => {
    assert.equal(isGitHubAuthenticationFailure(new Error("gh api failed (1): gh: Bad credentials (HTTP 401)")), true);
    assert.equal(isGitHubAuthenticationFailure(new Error("gh api failed (1): network unavailable")), false);
  });

  it("does not attempt a refresh when the App key is not configured", async () => {
    const previous = process.env.FORGEDOCK_APP_PEM;
    delete process.env.FORGEDOCK_APP_PEM;
    try {
      assert.equal(await refreshConfiguredGitHubApp("."), false);
    } finally {
      if (previous === undefined) delete process.env.FORGEDOCK_APP_PEM;
      else process.env.FORGEDOCK_APP_PEM = previous;
    }
  });
});
