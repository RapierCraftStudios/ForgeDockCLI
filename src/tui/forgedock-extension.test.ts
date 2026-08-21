// SPDX-License-Identifier: AGPL-3.0-or-later

import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { renderArtifactComment } from "../core/artifacts/codec.js";
import { createArtifact } from "../core/artifacts/schema.js";
import { readForgeDockConfig, updateForgeDockConfig } from "../core/config/forgedock-config.js";
import { DEFAULT_REMOTE_READ_CONCURRENCY } from "../core/concurrency.js";
import { GitHubClient } from "../adapters/github/github-client.js";
import { InMemoryLeaseRepository } from "../core/ports/lease.js";
import type { OrchestrationRecord } from "../core/ports/orchestration.js";
import { InMemoryOrchestrationRepository } from "../core/ports/repositories.js";
import { LeaseBackedOrchestrationExecutionAdmission } from "../adapters/sqlite/orchestration-admission.js";
import { createOrBootstrapLocalLeaseWitness } from "../adapters/sqlite/lease-witness.js";
import { ClaimPromotionConflictError, materializeClaimDependencies } from "../workflows/orchestrate/scheduler.js";
import forgedockExtension, { buildHarnessModePrompt, executeController, FORGEDOCK_NATIVE_WORKFLOW_MESSAGE, FORGEDOCK_READY_STATUS, isLifecycleControllerShellCommand } from "./forgedock-extension.js";
import { NESTED_AGENT_BRIDGE_RESTART_REQUIRED } from "./background-tasks.js";
import {
  bindOrchestrationInvocation,
  buildOrchestrationPreviewCheckpointGuidance,
  buildOrchestrationPreviewConfirmationGuidance,
  buildNativeCommandPrompt,
  defectClassFromIssueBody,
  dependencyIssueNumbersFromBody,
  priorityFromIssueLabels,
  resolveIssueWorkerRecovery,
  resolveModelReference,
  resolveOrchestrationInvocationScope,
  resolveRoutedOrchestrationScope,
  sourcePullRequestFromIssueBody,
  isOrchestrationPreviewConfirmationPrompt,
  materializeVisibleDecomposition,
  orchestrationTransportKey,
  type ControllerTaskSpec,
  type OrchestrationTransportIdentity,
  VisibleDagDelegator,
} from "./forgedock-tools.js";

const isolatedSessionCwd = mkdtempSync(join(tmpdir(), "forgedock-extension-session-"));
const fakePiStates: FakePiState[] = [];
const shutDownFakePiStates = new WeakSet<object>();
after(async () => {
  for (const state of fakePiStates) await shutdownFakePi(state, commandContext());
  rmSync(isolatedSessionCwd, { recursive: true, force: true });
});

interface FakePiState {
  pi: ExtensionAPI;
  tools: Map<string, ToolDefinition>;
  commands: Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>;
  handlers: Map<string, Array<(event: any, ctx?: any) => unknown>>;
  sent: Array<{
    content: string;
    customType?: string | undefined;
    display?: boolean | undefined;
    details?: unknown;
    options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" } | undefined;
  }>;
  messageRenderers: Map<string, (message: any, options: any, theme: any) => any>;
  active: string[];
  emitted: Array<{ event: string; data: any }>;
}

function fakePi(
  initialActive = ["read", "bash", "subagent", "subagent_wait", "subagent_supervisor"],
  toolOptions: Parameters<typeof forgedockExtension>[1] = {
    orchestrationRepository: new InMemoryOrchestrationRepository(),
    orchestrationExecutionAdmission: new LeaseBackedOrchestrationExecutionAdmission(new InMemoryLeaseRepository()),
    dispatchReadinessCheck: async () => undefined,
  },
): FakePiState {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, (args: string, ctx: ExtensionCommandContext) => Promise<void>>();
  const handlers = new Map<string, Array<(event: any, ctx?: any) => unknown>>();
  const sent: FakePiState["sent"] = [];
  const messageRenderers: FakePiState["messageRenderers"] = new Map();
  const emitted: FakePiState["emitted"] = [];
  let active = [...initialActive];
  const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
  const state = {} as FakePiState;
  const pi = {
    on: (name: string, handler: (event: any, ctx?: any) => unknown) => {
      handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    },
    registerTool: (tool: ToolDefinition) => { tools.set(tool.name, tool); },
    registerCommand: (name: string, options: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }) => {
      commands.set(name, options.handler);
    },
    registerMessageRenderer: (customType: string, renderer: (message: any, options: any, theme: any) => any) => {
      messageRenderers.set(customType, renderer);
    },
    sendUserMessage: (content: string, options?: { deliverAs?: "steer" | "followUp" }) => {
      sent.push(options ? { content, options } : { content });
    },
    sendMessage: (message: { content: string; customType?: string; display?: boolean; details?: unknown }, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" }) => {
      sent.push({ content: message.content, customType: message.customType, display: message.display, details: message.details, options });
    },
    getActiveTools: () => active,
    setActiveTools: (names: string[]) => { active = names; state.active = names; },
    events: {
      on: (name: string, handler: (data: unknown) => void) => {
        eventHandlers.set(name, [...(eventHandlers.get(name) ?? []), handler]);
        return () => eventHandlers.set(name, (eventHandlers.get(name) ?? []).filter((candidate) => candidate !== handler));
      },
      emit: (name: string, data: unknown) => {
        emitted.push({ event: name, data });
        for (const handler of eventHandlers.get(name) ?? []) handler(data);
      },
    },
  } as unknown as ExtensionAPI;
  Object.assign(state, { pi, tools, commands, handlers, sent, messageRenderers, active, emitted });
  forgedockExtension(pi, toolOptions);
  fakePiStates.push(state);
  return state;
}

function witnessedDagDelegator(
  pi: ExtensionAPI,
  repository = new InMemoryOrchestrationRepository(),
  rebuildInput?: ConstructorParameters<typeof VisibleDagDelegator>[2],
): VisibleDagDelegator {
  const admission = new LeaseBackedOrchestrationExecutionAdmission(new InMemoryLeaseRepository());
  return new VisibleDagDelegator(
    pi,
    () => repository,
    rebuildInput,
    undefined,
    () => admission,
  );
}

/** Fail once at the exact post-launch persistence boundary. */
class LaunchIdentityFaultRepository extends InMemoryOrchestrationRepository {
  failAfterLaunchIdentity = true;

  override async saveOrchestration(record: OrchestrationRecord): Promise<void> {
    const launched = record.nodes.some((node) => (node.attempts ?? []).some((attempt) =>
      attempt.taskId !== undefined || attempt.agentTaskId !== undefined || attempt.runId !== undefined));
    if (this.failAfterLaunchIdentity && launched) {
      this.failAfterLaunchIdentity = false;
      throw new Error("fault injected after worker launch before durable task identity");
    }
    await super.saveOrchestration(record);
  }
}

function commandContext(idle = true): ExtensionCommandContext {
  return {
    cwd: process.cwd(),
    model: { provider: "openai-codex", id: "gpt-test" },
    isIdle: () => idle,
    hasUI: true,
    ui: {
      confirm: async () => true,
      notify: () => undefined,
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
  } as unknown as ExtensionCommandContext;
}

function orchestrationDiscoveryIssue(
  number: number,
  overrides: Record<string, unknown> = {},
): any {
  return {
    repo: "a/b",
    number,
    title: `Issue ${number}`,
    body: "",
    url: `https://github.com/a/b/issues/${number}`,
    state: "OPEN",
    labels: [],
    comments: [],
    ...overrides,
  };
}

async function withDiscoveryGitHub(
  methods: Partial<Record<"getRepository" | "getMilestone" | "listOpenIssueNumbersForMilestone" | "listOpenIssueNumbersForSearch" | "listOpenIssueNumbersWithoutMilestone" | "getIssue" | "listBranches" | "getBranchHead", (...args: any[]) => any>>,
  run: () => Promise<void>,
): Promise<void> {
  const prototype = GitHubClient.prototype as any;
  const originals = new Map<string, unknown>();
  for (const [name, method] of Object.entries(methods)) {
    originals.set(name, prototype[name]);
    prototype[name] = method;
  }
  try {
    await run();
  } finally {
    for (const [name, method] of originals) prototype[name] = method;
  }
}

async function shutdownFakePi(state: FakePiState, context: ExtensionCommandContext): Promise<void> {
  if (shutDownFakePiStates.has(state)) return;
  shutDownFakePiStates.add(state);
  for (const handler of state.handlers.get("session_shutdown") ?? []) await handler({}, context);
}

function jsonSessionContext(): ExtensionCommandContext {
  return {
    ...commandContext(),
    cwd: isolatedSessionCwd,
    mode: "json",
  } as unknown as ExtensionCommandContext;
}

function createGitCheckout(parent: string, name: string, remote: string): string {
  const checkout = join(parent, name);
  mkdirSync(checkout, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: checkout, stdio: "ignore" });
  execFileSync("git", ["remote", "add", "origin", remote], { cwd: checkout, stdio: "ignore" });
  return checkout;
}

test("commands lazily activate separate semantic native tools without loading Markdown specs", async () => {
  const state = fakePi();
  assert.deepEqual(
    [...state.tools.keys()].sort(),
    ["forgedock_ask_user", "forgedock_configure", "forgedock_deep_plan", "forgedock_discover_orchestration", "forgedock_memory_search", "forgedock_orchestrate", "forgedock_promote", "forgedock_remember", "forgedock_resume_orchestration", "forgedock_review_pr", "forgedock_status", "forgedock_tasks", "forgedock_work_on"],
  );

  await state.handlers.get("session_start")?.[0]?.({}, jsonSessionContext());
  assert.deepEqual(state.active, ["read", "bash", "forgedock_configure", "forgedock_remember", "forgedock_memory_search", "forgedock_tasks", "forgedock_deep_plan", "forgedock_status", "forgedock_resume_orchestration"]);
  assert.ok(state.tools.get("forgedock_resume_orchestration"));
  const resumeTool = state.tools.get("forgedock_resume_orchestration") as any;
  assert.equal(resumeTool.parameters.properties.orchestrationId.type, "string");
  const deepPlanTool = state.tools.get("forgedock_deep_plan") as any;
  assert.deepEqual(deepPlanTool.parameters.properties.action.enum, ["start", "continue", "finish", "materialize"]);
  assert.equal(deepPlanTool.parameters.properties.repo.type, "string");
  assert.ok(deepPlanTool.parameters.properties.packet);

  await state.commands.get("orchestrate")?.("throwaway-milestone --dry-run", commandContext());
  assert.equal(state.sent.length, 1);
  assert.deepEqual(state.sent[0]?.options, { triggerTurn: true, deliverAs: "followUp" });
  assert.equal(state.sent[0]?.customType, FORGEDOCK_NATIVE_WORKFLOW_MESSAGE);
  assert.equal(state.sent[0]?.display, true);
  assert.equal((state.sent[0]?.details as { invocationLabel?: string } | undefined)?.invocationLabel, "/orchestrate throwaway-milestone --dry-run");
  assert.match(state.sent[0]?.content ?? "", /This is fresh orchestration resolution/);
  const invocationRenderer = state.messageRenderers.get(FORGEDOCK_NATIVE_WORKFLOW_MESSAGE);
  assert.ok(invocationRenderer);
  const renderedInvocation = invocationRenderer({ details: state.sent[0]?.details, content: state.sent[0]?.content }, { expanded: true, outputPad: 1 }, {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
  }).render(160).join("\\n").trim();
  assert.equal(renderedInvocation, "/orchestrate throwaway-milestone --dry-run");
  assert.doesNotMatch(renderedInvocation, /Every \/orchestrate invocation/);
  assert.match(state.sent[0]?.content ?? "", /kind=issue-set, milestone, github-query, or no-milestone/);
  assert.match(state.sent[0]?.content ?? "", /call forgedock_discover_orchestration exactly once/);
  assert.match(state.sent[0]?.content ?? "", /call forgedock_orchestrate exactly once/);
  assert.match(state.sent[0]?.content ?? "", /controller owns exact membership/);
  assert.doesNotMatch(state.sent[0]?.content ?? "", /a complete executionPlan/);
  assert.match(state.sent[0]?.content ?? "", /Automatic merge .* is the default/);
  assert.doesNotMatch(state.sent[0]?.content ?? "", /commands\/orchestrate\.md|command spec at/);
  assert.deepEqual(state.active, ["read", "forgedock_configure", "forgedock_remember", "forgedock_memory_search", "forgedock_tasks", "forgedock_discover_orchestration", "forgedock_orchestrate", "forgedock_ask_user"]);
});

test("typed no-milestone discovery applies only an authorized count and binds exact preview scope", async () => {
  const state = fakePi();
  await state.handlers.get("session_start")?.[0]?.({}, jsonSessionContext());
  await state.commands.get("orchestrate")?.("latest 2 issues with no milestone", commandContext());
  const searchQueries: string[] = [];
  const issueReads = new Map<number, number>();
  let searchMembers = [9, 8, 7];
  await withDiscoveryGitHub({
    getRepository: async () => ({ repo: "a/b", defaultBranch: "main" }),
    listBranches: async () => [{ name: "main", headSha: "a".repeat(40) }],
    getBranchHead: async () => "a".repeat(40),
    listOpenIssueNumbersForSearch: async (query: string) => { searchQueries.push(query); return searchMembers; },
    getIssue: async (number: number) => {
      issueReads.set(number, (issueReads.get(number) ?? 0) + 1);
      return orchestrationDiscoveryIssue(number);
    },
  }, async () => {
    const discovery = state.tools.get("forgedock_discover_orchestration");
    assert.ok(discovery);
    const result = await discovery.execute("discover-no-ms", {
      kind: "no-milestone",
      requestedCount: 2,
      order: "newest",
    }, undefined, undefined, { ...commandContext(), mode: "tui" } as any) as any;
    assert.equal(result.details.candidateCount, 2);
    assert.deepEqual(result.details.scope.issueNumbers, [8, 9]);
    assert.deepEqual(result.details.candidates.map((candidate: any) => candidate.number), [9, 8]);
    assert.deepEqual([...issueReads].sort(([left], [right]) => left - right), [[7, 1], [8, 1], [9, 1]]);
    assert.ok(searchQueries.every((query) => query === "no:milestone sort:created-desc"));

    const orchestrate = state.tools.get("forgedock_orchestrate")!;
    const preview = await orchestrate.execute("preview-order", {
      issueNumbers: [8, 9],
      executionPlan: [
        { issue: 8, title: "Eight", summary: "Deliver Eight", dependsOn: [], claims: ["src/eight"], labels: [] },
        { issue: 9, title: "Nine", summary: "Deliver Nine", dependsOn: [], claims: ["src/nine"], labels: [] },
      ],
    }, undefined, undefined, { ...commandContext(), hasUI: false } as any) as any;
    assert.match(preview.details.previewToken, /^[0-9a-f-]{36}$/);
    searchMembers = [10, 9, 8, 7];
    await assert.rejects(
      () => orchestrate.execute("order-drift", { issueNumbers: [8, 9], confirmed: true }, undefined, undefined, { ...commandContext(), hasUI: false } as any),
      /ordering changed during authoritative revalidation/,
    );
  });
});

test("typed discovery binds explicit issue IDs, counts, and remote repositories to the user request", async () => {
  const explicit = fakePi();
  bindOrchestrationInvocation(explicit.pi, { rawArgs: "issues 7 and 8 in owner/remote" });
  const repositoryArgs: Array<string | undefined> = [];
  const issueRepos: Array<string | undefined> = [];
  await withDiscoveryGitHub({
    getRepository: async (repo?: string) => {
      repositoryArgs.push(repo);
      return { repo: repo ?? "owner/remote", defaultBranch: "main" };
    },
    getIssue: async (number: number, repo?: string) => {
      issueRepos.push(repo);
      return orchestrationDiscoveryIssue(number);
    },
  }, async () => {
    const discovery = explicit.tools.get("forgedock_discover_orchestration")!;
    await assert.rejects(
      () => discovery.execute("substituted-explicit", {
        kind: "issue-set", repository: "owner/remote", issueNumbers: [7, 9],
      }, undefined, undefined, commandContext() as any),
      /must exactly match.*#7, #8/i,
    );
    const result = await discovery.execute("exact-explicit", {
      kind: "issue-set", repository: "owner/remote", issueNumbers: [7, 8],
    }, undefined, undefined, commandContext() as any) as any;
    assert.deepEqual(result.details.scope.issueNumbers, [7, 8]);
    assert.equal(result.details.scope.repository, "owner/remote");
  });
  assert.ok(repositoryArgs.every((repo) => repo === "owner/remote"));
  assert.deepEqual(issueRepos, ["owner/remote", "owner/remote"]);

  const counted = fakePi();
  bindOrchestrationInvocation(counted.pi, { rawArgs: "latest 2 issues with no milestone" });
  await assert.rejects(
    () => counted.tools.get("forgedock_discover_orchestration")!.execute("missing-count", {
      kind: "no-milestone", order: "newest",
    }, undefined, undefined, commandContext() as any),
    /requested exactly 2 issue.*preserve requestedCount/i,
  );
});

test("typed discovery preserves an exact GitHub query URL and rejects empty or ambiguous partial selection", async () => {
  const state = fakePi();
  const decoded = "is:issue state:open no:milestone sort:created-desc";
  bindOrchestrationInvocation(state.pi, { rawArgs: `2 issues from https://github.com/a/b/issues?q=${encodeURIComponent(decoded)}` });
  const queries: string[] = [];
  let repositoryArgument: string | undefined;
  await withDiscoveryGitHub({
    getRepository: async (repo?: string) => { repositoryArgument = repo; return { repo: "a/b", defaultBranch: "main" }; },
    listOpenIssueNumbersForSearch: async (query: string) => { queries.push(query); return [12, 11, 10]; },
    getIssue: async (number: number) => orchestrationDiscoveryIssue(number),
  }, async () => {
    const discovery = state.tools.get("forgedock_discover_orchestration")!;
    const result = await discovery.execute("query-url", {
      kind: "github-query",
      requestedCount: 2,
    }, undefined, undefined, { ...commandContext(), mode: "tui" } as any) as any;
    assert.equal(result.details.routing.query, decoded);
    assert.equal(repositoryArgument, "a/b");
    assert.deepEqual(result.details.scope.issueNumbers, [11, 12]);
    assert.ok(queries.every((query) => query === decoded));
  });

  const ambiguous = fakePi();
  bindOrchestrationInvocation(ambiguous.pi, { rawArgs: "2 issues without a milestone" });
  await withDiscoveryGitHub({
    getRepository: async () => ({ repo: "a/b", defaultBranch: "main" }),
    listOpenIssueNumbersWithoutMilestone: async () => [3, 2, 1],
    listOpenIssueNumbersForSearch: async () => [3, 2, 1],
    getIssue: async (number: number) => orchestrationDiscoveryIssue(number),
  }, async () => {
    await assert.rejects(
      () => ambiguous.tools.get("forgedock_discover_orchestration")!.execute("ambiguous", {
        kind: "no-milestone",
        requestedCount: 2,
      }, undefined, undefined, commandContext() as any),
      /without authorizing an order; use forgedock_ask_user/,
    );
  });

  const empty = fakePi();
  bindOrchestrationInvocation(empty.pi, { rawArgs: "all issues without a milestone" });
  await withDiscoveryGitHub({
    getRepository: async () => ({ repo: "a/b", defaultBranch: "main" }),
    listOpenIssueNumbersWithoutMilestone: async () => [],
  }, async () => {
    await assert.rejects(
      () => empty.tools.get("forgedock_discover_orchestration")!.execute("empty", {
        kind: "no-milestone",
      }, undefined, undefined, commandContext() as any),
      /found no open candidates/,
    );
  });
});

test("typed discovery rejects an oversized catalog before detail hydration", async () => {
  const state = fakePi();
  bindOrchestrationInvocation(state.pi, { rawArgs: "all issues without a milestone" });
  let detailReads = 0;
  await withDiscoveryGitHub({
    getRepository: async () => ({ repo: "a/b", defaultBranch: "main" }),
    listOpenIssueNumbersWithoutMilestone: async () => Array.from({ length: 101 }, (_, index) => index + 1),
    getIssue: async (number: number) => {
      detailReads += 1;
      return orchestrationDiscoveryIssue(number);
    },
  }, async () => {
    await assert.rejects(
      () => state.tools.get("forgedock_discover_orchestration")!.execute("oversized", {
        kind: "no-milestone",
      }, undefined, undefined, commandContext() as any),
      /exceeding the bounded limit of 100.*before issue details are loaded/,
    );
  });
  assert.equal(detailReads, 0);
});

test("typed discovery rejects closed and wrong-lane issues and substitutes authoritative decomposition children", async () => {
  const closed = fakePi();
  bindOrchestrationInvocation(closed.pi, { rawArgs: "issue 7" });
  await withDiscoveryGitHub({
    getRepository: async () => ({ repo: "a/b", defaultBranch: "main" }),
    getIssue: async (number: number) => orchestrationDiscoveryIssue(number, { state: "CLOSED" }),
  }, async () => {
    await assert.rejects(
      () => closed.tools.get("forgedock_discover_orchestration")!.execute("closed", {
        kind: "issue-set", issueNumbers: [7],
      }, undefined, undefined, commandContext() as any),
      /must be open/,
    );
  });

  const wrongLane = fakePi();
  bindOrchestrationInvocation(wrongLane.pi, { rawArgs: "all issues without a milestone" });
  await withDiscoveryGitHub({
    getRepository: async () => ({ repo: "a/b", defaultBranch: "main" }),
    listOpenIssueNumbersWithoutMilestone: async () => [7],
    listOpenIssueNumbersForSearch: async () => [7],
    getIssue: async (number: number) => orchestrationDiscoveryIssue(number, { milestone: { number: 1, title: "M1" } }),
  }, async () => {
    await assert.rejects(
      () => wrongLane.tools.get("forgedock_discover_orchestration")!.execute("wrong-lane", {
        kind: "no-milestone",
      }, undefined, undefined, commandContext() as any),
      /must have no milestone/,
    );
  });

  const decomposed = fakePi();
  bindOrchestrationInvocation(decomposed.pi, { rawArgs: "Milestone One" });
  const outcome = createArtifact({
    kind: "Outcome",
    runId: "run_decomposition_discovery",
    subject: { repo: "a/b", issue: 7 },
    producer: { role: "controller", runtime: "forgedock" },
    payload: { status: "decomposed", reason: "Split", childIssues: ["#8 Child"] },
  });
  await withDiscoveryGitHub({
    getRepository: async () => ({ repo: "a/b", defaultBranch: "main" }),
    listOpenIssueNumbersForMilestone: async () => [7],
    getIssue: async (number: number) => number === 7
      ? orchestrationDiscoveryIssue(7, { labels: ["workflow:decomposed"], milestone: { number: 1, title: "Milestone One" }, comments: [{ body: renderArtifactComment(outcome) }] })
      : orchestrationDiscoveryIssue(8, { milestone: { number: 1, title: "Milestone One" } }),
  }, async () => {
    const result = await decomposed.tools.get("forgedock_discover_orchestration")!.execute("decomposed", {
      kind: "milestone", milestone: "Milestone One",
    }, undefined, undefined, commandContext() as any) as any;
    assert.deepEqual(result.details.scope.issueNumbers, [8]);
    assert.deepEqual(result.details.scope.decomposedReplacements, [{ parent: 7, children: [8] }]);
    assert.deepEqual(result.details.candidates.map((candidate: any) => candidate.number), [8]);
  });

  const exactDecomposed = fakePi();
  bindOrchestrationInvocation(exactDecomposed.pi, { rawArgs: "issue 7" });
  await withDiscoveryGitHub({
    getRepository: async () => ({ repo: "a/b", defaultBranch: "main" }),
    getIssue: async (number: number) => number === 7
      ? orchestrationDiscoveryIssue(7, { labels: ["workflow:decomposed"], comments: [{ body: renderArtifactComment(outcome) }] })
      : orchestrationDiscoveryIssue(8),
  }, async () => {
    const result = await exactDecomposed.tools.get("forgedock_discover_orchestration")!.execute("exact-decomposed", {
      kind: "issue-set", issueNumbers: [7],
    }, undefined, undefined, commandContext() as any) as any;
    assert.deepEqual(result.details.scope.issueNumbers, [8]);
    assert.deepEqual(result.details.scope.decomposedReplacements, [{ parent: 7, children: [8] }]);
  });
});

test("discovered scope is authoritatively revalidated for closed, milestone, and decomposed changes", async () => {
  const decomposedOutcome = createArtifact({
    kind: "Outcome",
    runId: "run_revalidation_decomposed",
    subject: { repo: "a/b", issue: 7 },
    producer: { role: "controller", runtime: "forgedock" },
    payload: { status: "decomposed", reason: "Split after discovery", childIssues: ["#8 Child"] },
  });
  const cases: Array<{ name: string; changed: Record<string, unknown>; expected: RegExp }> = [
    { name: "closed", changed: { state: "CLOSED" }, expected: /must be open/ },
    { name: "milestone", changed: { milestone: { number: 1, title: "M1" } }, expected: /must have no milestone|Bound no-milestone scope changed/ },
    { name: "decomposed", changed: { labels: ["workflow:decomposed"], comments: [{ body: renderArtifactComment(decomposedOutcome) }] }, expected: /cannot dispatch decomposed parent/ },
  ];
  for (const scenario of cases) {
    const state = fakePi();
    bindOrchestrationInvocation(state.pi, { rawArgs: "issue 7" });
    let changed = false;
    await withDiscoveryGitHub({
      getRepository: async () => ({ repo: "a/b", defaultBranch: "main" }),
      getIssue: async (number: number) => orchestrationDiscoveryIssue(number, changed ? scenario.changed : {}),
    }, async () => {
      await state.tools.get("forgedock_discover_orchestration")!.execute(`discover-${scenario.name}`, {
        kind: "issue-set", issueNumbers: [7],
      }, undefined, undefined, commandContext() as any);
      changed = true;
      await assert.rejects(
        () => state.tools.get("forgedock_orchestrate")!.execute(`revalidate-${scenario.name}`, {
          issueNumbers: [7],
        }, undefined, undefined, { ...commandContext(), hasUI: false } as any),
        scenario.expected,
      );
    });
  }
});

test("GitHub query membership is revalidated after discovery before preview", async () => {
  const state = fakePi();
  bindOrchestrationInvocation(state.pi, { rawArgs: "https://github.com/a/b/issues?q=is%3Aissue%20state%3Aopen" });
  let membership = [7];
  await withDiscoveryGitHub({
    getRepository: async () => ({ repo: "a/b", defaultBranch: "main" }),
    listOpenIssueNumbersForSearch: async () => membership,
    getIssue: async (number: number) => orchestrationDiscoveryIssue(number),
  }, async () => {
    await state.tools.get("forgedock_discover_orchestration")!.execute("discover-query", {
      kind: "github-query",
    }, undefined, undefined, commandContext() as any);
    membership = [8];
    await assert.rejects(
      () => state.tools.get("forgedock_orchestrate")!.execute("query-drift", {
        issueNumbers: [7],
      }, undefined, undefined, { ...commandContext(), hasUI: false } as any),
      /outside resolved GitHub issue search/,
    );
  });
});

test("session presentation does not invent TUI restart recovery before terminalization", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "forgedock-extension-restart-"));
  const tasksDirectory = join(cwd, ".forgedock", "tasks");
  mkdirSync(tasksDirectory, { recursive: true });
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { cwd, detached: true, stdio: "ignore" });
  assert.ok(child.pid);
  child.unref();
  const taskId = "task_restart_bridge";
  const logPath = join(tasksDirectory, `${taskId}.log`);
  writeFileSync(join(tasksDirectory, `${taskId}.json`), JSON.stringify({
    id: taskId,
    command: process.execPath,
    args: ["controller"],
    cwd,
    pid: child.pid,
    logPath,
    status: "detached",
    startedAt: new Date().toISOString(),
    restartRequired: NESTED_AGENT_BRIDGE_RESTART_REQUIRED,
    resumeScope: "workflow",
  }));
  const state = fakePi();
  const context = { ...jsonSessionContext(), cwd };
  try {
    await state.handlers.get("session_start")?.[0]?.({}, context);
    const message = state.sent.map((entry) => entry.content).find((content) => content.includes(taskId));
    assert.equal(message, undefined);
    const persisted = JSON.parse(readFileSync(join(tasksDirectory, `${taskId}.json`), "utf8")) as Record<string, unknown>;
    assert.equal(persisted.status, "detached");
    assert.equal(persisted.terminalCause, undefined);
    assert.doesNotThrow(() => process.kill(child.pid!, 0));
    await shutdownFakePi(state, context);
  } finally {
    try { process.kill(-child.pid!, "SIGKILL"); } catch { /* already exited */ }
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("assistant mode keeps generic PR requests on normal GitHub tooling", async () => {
  const state = fakePi();
  await state.handlers.get("session_start")?.[0]?.({}, jsonSessionContext());
  const prompt = state.handlers.get("before_agent_start")?.[0]?.(
    { systemPrompt: "base prompt" },
    { cwd: process.cwd() },
  ) as { systemPrompt: string };

  assert.match(prompt.systemPrompt, /Mode: assistant \(default\)/);
  assert.match(prompt.systemPrompt, /create\/open pull-request requests default to ordinary gh usage/);
  assert.match(prompt.systemPrompt, /explicitly requests gh CLI, honor that tool choice/);
  assert.match(prompt.systemPrompt, /Plain GitHub PR or ForgeDock promotion/);
  assert.match(prompt.systemPrompt, /from a forgedock_\* workflow tool call onward/);
  assert.match(prompt.systemPrompt, /do not combine or follow it with raw gh mutations/);
  assert.match(prompt.systemPrompt, /Do not inspect ForgeDock controller source/);
  assert.equal(state.active.includes("forgedock_promote"), false);
  assert.equal(state.sent.length, 0);
});

test("explicit promote activates one semantic workflow and settled failure returns to assistant mode", async () => {
  const state = fakePi();
  await state.handlers.get("session_start")?.[0]?.({}, jsonSessionContext());
  await state.commands.get("promote")?.("--production --confirm", commandContext());

  assert.equal(state.sent.length, 1);
  assert.match(state.sent[0]?.content ?? "", /call forgedock_promote exactly once/);
  assert.deepEqual(state.active, ["read", "bash", "forgedock_configure", "forgedock_remember", "forgedock_memory_search", "forgedock_tasks", "forgedock_promote"]);
  const activePrompt = state.handlers.get("before_agent_start")?.[0]?.(
    { systemPrompt: "base prompt" },
    { cwd: process.cwd() },
  ) as { systemPrompt: string };
  assert.match(activePrompt.systemPrompt, /Mode: forgedock-workflow \(explicitly activated by \/promote\)/);
  assert.match(activePrompt.systemPrompt, /Do not replace the active workflow's GitHub mutations with raw gh/);

  await state.handlers.get("agent_settled")?.[0]?.({}, commandContext());
  const resetPrompt = state.handlers.get("before_agent_start")?.[0]?.(
    { systemPrompt: "base prompt" },
    { cwd: process.cwd() },
  ) as { systemPrompt: string };
  assert.match(resetPrompt.systemPrompt, /Mode: assistant \(default\)/);
  assert.match(resetPrompt.systemPrompt, /explicitly requests gh CLI, honor that tool choice/);
});

test("direct semantic workflow invocation enters workflow mode under current-turn conditional authority", () => {
  const state = fakePi();
  const beforeStart = state.handlers.get("before_agent_start")?.[0];
  const assistantPrompt = beforeStart?.(
    { systemPrompt: "base prompt" },
    { cwd: process.cwd() },
  ) as { systemPrompt: string };
  assert.match(assistantPrompt.systemPrompt, /from a forgedock_\* workflow tool call onward/);

  const guard = state.handlers.get("tool_call")?.[0];
  guard?.({ toolName: "forgedock_promote", input: {} });
  const retryPrompt = beforeStart?.(
    { systemPrompt: "base prompt" },
    { cwd: process.cwd() },
  ) as { systemPrompt: string };
  assert.match(retryPrompt.systemPrompt, /Mode: forgedock-workflow \(explicitly activated by \/promote\)/);
  assert.match(buildHarnessModePrompt("assistant"), /ForgeDock workflows are opt-in/);
});

test("failed slash-command dispatch restores assistant mode immediately", async () => {
  const state = fakePi();
  await state.handlers.get("session_start")?.[0]?.({}, jsonSessionContext());
  state.pi.sendUserMessage = (() => { throw new Error("dispatch failed"); }) as typeof state.pi.sendUserMessage;

  await assert.rejects(
    () => state.commands.get("promote")!("--production --confirm", commandContext()),
    /dispatch failed/,
  );
  assert.equal(state.active.includes("forgedock_promote"), false);
  const prompt = state.handlers.get("before_agent_start")?.[0]?.(
    { systemPrompt: "base prompt" },
    { cwd: process.cwd() },
  ) as { systemPrompt: string };
  assert.match(prompt.systemPrompt, /Mode: assistant \(default\)/);
});

test("keeps native workflow tools active through a transient provider retry", async () => {
  const state = fakePi();
  await state.handlers.get("session_start")?.[0]?.({}, jsonSessionContext());
  await state.commands.get("orchestrate")?.("throwaway-milestone --dry-run", commandContext());
  const activeDuringWorkflow = [...state.active];

  // Pi emits agent_end before retrying an overload/rate-limit/server error.
  await state.handlers.get("agent_end")?.[0]?.({}, commandContext());
  assert.deepEqual(state.active, activeDuringWorkflow);

  // The slash-command dispatch turn can settle before Pi starts the queued
  // custom follow-up. Its invocation binding and active tools must survive.
  await state.handlers.get("agent_settled")?.[0]?.({}, commandContext());
  assert.deepEqual(state.active, activeDuringWorkflow);
  assert.throws(
    () => bindOrchestrationInvocation(state.pi, { rawArgs: "replacement" }),
    /already awaiting execution/,
  );

  await state.handlers.get("message_start")?.[0]?.({
    message: {
      role: "custom",
      customType: FORGEDOCK_NATIVE_WORKFLOW_MESSAGE,
      details: state.sent[0]?.details,
    },
  });
  await state.handlers.get("agent_settled")?.[0]?.({}, commandContext());
  assert.deepEqual(state.active, ["read", "forgedock_configure", "forgedock_remember", "forgedock_memory_search", "forgedock_tasks", "bash", "forgedock_deep_plan", "forgedock_status", "forgedock_resume_orchestration"]);
});

test("invalid confirmed orchestration remains read-only before durable admission", async () => {
  const root = mkdtempSync(join(tmpdir(), "forgedock-orchestrate-witness-"));
  const cwd = createGitCheckout(root, "target", "https://github.com/a/b.git");
  const localDataRoot = join(root, "local-data");
  const state = fakePi(undefined, {
    ensureLeaseWitness: (checkout) => createOrBootstrapLocalLeaseWitness(checkout, { localDataRoot, environment: {} }),
  });
  try {
    const tool = state.tools.get("forgedock_orchestrate");
    assert.ok(tool);
    bindOrchestrationInvocation(state.pi, {
      rawArgs: "7 --confirm",
      issueNumbers: [7],
      repository: "a/b",
      defaultBranch: "main",
      noMilestone: true,
    });

    await assert.rejects(
      () => tool.execute("missing-witness", {
        issueNumbers: [8],
        executionPlan: [{ issue: 7, title: "Seven", summary: "Deliver Seven", dependsOn: [], claims: ["src/a"], labels: [] }],
        confirmed: true,
      }, undefined, undefined, { ...commandContext(), cwd, mode: "tui" } as any),
      /issue substitution rejected/,
    );
    assert.equal(existsSync(join(cwd, ".forgedock", "lease-witness.json")), false);
    assert.equal(existsSync(join(cwd, ".forgedock", "state.db")), false);
    assert.equal(existsSync(join(root, ".forgedock", "state.db")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("parent-launched orchestration carries the resolved checkout into DAG workers", async () => {
  const root = mkdtempSync(join(tmpdir(), "forgedock-orchestrate-parent-"));
  const target = createGitCheckout(root, "ForgeDockCLI", "https://github.com/example/target.git");
  const state = fakePi();
  const spawnRequests: any[] = [];
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  const previousControllerEntry = process.env.FORGEDOCK_CONTROLLER_ENTRY;
  delete process.env.FORGEDOCK_CONTROLLER_ENTRY;
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      spawnRequests.push(data);
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1,
        requestId: data.requestId,
        success: true,
        data: { text: "started", details: { asyncId: `parent-run-${spawnRequests.length}` } },
      }));
    } else if (name === "subagents:rpc:v1:request" && data.method === "stop") {
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1,
        requestId: data.requestId,
        success: true,
        data: { stopped: true },
      }));
    }
  }) as typeof state.pi.events.emit;
  try {
    const tool = state.tools.get("forgedock_orchestrate");
    assert.ok(tool);
    bindOrchestrationInvocation(state.pi, {
      rawArgs: "7 --confirm",
      issueNumbers: [7],
      repository: "example/target",
      noMilestone: true,
    });

    const result = await tool.execute("parent-launch", {
      issueNumbers: [7],
      executionPlan: [{ issue: 7, title: "Seven", summary: "Deliver Seven", dependsOn: [], claims: ["src/a"], labels: [] }],
      confirmed: true,
    }, undefined, undefined, { ...commandContext(), cwd: root, mode: "tui" } as any);

    assert.match((result.content[0] as { text: string }).text, /started streaming DAG/);
    assert.equal(spawnRequests.length, 1);
    assert.equal(spawnRequests[0]?.params.cwd, target);
    assert.equal(spawnRequests[0]?.params.model, "openai-codex/gpt-test");
  } finally {
    await shutdownFakePi(state, commandContext());
    if (previousControllerEntry === undefined) delete process.env.FORGEDOCK_CONTROLLER_ENTRY;
    else process.env.FORGEDOCK_CONTROLLER_ENTRY = previousControllerEntry;
    rmSync(root, { recursive: true, force: true });
  }
});

test("natural configuration resolves a friendly live model name for all subagents", async () => {
  const state = fakePi();
  const cwd = mkdtempSync(join(tmpdir(), "forgedock-model-config-"));
  const models = [
    { provider: "openai-codex", id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
    { provider: "openai-codex", id: "gpt-5.6-sol", name: "GPT-5.6 Sol" },
  ];
  try {
    const tool = state.tools.get("forgedock_configure");
    assert.ok(tool);
    await tool.execute("config-1", {
      subagentModel: "Luna 5.6",
      subagentThinking: "max",
      planningModel: "Sol 5.6",
      planningThinking: "high",
    }, undefined, undefined, {
      ...commandContext(),
      cwd,
      hasUI: false,
      modelRegistry: { getAvailable: () => models, getAll: () => models },
    } as any);
    assert.deepEqual(readForgeDockConfig(cwd), {
      workerModel: "openai-codex/gpt-5.6-luna",
      workerThinking: "max",
      planningModel: "openai-codex/gpt-5.6-sol",
      planningThinking: "high",
      reviewerModel: "openai-codex/gpt-5.6-luna",
      reviewerThinking: "max",
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("model configuration rejects installed models without available authentication", () => {
  const unavailable = { provider: "example", id: "luna-5.6" };
  assert.throws(() => resolveModelReference("example/luna-5.6", {
    modelRegistry: { getAvailable: () => [], getAll: () => [unavailable] },
  } as any), /installed but unavailable/);
});

test("runtime diagnostic verifies the real bundled subagent RPC bridge", async () => {
  const state = fakePi();
  const notices: string[] = [];
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "ping") {
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1,
        requestId: data.requestId,
        success: true,
        data: { version: 1, capabilities: { asyncSpawn: true, fleetStatus: { version: 1 } } },
      }));
    }
  }) as typeof state.pi.events.emit;
  const previous = process.env.FORGEDOCK_RUNTIME_ROOT;
  process.env.FORGEDOCK_RUNTIME_ROOT = "C:/checkout/forgedock";
  try {
    const ctx = commandContext() as any;
    ctx.ui.notify = (message: string) => notices.push(message);
    await state.commands.get("forgedock-runtime")?.("", ctx);
  } finally {
    if (previous === undefined) delete process.env.FORGEDOCK_RUNTIME_ROOT;
    else process.env.FORGEDOCK_RUNTIME_ROOT = previous;
  }
  assert.match(notices[0] ?? "", /semantic-tools\+live-subagents-v2/);
  assert.match(notices[0] ?? "", /Bundled subagents: ready/);
  assert.match(notices[0] ?? "", /C:\/checkout\/forgedock/);
});

test("idle TUI shows actionable workflow entrypoints without reserving a help widget", async () => {
  const state = fakePi();
  const widgets: string[] = [];
  const statuses: string[] = [];
  const ctx = {
    mode: "tui",
    cwd: process.cwd(),
    hasUI: true,
    ui: {
      setTitle: () => undefined,
      setStatus: (_key: string, text: string) => statuses.push(text),
      setWidget: (key: string) => widgets.push(key),
    },
  };
  await state.handlers.get("session_start")?.[0]?.({}, ctx);
  assert.deepEqual(widgets, []);
  assert.equal(statuses.at(-1), FORGEDOCK_READY_STATUS);
  assert.match(statuses.at(-1) ?? "", /\/deep-plan · \/work-on · \/review-pr · \/orchestrate/);
  assert.doesNotMatch(statuses.at(-1) ?? "", /semantic-tools|authoritative/i);

  await state.handlers.get("agent_end")?.[0]?.({}, ctx);
  assert.equal(statuses.at(-1), FORGEDOCK_READY_STATUS);
});

test("busy sessions queue native workflow intent as a follow-up", async () => {
  const state = fakePi();
  await state.commands.get("work-on")?.("42", commandContext(false));
  assert.deepEqual(state.sent[0]?.options, { deliverAs: "followUp" });
});

test("supervisor escalations lazily expose decision-interview and reply tools", async () => {
  const state = fakePi();
  await state.handlers.get("session_start")?.[0]?.({}, jsonSessionContext());
  await state.handlers.get("message_start")?.[0]?.({
    message: { role: "custom", customType: "subagent_supervisor_request" },
  });
  assert.deepEqual(state.active, ["read", "bash", "forgedock_configure", "forgedock_remember", "forgedock_memory_search", "forgedock_tasks", "forgedock_ask_user", "forgedock_deep_plan", "subagent_supervisor"]);
});

test("human checkpoints use the tabbed decision interview and return typed answers", async () => {
  const state = fakePi();
  const screens: string[] = [];
  const ctx = {
    ...commandContext(),
    mode: "tui",
    ui: {
      setWorkingVisible: () => undefined,
      custom: async (factory: (...args: any[]) => any) => {
        let completed: unknown;
        const component = factory(
          { requestRender: () => undefined },
          {
            fg: (_color: string, text: string) => text,
            bg: (_color: string, text: string) => text,
            bold: (text: string) => text,
          },
          {},
          (value: unknown) => { completed = value; },
        );
        screens.push(component.render(80).join("\n"));
        component.handleInput("1");
        screens.push(component.render(80).join("\n"));
        component.handleInput("1");
        return completed;
      },
    },
  } as any;
  const tool = state.tools.get("forgedock_ask_user");
  assert.ok(tool);
  const result = await tool.execute("decision-1", {
    title: "Choose rollout",
    questions: [{
      id: "rollout",
      label: "Rollout",
      prompt: "How should this ship?",
      type: "single",
      options: [
        { value: "safe", label: "Canary", description: "Limits blast radius" },
        { value: "fast", label: "Immediate", description: "Finishes sooner with more risk" },
      ],
      recommendedValue: "safe",
      recommendation: "Canary has bounded impact.",
    }],
  }, undefined, undefined, ctx);
  assert.match(screens[0] ?? "", /★ Recommended: Canary/);
  assert.match(screens[0] ?? "", /Canary has bounded impact/);
  assert.match(screens[1] ?? "", /Review your decisions/);
  assert.match((result.content[0] as { text: string }).text, /rollout: Canary/);
  assert.deepEqual((result.details as { answers: Record<string, { values: string[] }> }).answers.rollout?.values, ["safe"]);
});

test("decision interviews normalize stored legacy single-question calls", () => {
  const tool = fakePi().tools.get("forgedock_ask_user");
  assert.ok(tool?.prepareArguments);
  const normalized = tool.prepareArguments!({
    title: "Legacy",
    question: "Choose?",
    options: [
      { id: "a", label: "A", description: "First" },
      { id: "b", label: "B", description: "Second" },
    ],
    recommendedId: "a",
    recommendation: "A is safer.",
  }) as { questions: Array<{ id: string; recommendedValue: string; options: Array<{ value: string }> }> };
  assert.equal(normalized.questions[0]?.id, "decision");
  assert.equal(normalized.questions[0]?.recommendedValue, "a");
  assert.deepEqual(normalized.questions[0]?.options.map((option) => option.value), ["a", "b"]);
});

test("ForgeDock issue children receive only the typed mutation tool", async () => {
  const previous = process.env.PI_SUBAGENT_CHILD_AGENT;
  process.env.PI_SUBAGENT_CHILD_AGENT = "forgedock-issue-worker";
  try {
    const state = fakePi(["forgedock_work_on", "contact_supervisor", "subagent_supervisor"]);
    await state.handlers.get("session_start")?.[0]?.({}, { mode: "json", ui: {} });
    assert.deepEqual(state.active, ["contact_supervisor", "forgedock_work_on"]);
    assert.ok(!state.active.includes("subagent"));
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
    else process.env.PI_SUBAGENT_CHILD_AGENT = previous;
  }
});

test("orchestrate starts only the live DAG ready set without static batch phases", async () => {
  let readinessChecks = 0;
  const state = fakePi(undefined, {
    orchestrationRepository: new InMemoryOrchestrationRepository(),
    orchestrationExecutionAdmission: new LeaseBackedOrchestrationExecutionAdmission(new InMemoryLeaseRepository()),
    dispatchReadinessCheck: async (input) => {
      readinessChecks += 1;
      assert.equal(input.requireLeaseWitness, true);
    },
  });
  const spawnRequests: any[] = [];
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      spawnRequests.push(data);
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1,
        requestId: data.requestId,
        success: true,
        data: { text: "started", details: { asyncId: `test-run-${spawnRequests.length}` } },
      }));
    } else if (name === "subagents:rpc:v1:request" && data.method === "stop") {
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1, requestId: data.requestId, success: true, data: { stopped: true },
      }));
    }
  }) as typeof state.pi.events.emit;
  const previous = process.env.FORGEDOCK_CONTROLLER_ENTRY;
  process.env.FORGEDOCK_CONTROLLER_ENTRY = "C:/Forge Dock/bin/forgedock-next.mjs";
  try {
    const tool = state.tools.get("forgedock_orchestrate");
    assert.ok(tool);
    bindOrchestrationInvocation(state.pi, { rawArgs: "7,8 --max-parallel 2", issueNumbers: [7, 8], repository: "a/b", noMilestone: true });
    const result = await tool.execute("call-1", {
      issueNumbers: [7, 8],
      executionPlan: [
        { issue: 7, title: "Seven", summary: "Implement the accepted bounded behavior.", priority: 1, dependsOn: [], claims: ["src/core"], labels: ["workflow:building"] },
        { issue: 8, title: "Eight", summary: "Consume Seven's completed behavior.", priority: 2, dependsOn: [7], claims: ["src/api"] },
      ],
      maxParallel: 2,
      maxRemediationCycles: 2,
      maxRemediationDepth: 2,
      maxRemediationChildren: 8,
      confirmed: true,
      workerModel: "openai-codex/gpt-worker",
    }, undefined, undefined, commandContext() as any);
    assert.match((result.content[0] as { text: string }).text, /started streaming DAG/);
    assert.match((result.content[0] as { text: string }).text, /Initial ready set: #7/);
    assert.match((result.content[0] as { text: string }).text, /DAG nodes: 2/);
    assert.match((result.content[0] as { text: string }).text, /Issue slots: 2 total · 1 initially ready · cap 2/);
    assert.doesNotMatch((result.content[0] as { text: string }).text, /visible batch|Batch 1/);
  } finally {
    if (previous === undefined) delete process.env.FORGEDOCK_CONTROLLER_ENTRY;
    else process.env.FORGEDOCK_CONTROLLER_ENTRY = previous;
  }

  assert.equal(spawnRequests.length, 1);
  assert.equal(readinessChecks, 1, "an injected orchestration repository must not bypass dispatch readiness");
  const spawnRequest = spawnRequests[0];
  assert.equal(spawnRequest.method, "spawn");
  assert.equal(spawnRequest.params.async, true);
  assert.equal(spawnRequest.params.agent, "forgedock-issue-worker");
  assert.match(spawnRequest.params.model, /^openai-codex\/gpt-worker(?::[a-z]+)?$/);
  assert.equal(spawnRequest.params.chain, undefined);
  assert.match(spawnRequest.params.task, /forgedock_work_on.*\{"issue":7,"repo":"[^"]+","dependencies":\[\]/);
  assert.match(spawnRequest.params.task, /"autoMerge":true/);
  assert.match(spawnRequest.params.task, /"scopeExpansion":"scope-locked"/);
  assert.match(spawnRequest.params.task, /"maxRemediationCycles":2/);
  assert.match(spawnRequest.params.task, /"maxRemediationDepth":2/);
  assert.match(spawnRequest.params.task, /"maxRemediationChildren":8/);
  assert.match(spawnRequest.params.task, /"rerun":false/);
  assert.match(spawnRequest.params.task, /"resume":false/);
  assert.match(spawnRequest.params.task, /Implement the accepted bounded behavior/);
  assert.match(spawnRequest.params.task, /contact_supervisor/);
  await shutdownFakePi(state, commandContext());
});

test("headless orchestration requires explicit dispatch authorization", async () => {
  const state = fakePi();
  const tool = state.tools.get("forgedock_orchestrate");
  assert.ok(tool);
  bindOrchestrationInvocation(state.pi, { rawArgs: "7", issueNumbers: [7], noMilestone: true });
  const result = await tool.execute("headless", {
    issueNumbers: [7],
    executionPlan: [{ issue: 7, title: "Seven", summary: "Deliver Seven", dependsOn: [], claims: ["src/a"], labels: [] }],
  }, undefined, undefined, { ...commandContext(), hasUI: false } as any);
  assert.match((result.content[0] as { text: string }).text, /Dispatch is disabled in preview mode/);
});

test("orchestration preview projects all five selected nodes and the clamped issue-slot cap", async () => {
  const state = fakePi();
  const tool = state.tools.get("forgedock_orchestrate");
  assert.ok(tool);
  const issueNumbers = [701, 702, 703, 704, 705];
  bindOrchestrationInvocation(state.pi, {
    rawArgs: "701,702,703,704,705 --max-parallel 20 --dry-run",
    issueNumbers,
    noMilestone: true,
  });
  const result = await tool.execute("five-preview", {
    issueNumbers,
    maxParallel: 20,
    dryRun: true,
    executionPlan: issueNumbers.map((issue, index) => ({
      issue,
      title: `Visible ${issue}`,
      summary: `Deliver visible issue ${issue}`,
      dependsOn: index === 0 ? [] : [issueNumbers[index - 1]],
      claims: [`src/${issue}.ts`],
      labels: ["review-finding", "priority:P2"],
      affectedFiles: [`src/${issue}.ts`],
    })),
  }, undefined, undefined, { ...commandContext(), hasUI: false } as any);
  const text = (result.content[0] as { text: string }).text;
  for (const issue of issueNumbers) assert.match(text, new RegExp(`#${issue}.*Visible ${issue}`));
  assert.match(text, /Issue slots: 5 selected · 1 runnable now/);
  assert.match(text, /Issue-slot caps: requested 5 · transport not sampled · effective 5/);
  assert.match(text, /semantic dependencies #704/);
  const ui = (result.details as any).ui;
  assert.equal(ui.snapshot.nodes.length, 5);
  assert.deepEqual(ui.selectedIssueNumbers, issueNumbers);
  assert.deepEqual(ui.issueSlots, { selected: 5, runnableNow: 1, requestedCap: 5, effectiveCap: 5 });
  await shutdownFakePi(state, commandContext());
});

test("orchestration rejects a supervisor-invented batching override", async () => {
  const state = fakePi();
  const tool = state.tools.get("forgedock_orchestrate");
  assert.ok(tool);
  bindOrchestrationInvocation(state.pi, { rawArgs: "7", issueNumbers: [7], noMilestone: true });
  await assert.rejects(() => tool.execute("invented-batching", {
    issueNumbers: [7],
    batching: "aggressive",
    executionPlan: [{ issue: 7, title: "Seven", summary: "Deliver Seven", dependsOn: [], claims: ["src/a"], labels: [] }],
  }, undefined, undefined, { ...commandContext(), hasUI: false } as any), /batching=aggressive is not authorized/);
});

test("orchestration rejects a supervisor-invented concurrency override", async () => {
  const state = fakePi();
  const tool = state.tools.get("forgedock_orchestrate");
  assert.ok(tool);
  bindOrchestrationInvocation(state.pi, { rawArgs: "7", issueNumbers: [7], noMilestone: true });
  await assert.rejects(() => tool.execute("invented-concurrency", {
    issueNumbers: [7],
    maxParallel: 20,
    executionPlan: [{ issue: 7, title: "Seven", summary: "Deliver Seven", dependsOn: [], claims: ["src/a"], labels: [] }],
  }, undefined, undefined, { ...commandContext(), hasUI: false } as any), /maxParallel=20 is not authorized by the user request/);
});

test("native promotion exposes an explicit mutation-aware entrypoint", async () => {
  const state = fakePi();
  const promote = state.tools.get("forgedock_promote") as any;
  assert.ok(promote);
  assert.equal(promote.parameters.properties.confirm.type, "boolean");
  assert.equal(promote.parameters.properties.authorizeMerge.type, "boolean");
  await state.handlers.get("session_start")?.[0]?.({}, jsonSessionContext());
  assert.equal(state.active.includes("forgedock_promote"), false);
});

test("orchestration preview exposes a single-use continuation checkpoint", async () => {
  const state = fakePi();
  const spawnRequests: any[] = [];
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      spawnRequests.push(data);
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1, requestId: data.requestId, success: true, data: { details: { asyncId: "preview-continuation-run" } },
      }));
    } else if (name === "subagents:rpc:v1:request" && data.method === "stop") {
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1, requestId: data.requestId, success: true, data: { stopped: true },
      }));
    }
  }) as typeof state.pi.events.emit;
  const tool = state.tools.get("forgedock_orchestrate") as any;
  assert.ok(tool);
  bindOrchestrationInvocation(state.pi, { rawArgs: "7", issueNumbers: [7], repository: "a/b", noMilestone: true });
  const preview = await tool.execute("preview-checkpoint", {
    issueNumbers: [7],
    executionPlan: [{ issue: 7, title: "Seven", summary: "Deliver Seven", dependsOn: [], claims: ["src/a"], labels: [] }],
  }, undefined, undefined, { ...commandContext(), hasUI: false } as any);
  const previewDetails = preview.details as { previewToken?: string };
  assert.match(previewDetails.previewToken ?? "", /^[0-9a-f-]{36}$/);
  assert.match((preview.content[0] as { text: string }).text, /confirmation checkpoint/);
  assert.match((preview.content[0] as { text: string }).text, /FORGEDOCK_PREVIEW_CONTINUATION/);
  assert.match((preview.content[0] as { text: string }).text, /previewToken/);

  // A restart/recovery notice can be queued between the preview and the next
  // user turn. The live checkpoint must still bind a short affirmative typo to
  // the exact typed continuation rather than to durable DAG recovery.
  const confirmationPrompt = state.handlers.get("before_agent_start")?.[0]?.(
    { prompt: "prceed", systemPrompt: "base prompt" },
    commandContext(),
  ) as { systemPrompt: string };
  assert.match(confirmationPrompt.systemPrompt, /preview confirmation checkpoint/);
  assert.match(confirmationPrompt.systemPrompt, /call forgedock_orchestrate exactly once/i);
  assert.match(confirmationPrompt.systemPrompt, new RegExp(`"previewToken":"${previewDetails.previewToken}"`));
  assert.match(confirmationPrompt.systemPrompt, /"issueNumbers":\[7\]/);
  assert.match(confirmationPrompt.systemPrompt, /ignore any injected forgedock-background-task/i);
  assert.match(confirmationPrompt.systemPrompt, /do not ask for a dag_\* ID/i);
  assert.doesNotMatch(confirmationPrompt.systemPrompt, /No live preview|start a fresh \/orchestrate/i);

  const warningOnlyPrompt = state.handlers.get("before_agent_start")?.[0]?.(
    { prompt: "", systemPrompt: "base prompt" },
    commandContext(),
  ) as { systemPrompt: string };
  assert.match(warningOnlyPrompt.systemPrompt, /live preview checkpoint/);
  assert.match(warningOnlyPrompt.systemPrompt, /do not dispatch or resume anything/i);
  assert.doesNotMatch(warningOnlyPrompt.systemPrompt, /call forgedock_orchestrate exactly once/i);

  await state.handlers.get("agent_settled")?.[0]?.({}, commandContext());
  assert.equal(state.active.includes("forgedock_orchestrate"), true);
  assert.equal(state.active.includes("forgedock_resume_orchestration"), true);
  assert.equal(state.active.includes("forgedock_discover_orchestration"), false);
  const continued = await tool.execute("confirmed-checkpoint", {
    issueNumbers: [7],
    confirmed: true,
  }, undefined, undefined, { ...commandContext(), hasUI: false } as any);
  assert.match((continued.content[0] as { text: string }).text, /started streaming DAG/);
  assert.equal(spawnRequests.length, 1);
  await shutdownFakePi(state, commandContext());
});

test("confirmation prompt remains read-only until the user authorizes dispatch", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "forgedock-confirm-readonly-"));
  let witnessCalls = 0;
  updateForgeDockConfig(cwd, { orchestration: { dispatchMode: "confirm" } });
  const state = fakePi(undefined, {
    ensureLeaseWitness: () => {
      witnessCalls += 1;
      throw new Error("witness bootstrap must not run before confirmation");
    },
  });
  const tool = state.tools.get("forgedock_orchestrate") as any;
  bindOrchestrationInvocation(state.pi, { rawArgs: "7 --confirm", issueNumbers: [7], repository: "a/b", noMilestone: true });
  const ctx = {
    ...commandContext(),
    cwd,
    ui: { ...commandContext().ui, confirm: async () => false },
  } as any;
  try {
    await assert.rejects(() => tool.execute("declined-confirmation", {
      issueNumbers: [7],
      executionPlan: [{ issue: 7, title: "Seven", summary: "Deliver Seven", dependsOn: [], claims: ["src/a"], labels: [] }],
    }, undefined, undefined, ctx), /cancelled before dispatch/);
    assert.equal(witnessCalls, 0);
    assert.equal(existsSync(join(cwd, ".forgedock", "lease-witness.json")), false);
    assert.equal(existsSync(join(cwd, ".forgedock", "state.db")), false);
    assert.equal(existsSync(join(cwd, ".forgedock", "tasks")), false, "preview must not initialize or reconcile background tasks");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("confirm-mode orchestration provisions and re-reads a missing milestone branch before dispatch", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "forgedock-confirm-milestone-"));
  const branchNames = new Set<string>();
  const branchEvents: string[] = [];
  let listBranchesCalls = 0;
  const originalGetIssue = GitHubClient.prototype.getIssue;
  const originalListBranches = GitHubClient.prototype.listBranches;
  const originalGetBranchHead = GitHubClient.prototype.getBranchHead;
  const originalCreateBranch = GitHubClient.prototype.createBranch;
  GitHubClient.prototype.getIssue = (async function (number, repo) {
    return {
      repo: repo ?? "a/b",
      number,
      title: `Issue ${number}`,
      body: "Deliver the milestone work.",
      url: `https://github.test/a/b/issues/${number}`,
      state: "OPEN",
      labels: [],
      milestone: { number: 1, title: "Milestone One" },
      comments: [],
    };
  }) as typeof GitHubClient.prototype.getIssue;
  GitHubClient.prototype.listBranches = (async function () {
    listBranchesCalls += 1;
    return [...branchNames].map((name) => ({ name, headSha: "a".repeat(40) }));
  }) as typeof GitHubClient.prototype.listBranches;
  GitHubClient.prototype.getBranchHead = (async function (_repo, branch) {
    branchEvents.push(`head:${branch}`);
    return "a".repeat(40);
  }) as typeof GitHubClient.prototype.getBranchHead;
  GitHubClient.prototype.createBranch = (async function (_repo, branch) {
    branchEvents.push(`create:${branch}`);
    branchNames.add(branch);
    return { name: branch, headSha: "a".repeat(40) };
  }) as typeof GitHubClient.prototype.createBranch;
  try {
    updateForgeDockConfig(cwd, { orchestration: { dispatchMode: "confirm" } });
    const state = fakePi(undefined, {
      orchestrationRepository: new InMemoryOrchestrationRepository(),
      orchestrationExecutionAdmission: new LeaseBackedOrchestrationExecutionAdmission(new InMemoryLeaseRepository()),
      dispatchReadinessCheck: async () => undefined,
    });
    const spawnRequests: any[] = [];
    const originalEmit = state.pi.events.emit.bind(state.pi.events);
    state.pi.events.emit = ((name: string, data: any) => {
      originalEmit(name, data);
      if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
        spawnRequests.push(data);
        branchEvents.push("spawn");
        queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
          version: 1, requestId: data.requestId, success: true, data: { details: { asyncId: "confirm-milestone-run" } },
        }));
      }
    }) as typeof state.pi.events.emit;
    const tool = state.tools.get("forgedock_orchestrate");
    assert.ok(tool);
    bindOrchestrationInvocation(state.pi, {
      rawArgs: "7 --confirm",
      issueNumbers: [7],
      repository: "a/b",
      defaultBranch: "main",
      milestone: "Milestone One",
      noMilestone: false,
    });
    const result = await tool.execute("confirm-milestone", {
      issueNumbers: [7],
      executionPlan: [{ issue: 7, title: "Issue 7", summary: "Milestone work", dependsOn: [], claims: ["src/milestone"], labels: [] }],
    }, undefined, undefined, {
      ...commandContext(),
      cwd,
      ui: { ...commandContext().ui, confirm: async () => true },
    } as any);
    assert.match((result.content[0] as { text: string }).text, /started streaming DAG/);
    assert.deepEqual([...branchNames], ["milestone/milestone-one"]);
    assert.equal(listBranchesCalls, 4, "discovery, provisioning validation, and post-authorization route refresh must read the branch catalog");
    assert.deepEqual(branchEvents.slice(0, 3), ["head:main", "create:milestone/milestone-one", "head:milestone/milestone-one"]);
    assert.equal(branchEvents.at(-1), "spawn");
    assert.equal(spawnRequests.length, 1);
  } finally {
    GitHubClient.prototype.getIssue = originalGetIssue;
    GitHubClient.prototype.listBranches = originalListBranches;
    GitHubClient.prototype.getBranchHead = originalGetBranchHead;
    GitHubClient.prototype.createBranch = originalCreateBranch;
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("preview continuation carries the full frozen runtime contract into the child controller invocation", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "forgedock-preview-runtime-"));
  updateForgeDockConfig(cwd, {
    workerModel: "worker/old-model", workerThinking: "high",
    reviewerModel: "reviewer/old-model", reviewerThinking: "medium",
    planningModel: "planner/old-model", planningThinking: "low",
  });
  const state = fakePi();
  const spawnRequests: any[] = [];
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      spawnRequests.push(data);
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1, requestId: data.requestId, success: true, data: { details: { asyncId: "frozen-runtime-run" } },
      }));
    }
  }) as typeof state.pi.events.emit;
  const tool = state.tools.get("forgedock_orchestrate") as any;
  bindOrchestrationInvocation(state.pi, { rawArgs: "7", issueNumbers: [7], repository: "a/b", noMilestone: true });
  const ctx = { ...commandContext(), cwd, hasUI: false } as any;
  try {
    await tool.execute("runtime-preview", {
      issueNumbers: [7],
      executionPlan: [{ issue: 7, title: "Seven", summary: "Deliver Seven", dependsOn: [], claims: ["src/a"], labels: [] }],
    }, undefined, undefined, ctx);
    updateForgeDockConfig(cwd, {
      workerModel: "worker/new-model", workerThinking: "max",
      reviewerModel: "reviewer/new-model", reviewerThinking: "max",
      planningModel: "planner/new-model", planningThinking: "max",
    });
    await tool.execute("runtime-confirm", { issueNumbers: [7], confirmed: true }, undefined, undefined, ctx);
    assert.equal(spawnRequests.length, 1);
    assert.equal(spawnRequests[0]?.params.model, "worker/old-model:high");
    const task = spawnRequests[0]?.params.task ?? "";
    assert.match(task, /"workerModel":"worker\/old-model:high"/);
    assert.match(task, /"reviewerModel":"reviewer\/old-model"/);
    assert.match(task, /"reviewerThinking":"medium"/);
    assert.match(task, /"planningModel":"planner\/old-model"/);
    assert.match(task, /"planningThinking":"low"/);
    assert.doesNotMatch(task, /(?:worker|reviewer|planner)\/new-model/);
  } finally {
    await shutdownFakePi(state, ctx);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("bound decomposed scope rebinds a parent execution plan before DAG validation", async () => {
  const state = fakePi();
  const tool = state.tools.get("forgedock_orchestrate") as any;
  assert.ok(tool);
  bindOrchestrationInvocation(state.pi, {
    rawArgs: "open issues",
    issueNumbers: [110, 111],
    noMilestone: true,
    decomposedReplacements: [{ parent: 7, children: [110, 111] }],
  });
  const result = await tool.execute("rebind-parent-plan", {
    issueNumbers: [110, 111],
    executionPlan: [{ issue: 7, title: "Decomposed parent", summary: "Original parent scope", dependsOn: [], claims: ["src/orchestration"], labels: ["workflow:decomposed"] }],
  }, undefined, undefined, { ...commandContext(), hasUI: false } as any);
  assert.match((result.content[0] as { text: string }).text, /Selected issues: #110, #111/);
  assert.doesNotMatch((result.content[0] as { text: string }).text, /executionPlan must exactly match/);
});

test("preview confirmation rejects changed execution plans", async () => {
  const state = fakePi();
  const tool = state.tools.get("forgedock_orchestrate") as any;
  assert.ok(tool);
  bindOrchestrationInvocation(state.pi, { rawArgs: "7", issueNumbers: [7], noMilestone: true });
  await tool.execute("preview-plan-freeze", {
    issueNumbers: [7],
    executionPlan: [{ issue: 7, title: "Seven", summary: "Original", dependsOn: [], claims: ["src/a"], labels: [] }],
  }, undefined, undefined, { ...commandContext(), hasUI: false } as any);
  await assert.rejects(() => tool.execute("changed-plan", {
    issueNumbers: [7],
    confirmed: true,
    executionPlan: [{ issue: 7, title: "Seven", summary: "Changed", dependsOn: [], claims: ["src/a"], labels: [] }],
  }, undefined, undefined, { ...commandContext(), hasUI: false } as any), /executionPlan changed after confirmation/);
});

test("preview continuation rejects a wrong token and issue substitution", async () => {
  const state = fakePi();
  const tool = state.tools.get("forgedock_orchestrate") as any;
  assert.ok(tool);
  bindOrchestrationInvocation(state.pi, { rawArgs: "7", issueNumbers: [7], noMilestone: true });
  await tool.execute("preview-replay-guards", {
    issueNumbers: [7],
    executionPlan: [{ issue: 7, title: "Seven", summary: "Original", dependsOn: [], claims: ["src/a"], labels: [] }],
  }, undefined, undefined, { ...commandContext(), hasUI: false } as any);
  await assert.rejects(() => tool.execute("wrong-token", {
    issueNumbers: [7],
    confirmed: true,
    previewToken: "not-the-live-token",
  }, undefined, undefined, { ...commandContext(), hasUI: false } as any), /missing, expired, or belongs to another preview/);
  await assert.rejects(() => tool.execute("wrong-scope", {
    issueNumbers: [8],
    confirmed: true,
  }, undefined, undefined, { ...commandContext(), hasUI: false } as any), /issue substitution rejected/);
});

test("fresh orchestration never invokes the implicit resume tool", async () => {
  const state = fakePi();
  const tool = state.tools.get("forgedock_orchestrate");
  assert.ok(tool);
  bindOrchestrationInvocation(state.pi, { rawArgs: "7", issueNumbers: [7], noMilestone: true });
  const resume = state.tools.get("forgedock_resume_orchestration");
  assert.ok(resume);
  await state.handlers.get("session_start")?.[0]?.({}, jsonSessionContext());
  assert.equal(state.active.includes("forgedock_resume_orchestration"), true);
  assert.equal((resume as any).parameters.properties.orchestrationId.type, "string");
  const result = await tool.execute("fresh-preview", {
    issueNumbers: [7],
    executionPlan: [{ issue: 7, title: "Seven", summary: "Deliver Seven", dependsOn: [], claims: ["src/a"], labels: [] }],
  }, undefined, undefined, { ...commandContext(), hasUI: false } as any);
  assert.match((result.content[0] as { text: string }).text, /Dispatch is disabled in preview mode/);
  assert.equal(state.sent.some(({ content }) => /Resume orchestration|forgedock_resume_orchestration/i.test(content)), false);
});

test("orchestration preview stays read-only and final admission rejects a live durable batch DAG", async () => {
  const repository = new InMemoryOrchestrationRepository();
  const leases = new InMemoryLeaseRepository();
  const executionAdmission = new LeaseBackedOrchestrationExecutionAdmission(leases);
  const active: OrchestrationRecord = {
    schema: "forgedock.orchestration/v1",
    orchestrationId: "dag_active_batch",
    repository: "a/b",
    requestedIssueNumbers: [7, 8],
    issueNumbers: [7, 8],
    maxParallel: 1,
    autoMerge: true,
    status: "running",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    nodes: [{
      id: "issue-900",
      issue: 900,
      priority: 1,
      dependencies: [],
      claims: ["src"],
      status: "running",
      childRunIds: [],
      memberIssues: [7, 8],
    }],
  };
  await repository.createOrchestration(active);
  const activeClaim = await executionAdmission.acquire(active.orchestrationId);
  assert.ok(activeClaim);
  const state = fakePi(undefined, {
    orchestrationRepository: repository,
    orchestrationExecutionAdmission: executionAdmission,
    dispatchReadinessCheck: async () => undefined,
  });
  const tool = state.tools.get("forgedock_orchestrate");
  assert.ok(tool);
  const executionPlan = [{ issue: 900, title: "Generated batch", summary: "Already owned", dependsOn: [], claims: ["src"], labels: ["batch"] }];
  bindOrchestrationInvocation(state.pi, {
    rawArgs: "open issues",
    issueNumbers: [900],
    repository: "a/b",
    noMilestone: true,
  });

  const preview = await tool.execute("active-owned-preview", {
    issueNumbers: [900],
    executionPlan,
    dryRun: true,
  }, undefined, undefined, { ...commandContext(), hasUI: false } as any);
  assert.match((preview.content[0] as { text: string }).text, /Dispatch is disabled by --dry-run/);
  assert.equal(repository.records.size, 1, "read-only preview must not create or mutate a DAG");

  bindOrchestrationInvocation(state.pi, {
    rawArgs: "open issues",
    issueNumbers: [900],
    repository: "a/b",
    noMilestone: true,
  });
  await assert.rejects(() => tool.execute("active-owned-dispatch", {
    issueNumbers: [900],
    executionPlan,
    confirmed: true,
  }, undefined, undefined, { ...commandContext(), hasUI: false } as any), /active durable DAG ownership.*#900.*dag_active_batch/);
  assert.equal((await repository.loadOrchestration(active.orchestrationId))?.status, "running");
  await activeClaim.release();
  await shutdownFakePi(state, commandContext());
});

test("authorized orchestration retains an expired durable owner in retry_wait before final scope admission", async () => {
  let now = Date.parse("2026-08-18T00:00:00.000Z");
  const repository = new InMemoryOrchestrationRepository();
  const leases = new InMemoryLeaseRepository();
  const executionAdmission = new LeaseBackedOrchestrationExecutionAdmission(leases, {
    now: () => now,
    ttlMs: 1_000,
    heartbeatMs: 500,
  });
  const stale: OrchestrationRecord = {
    schema: "forgedock.orchestration/v1",
    orchestrationId: "dag_expired_owner",
    repository: "a/b",
    requestedIssueNumbers: [901],
    issueNumbers: [901],
    maxParallel: 1,
    autoMerge: true,
    executionAttempt: 1,
    status: "running",
    createdAt: "2026-08-18T00:00:00.000Z",
    updatedAt: "2026-08-18T00:00:00.000Z",
    nodes: [{
      id: "issue-901",
      issue: 901,
      priority: 1,
      dependencies: [],
      claims: ["src"],
      status: "running",
      childRunIds: [],
    }],
  };
  await repository.createOrchestration(stale);
  const staleClaim = await executionAdmission.acquire(stale.orchestrationId);
  assert.ok(staleClaim);
  now += 1_001;

  const state = fakePi(undefined, {
    orchestrationRepository: repository,
    orchestrationExecutionAdmission: executionAdmission,
    dispatchReadinessCheck: async () => undefined,
  });
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1,
        requestId: data.requestId,
        success: true,
        data: { text: "started", details: { asyncId: "expired-owner-replacement" } },
      }));
    } else if (name === "subagents:rpc:v1:request" && data.method === "stop") {
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1,
        requestId: data.requestId,
        success: true,
        data: { stopped: true },
      }));
    }
  }) as typeof state.pi.events.emit;
  const tool = state.tools.get("forgedock_orchestrate");
  assert.ok(tool);
  bindOrchestrationInvocation(state.pi, {
    rawArgs: "901",
    issueNumbers: [901],
    repository: "a/b",
    noMilestone: true,
  });

  await assert.rejects(
    tool.execute("expired-owned-dispatch", {
      issueNumbers: [901],
      executionPlan: [{ issue: 901, title: "Replacement", summary: "Replace expired owner", dependsOn: [], claims: ["src"], labels: [] }],
      confirmed: true,
    }, undefined, undefined, { ...commandContext(), hasUI: false } as any),
    /active durable DAG ownership.*#901.*dag_expired_owner/,
  );

  const recovered = await repository.loadOrchestration(stale.orchestrationId);
  assert.equal(recovered?.status, "running");
  assert.equal(recovered?.nodes[0]?.status, "retry_wait");
  assert.equal(repository.records.size, 1, "the retrying owner remains the sole durable DAG");
  await staleClaim.release();
  await shutdownFakePi(state, commandContext());
});

test("visible DAG delegation dispatches a successor on its predecessor completion event", async () => {
  const state = fakePi();
  const launched: number[] = [];
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      const issue = Number(/issue #(\d+)/.exec(data.params.task)?.[1]);
      launched.push(issue);
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1, requestId: data.requestId, success: true,
        data: { details: { asyncId: `run-${issue}` } },
      }));
    }
  }) as typeof state.pi.events.emit;
  const delegator = witnessedDagDelegator(state.pi);
  const completed: number[] = [];
  const discovered = [
    { id: "issue-1", issue: 1, title: "One", summary: "One", priority: 1, dependencies: [], claims: ["src/**/*.ts"], labels: [], affectedFiles: ["src/**/*.ts"], memberIssues: [1] },
    { id: "issue-2", issue: 2, title: "Two", summary: "Two", priority: 1, dependencies: [], claims: ["src/foo.ts"], labels: [], affectedFiles: ["src/foo.ts"], memberIssues: [2] },
  ];
  const derived = materializeClaimDependencies(discovered);
  assert.deepEqual(derived.edges, [{
    predecessor: "issue-1",
    successor: "issue-2",
    overlappingClaims: ["src/**/*.ts ↔ src/foo.ts"],
  }]);
  const run = await delegator.start({
    items: derived.items.map((item) => ({
      ...item,
      title: item.title ?? `Issue ${item.issue}`,
      summary: item.summary ?? "",
      labels: [],
      affectedFiles: item.affectedFiles ?? [],
      memberIssues: item.memberIssues ?? [item.issue],
    })),
    maxParallel: 2,
    serializationEdges: derived.edges,
    taskFor: (item) => ({ agent: "forgedock-issue-worker", task: `Deliver issue #${item.issue}`, cwd: process.cwd() }),
    assertCompleted: async (item) => { completed.push(item.issue); },
    onComplete: () => undefined,
  });
  assert.deepEqual(launched, [1]);
  originalEmit("subagent:async-complete", { runId: "run-1" });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(launched, [1, 2]);
  originalEmit("subagent:async-complete", { runId: "run-2" });
  await run.completion;
  assert.deepEqual(completed, [1, 2]);
  await delegator.shutdown();
});

test("visible DAG start surfaces failure before the first worker dispatch", async () => {
  const state = fakePi();
  const repository = new InMemoryOrchestrationRepository();
  const delegator = new VisibleDagDelegator(
    state.pi,
    () => repository,
    undefined,
    undefined,
    () => ({ acquire: async () => { throw new Error("witness admission failed"); } }),
  );

  await assert.rejects(() => delegator.start({
    repository: "a/b",
    items: [{ id: "issue-1", issue: 1, title: "One", summary: "One", priority: 1, dependencies: [], claims: [], labels: [], affectedFiles: [], memberIssues: [1] }],
    maxParallel: 1,
    taskFor: () => ({ agent: "forgedock-issue-worker", task: "Deliver issue #1", cwd: process.cwd() }),
    assertCompleted: async () => undefined,
    onComplete: () => undefined,
  }), /witness admission failed/);

  const [durable] = await repository.listOrchestrations();
  assert.equal(durable?.status, "failed");
  await delegator.shutdown();
});

test("visible DAG shutdown aborts a native scheduler waiting for capacity", async () => {
  const state = fakePi();
  const repository = new InMemoryOrchestrationRepository();
  const occupied = Array.from({ length: 4 }, (_, index) => ({
    id: `occupied-${index}`,
    command: "node",
    args: [],
    cwd: process.cwd(),
    pid: index + 1,
    logPath: "",
    status: "running" as const,
    startedAt: new Date(0).toISOString(),
  }));
  let starts = 0;
  const transport = {
    list: () => occupied,
    isActive: () => true,
    start: async () => { starts += 1; return "unexpected-task"; },
    wait: async () => undefined,
  };
  const admission = new LeaseBackedOrchestrationExecutionAdmission(new InMemoryLeaseRepository());
  const delegator = new VisibleDagDelegator(state.pi, () => repository, undefined, transport, () => admission);
  const start = delegator.start({
    repository: "a/b",
    items: [{ id: "issue-capacity", issue: 1, title: "Capacity", summary: "Capacity", priority: 1, dependencies: [], claims: [], labels: [], affectedFiles: [], memberIssues: [1] }],
    maxParallel: 1,
    taskFor: () => ({ agent: "forgedock-issue-worker", task: "Deliver issue #1", cwd: process.cwd() }),
    controllerTaskFor: () => ({ args: [], cwd: process.cwd() }),
    assertCompleted: async () => undefined,
    onComplete: () => undefined,
  });

  await delegator.shutdown();
  await assert.rejects(start, /TUI shutdown|cancelled/i);
  assert.equal(starts, 0);
});

test("dead detached task evidence does not reduce native orchestration capacity", async () => {
  const state = fakePi();
  const repository = new InMemoryOrchestrationRepository();
  const detached = {
    id: "task-stale",
    command: "node",
    args: ["controller"],
    cwd: process.cwd(),
    pid: 999_999_999,
    logPath: "stale.log",
    status: "detached" as const,
    startedAt: new Date(0).toISOString(),
  };
  const transport = {
    list: () => [detached],
    isActive: () => false,
    start: async () => "task-current",
    wait: async () => ({ ...detached, id: "task-current", status: "completed" as const, completedAt: new Date().toISOString(), exitCode: 0 }),
  };
  const admission = new LeaseBackedOrchestrationExecutionAdmission(new InMemoryLeaseRepository());
  const delegator = new VisibleDagDelegator(state.pi, () => repository, undefined, transport, () => admission);
  const run = await delegator.start({
    repository: "a/b",
    items: [{ id: "issue-1", issue: 1, title: "One", summary: "One", priority: 1, dependencies: [], claims: [], labels: [], affectedFiles: [], memberIssues: [1] }],
    maxParallel: 4,
    taskFor: () => ({ agent: "forgedock-issue-worker", task: "Deliver issue #1", cwd: process.cwd() }),
    controllerTaskFor: () => ({ args: [], cwd: process.cwd() }),
    assertCompleted: async () => undefined,
    onComplete: () => undefined,
  });
  await run.completion;
  const durable = await repository.loadOrchestration(run.id);
  assert.equal(durable?.transportCapacity, 4);
  assert.equal(durable?.effectiveMaxParallel, 4);
  await delegator.shutdown();
});

test("configured orchestration concurrency raises native transport capacity", async () => {
  const state = fakePi();
  const repository = new InMemoryOrchestrationRepository();
  const records: any[] = [];
  let configuredLimit = 0;
  const transport = {
    setLimit: (limit: number) => { configuredLimit = limit; },
    list: () => records,
    isActive: () => true,
    start: async () => {
      const id = `configured-${records.length + 1}`;
      records.push({ id, command: "node", args: [], cwd: process.cwd(), pid: records.length + 1, logPath: "", status: "running" as const, startedAt: new Date(0).toISOString() });
      return id;
    },
    wait: async (id: string) => ({ ...records.find((record) => record.id === id), status: "completed" as const, exitCode: 0 }),
  };
  const admission = new LeaseBackedOrchestrationExecutionAdmission(new InMemoryLeaseRepository());
  const delegator = new VisibleDagDelegator(state.pi, () => repository, undefined, transport, () => admission);
  const run = await delegator.start({
    repository: "a/b",
    items: Array.from({ length: 10 }, (_, index) => ({ id: `issue-${index + 1}`, issue: index + 1, title: `Issue ${index + 1}`, summary: "Configured capacity", priority: 1, dependencies: [], claims: [], labels: [], affectedFiles: [], memberIssues: [index + 1] })),
    maxParallel: 10,
    taskFor: (item) => ({ agent: "forgedock-issue-worker", task: `Deliver issue #${item.issue}`, cwd: process.cwd() }),
    controllerTaskFor: () => ({ args: [], cwd: process.cwd() }),
    assertCompleted: async () => undefined,
    onComplete: () => undefined,
  });
  await run.completion;
  const durable = await repository.loadOrchestration(run.id);
  assert.equal(configuredLimit, 10);
  assert.equal(durable?.transportCapacity, 10);
  assert.equal(durable?.effectiveMaxParallel, 10);
  await delegator.shutdown();
});

test("live capacity excludes this DAG's immediate native launch receipts", async () => {
  const state = fakePi();
  const repository = new InMemoryOrchestrationRepository();
  const launched: any[] = [];
  const transport = {
    list: () => launched,
    isActive: () => true,
    start: async () => {
      const id = `owned-${launched.length + 1}`;
      launched.push({ id, command: "node", args: [], cwd: process.cwd(), pid: launched.length + 1, logPath: "", status: "running" as const, startedAt: new Date(0).toISOString() });
      return id;
    },
    wait: async (id: string) => ({ ...launched.find((record) => record.id === id), status: "completed" as const, exitCode: 0 }),
  };
  const admission = new LeaseBackedOrchestrationExecutionAdmission(new InMemoryLeaseRepository());
  const delegator = new VisibleDagDelegator(state.pi, () => repository, undefined, transport, () => admission);
  const run = await delegator.start({
    repository: "a/b",
    items: Array.from({ length: 5 }, (_, index) => ({ id: `issue-${index + 1}`, issue: index + 1, title: `Issue ${index + 1}`, summary: "Capacity ownership", priority: 1, dependencies: [], claims: [], labels: [], affectedFiles: [], memberIssues: [index + 1] })),
    maxParallel: 4,
    taskFor: (item) => ({ agent: "forgedock-issue-worker", task: `Deliver issue #${item.issue}`, cwd: process.cwd() }),
    controllerTaskFor: () => ({ args: [], cwd: process.cwd() }),
    assertCompleted: async () => undefined,
    onComplete: () => undefined,
  });
  await run.completion;
  assert.equal(launched.length, 5);
  await delegator.shutdown();
});

test("native controller tasks promote Build Packet claims into the parent scheduler before building", async () => {
  const state = fakePi();
  const repository = new InMemoryOrchestrationRepository();
  const specs = new Map<string, ControllerTaskSpec>();
  let firstPromoted!: () => void;
  const firstPromotion = new Promise<void>((resolve) => { firstPromoted = resolve; });
  let secondRejected!: () => void;
  const secondRejection = new Promise<void>((resolve) => { secondRejected = resolve; });
  let releaseFirst!: () => void;
  const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let secondWaits = 0;
  const transport = {
    start: async (spec: ControllerTaskSpec) => {
      const id = `task-${spec.claimPromotion?.identity.nodeId}`;
      specs.set(id, spec);
      return id;
    },
    wait: async (taskId: string) => {
      const promotion = specs.get(taskId)?.claimPromotion;
      assert.ok(promotion);
      if (promotion.identity.nodeId === "issue-1") {
        await promotion.promoteClaims(["src/shared.ts"]);
        firstPromoted();
        await firstRelease;
        return { id: taskId, command: "node", args: [], cwd: process.cwd(), pid: 1, logPath: "", status: "completed" as const, startedAt: new Date(0).toISOString() };
      }
      await firstPromotion;
      secondWaits++;
      try {
        await promotion.promoteClaims(["src/shared.ts"]);
      } catch (error) {
        assert.ok(error instanceof ClaimPromotionConflictError);
        secondRejected();
        return { id: taskId, command: "node", args: [], cwd: process.cwd(), pid: 2, logPath: "", status: "blocked" as const, startedAt: new Date(0).toISOString() };
      }
      return { id: taskId, command: "node", args: [], cwd: process.cwd(), pid: 2, logPath: "", status: "completed" as const, startedAt: new Date(0).toISOString() };
    },
  };
  const admission = new LeaseBackedOrchestrationExecutionAdmission(new InMemoryLeaseRepository());
  const delegator = new VisibleDagDelegator(state.pi, () => repository, undefined, transport, () => admission);
  const run = await delegator.start({
    repository: "a/b",
    items: [
      { id: "issue-1", issue: 1, title: "One", summary: "One", priority: 1, dependencies: [], claims: [], labels: [], affectedFiles: [], memberIssues: [1] },
      { id: "issue-2", issue: 2, title: "Two", summary: "Two", priority: 1, dependencies: [], claims: [], labels: [], affectedFiles: [], memberIssues: [2] },
    ],
    maxParallel: 2,
    taskFor: (item) => ({ agent: "forgedock-issue-worker", task: `Deliver issue #${item.issue}`, cwd: process.cwd() }),
    controllerTaskFor: () => ({ args: [], cwd: process.cwd() }),
    assertCompleted: async (item) => {
      if (item.id === "issue-2" && secondWaits === 1) throw new Error("reconciled state is building");
    },
    onComplete: () => undefined,
  });
  await secondRejection;
  const duringConflict = await repository.loadOrchestration(run.id);
  assert.deepEqual(duringConflict?.nodes.find((node) => node.id === "issue-1")?.claims, ["src/shared.ts"]);
  // A conflicting promotion is retained only in the live scheduler until it
  // is admitted; the durable node projection must not claim an unowned scope.
  assert.deepEqual(duringConflict?.nodes.find((node) => node.id === "issue-2")?.claims, []);
  releaseFirst();
  await run.completion;
  const completed = await repository.loadOrchestration(run.id);
  assert.equal(completed?.nodes.find((node) => node.id === "issue-1")?.status, "completed");
  assert.equal(completed?.nodes.find((node) => node.id === "issue-2")?.status, "completed");
  assert.deepEqual(completed?.nodes.find((node) => node.id === "issue-2")?.attempts?.map((attempt) => attempt.recovery), ["initial", "resume"]);
  await delegator.shutdown();
});

test("native DAG recovery adopts a task launched before task identity persistence", async () => {
  const state = fakePi();
  const repository = new LaunchIdentityFaultRepository();
  const tasks = new Map<string, any>();
  let launches = 0;
  const transport = {
    start: async (spec: ControllerTaskSpec) => {
      assert.ok(spec.launchIdentity);
      assert.equal(spec.launchKey, orchestrationTransportKey(spec.launchIdentity!));
      const id = `native-crash-window-${++launches}`;
      tasks.set(id, {
        id,
        command: "node",
        args: [],
        cwd: process.cwd(),
        pid: 1,
        logPath: "",
        status: "running" as const,
        startedAt: new Date(0).toISOString(),
        launchKey: spec.launchKey,
      });
      return id;
    },
    findByLaunchIdentity: (identity: OrchestrationTransportIdentity) =>
      [...tasks.values()].find((task) => task.launchKey === orchestrationTransportKey(identity))?.id,
    list: () => [...tasks.values()],
    isActive: () => true,
    wait: async (id: string) => ({ ...tasks.get(id), status: "completed" as const, exitCode: 0 }),
  };
  const admission = new LeaseBackedOrchestrationExecutionAdmission(new InMemoryLeaseRepository());
  const delegator = new VisibleDagDelegator(state.pi, () => repository, undefined, transport, () => admission);
  const input = {
    repository: "a/b",
    items: [{ id: "issue-launch", issue: 101, title: "Launch", summary: "Launch", priority: 1, dependencies: [], claims: [], labels: [], affectedFiles: [], memberIssues: [101] }],
    maxParallel: 1,
    taskFor: () => ({ agent: "forgedock-issue-worker", task: "Deliver issue #101", cwd: process.cwd() }),
    controllerTaskFor: () => ({ args: [], cwd: process.cwd() }),
    assertCompleted: async () => undefined,
    onComplete: () => undefined,
  };

  await assert.rejects(() => delegator.start(input), /fault injected after worker launch/);
  const [crashed] = await repository.listOrchestrations();
  assert.ok(crashed);
  const crashedAttempt = crashed.nodes[0]?.attempts?.[0];
  assert.equal(crashed.nodes[0]?.status, "running");
  assert.equal(crashedAttempt?.status, "launching");
  assert.equal(crashedAttempt?.taskId, undefined, "the injected write must leave the durable identity absent");

  const resumed = await delegator.resume(crashed.orchestrationId);
  await resumed.completion;
  assert.equal(launches, 1, "recovery must adopt the exact native task instead of spawning a duplicate");
  const recovered = await repository.loadOrchestration(crashed.orchestrationId);
  assert.equal(recovered?.status, "completed");
  assert.equal(recovered?.nodes[0]?.attempts?.length, 1);
  assert.equal(recovered?.nodes[0]?.attempts?.[0]?.taskId, "native-crash-window-1");
  await delegator.shutdown();
});

test("Pi fallback recovery reuses its launch receipt across the launch-to-record crash window", async () => {
  const state = fakePi();
  const repository = new LaunchIdentityFaultRepository();
  let launches = 0;
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      launches++;
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1,
        requestId: data.requestId,
        success: true,
        data: { details: { asyncId: "pi-crash-window-1" } },
      }));
    }
  }) as typeof state.pi.events.emit;
  const delegator = witnessedDagDelegator(state.pi, repository);
  const input = {
    repository: "a/b",
    items: [{ id: "issue-pi-launch", issue: 102, title: "Pi launch", summary: "Pi launch", priority: 1, dependencies: [], claims: [], labels: [], affectedFiles: [], memberIssues: [102] }],
    maxParallel: 1,
    taskFor: () => ({ agent: "forgedock-issue-worker", task: "Deliver issue #102", cwd: process.cwd() }),
    assertCompleted: async () => undefined,
    onComplete: () => undefined,
  };

  await assert.rejects(() => delegator.start(input), /fault injected after worker launch/);
  const [crashed] = await repository.listOrchestrations();
  assert.ok(crashed);
  assert.equal(crashed.nodes[0]?.attempts?.[0]?.runId, undefined);

  const resumedPromise = delegator.resume(crashed.orchestrationId);
  const completionTicker = setInterval(() => originalEmit("subagent:async-complete", { runId: "pi-crash-window-1" }), 10);
  const resumed = await Promise.race([
    resumedPromise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Pi recovery did not adopt the launched run")), 2_000)),
  ]);
  clearInterval(completionTicker);
  await resumed.completion;
  assert.equal(launches, 1, "Pi recovery must wait for the existing GitHub-capable worker");
  const recovered = await repository.loadOrchestration(crashed.orchestrationId);
  assert.equal(recovered?.status, "completed");
  assert.equal(recovered?.nodes[0]?.attempts?.length, 1);
  assert.equal(recovered?.nodes[0]?.attempts?.[0]?.runId, "pi-crash-window-1");
  await delegator.shutdown();
});

test("fresh-rerun authorization cannot be converted back into checkpoint resume", () => {
  assert.deepEqual(resolveIssueWorkerRecovery(["needs-human"], false, "rerun"), { rerun: true, resume: false });
  assert.deepEqual(resolveIssueWorkerRecovery(["workflow:engine-error"], true, "initial"), { rerun: true, resume: false });
  assert.deepEqual(resolveIssueWorkerRecovery([], true, "resume"), { rerun: false, resume: true });
  assert.deepEqual(resolveIssueWorkerRecovery(["workflow:in-review", "needs-human"], false, "initial"), { rerun: false, resume: false });
  assert.deepEqual(resolveIssueWorkerRecovery([], false, "resume"), { rerun: false, resume: true });
});

test("visible DAG persists its durable parent record and terminal node state", async () => {
  const state = fakePi();
  const repository = new InMemoryOrchestrationRepository();
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1, requestId: data.requestId, success: true, data: { details: { asyncId: "durable-child" } },
      }));
    }
  }) as typeof state.pi.events.emit;
  const delegator = witnessedDagDelegator(state.pi, repository);
  const run = await delegator.start({
    repository: "a/b", autoMerge: true,
    requestedIssueNumbers: [21, 22],
    items: [{ id: "issue-21", issue: 21, title: "Twenty-one", summary: "Durable", priority: 1, dependencies: [], claims: [], labels: [], affectedFiles: [], memberIssues: [21, 22] }],
    maxParallel: 1,
    taskFor: (item) => ({ agent: "forgedock-issue-worker", task: `Deliver issue #${item.issue}`, cwd: process.cwd() }),
    assertCompleted: async () => undefined,
    onComplete: () => undefined,
  });
  originalEmit("subagent:async-complete", { runId: "durable-child" });
  await run.completion;
  const record = await repository.loadOrchestration(run.id);
  assert.equal(record?.status, "completed");
  assert.equal(record?.repository, "a/b");
  assert.deepEqual(record?.requestedIssueNumbers, [21, 22]);
  assert.deepEqual(record?.issueNumbers, [21, 22]);
  assert.equal(record?.nodes[0]?.status, "completed");
  assert.deepEqual(record?.nodes[0]?.childRunIds, ["durable-child"]);
  await delegator.shutdown();
});

test("visible DAG rebuilds and resumes a durable parent after supervisor restart", async () => {
  const repository = new InMemoryOrchestrationRepository();
  const firstState = fakePi();
  const firstEmit = firstState.pi.events.emit.bind(firstState.pi.events);
  firstState.pi.events.emit = ((name: string, data: any) => {
    firstEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      queueMicrotask(() => firstEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1, requestId: data.requestId, success: true, data: { details: { asyncId: "restart-child-1" } },
      }));
    }
  }) as typeof firstState.pi.events.emit;
  const first = witnessedDagDelegator(firstState.pi, repository);
  const input = {
    repository: "a/b", autoMerge: true,
    items: [{ id: "issue-22", issue: 22, title: "Twenty-two", summary: "Restart", priority: 1, dependencies: [], claims: [], labels: [], affectedFiles: [], memberIssues: [22] }],
    maxParallel: 1,
    taskFor: (item: any) => ({ agent: "forgedock-issue-worker", task: `Deliver issue #${item.issue}`, cwd: process.cwd() }),
    assertCompleted: async () => ({ status: "failed" as const, error: "controller stopped" }),
    onComplete: () => undefined,
  };
  const initial = await first.start(input);
  firstEmit("subagent:async-complete", { runId: "restart-child-1" });
  await initial.completion;
  await first.shutdown();

  const secondState = fakePi();
  const secondEmit = secondState.pi.events.emit.bind(secondState.pi.events);
  secondState.pi.events.emit = ((name: string, data: any) => {
    secondEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      queueMicrotask(() => secondEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1, requestId: data.requestId, success: true, data: { details: { asyncId: "restart-child-2" } },
      }));
    }
  }) as typeof secondState.pi.events.emit;
  const second = witnessedDagDelegator(secondState.pi, repository, async (record) => ({
    ...input,
    items: record.nodes.map((node) => ({ ...node, title: node.title ?? `Issue #${node.issue}`, summary: node.summary ?? "Restart", labels: [], memberIssues: node.memberIssues ?? [node.issue], affectedFiles: node.affectedFiles ?? [] })),
    assertCompleted: async () => undefined,
  }));
  const resumed = await second.resume(initial.id, { rerunIssueNumbers: [22] });
  secondEmit("subagent:async-complete", { runId: "restart-child-2" });
  await resumed.completion;
  const record = await repository.loadOrchestration(initial.id);
  assert.equal(record?.status, "completed");
  assert.deepEqual(record?.nodes[0]?.childRunIds, ["restart-child-1", "restart-child-2"]);
  await second.shutdown();
});

test("visible DAG resume retries failed nodes without replaying completed nodes", async () => {
  const state = fakePi();
  const launched: string[] = [];
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      const runId = `retry-run-${launched.length + 1}`;
      launched.push(runId);
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1, requestId: data.requestId, success: true, data: { details: { asyncId: runId } },
      }));
    }
  }) as typeof state.pi.events.emit;
  const delegator = witnessedDagDelegator(state.pi);
  let assertions = 0;
  const results: string[] = [];
  const recoveryModes: string[] = [];
  const first = await delegator.start({
    items: [{ id: "issue-6", issue: 6, title: "Six", summary: "Six", priority: 1, dependencies: [], claims: [], labels: [], affectedFiles: [], memberIssues: [6] }],
    maxParallel: 1,
    taskFor: (item, recovery) => {
      recoveryModes.push(recovery);
      return { agent: "forgedock-issue-worker", task: `Deliver issue #${item.issue}`, cwd: process.cwd() };
    },
    assertCompleted: async () => {
      assertions++;
      if (assertions === 1) throw new Error("interrupted build");
    },
    onComplete: (result) => results.push(result.status.get("issue-6") ?? "missing"),
  });
  originalEmit("subagent:async-complete", { runId: "retry-run-1" });
  await first.completion;
  assert.deepEqual(results, ["failed"]);

  const resumed = await delegator.resume(first.id);
  originalEmit("subagent:async-complete", { runId: "retry-run-2" });
  await resumed.completion;
  assert.deepEqual(launched, ["retry-run-1", "retry-run-2"]);
  assert.deepEqual(recoveryModes, ["initial", "resume"]);
  assert.deepEqual(results, ["failed", "completed"]);
  await delegator.shutdown();
});

test("visible decomposition keeps non-root repository identity on initial and resumed materialization", async () => {
  const repositoryReads: string[] = [];
  const artifactReads: Array<{ repo: string; issue: number }> = [];
  const issueReads: Array<{ repo: string; issue: number }> = [];
  const branchReads: Array<{ repo: string; branch: string }> = [];
  const outcome = createArtifact({
    kind: "Outcome",
    runId: "run-visible-remote-decomposition",
    subject: { repo: "owner/work", issue: 42 },
    producer: { role: "controller", runtime: "forgedock" },
    payload: { status: "decomposed", reason: "Split work", childIssues: ["#100 Child"] },
  });
  const github = {
    async getRepository(repo: string) {
      repositoryReads.push(repo);
      return { repo, defaultBranch: repo === "owner/work" ? "work-main" : "control-main" };
    },
    async getIssue(issue: number, repo: string) {
      issueReads.push({ repo, issue });
      return {
        repo,
        number: issue,
        title: `Child ${issue}`,
        body: "",
        url: `https://github.test/${repo}/issues/${issue}`,
        state: "OPEN" as const,
        labels: [],
        comments: [],
      };
    },
    async listBranches(repo: string) {
      branchReads.push({ repo, branch: "milestone/" });
      return [];
    },
    async getBranchHead(repo: string, branch: string) {
      branchReads.push({ repo, branch });
      return "head";
    },
  } as any;
  const artifacts = {
    async list(subject: { repo: string; issue: number }) {
      artifactReads.push(subject);
      return [outcome];
    },
  };
  const input = {
    github,
    artifacts,
    repository: "owner/control",
    effective: { fastLaneTarget: "work-main" } as any,
    orchestration: { nodes: [] } as any,
    node: { id: "parent", issue: 42, repository: "owner/work" } as any,
    item: {
      id: "parent",
      issue: 42,
      repository: "owner/work",
      priority: 1,
      dependencies: [],
      claims: [],
      labels: [],
      affectedFiles: [],
      memberIssues: [42],
      title: "Parent",
      summary: "Parent",
    },
  };

  const initial = await materializeVisibleDecomposition(input);
  assert.deepEqual(repositoryReads, ["owner/work"]);
  assert.deepEqual(artifactReads, [{ repo: "owner/work", issue: 42 }]);
  assert.deepEqual(issueReads, [{ repo: "owner/work", issue: 100 }]);
  assert.deepEqual(branchReads, [{ repo: "owner/work", branch: "work-main" }]);
  assert.equal(initial?.items[0]?.repository, "owner/work");
  assert.equal(initial?.items[0]?.targetBranch, "work-main");

  repositoryReads.length = 0;
  artifactReads.length = 0;
  issueReads.length = 0;
  branchReads.length = 0;
  const resumed = await materializeVisibleDecomposition({ ...input, childIssues: [100] });
  assert.deepEqual(repositoryReads, ["owner/work"]);
  assert.deepEqual(artifactReads, []);
  assert.deepEqual(issueReads, [{ repo: "owner/work", issue: 100 }]);
  assert.deepEqual(branchReads, [{ repo: "owner/work", branch: "work-main" }]);
  assert.equal(resumed?.items[0]?.repository, "owner/work");
  assert.equal(resumed?.items[0]?.targetBranch, "work-main");
});

test("visible DAG refuses to retry terminally decomposed work", async () => {
  const state = fakePi();
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1, requestId: data.requestId, success: true, data: { details: { asyncId: "decomposed-run" } },
      }));
    }
  }) as typeof state.pi.events.emit;
  const delegator = witnessedDagDelegator(state.pi);
  const run = await delegator.start({
    items: [{ id: "issue-7", issue: 7, title: "Seven", summary: "Seven", priority: 1, dependencies: [], claims: [], labels: ["workflow:decomposed"], affectedFiles: [], memberIssues: [7] }],
    maxParallel: 1,
    taskFor: () => ({ agent: "forgedock-issue-worker", task: "Deliver issue #7", cwd: process.cwd() }),
    assertCompleted: async () => ({ status: "skipped", error: "authoritative child scope required" }),
    onComplete: () => undefined,
  });
  originalEmit("subagent:async-complete", { runId: "decomposed-run" });
  await run.completion;
  const durable = (delegator as any).runs.get(run.id).durableRecord;
  durable.status = "failed";
  await assert.rejects(() => delegator.resume(run.id), /terminally decomposed work.*invoke \/orchestrate again/);
  await delegator.shutdown();
});

test("visible DAG recovery applies an explicitly authorized fresh rerun to the failed issue", async () => {
  const state = fakePi();
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  let launches = 0;
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      const runId = `rerun-override-${++launches}`;
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1, requestId: data.requestId, success: true, data: { details: { asyncId: runId } },
      }));
    }
  }) as typeof state.pi.events.emit;
  const delegator = witnessedDagDelegator(state.pi);
  const recoveryModes: string[] = [];
  let assertions = 0;
  const first = await delegator.start({
    items: [{ id: "issue-6", issue: 6, title: "Six", summary: "Six", priority: 1, dependencies: [], claims: [], labels: ["needs-human"], affectedFiles: [], memberIssues: [6] }],
    maxParallel: 1,
    taskFor: (_item, recovery) => {
      recoveryModes.push(recovery);
      return { agent: "forgedock-issue-worker", task: "Deliver issue #6", cwd: process.cwd() };
    },
    assertCompleted: async () => {
      if (++assertions === 1) throw new Error("checkpoint is not recoverable");
    },
    onComplete: () => undefined,
  });
  originalEmit("subagent:async-complete", { runId: "rerun-override-1" });
  await first.completion;

  const durable = (delegator as any).runs.get(first.id).durableRecord;
  durable.status = "failed";
  const resumed = await delegator.resume(first.id, { rerunIssueNumbers: [6] });
  originalEmit("subagent:async-complete", { runId: "rerun-override-2" });
  await resumed.completion;
  assert.deepEqual(recoveryModes, ["initial", "rerun"]);
  const completedDurable = (delegator as any).runs.get(first.id).durableRecord;
  completedDurable.status = "failed";
  await assert.rejects(() => delegator.resume(first.id, { rerunIssueNumbers: [99] }), /already complete|does not match/);
  await delegator.shutdown();
});

test("visible DAG resume carries typed verification adjudication without fresh rerun", async () => {
  const state = fakePi();
  const originalEmit = state.pi.events.emit.bind(state.pi.events);
  let launches = 0;
  const adjudications: string[] = [];
  state.pi.events.emit = ((name: string, data: any) => {
    originalEmit(name, data);
    if (name === "subagents:rpc:v1:request" && data.method === "spawn") {
      const runId = `adjudication-run-${++launches}`;
      queueMicrotask(() => originalEmit(`subagents:rpc:v1:reply:${data.requestId}`, {
        version: 1, requestId: data.requestId, success: true, data: { details: { asyncId: runId } },
      }));
    }
  }) as typeof state.pi.events.emit;
  const delegator = witnessedDagDelegator(state.pi);
  let assertions = 0;
  const first = await delegator.start({
    items: [{ id: "issue-73", issue: 73, title: "Seventy-three", summary: "Seventy-three", priority: 1, dependencies: [], claims: [], labels: [], affectedFiles: [], memberIssues: [73] }],
    maxParallel: 1,
    taskFor: (item: { issue: number }, _recovery: unknown, reason?: string) => {
      if (reason) adjudications.push(reason);
      return { agent: "forgedock-issue-worker", task: `Deliver issue #${item.issue}${reason ? ` adjudicate=${reason}` : ""}`, cwd: process.cwd() };
    },
    assertCompleted: async () => { if (++assertions === 1) throw new Error("verification repair budget exhausted"); },
    onComplete: () => undefined,
  });
  originalEmit("subagent:async-complete", { runId: "adjudication-run-1" });
  await first.completion;
  const durable = (delegator as any).runs.get(first.id).durableRecord;
  durable.status = "failed";
  const resumed = await delegator.resume(first.id, { adjudications: new Map([[73, "Clean worktree baseline repaired and independently checked."]]) });
  originalEmit("subagent:async-complete", { runId: "adjudication-run-2" });
  await resumed.completion;
  assert.deepEqual(adjudications, ["Clean worktree baseline repaired and independently checked."]);
  await delegator.shutdown();
});

test("forgedock tasks distinguishes durable DAG output from native process output", async () => {
  const state = fakePi();
  const tasks = state.tools.get("forgedock_tasks");
  assert.ok(tasks);
  const ctx = commandContext() as any;
  await assert.rejects(
    () => tasks.execute("unknown-dag", { action: "output", taskId: "dag_missing" }, undefined, undefined, ctx),
    /Unknown durable orchestration DAG.*native task_/,
  );
});

test("controller subprocess output streams before completion", async () => {
  const updates: string[] = [];
  const result = await executeController(
    process.execPath,
    ["-e", "process.stdout.write('first\\n'); setTimeout(() => process.stdout.write('second\\n'), 20)"],
    process.cwd(),
    undefined,
    (output) => updates.push(output),
  );
  assert.equal(result.code, 0);
  assert.match(result.stdout, /first/);
  assert.match(result.stdout, /second/);
  assert.ok(updates.some((output) => output.includes("first")));
  assert.ok(updates.some((output) => output.includes("second")));
});

test("controller subprocess does not inherit the invoking worker role", async () => {
  const previous = process.env.PI_SUBAGENT_CHILD_AGENT;
  process.env.PI_SUBAGENT_CHILD_AGENT = "forgedock-issue-worker";
  try {
    const result = await executeController(
      process.execPath,
      ["-e", "process.stdout.write(process.env.PI_SUBAGENT_CHILD_AGENT ?? 'clean')"],
      process.cwd(),
      undefined,
      () => undefined,
    );
    assert.equal(result.code, 0);
    assert.equal(result.stdout, "clean");
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
    else process.env.PI_SUBAGENT_CHILD_AGENT = previous;
  }
});

test("work-on rejects contradictory fresh-rerun and checkpoint-resume policies", async () => {
  const state = fakePi();
  const ctx = commandContext() as any;
  await state.handlers.get("session_start")?.[0]?.({}, ctx);
  const tool = state.tools.get("forgedock_work_on");
  assert.ok(tool);
  await assert.rejects(tool.execute("conflicting-recovery", { issue: 6, rerun: true, resume: true }, undefined, undefined, ctx), /mutually exclusive/);
});

test("work-on readiness failure prevents native task launch", async () => {
  const root = mkdtempSync(join(tmpdir(), "forgedock-readiness-no-launch-"));
  const repository = new InMemoryOrchestrationRepository();
  const state = fakePi(undefined, {
    orchestrationRepository: repository,
    orchestrationExecutionAdmission: new LeaseBackedOrchestrationExecutionAdmission(new InMemoryLeaseRepository()),
    dispatchReadinessCheck: async () => { throw new Error("aggregate readiness blocked"); },
  });
  const ctx = { ...commandContext(), cwd: root } as any;
  const tool = state.tools.get("forgedock_work_on");
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("blocked-before-launch", { issue: 20, background: true }, undefined, undefined, ctx),
    /aggregate readiness blocked/,
  );
  assert.equal(state.emitted.some(({ event }) => event === "subagents:rpc:v1:request"), false);
  assert.equal(existsSync(join(ctx.cwd, ".forgedock", "tasks")), false);
  rmSync(root, { recursive: true, force: true });
});

test("orchestration resume readiness failure prevents durable execution mutation", async () => {
  const repository = new InMemoryOrchestrationRepository();
  const timestamp = new Date(0).toISOString();
  await repository.createOrchestration({
    schema: "forgedock.orchestration/v1",
    orchestrationId: "dag_readiness_blocked",
    repository: "a/b",
    issueNumbers: [20],
    maxParallel: 1,
    autoMerge: true,
    executionAttempt: 1,
    status: "failed",
    createdAt: timestamp,
    updatedAt: timestamp,
    nodes: [{
      id: "issue-20", issue: 20, priority: 1, dependencies: [], claims: [],
      status: "failed", childRunIds: [], attempts: [],
    }],
  });
  const before = await repository.loadOrchestration("dag_readiness_blocked");
  const state = fakePi(undefined, {
    orchestrationRepository: repository,
    orchestrationExecutionAdmission: new LeaseBackedOrchestrationExecutionAdmission(new InMemoryLeaseRepository()),
    dispatchReadinessCheck: async () => { throw new Error("aggregate readiness blocked"); },
  });
  const tool = state.tools.get("forgedock_resume_orchestration");
  assert.ok(tool);
  await assert.rejects(
    () => tool.execute("blocked-resume", { orchestrationId: "dag_readiness_blocked" }, undefined, undefined, commandContext() as any),
    /aggregate readiness blocked/,
  );
  assert.deepEqual(await repository.loadOrchestration("dag_readiness_blocked"), before);
  assert.equal(state.emitted.some(({ event }) => event === "subagents:rpc:v1:request"), false);
});

test("direct work-on defaults to a native non-blocking controller task", async () => {
  const root = mkdtempSync(join(tmpdir(), "forgedock-tool-background-"));
  const entry = join(root, "controller.mjs");
  writeFileSync(entry, "setTimeout(() => console.log('controller done'), 50);\n");
  const state = fakePi();
  const ctx = { ...commandContext(), cwd: root, mode: "rpc" } as any;
  await state.handlers.get("session_start")?.[0]?.({}, ctx);
  const previous = process.env.FORGEDOCK_CONTROLLER_ENTRY;
  process.env.FORGEDOCK_CONTROLLER_ENTRY = entry;
  try {
    const tool = state.tools.get("forgedock_work_on");
    assert.ok(tool);
    const started = Date.now();
    const result = await tool.execute("background-work", { issue: 20 }, undefined, undefined, ctx);
    assert.ok(Date.now() - started < 1_000);
    const details = result.details as { taskId?: string; state?: string; args?: string[] };
    assert.equal(details.state, "delegated");
    assert.ok(details.args?.includes("--auto-merge"));
    assert.match(details.taskId ?? "", /^task_/);
    const persisted = JSON.parse(readFileSync(join(root, ".forgedock", "tasks", `${details.taskId}.json`), "utf8")) as { resumeScope?: string };
    assert.equal(persisted.resumeScope, "work-on");
    const tasks = state.tools.get("forgedock_tasks");
    assert.ok(tasks);
    for (let attempt = 0; attempt < 100; attempt++) {
      const listed = await tasks.execute("list", { action: "list" }, undefined, undefined, ctx);
      const records = (listed.details as { records: Array<{ id: string; status: string }> }).records;
      if (records.find((record) => record.id === details.taskId)?.status === "completed") break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const listed = await tasks.execute("list-final", { action: "list" }, undefined, undefined, ctx);
    assert.equal((listed.details as { records: Array<{ id: string; status: string }> }).records.find((record) => record.id === details.taskId)?.status, "completed");
  } finally {
    await shutdownFakePi(state, ctx);
    if (previous === undefined) delete process.env.FORGEDOCK_CONTROLLER_ENTRY;
    else process.env.FORGEDOCK_CONTROLLER_ENTRY = previous;
  }
});

test("background review and promotion tasks persist truthful restart scopes", async () => {
  const root = mkdtempSync(join(tmpdir(), "forgedock-tool-recovery-scope-"));
  const entry = join(root, "controller.mjs");
  writeFileSync(entry, "setTimeout(() => process.exit(0), 50);\n");
  const state = fakePi();
  const ctx = { ...commandContext(), cwd: root, mode: "rpc" } as any;
  await state.handlers.get("session_start")?.[0]?.({}, ctx);
  const previous = process.env.FORGEDOCK_CONTROLLER_ENTRY;
  process.env.FORGEDOCK_CONTROLLER_ENTRY = entry;
  const taskIds: string[] = [];
  try {
    for (const [toolName, params, expectedScope] of [
      ["forgedock_review_pr", { pullRequest: 21 }, "review-pr-rerun"],
      ["forgedock_promote", { production: true }, "promote"],
    ] as const) {
      const tool = state.tools.get(toolName);
      assert.ok(tool);
      const result = await tool.execute(`background-${toolName}`, params, undefined, undefined, ctx);
      const taskId = (result.details as { taskId?: string }).taskId;
      assert.ok(taskId);
      taskIds.push(taskId);
      const persisted = JSON.parse(readFileSync(join(root, ".forgedock", "tasks", `${taskId}.json`), "utf8")) as { resumeScope?: string };
      assert.equal(persisted.resumeScope, expectedScope);
    }
    const tasks = state.tools.get("forgedock_tasks");
    assert.ok(tasks);
    for (let attempt = 0; attempt < 100; attempt++) {
      const listed = await tasks.execute("recovery-scope-list", { action: "list" }, undefined, undefined, ctx);
      const records = (listed.details as { records: Array<{ id: string; status: string }> }).records;
      if (taskIds.every((id) => records.find((record) => record.id === id)?.status === "completed")) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  } finally {
    await shutdownFakePi(state, ctx);
    if (previous === undefined) delete process.env.FORGEDOCK_CONTROLLER_ENTRY;
    else process.env.FORGEDOCK_CONTROLLER_ENTRY = previous;
  }
});

test("missing reviewer probe paths remain evidence instead of failing the review process", () => {
  const state = fakePi();
  forgedockExtension(state.pi);
  const handler = state.handlers.get("tool_result")?.[0];
  assert.ok(handler);
  const previous = process.env.PI_SUBAGENT_CHILD_AGENT;
  process.env.PI_SUBAGENT_CHILD_AGENT = "forgedock-reviewer";
  try {
    const result = handler({
      toolName: "read",
      isError: true,
      content: [{ type: "text", text: "ENOENT: no such file or directory, access 'workflows/missing.yml'" }],
    });
    assert.deepEqual(result, {
      isError: false,
      content: [{ type: "text", text: "File does not exist at the requested path. Treat absence as review evidence and continue with ls/find rather than failing the review." }],
    });
    assert.equal(handler({ toolName: "read", isError: true, content: [{ type: "text", text: "EACCES: permission denied" }] }), undefined);
  } finally {
    if (previous === undefined) delete process.env.PI_SUBAGENT_CHILD_AGENT;
    else process.env.PI_SUBAGENT_CHILD_AGENT = previous;
  }
});

test("shell fallback cannot impose a wall-clock timeout on lifecycle controllers", () => {
  const state = fakePi();
  forgedockExtension(state.pi);
  const guard = state.handlers.get("tool_call")?.[0];
  assert.ok(guard);
  const blocked = guard({ toolName: "bash", input: { command: "node dist/cli/main.js work-on 6 --rerun" } });
  assert.deepEqual(blocked, {
    block: true,
    reason: "ForgeDock lifecycle controllers cannot be launched through the shell tool or bounded by its wall-clock timeout. Use the active semantic workflow, resume, task-status, or cancellation tool instead.",
  });
  assert.equal(guard({ toolName: "bash", input: { command: "node dist/cli/main.js status --issue 6" } }), undefined);
  assert.equal(guard({ toolName: "bash", input: { command: "gh pr create --head staging --base main" } }), undefined);
  assert.equal(guard({ toolName: "bash", input: { command: "npm test" } }), undefined);
  assert.equal(isLifecycleControllerShellCommand("forgedock-next orchestrate 6,7"), true);
  assert.equal(isLifecycleControllerShellCommand("npm run next -- work-on 6 --rerun"), true);
  assert.equal(isLifecycleControllerShellCommand("forgedock-next promote --from milestone/feature --confirm"), true);
});

test("fresh orchestration has no shell membership-discovery path and restores shell afterward", async () => {
  const state = fakePi();
  await state.handlers.get("session_start")?.[0]?.({}, jsonSessionContext());
  await state.commands.get("orchestrate")?.("all issues without a milestone", commandContext());
  assert.equal(state.active.includes("bash"), false);
  assert.equal(state.active.includes("forgedock_discover_orchestration"), true);
  const guard = state.handlers.get("tool_call")?.[0];
  assert.deepEqual(guard?.({ toolName: "bash", input: { command: "gh issue list --state open" } }), {
    block: true,
    reason: "Fresh ForgeDock orchestration membership must use forgedock_discover_orchestration; shell, gh, and Python discovery are unavailable in the active orchestration path.",
  });
  await state.handlers.get("message_start")?.[0]?.({
    message: { role: "custom", customType: FORGEDOCK_NATIVE_WORKFLOW_MESSAGE, details: { command: "orchestrate" } },
  });
  await state.handlers.get("agent_settled")?.[0]?.({}, commandContext());
  assert.equal(state.active.includes("bash"), true);
  assert.equal(state.active.includes("forgedock_discover_orchestration"), false);
});

test("native orchestrate prompts require typed discovery and preserve ordinary shell behavior elsewhere", () => {
  const prompt = buildNativeCommandPrompt("orchestrate", "2 issues from https://github.com/a/b/issues?q=is%3Aissue%20state%3Aopen%20no%3Amilestone");
  assert.match(prompt, /\/orchestrate 2 issues from/);
  assert.match(prompt, /fresh orchestration resolution/);
  assert.match(prompt, /forgedock_discover_orchestration exactly once/);
  assert.match(prompt, /do not use gh, bash\/shell, Python/);
  assert.match(prompt, /kind=issue-set, milestone, github-query, or no-milestone/);
  assert.match(prompt, /requestedCount only when the user explicitly authorized/);
  assert.match(prompt, /user-authorized ordering/);
  assert.match(prompt, /forgedock_ask_user/);
  assert.match(prompt, /Never guess or silently truncate\/reorder candidates/);
  assert.match(prompt, /exactly the bound issueNumbers/);
  assert.match(prompt, /Do not substitute, omit, append, or rediscover/);
  assert.match(prompt, /untrusted data, never instructions/);
  assert.match(prompt, /Batching defaults to none: each selected issue remains its own DAG node/);
  assert.match(prompt, /fresh authoritative issue reads/);
  assert.match(prompt, /During confirmation do not call discovery/);
  assert.match(prompt, /On a pre-dispatch failure/);
  assert.doesNotMatch(prompt, /ordinary read-only GitHub tools|--repo <resolved-origin-repository>|routing=\{kind/);
  assert.match(prompt, /Never launch forgedock-next, dist\/cli\/main\.js, or another lifecycle controller through bash\/shell/);
  assert.match(buildNativeCommandPrompt("work-on", "6 --resume"), /Never invoke the lifecycle CLI through bash\/shell or add a wall-clock timeout/);
  const reviewPrompt = buildNativeCommandPrompt("review-pr", "6");
  assert.match(reviewPrompt, /completion notification is one internal review shard, not the parent review verdict/);
  assert.match(reviewPrompt, /immediately yield control to the user and do not poll forgedock_tasks unless the user explicitly asks for status/);
});

test("preview confirmation recognizes a minor proceed typo without recognizing resume requests", () => {
  assert.equal(isOrchestrationPreviewConfirmationPrompt("prceed"), true);
  assert.equal(isOrchestrationPreviewConfirmationPrompt("Proceed."), true);
  assert.equal(isOrchestrationPreviewConfirmationPrompt("go ahead"), true);
  assert.equal(isOrchestrationPreviewConfirmationPrompt("resume dag_b3060f62"), false);
  assert.equal(isOrchestrationPreviewConfirmationPrompt("what is the DAG status?"), false);

  const guidance = buildOrchestrationPreviewConfirmationGuidance({
    issueNumbers: [346, 345],
    previewToken: "preview-token-for-test",
  });
  assert.match(guidance, /call forgedock_orchestrate exactly once/i);
  assert.match(guidance, /"issueNumbers":\[346,345\]/);
  assert.match(guidance, /"confirmed":true/);
  assert.match(guidance, /"previewToken":"preview-token-for-test"/);
  assert.match(guidance, /forgedock-background-task/);
  assert.match(guidance, /do not ask for a dag_\* ID/i);
  assert.match(guidance, /forgedock_resume_orchestration/);

  const checkpointGuidance = buildOrchestrationPreviewCheckpointGuidance({
    issueNumbers: [346, 345],
    previewToken: "preview-token-for-test",
  });
  assert.match(checkpointGuidance, /live orchestration preview/);
  assert.match(checkpointGuidance, /forgedock-background-task/);
  assert.match(checkpointGuidance, /do not dispatch or resume anything/i);
});

test("explicit orchestration resume routes directly to the durable resume tool", async () => {
  const orchestrationId = "dag_cd83f20b-7670-4be3-984c-63f20a77a72f";
  const prompt = buildNativeCommandPrompt("orchestrate", `resume ${orchestrationId}`);
  assert.match(prompt, new RegExp(`Call forgedock_resume_orchestration exactly once with orchestrationId="${orchestrationId}"`));
  assert.match(prompt, /Do not perform repository, filesystem, issue, or GitHub discovery/);
  assert.doesNotMatch(prompt, /natural-language intent routing|GitHub tools to resolve/);
  assert.match(prompt, /Do not call forgedock_orchestrate/);

  const state = fakePi();
  forgedockExtension(state.pi);
  await state.commands.get("orchestrate")?.(`resume ${orchestrationId}`, commandContext());
  assert.deepEqual(state.active, ["read", "bash", "forgedock_resume_orchestration"]);
  assert.match(state.sent.at(-1)?.content ?? "", /durable controller state is authoritative/);
  assert.doesNotThrow(() => bindOrchestrationInvocation(state.pi, { rawArgs: "another fresh request" }));
});

test("typed orchestration derives bounded authoritative plan metadata", () => {
  const body = [
    "**Source:** PR #186 — staging review",
    "<!-- FORGE:CLASS: scheduler-claim -->",
    "",
    "## Dependencies",
    "- Requires #214 and #999.",
    "- Also blocked by #228.",
    "",
    "## Evidence",
    "An unrelated mention of #230 is not dependency authority.",
  ].join("\n");

  assert.equal(priorityFromIssueLabels(["review-finding", "priority:P2"]), 200);
  assert.equal(priorityFromIssueLabels([]), 400);
  assert.equal(sourcePullRequestFromIssueBody(body), 186);
  assert.equal(defectClassFromIssueBody(body), "scheduler-claim");
  assert.deepEqual(dependencyIssueNumbersFromBody(body, new Set([214, 228, 230])), [214, 228]);
});

test("complete GitHub queries replace decomposed parents with authoritative children", async () => {
  const outcome = createArtifact({
    kind: "Outcome",
    runId: "run-decomposed-query",
    subject: { repo: "a/b", issue: 7 },
    producer: { role: "controller", runtime: "forgedock" },
    payload: { status: "decomposed", reason: "Split work", childIssues: ["#110 — First child", "#111 — Second child"] },
  });
  const issueReads = new Map<number, number>();
  const scope = await resolveRoutedOrchestrationScope(
    "https://github.com/a/b/issues?q=is%3Aissue%20state%3Aopen%20no%3Amilestone",
    { kind: "github-query", rationale: "Complete open no-milestone query", noMilestone: true, repository: "a/b" },
    [7, 8, 110, 111],
    {
      async getRepository() { return { repo: "a/b", defaultBranch: "main" }; },
      async getMilestone(number) { return { number, title: "unused", state: "open" as const }; },
      async listOpenIssueNumbersForMilestone() { return []; },
      async listOpenIssueNumbersForSearch() { return [7, 8, 110, 111]; },
      async getIssue(number) {
        issueReads.set(number, (issueReads.get(number) ?? 0) + 1);
        if (number === 7) return { number, state: "OPEN" as const, labels: ["workflow:decomposed"], comments: [{ body: renderArtifactComment(outcome) }] };
        return { number, state: "OPEN" as const, labels: [], comments: [] };
      },
    },
  );
  assert.deepEqual(scope.issueNumbers, [8, 110, 111]);
  assert.equal(scope.noMilestone, true);
  assert.deepEqual(scope.decomposedReplacements, [{ parent: 7, children: [110, 111] }]);
  assert.deepEqual([...issueReads.entries()].sort(([left], [right]) => left - right), [[7, 1], [8, 1], [110, 1], [111, 1]]);
});

test("query revalidation accepts authoritative decomposition children outside raw query membership", async () => {
  const outcome = createArtifact({
    kind: "Outcome",
    runId: "run-decomposed-query-closure",
    subject: { repo: "a/b", issue: 7 },
    producer: { role: "controller", runtime: "forgedock" },
    payload: { status: "decomposed", reason: "Split work", childIssues: ["#8 — Child"] },
  });
  const scope = await resolveRoutedOrchestrationScope(
    "https://github.com/a/b/issues?q=label%3Abug",
    { kind: "github-query", rationale: "Exact bug query", query: "label:bug", repository: "a/b" },
    [8],
    {
      async getRepository() { return { repo: "a/b", defaultBranch: "main" }; },
      async getMilestone(number) { return { number, title: "unused", state: "open" as const }; },
      async listOpenIssueNumbersForMilestone() { return []; },
      async listOpenIssueNumbersForSearch() { return [7]; },
      async getIssue(number) {
        return number === 7
          ? { number, state: "OPEN" as const, labels: ["workflow:decomposed"], comments: [{ body: renderArtifactComment(outcome) }] }
          : { number, state: "OPEN" as const, labels: [], comments: [] };
      },
    },
  );
  assert.deepEqual(scope.issueNumbers, [8]);
  assert.deepEqual(scope.decomposedReplacements, [{ parent: 7, children: [8] }]);
});

test("milestone and direct scopes expose decomposed replacements for plan rebinding", async () => {
  const outcome = createArtifact({
    kind: "Outcome",
    runId: "run-decomposed-rebind",
    subject: { repo: "a/b", issue: 7 },
    producer: { role: "controller", runtime: "forgedock" },
    payload: { status: "decomposed", reason: "Split work", childIssues: ["#110 — First child", "#111 — Second child"] },
  });
  const host = {
    async getRepository() { return { repo: "a/b", defaultBranch: "main" }; },
    async getMilestone(number: number) { return { number, title: "Milestone One", state: "open" as const }; },
    async listOpenIssueNumbersForMilestone() { return [7, 110, 111]; },
    async getIssue(number: number) {
      return number === 7
        ? { number, state: "OPEN" as const, labels: ["workflow:decomposed"], milestone: { number: 1, title: "Milestone One" }, comments: [{ body: renderArtifactComment(outcome) }] }
        : { number, state: "OPEN" as const, labels: [], milestone: { number: 1, title: "Milestone One" }, comments: [] };
    },
  };
  const milestone = await resolveOrchestrationInvocationScope("Milestone One", process.cwd(), host);
  assert.deepEqual(milestone.issueNumbers, [110, 111]);
  assert.deepEqual(milestone.decomposedReplacements, [{ parent: 7, children: [110, 111] }]);
  const direct = await resolveOrchestrationInvocationScope("7", process.cwd(), host);
  assert.deepEqual(direct.issueNumbers, [110, 111]);
  assert.deepEqual(direct.decomposedReplacements, [{ parent: 7, children: [110, 111] }]);
});

test("routed decomposed replacements rebind parent plan entries to child issues", async () => {
  const outcome = createArtifact({
    kind: "Outcome",
    runId: "run-decomposed-plan",
    subject: { repo: "a/b", issue: 7 },
    producer: { role: "controller", runtime: "forgedock" },
    payload: { status: "decomposed", reason: "Split work", childIssues: ["#110 — First child", "#111 — Second child"] },
  });
  const scope = await resolveRoutedOrchestrationScope(
    "https://github.com/a/b/issues?q=is%3Aissue%20state%3Aopen%20no%3Amilestone",
    { kind: "github-query", rationale: "Complete open no-milestone query", noMilestone: true, repository: "a/b" },
    [7, 8, 110, 111],
    {
      async getRepository() { return { repo: "a/b", defaultBranch: "main" }; },
      async getMilestone(number) { return { number, title: "unused", state: "open" as const }; },
      async listOpenIssueNumbersForMilestone() { return []; },
      async listOpenIssueNumbersForSearch() { return [7, 8, 110, 111]; },
      async getIssue(number) {
        if (number === 7) return { number, state: "OPEN" as const, labels: ["workflow:decomposed"], comments: [{ body: renderArtifactComment(outcome) }] };
        return { number, state: "OPEN" as const, labels: [], comments: [] };
      },
    },
  );
  assert.deepEqual(scope.issueNumbers, [8, 110, 111]);
  assert.deepEqual(scope.decomposedReplacements, [{ parent: 7, children: [110, 111] }]);
});

test("LLM-routed GitHub issue URLs resolve natural-language count and membership", async () => {
  const calls: Array<{ query: string; repo?: string }> = [];
  const scope = await resolveRoutedOrchestrationScope(
    "2 issues from https://github.com/a/b/issues?q=is%3Aissue%20state%3Aopen%20no%3Amilestone",
    {
      kind: "github-query",
      rationale: "The URL is an issue search; its decoded query is open issues without a milestone.",
      requestedCount: 2,
      noMilestone: true,
      repository: "a/b",
    },
    [8, 7],
    {
      async getRepository() { return { repo: "a/b", defaultBranch: "main" }; },
      async getMilestone(number) { return { number, title: "unused", state: "open" as const }; },
      async listOpenIssueNumbersForMilestone() { return []; },
      async listOpenIssueNumbersForSearch(query, repo) {
        calls.push({ query, ...(repo ? { repo } : {}) });
        return [7, 8, 9];
      },
      async getIssue(number) { return { number, state: "OPEN" as const }; },
    },
  );
  assert.deepEqual(scope, {
    rawArgs: "2 issues from https://github.com/a/b/issues?q=is%3Aissue%20state%3Aopen%20no%3Amilestone",
    issueNumbers: [7, 8],
    repository: "a/b",
    defaultBranch: "main",
    noMilestone: true,
  });
  assert.deepEqual(calls, [{ query: "is:issue state:open no:milestone", repo: "a/b" }]);
});

test("controller leaves prose issue interpretation to the routed model", async () => {
  const calls: Array<{ number: number; repo?: string }> = [];
  const scope = await resolveRoutedOrchestrationScope(
    "148 and 149 from https://github.com/a/b/issues",
    {
      kind: "natural-language",
      rationale: "Read-only GitHub inspection confirmed that the user's prose names two open issues in the checkout repository.",
      requestedCount: 2,
      repository: "a/b",
    },
    [149, 148],
    {
      async getRepository() { return { repo: "a/b", defaultBranch: "main" }; },
      async getMilestone(number) { return { number, title: "unused", state: "open" as const }; },
      async listOpenIssueNumbersForMilestone() { return []; },
      async listOpenIssueNumbersForSearch() { throw new Error("a URL without q= must not synthesize a search"); },
      async getIssue(number, repo) {
        calls.push({ number, ...(repo ? { repo } : {}) });
        return { number, state: "OPEN" as const };
      },
    },
  );
  assert.deepEqual(scope, {
    rawArgs: "148 and 149 from https://github.com/a/b/issues",
    issueNumbers: [148, 149],
    repository: "a/b",
    defaultBranch: "main",
    noMilestone: true,
  });
  assert.deepEqual(calls, [{ number: 148, repo: "a/b" }, { number: 149, repo: "a/b" }]);
});

test("LLM-routed natural language rejects issue substitution and milestone drift", async () => {
  await assert.rejects(() => resolveRoutedOrchestrationScope(
    "two issues without a milestone",
    { kind: "natural-language", rationale: "The user requested two unmilestoned issues.", requestedCount: 2, noMilestone: true },
    [7, 8],
    {
      async getRepository() { return { repo: "a/b", defaultBranch: "main" }; },
      async getMilestone(number) { return { number, title: "unused", state: "open" as const }; },
      async listOpenIssueNumbersForMilestone() { return []; },
      async getIssue(number) {
        return { number, state: "OPEN" as const, ...(number === 8 ? { milestone: { number: 1, title: "wrong-lane" } } : {}) };
      },
    },
  ), /must have no milestone/);
});

test("orchestration scope resolution still supports an exact milestone fast path", async () => {
  const calls: string[] = [];
  const scope = await resolveOrchestrationInvocationScope("throwaway-milestone --auto", process.cwd(), {
    async getRepository() { return { repo: "a/b", defaultBranch: "main" }; },
    async getMilestone(number) { return { number, title: "throwaway-milestone", state: "open" as const }; },
    async getIssue(number) { return { number, state: "OPEN" as const, milestone: { number: 1, title: "throwaway-milestone" } }; },
    async listOpenIssueNumbersForMilestone(title) { calls.push(title); return [129]; },
  });
  assert.deepEqual(scope, {
    rawArgs: "throwaway-milestone --auto",
    issueNumbers: [129],
    repository: "a/b",
    defaultBranch: "main",
    milestone: "throwaway-milestone",
    noMilestone: false,
  });
  assert.deepEqual(calls, ["throwaway-milestone"]);
});

test("orchestration scope resolves a GitHub milestone URL before selecting open members", async () => {
  const calls: Array<string | number> = [];
  const scope = await resolveOrchestrationInvocationScope("https://github.com/a/b/milestone/1", process.cwd(), {
    async getRepository() { return { repo: "a/b", defaultBranch: "main" }; },
    async getMilestone(number) { calls.push(number); return { number, title: "Milestone One", state: "open" as const }; },
    async getIssue(number) { return { number, state: "OPEN" as const, milestone: { number: 1, title: "Milestone One" } }; },
    async listOpenIssueNumbersForMilestone(title) { calls.push(title); return [7, 8]; },
  });
  assert.deepEqual(scope, {
    rawArgs: "https://github.com/a/b/milestone/1",
    issueNumbers: [7, 8],
    repository: "a/b",
    defaultBranch: "main",
    milestone: "Milestone One",
    noMilestone: false,
  });
  assert.deepEqual(calls, [1, "Milestone One"]);
});

test("TUI issue discovery bounds 500 GitHub reads while preserving scope order", async () => {
  const issueNumbers = Array.from({ length: 500 }, (_, index) => index + 1);
  let inFlight = 0;
  let maxInFlight = 0;
  const scope = await resolveOrchestrationInvocationScope(issueNumbers.join(" "), process.cwd(), {
    async getRepository() { return { repo: "a/b", defaultBranch: "main" }; },
    async getMilestone(number) { return { number, title: "unused", state: "open" as const }; },
    async listOpenIssueNumbersForMilestone() { return []; },
    async getIssue(number) {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((resolve) => setTimeout(resolve, number % 2));
      inFlight -= 1;
      return { number, state: "OPEN" as const };
    },
  });
  assert.equal(maxInFlight, DEFAULT_REMOTE_READ_CONCURRENCY);
  assert.equal(inFlight, 0);
  assert.deepEqual(scope.issueNumbers, issueNumbers);
});

test("milestone scope replaces an authoritative decomposed parent with same-milestone children", async () => {
  const outcome = createArtifact({
    kind: "Outcome",
    runId: "run-decomposed",
    subject: { repo: "a/b", issue: 7 },
    producer: { role: "controller", runtime: "forgedock" },
    payload: {
      status: "decomposed",
      reason: "Split into independently verifiable work",
      childIssues: ["#110 — First child (https://github.test/a/b/issues/110)", "#111 — Second child (https://github.test/a/b/issues/111)"],
    },
  });
  const scope = await resolveOrchestrationInvocationScope("Milestone One", process.cwd(), {
    async getRepository() { return { repo: "a/b", defaultBranch: "main" }; },
    async getMilestone(number) { return { number, title: "Milestone One", state: "open" as const }; },
    async getIssue(number) {
      return number === 7
        ? { number, state: "OPEN" as const, labels: ["workflow:decomposed"], milestone: { number: 1, title: "Milestone One" }, comments: [{ body: renderArtifactComment(outcome) }] }
        : { number, state: "OPEN" as const, labels: number === 110 ? ["needs-human"] : [], milestone: { number: 1, title: "Milestone One" }, comments: [] };
    },
    async listOpenIssueNumbersForMilestone() { return [7, 8, 110, 111]; },
  });
  assert.deepEqual(scope.issueNumbers, [8, 110, 111]);
});

test("milestone scope fails closed when a decomposition child is outside the bound milestone", async () => {
  const outcome = createArtifact({
    kind: "Outcome",
    runId: "run-decomposed",
    subject: { repo: "a/b", issue: 7 },
    producer: { role: "controller", runtime: "forgedock" },
    payload: { status: "decomposed", reason: "Split work", childIssues: ["#110 — Child"] },
  });
  await assert.rejects(() => resolveOrchestrationInvocationScope("Milestone One", process.cwd(), {
    async getRepository() { return { repo: "a/b", defaultBranch: "main" }; },
    async getMilestone(number) { return { number, title: "Milestone One", state: "open" as const }; },
    async getIssue(number) {
      return number === 7
        ? { number, state: "OPEN" as const, labels: ["workflow:decomposed"], milestone: { number: 1, title: "Milestone One" }, comments: [{ body: renderArtifactComment(outcome) }] }
        : { number, state: "OPEN" as const, labels: [], comments: [] };
    },
    async listOpenIssueNumbersForMilestone() { return [7]; },
  }), /#110 is not assigned to milestone 'Milestone One'/);
});

test("orchestration tool rejects source-issue substitution before dispatch", async () => {
  const state = fakePi();
  const tool = state.tools.get("forgedock_orchestrate");
  assert.ok(tool);
  bindOrchestrationInvocation(state.pi, {
    rawArgs: "throwaway-milestone",
    issueNumbers: [129],
    milestone: "throwaway-milestone",
    noMilestone: false,
  });
  await assert.rejects(() => tool.execute("substitution", {
    issueNumbers: [110],
    executionPlan: [{ issue: 110, title: "Source", summary: "Wrong source issue", dependsOn: [], claims: ["src"], labels: [] }],
    milestone: "throwaway-milestone",
    dryRun: true,
  }, undefined, undefined, commandContext() as any), /issue substitution rejected.*#129.*#110/);
});
