// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createConfiguredLeaseWitness, bootstrapLocalLeaseWitness } from "../sqlite/lease-witness.js";
import { CheckoutContextError, resolveCheckoutContext } from "./repository-context.js";

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function createCheckout(parent: string, name: string, remote: string): string {
  const checkout = join(parent, name);
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "--quiet");
  git(checkout, "config", "user.email", "forgedock-test@example.invalid");
  git(checkout, "config", "user.name", "ForgeDock test");
  git(checkout, "commit", "--allow-empty", "-m", "test checkout");
  git(checkout, "remote", "add", "origin", remote);
  return checkout;
}

test("keeps checkout-root launches working for local lease witnesses", () => {
  const root = mkdtempSync(join(tmpdir(), "forgedock-checkout-context-root-"));
  const checkout = createCheckout(root, "ForgeDockCLI", "https://github.com/RapierCraftStudios/ForgeDockCLI.git");
  const localDataRoot = join(root, "local-data");
  try {
    bootstrapLocalLeaseWitness(checkout, { localDataRoot });

    const context = resolveCheckoutContext(checkout, "RapierCraftStudios/ForgeDockCLI");
    assert.equal(context.checkoutRoot, checkout);
    assert.equal(context.source, "current-checkout");
    assert.equal(createConfiguredLeaseWitness(context.checkoutRoot, { localDataRoot, environment: {} })?.verify().state, "verified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolves a target checkout from its workspace parent before lease lookup", () => {
  const root = mkdtempSync(join(tmpdir(), "forgedock-checkout-context-parent-"));
  const workspace = join(root, "Projects");
  mkdirSync(workspace);
  const checkout = createCheckout(workspace, "ForgeDockCLI", "git@github.com:RapierCraftStudios/ForgeDockCLI.git");
  createCheckout(workspace, "OtherProject", "https://github.com/example/OtherProject.git");
  const localDataRoot = join(root, "local-data");
  try {
    bootstrapLocalLeaseWitness(checkout, { localDataRoot });

    const context = resolveCheckoutContext(workspace, "RapierCraftStudios/ForgeDockCLI");
    assert.equal(context.checkoutRoot, checkout);
    assert.equal(context.source, "matching-child-checkout");
    assert.equal(createConfiguredLeaseWitness(workspace, { localDataRoot, environment: {} }), undefined);
    assert.equal(createConfiguredLeaseWitness(context.checkoutRoot, { localDataRoot, environment: {} })?.verify().state, "verified");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when the resolved checkout has no witness", () => {
  const root = mkdtempSync(join(tmpdir(), "forgedock-checkout-context-missing-"));
  const workspace = join(root, "Projects");
  mkdirSync(workspace);
  const checkout = createCheckout(workspace, "ForgeDockCLI", "https://github.com/RapierCraftStudios/ForgeDockCLI.git");
  const localDataRoot = join(root, "local-data");
  try {
    const context = resolveCheckoutContext(workspace, "RapierCraftStudios/ForgeDockCLI");
    assert.equal(context.checkoutRoot, checkout);
    assert.equal(createConfiguredLeaseWitness(context.checkoutRoot, { localDataRoot, environment: {} }), undefined);
    assert.throws(
      () => resolveCheckoutContext(workspace, "example/NotCheckedOut"),
      (error: unknown) => error instanceof CheckoutContextError && /could not find a local checkout/.test(error.message),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("never lets one checkout witness another repository or an ambiguous clone", () => {
  const root = mkdtempSync(join(tmpdir(), "forgedock-checkout-context-safety-"));
  const workspace = join(root, "Projects");
  mkdirSync(workspace);
  const first = createCheckout(workspace, "First", "https://github.com/example/First.git");
  const second = createCheckout(workspace, "Second", "https://github.com/example/Second.git");
  const localDataRoot = join(root, "local-data");
  try {
    bootstrapLocalLeaseWitness(first, { localDataRoot });

    const secondContext = resolveCheckoutContext(first, "example/Second");
    assert.equal(secondContext.checkoutRoot, second);
    assert.equal(createConfiguredLeaseWitness(secondContext.checkoutRoot, { localDataRoot, environment: {} }), undefined);
    assert.equal(createConfiguredLeaseWitness(first, { localDataRoot, environment: {} })?.verify().state, "verified");
    const duplicate = createCheckout(workspace, "Second-copy", "https://github.com/example/Second.git");
    assert.throws(
      () => resolveCheckoutContext(workspace, "example/Second"),
      (error: unknown) => error instanceof CheckoutContextError && /multiple local checkouts/.test(error.message),
    );
    assert.notEqual(secondContext.checkoutRoot, duplicate);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
