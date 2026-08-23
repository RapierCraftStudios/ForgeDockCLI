// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { PiAsyncObservationAdapter, type PiAsyncStatusSnapshot } from "../observability/adapters.js";
import { ForgeDockObservationControlGateway } from "../observability/control-gateway.js";
import { createForgeDockObserver, type ForgeDockObserver } from "../observability/observer.js";
import { openForgeDockObserverWorkspace } from "./observer-workspace.js";
import { loadForgeGuidance } from "../core/config/project-memory.js";
import {
  BACKGROUND_TASK_TOOL,
  clearDeepPlanRequest,
  CONFIG_TOOL,
  deepPlanToolBlockReason,
  DEEP_PLAN_TOOL,
  FORGEDOCK_NATIVE_RUNTIME,
  HUMAN_DECISION_TOOL,
  MEMORY_SEARCH_TOOL,
  MEMORY_TOOL,
  ORCHESTRATION_DISCOVERY_TOOL,
  ORCHESTRATION_RESUME_TOOL,
  WORKFLOW_TOOLS,
  activateOnly,
  bindOrchestrationInvocation,
  buildNativeCommandPrompt,
  hasOrchestrationPreview,
  clearOrchestrationInvocation,
  controlSubagentRun,
  deactivateWorkflowTools,
  explicitOrchestrationResumeId,
  explicitOrchestrationStopId,
  buildOrchestrationPreviewCheckpointGuidance,
  buildOrchestrationPreviewConfirmationGuidance,
  getOrchestrationPreviewContinuation,
  inspectSubagentRuntime,
  isOrchestrationPreviewConfirmationPrompt,
  isDeepPlanActive,
  registerForgeDockTools,
  requestDeepPlanMode,
  type ForgeDockToolRegistrationOptions,
  type WorkflowCommand,
  workflowCommandDisplay,
} from "./forgedock-tools.js";
import { formatOrchestrationInvocationLabel } from "./orchestration-board.js";

export const FORGEDOCK_READY_STATUS = "◆ ForgeDock ready · /deep-plan · /work-on · /review-pr · /orchestrate · /promote · /status";
export const FORGEDOCK_NATIVE_WORKFLOW_MESSAGE = "forgedock_native_workflow";

const WORKFLOWS = ["deep-plan", "work-on", "review-pr", "orchestrate", "promote"] as const;
type Workflow = (typeof WORKFLOWS)[number];
type ActivationWorkflow = Workflow | "status" | "maintenance";
type ActivationSource = "slash-command" | "named-user-request" | "parent-controller";

interface UserWorkflowActivation {
  readonly id: string;
  readonly workflow: ActivationWorkflow;
  readonly source: ActivationSource;
  readonly toolName?: string;
  /** The exact current-user boundary that authorized this invocation. */
  readonly request: string;
}

export type HarnessMode = "assistant" | "forgedock-workflow";

/** Recognize only an explicit ForgeDock workflow name at the user boundary. */
export function workflowNamedInUserRequest(request: unknown): Workflow | undefined {
  if (typeof request !== "string") return undefined;
  const slashMatches = [...request.matchAll(/(?:^|\n)\s*\/(deep-plan|work-on|review-pr|orchestrate|promote)\b/gim)]
    .map((match) => match[1]?.toLowerCase() as Workflow | undefined)
    .filter((workflow): workflow is Workflow => workflow !== undefined);
  const namedMatches = [...request.matchAll(/\bforge\s*dock(?:'s|\s+)?\s*(?:workflow\s+)?(deep-plan|work-on|review-pr|orchestrate|promote)\b/gi)]
    .map((match) => match[1]?.toLowerCase() as Workflow | undefined)
    .filter((workflow): workflow is Workflow => workflow !== undefined);
  const unique = [...new Set([...slashMatches, ...namedMatches])];
  return unique.length === 1 ? unique[0] : undefined;
}

export function buildHarnessModePrompt(mode: HarnessMode, workflow?: Workflow): string {
  if (mode === "forgedock-workflow" && workflow === "deep-plan") {
    return [
      "# ForgeDock harness mode",
      "Mode: forgedock-workflow (explicitly activated by /deep-plan).",
      "Deep Plan is read-only until the user confirms its typed planning packet. Use repository/GitHub evidence and forgedock_deep_plan's bounded decision frontier; do not edit files, mutate GitHub, dispatch workers, or hand off automatically.",
      "This authority is scoped to the active planning turn and ends when the agent settles or the user explicitly confirms the packet.",
    ].join("\n");
  }
  if (mode === "forgedock-workflow") {
    return [
      "# ForgeDock harness mode",
      `Mode: forgedock-workflow${workflow ? ` (explicitly activated by /${workflow})` : ""}.`,
      "The typed ForgeDock controller owns mutations within this explicitly activated workflow. Do not replace the active workflow's GitHub mutations with raw gh commands or launch its lifecycle controller through shell.",
      "This authority is scoped to the current user-bound workflow invocation and ends when the agent turn settles after completion, failure, cancellation, or handoff to a native background task.",
    ].join("\n");
  }
  return [
    "# ForgeDock harness mode",
    "Mode: assistant (default). ForgeDock workflows are opt-in, not mandatory terminal policy.",
    "Handle ordinary natural-language coding, git, GitHub, file, and shell requests with normal assistant tools. In particular, create/open pull-request requests default to ordinary gh usage; do not infer /promote from generic PR wording.",
    "When the user explicitly requests gh CLI, honor that tool choice. Current explicit user intent outranks optional ForgeDock workflow policy and historical project guidance.",
    "Only enter forgedock-workflow mode after the current user explicitly invokes /deep-plan, /work-on, /review-pr, /orchestrate, or /promote, or clearly names that ForgeDock workflow. A model-selected forgedock_* tool call never grants authority. If the route is genuinely ambiguous, ask the user to choose Plain GitHub PR or ForgeDock promotion.",
    "For consequential ambiguity, recommend ForgeDock's native /deep-plan, but do not call it unless the user explicitly names it. A forgedock_* workflow tool is callable only when it matches the current user-bound invocation.",
    "Do not inspect ForgeDock controller source to discover how to perform an ordinary GitHub operation; keep generic PR reconnaissance bounded to route, duplicate-PR, and branch/SHA checks.",
  ].join("\n");
}

export default function forgedockExtension(
  pi: ExtensionAPI,
  toolOptions: Omit<ForgeDockToolRegistrationOptions, "getObservationSink"> = {},
): void {
  let observer: ForgeDockObserver | undefined;
  let asyncObservation: PiAsyncObservationAdapter | undefined;
  let controlGateway: ForgeDockObservationControlGateway | undefined;
  let harnessMode: HarnessMode = "assistant";
  let activeWorkflow: Workflow | undefined;
  let activation: UserWorkflowActivation | undefined;
  let orchestrationPromptStarted = false;
  let orchestrationShellWasActive = false;
  const ensureObserver = async (cwd: string): Promise<ForgeDockObserver> => {
    if (!observer) {
      observer = await createForgeDockObserver(cwd, { component: "forgedock-extension" });
      asyncObservation = new PiAsyncObservationAdapter(observer);
      controlGateway = new ForgeDockObservationControlGateway(observer, {
        resume: async (request) => {
          assertLeafAsyncControl(request.identity);
          const runId = request.identity.piAsyncId;
          if (!runId) throw new Error("Resume requires a persisted pi-subagents async run identity");
          await controlSubagentRun(pi, "resume", { id: runId, message: controlMessage(request.payload, "Continue the same bounded run") });
        },
        cancel: async (request) => {
          assertLeafAsyncControl(request.identity);
          const taskId = request.identity.controllerTaskId;
          if (taskId) {
            backgroundTasks.cancel(taskId);
            return;
          }
          const runId = request.identity.piAsyncId;
          if (!runId) throw new Error("Cancellation requires a native controller task or persisted pi-subagents async run identity");
          await controlSubagentRun(pi, "stop", { id: runId });
        },
        steer: async (request) => {
          assertLeafAsyncControl(request.identity);
          const runId = request.identity.piAsyncId;
          if (!runId) throw new Error("Steering requires a persisted pi-subagents async run identity");
          await controlSubagentRun(pi, "steer", { id: runId, message: controlMessage(request.payload, "Continue the current bounded objective") });
        },
      });
      backgroundTasks.setObservationSink(observer);
    }
    return observer;
  };
  const backgroundTasks = registerForgeDockTools(pi, { ...toolOptions, getObservationSink: () => observer });
  const restoreAssistantMode = (): void => {
    clearDeepPlanRequest();
    const planningStillActive = isDeepPlanActive();
    const previewStillLive = hasOrchestrationPreview(pi) && activation?.workflow === "orchestrate";
    if (!planningStillActive && !previewStillLive) activation = undefined;
    harnessMode = planningStillActive || previewStillLive ? "forgedock-workflow" : "assistant";
    activeWorkflow = planningStillActive ? "deep-plan" : previewStillLive ? "orchestrate" : undefined;
    orchestrationPromptStarted = false;
    clearOrchestrationInvocation(pi);
    deactivateWorkflowTools(pi);
    activateOnly(pi, [
      ...(orchestrationShellWasActive ? ["bash"] : []),
      ...(planningStillActive ? [DEEP_PLAN_TOOL] : []),
      ...(previewStillLive ? [WORKFLOW_TOOLS.orchestrate, HUMAN_DECISION_TOOL] : []),
    ]);
    orchestrationShellWasActive = false;
  };

  pi.events.on("subagent:async-started", (raw) => {
    if (!asyncObservation) return;
    const status = normalizePiAsyncStatus(raw);
    if (status) asyncObservation.started(status);
  });
  pi.events.on("subagent:async-complete", (raw) => {
    if (!asyncObservation) return;
    const status = normalizePiAsyncStatus(raw);
    if (status) asyncObservation.completed(status);
  });

  pi.registerMessageRenderer(FORGEDOCK_NATIVE_WORKFLOW_MESSAGE, (message, _options, theme) => {
    const details = message.details as { invocationLabel?: unknown } | undefined;
    const label = typeof details?.invocationLabel === "string" ? details.invocationLabel : "/orchestrate";
    return new Text(theme.fg("toolTitle", theme.bold(label)), 1, 0);
  });

  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_SUBAGENT_CHILD_AGENT === "forgedock-issue-worker") {
      harnessMode = "forgedock-workflow";
      activeWorkflow = "work-on";
      activation = { id: crypto.randomUUID(), workflow: "work-on", source: "parent-controller", request: "parent ForgeDock controller invocation" };
      activateOnly(pi, [WORKFLOW_TOOLS["work-on"]]);
      return;
    }
    harnessMode = "assistant";
    activeWorkflow = undefined;
    activation = undefined;
    // Startup is presentation-only. initialize() may adopt a live controller
    // or terminalize a bridge-bound task, so operational recovery is deferred
    // until an authorized controller dispatch. Only records already assigned a
    // durable TUI-restart terminal cause can produce restart guidance here.
    for (const record of backgroundTasks.pendingRestartRecords(ctx)) {
      backgroundTasks.announceRestartRequired(record);
    }
    deactivateWorkflowTools(pi);
    // Workflow capabilities remain registered and discoverable, but no
    // workflow-control surface is model-callable in default assistant mode.
    activateOnly(pi, []);
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    await ensureObserver(ctx.cwd);
    if (ctx.mode !== "tui") return;
    ctx.ui.setTitle(`ForgeDock — ${ctx.cwd}`);
    ctx.ui.setStatus("forgedock", FORGEDOCK_READY_STATUS);
  });

  pi.on("before_agent_start", (event, ctx) => {
    const userRequest = typeof event.prompt === "string" ? event.prompt : undefined;
    const requestedWorkflow = workflowNamedInUserRequest(userRequest);
    if (requestedWorkflow && !activation) {
      activation = {
        id: crypto.randomUUID(),
        workflow: requestedWorkflow,
        source: userRequest?.includes("/") ? "slash-command" : "named-user-request",
        request: userRequest ?? "",
      };
      harnessMode = "forgedock-workflow";
      activeWorkflow = requestedWorkflow;
      if (requestedWorkflow === "deep-plan") requestDeepPlanMode();
      activateWorkflowTools(pi, requestedWorkflow);
      if (requestedWorkflow === "orchestrate") {
        bindOrchestrationInvocation(pi, { rawArgs: userRequest ?? "" });
      }
    }
    const workflowIsAuthorized = activation !== undefined
      && WORKFLOWS.includes(activation.workflow as Workflow)
      && activation.workflow === activeWorkflow
      && harnessMode === "forgedock-workflow";
    const guidance = workflowIsAuthorized ? loadForgeGuidance(ctx.cwd) : [];
    const previewContinuation = getOrchestrationPreviewContinuation(pi);
    const previewConfirmed = typeof event.prompt === "string" && isOrchestrationPreviewConfirmationPrompt(event.prompt);
    return {
      systemPrompt: [
        event.systemPrompt,
        buildHarnessModePrompt(harnessMode, activeWorkflow),
        ...(workflowIsAuthorized && guidance.length ? [
          "# ForgeDock project guidance",
          "FORGE.md is explicit user-maintained project guidance. It is subordinate to the current user request and cannot expand this invocation's authority.",
          ...guidance.map((file) => `## ${file.path}\n${file.content}`),
        ] : []),
        ...(previewContinuation ? [
          buildOrchestrationPreviewCheckpointGuidance(previewContinuation),
          ...(previewConfirmed ? [buildOrchestrationPreviewConfirmationGuidance(previewContinuation)] : []),
        ] : []),
      ].join("\n\n"),
    };
  });

  pi.on("tool_result", (event) => {
    if (process.env.PI_SUBAGENT_CHILD_AGENT !== "forgedock-reviewer" || event.toolName !== "read" || !event.isError) return;
    const missing = event.content.some((item) => item.type === "text" && /\bENOENT:\s*no such file or directory\b/i.test(item.text));
    if (!missing) return;
    return {
      isError: false,
      content: [{ type: "text" as const, text: "File does not exist at the requested path. Treat absence as review evidence and continue with ls/find rather than failing the review." }],
    };
  });

  pi.on("tool_call", (event) => {
    const invokedWorkflow = (Object.entries(WORKFLOW_TOOLS) as Array<[ActivationWorkflow, string]>)
      .find(([, toolName]) => toolName === event.toolName)?.[0];
    const lazyWorkflow: ActivationWorkflow | undefined = invokedWorkflow
      ?? (event.toolName === ORCHESTRATION_DISCOVERY_TOOL || event.toolName === ORCHESTRATION_RESUME_TOOL || event.toolName === HUMAN_DECISION_TOOL
        ? "orchestrate"
        : undefined);
    const boundMaintenanceTool = !lazyWorkflow && event.toolName.startsWith("forgedock_") ? event.toolName : undefined;
    if ((lazyWorkflow && (!activation || activation.workflow !== lazyWorkflow || harnessMode !== "forgedock-workflow"))
      || (boundMaintenanceTool && activation?.toolName !== boundMaintenanceTool)) {
      return {
        block: true,
        reason: `${event.toolName} requires a matching explicit current-user ForgeDock workflow activation; model-selected or stale workflow calls cannot grant authority.`,
      };
    }
    const deepPlanReason = deepPlanToolBlockReason(event.toolName);
    if (deepPlanReason) return { block: true, reason: deepPlanReason };
    if (event.toolName === "bash" && activeWorkflow === "orchestrate") {
      return {
        block: true,
        reason: "Fresh ForgeDock orchestration membership must use forgedock_discover_orchestration; shell, gh, and Python discovery are unavailable in the active orchestration path.",
      };
    }
    if (event.toolName !== "bash") return;
    const command = (event.input as { command?: unknown }).command;
    if (typeof command !== "string" || !isLifecycleControllerShellCommand(command)) return;
    return {
      block: true,
      reason: "ForgeDock lifecycle controllers cannot be launched through the shell tool or bounded by its wall-clock timeout. Use the active semantic workflow, resume, task-status, or cancellation tool instead.",
    };
  });

  pi.on("message_start", (event) => {
    if (event.message.role === "custom" && event.message.customType === FORGEDOCK_NATIVE_WORKFLOW_MESSAGE) {
      const details = event.message.details as { command?: unknown } | undefined;
      if (details?.command === "orchestrate") orchestrationPromptStarted = true;
    }
    if (event.message.role !== "custom" || event.message.customType !== "subagent_supervisor_request") return;
    activateOnly(pi, [HUMAN_DECISION_TOOL, DEEP_PLAN_TOOL, "subagent_supervisor"]);
  });

  // Pi emits agent_end before an automatic provider retry, compaction retry, or
  // queued continuation. Keep the workflow tools and bound invocation alive
  // until the session has fully settled so transient provider failures can
  // recover without turning the native tool into an unavailable one.
  pi.on("agent_end", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("forgedock", FORGEDOCK_READY_STATUS);
  });

  pi.on("agent_settled", (_event, ctx) => {
    // `/orchestrate` queues its real supervisor prompt as a follow-up. Pi can
    // settle the slash-command dispatch turn before that custom message starts;
    // clearing here would discard the invocation binding before the typed tool
    // can consume it. Once the queued prompt has actually started, ordinary
    // settlement owns cleanup again.
    if (activeWorkflow === "orchestrate" && !orchestrationPromptStarted) {
      if (ctx.mode === "tui") ctx.ui.setStatus("forgedock", "◇ Preparing orchestration…");
      return;
    }
    restoreAssistantMode();
    if (ctx.mode === "tui") ctx.ui.setStatus("forgedock", FORGEDOCK_READY_STATUS);
  });

  pi.on("session_shutdown", async () => {
    // Native controller processes own durable work. Ordinary terminal/session
    // teardown detaches them; the next supervisor adopts only tasks whose
    // transport is reconnectable. Controllers bound to the in-memory nested
    // reviewer bridge are durably blocked on restart and must resume from the
    // workflow checkpoint. Explicit forgedock_tasks cancellation remains
    // destructive.
    await backgroundTasks.shutdown({ cancel: false });
    backgroundTasks.setObservationSink(undefined);
    await observer?.flush();
    observer?.close();
    observer = undefined;
    asyncObservation = undefined;
    controlGateway = undefined;
  });

  for (const workflow of WORKFLOWS) {
    registerWorkflow(
      pi,
      workflow,
      () => {
        activation = { id: crypto.randomUUID(), workflow, source: "slash-command", request: `/${workflow}` };
        harnessMode = "forgedock-workflow";
        activeWorkflow = workflow;
        if (workflow === "orchestrate") {
          orchestrationPromptStarted = false;
          orchestrationShellWasActive = pi.getActiveTools().includes("bash");
        }
      },
      restoreAssistantMode,
    );
  }

  pi.registerCommand("forgedock-status", {
    description: "Show typed ForgeDock issue/run status",
    handler: async (args, ctx) => {
      activation = { id: crypto.randomUUID(), workflow: "status", source: "slash-command", request: `/forgedock-status ${args}` };
      harnessMode = "forgedock-workflow";
      activateOnly(pi, [WORKFLOW_TOOLS.status, ORCHESTRATION_RESUME_TOOL]);
      try {
        await queueNativeWorkflow(pi, "status", args.trim(), ctx);
      } catch (error) {
        restoreAssistantMode();
        throw error;
      }
    },
  });

  pi.registerCommand("forgedock-config", {
    description: "Naturally update ForgeDock planning, worker, reviewer, and orchestration preferences",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) {
        ctx.ui.notify("Usage: /forgedock-config <natural-language preference>", "warning");
        return;
      }
      activation = { id: crypto.randomUUID(), workflow: "maintenance", toolName: CONFIG_TOOL, source: "slash-command", request: `/forgedock-config ${request}` };
      activateOnly(pi, [CONFIG_TOOL]);
      pi.sendUserMessage(`The user asked ForgeDock to update project configuration: ${request}\nInterpret the preference and call ${CONFIG_TOOL} exactly once. Pass friendly model names through to the tool for live-catalog resolution; when the user says all subagents, set the shared model through subagentModel/subagentThinking for planners, workers, and reviewers. Preserve unrelated forge.yaml content.`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    },
  });

  pi.registerCommand("forgedock-remember", {
    description: "Persist an explicit project preference or architectural decision",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) {
        ctx.ui.notify("Usage: /forgedock-remember <preference or decision>", "warning");
        return;
      }
      activation = { id: crypto.randomUUID(), workflow: "maintenance", toolName: MEMORY_TOOL, source: "slash-command", request: `/forgedock-remember ${request}` };
      activateOnly(pi, [MEMORY_TOOL]);
      pi.sendUserMessage(`The user explicitly asked ForgeDock to remember durable project knowledge: ${request}\nClassify it as a concise agentic preference for FORGE.md or an architectural decision for devdocs, then call ${MEMORY_TOOL} exactly once. Do not invent implications beyond the user's intent.`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
    },
  });

  pi.registerCommand("forgedock-tasks", {
    description: "List, inspect, or cancel native ForgeDock background tasks",
    handler: async (args, ctx) => {
      const [action = "list", taskId] = args.trim().split(/\s+/);
      try {
        if (action === "list") {
          const records = backgroundTasks.list();
          ctx.ui.notify(records.length ? records.map((record) => `${record.id} · ${record.status} · ${record.args.slice(1, 3).join(" ")}`).join("\n") : "No ForgeDock background tasks.", "info");
          return;
        }
        if (!taskId || (action !== "output" && action !== "cancel")) {
          ctx.ui.notify("Usage: /forgedock-tasks [list | output <task-id> | cancel <task-id>]", "warning");
          return;
        }
        if (action === "cancel") {
          const record = backgroundTasks.cancel(taskId);
          ctx.ui.notify(`Cancelled ${record.id}`, "warning");
        } else {
          ctx.ui.notify(backgroundTasks.output(taskId), "info");
        }
      } catch (error) {
        ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
      }
    },
  });

  pi.registerCommand("forgedock-observe", {
    description: "Open the ForgeDock-owned semantic observer workspace",
    handler: async (args, ctx) => {
      const activeObserver = await ensureObserver(ctx.cwd);
      await openForgeDockObserverWorkspace(ctx, activeObserver, {
        ...(args.trim() ? { initialEntityId: args.trim() } : {}),
        ...(controlGateway ? { gateway: controlGateway } : {}),
      });
    },
  });

  pi.registerCommand("forgedock-runtime", {
    description: "Verify semantic-tool and bundled-subagent runtime provenance",
    handler: async (_args, ctx) => {
      try {
        const response = await inspectSubagentRuntime(pi) as {
          version?: number;
          capabilities?: { asyncSpawn?: boolean; fleetStatus?: unknown };
        };
        const root = process.env.FORGEDOCK_RUNTIME_ROOT ?? "unknown package root";
        const ready = response.version === 1 && response.capabilities?.asyncSpawn === true;
        ctx.ui.notify(
          `${FORGEDOCK_NATIVE_RUNTIME}\nBundled subagents: ${ready ? "ready" : "unexpected response"}\nRuntime root: ${root}`,
          ready ? "info" : "warning",
        );
      } catch (error) {
        ctx.ui.notify(`Bundled subagents unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}

function assertLeafAsyncControl(identity: { depth?: number }): void {
  if (identity.depth !== undefined && identity.depth > 0) throw new Error("Nested reviewer controls must go through the parent reviewer bridge");
}

function controlMessage(payload: unknown, fallback: string): string {
  const message = payload && typeof payload === "object" && !Array.isArray(payload) && typeof (payload as { message?: unknown }).message === "string"
    ? (payload as { message: string }).message.trim()
    : fallback;
  if (Buffer.byteLength(message, "utf8") > 8 * 1024) throw new Error("Control message exceeds the 8 KiB bounded request limit");
  return message || fallback;
}

function normalizePiAsyncStatus(raw: unknown): PiAsyncStatusSnapshot | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  const id = typeof value.id === "string" ? value.id : typeof value.runId === "string" ? value.runId : undefined;
  if (!id) return undefined;
  return {
    id,
    ...(typeof value.state === "string" ? { state: value.state } : {}),
    ...(typeof value.sessionId === "string" ? { sessionId: value.sessionId } : {}),
    ...(typeof value.asyncDir === "string" ? { asyncDir: value.asyncDir } : {}),
    ...(typeof value.agent === "string" ? { agent: value.agent } : {}),
    ...(typeof value.currentTool === "string" ? { currentTool: value.currentTool } : {}),
    ...(typeof value.currentPath === "string" ? { currentPath: value.currentPath } : {}),
    ...(typeof value.pid === "number" ? { pid: value.pid } : {}),
    ...(typeof value.parentRunId === "string" ? { parentRunId: value.parentRunId } : {}),
    ...(typeof value.parentStepIndex === "number" ? { parentStepIndex: value.parentStepIndex } : {}),
    ...(typeof value.depth === "number" ? { depth: value.depth } : {}),
    ...(typeof value.error === "string" ? { summary: value.error } : {}),
  };
}

export function isLifecycleControllerShellCommand(command: string): boolean {
  const lifecycle = "(?:work-on|review-pr|orchestrate|promote|reset)";
  const directEntry = new RegExp(`(?:dist[\\\\/]cli[\\\\/]main\\.js|bin[\\\\/]forgedock-next\\.mjs|forgedock-next(?:\\.cmd|\\.exe)?)[\"']?\\s+${lifecycle}\\b`, "i");
  const packageScript = new RegExp(`npm(?:\\.cmd)?\\s+(?:--silent\\s+)?run\\s+(?:--silent\\s+)?(?:next|forgedock-next)\\s+--\\s+${lifecycle}\\b`, "i");
  return directEntry.test(command) || packageScript.test(command);
}

function activateWorkflowTools(pi: ExtensionAPI, workflow: Workflow): void {
  if (workflow === "orchestrate") {
    activateOnly(pi, [ORCHESTRATION_DISCOVERY_TOOL, WORKFLOW_TOOLS.orchestrate, HUMAN_DECISION_TOOL], ["bash"]);
    return;
  }
  activateOnly(pi, [WORKFLOW_TOOLS[workflow]]);
}

function registerWorkflow(
  pi: ExtensionAPI,
  workflow: Workflow,
  activateWorkflow: () => void,
  restoreAssistantMode: () => void,
): void {
  pi.registerCommand(workflow, {
    description: workflowDescription(workflow),
    handler: async (args, ctx) => {
      const normalized = args.trim();
      if (!normalized) {
        ctx.ui.notify(workflowUsage(workflow), "warning");
        return;
      }
      // Orchestration confirms the resolved DAG and proposed work-unit batches inside
      // its native tool; a pre-resolution confirmation would be both vague and duplicate.
      if (workflow !== "orchestrate" && workflow !== "deep-plan" && !await confirmWorkflow(workflow, normalized, ctx)) return;
      if (workflow === "orchestrate" && explicitOrchestrationStopId(normalized) && ctx.hasUI
        && !await ctx.ui.confirm("Stop ForgeDock orchestration?", `Exact DAG: ${explicitOrchestrationStopId(normalized)}\n\nThis cancels the DAG semantically, drains its admitted workers, and preserves queued nodes unattempted.`)) return;
      if (workflow === "deep-plan") requestDeepPlanMode();
      activateWorkflow();
      if (workflow === "orchestrate" && !explicitOrchestrationResumeId(normalized) && !explicitOrchestrationStopId(normalized)) {
        bindOrchestrationInvocation(pi, { rawArgs: normalized });
      }
      try {
        await queueNativeWorkflow(pi, workflow, normalized, ctx);
      } catch (error) {
        restoreAssistantMode();
        throw error;
      }
    },
  });
}

async function queueNativeWorkflow(
  pi: ExtensionAPI,
  command: WorkflowCommand,
  rawArgs: string,
  ctx: ExtensionCommandContext,
): Promise<void> {
  const tool = WORKFLOW_TOOLS[command];
  const resumeOrchestrationId = command === "orchestrate" ? explicitOrchestrationResumeId(rawArgs) : undefined;
  const stopOrchestrationId = command === "orchestrate" ? explicitOrchestrationStopId(rawArgs) : undefined;
  activateOnly(pi, command === "orchestrate"
    ? resumeOrchestrationId ? [ORCHESTRATION_RESUME_TOOL] : stopOrchestrationId ? [tool] : [ORCHESTRATION_DISCOVERY_TOOL, tool, HUMAN_DECISION_TOOL]
    : [tool],
  command === "orchestrate" && !resumeOrchestrationId ? ["bash"] : []);
  ctx.ui.setStatus("forgedock", `◇ Preparing ${workflowCommandDisplay(command)}…`);
  const prompt = buildNativeCommandPrompt(command, rawArgs);
  // Slash-command dispatch itself occupies Pi's prompt pipeline, so deliverAs
  // remains followUp while triggerTurn covers the idle case. The custom message
  // keeps the complete prompt in model context while its renderer shows only a
  // concise invocation label in the ordinary TUI.
  if (command === "orchestrate") {
    pi.sendMessage({
      customType: FORGEDOCK_NATIVE_WORKFLOW_MESSAGE,
      content: prompt,
      display: true,
      details: { command, rawArgs, invocationLabel: formatOrchestrationInvocationLabel(command, rawArgs) },
    }, { triggerTurn: true, deliverAs: "followUp" });
    return;
  }
  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

function workflowDescription(workflow: Workflow): string {
  if (workflow === "deep-plan") return "Run a confirmation-gated ForgeDock-native planning interview";
  if (workflow === "work-on") return "Run the full typed ForgeDock issue pipeline";
  if (workflow === "review-pr") return "Run a fresh-context, SHA-anchored pull-request review";
  if (workflow === "promote") return "Promote an explicit feature or integration branch through durable gates";
  return "Resolve and schedule issues through visible parallel subagents";
}

function workflowUsage(workflow: Workflow): string {
  if (workflow === "deep-plan") return "Usage: /deep-plan <natural-language planning request>";
  if (workflow === "work-on") return "Usage: /work-on <issue or natural-language issue reference> [--no-auto-merge]";
  if (workflow === "review-pr") return "Usage: /review-pr <PR or natural-language PR reference>";
  if (workflow === "promote") return "Usage: /promote --from <branch> [--to <target>] [--confirm] [--authorize-merge]";
  return "Usage: /orchestrate <issue set or natural-language scope> [--no-auto-merge] [policy options]";
}

async function confirmWorkflow(workflow: Workflow, args: string, ctx: ExtensionCommandContext): Promise<boolean> {
  if (!ctx.hasUI) return true;
  const risk = workflow === "deep-plan"
    ? "This opens an interactive planning interview; no code, GitHub, or workflow mutation occurs before a separate confirmation."
    : workflow === "review-pr"
    ? "This may publish a SHA-anchored review and update durable GitHub state."
    : workflow === "promote"
      ? "This may create a promotion PR or merge an explicitly reviewed SHA when separately authorized."
      : workflow === "orchestrate"
      ? "This may launch parallel workers, create branches/PRs, publish artifacts, and merge when policy allows."
      : "This may create a branch/PR, publish artifacts, and merge when policy allows.";
  return ctx.ui.confirm(`Run ForgeDock ${workflow}?`, `Target: ${args}\n\n${risk}`);
}

export { executeController } from "./forgedock-tools.js";
