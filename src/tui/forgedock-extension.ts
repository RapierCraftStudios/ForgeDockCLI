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
  CONFIG_TOOL,
  FORGEDOCK_NATIVE_RUNTIME,
  HUMAN_DECISION_TOOL,
  MEMORY_SEARCH_TOOL,
  MEMORY_TOOL,
  ORCHESTRATION_RESUME_TOOL,
  WORKFLOW_TOOLS,
  activateOnly,
  bindOrchestrationInvocation,
  buildNativeCommandPrompt,
  hasOrchestrationPreview,
  clearOrchestrationInvocation,
  controlSubagentRun,
  deactivateWorkflowTools,
  inspectSubagentRuntime,
  registerForgeDockTools,
  type WorkflowCommand,
  workflowCommandDisplay,
} from "./forgedock-tools.js";
import { formatOrchestrationInvocationLabel } from "./orchestration-board.js";

export const FORGEDOCK_READY_STATUS = "◆ ForgeDock ready · /work-on · /review-pr · /orchestrate";
export const FORGEDOCK_NATIVE_WORKFLOW_MESSAGE = "forgedock_native_workflow";

const WORKFLOWS = ["work-on", "review-pr", "orchestrate", "promote"] as const;
type Workflow = (typeof WORKFLOWS)[number];
export type HarnessMode = "assistant" | "forgedock-workflow";

export function buildHarnessModePrompt(mode: HarnessMode, workflow?: Workflow): string {
  if (mode === "forgedock-workflow") {
    return [
      "# ForgeDock harness mode",
      `Mode: forgedock-workflow${workflow ? ` (explicitly activated by /${workflow})` : ""}.`,
      "The typed ForgeDock controller owns mutations within this explicitly activated workflow. Do not replace the active workflow's GitHub mutations with raw gh commands or launch its lifecycle controller through shell.",
      "This authority is scoped to the active workflow only and ends when the agent turn settles after completion, failure, cancellation, or handoff to a native background task.",
    ].join("\n");
  }
  return [
    "# ForgeDock harness mode",
    "Mode: assistant (default). ForgeDock workflows are opt-in, not mandatory terminal policy.",
    "Handle ordinary natural-language coding, git, GitHub, file, and shell requests with normal assistant tools. In particular, create/open pull-request requests default to ordinary gh usage; do not infer /promote from generic PR wording.",
    "When the user explicitly requests gh CLI, honor that tool choice. Current explicit user intent outranks optional ForgeDock workflow policy and historical project guidance.",
    "Only enter forgedock-workflow mode for /work-on, /review-pr, /orchestrate, /promote, a direct forgedock_* workflow tool call, or an explicit request to use a named ForgeDock workflow. If the route is genuinely ambiguous, ask the user to choose Plain GitHub PR or ForgeDock promotion.",
    "This prompt also governs direct tool invocation in the current turn: from a forgedock_* workflow tool call onward, its typed controller exclusively owns that workflow's GitHub mutations; do not combine or follow it with raw gh mutations for the same operation.",
    "Do not inspect ForgeDock controller source to discover how to perform an ordinary GitHub operation; keep generic PR reconnaissance bounded to route, duplicate-PR, and branch/SHA checks.",
  ].join("\n");
}

export default function forgedockExtension(pi: ExtensionAPI): void {
  let observer: ForgeDockObserver | undefined;
  let asyncObservation: PiAsyncObservationAdapter | undefined;
  let controlGateway: ForgeDockObservationControlGateway | undefined;
  let harnessMode: HarnessMode = "assistant";
  let activeWorkflow: Workflow | undefined;
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
  const backgroundTasks = registerForgeDockTools(pi, { getObservationSink: () => observer });
  const restoreAssistantMode = (): void => {
    harnessMode = "assistant";
    activeWorkflow = undefined;
    clearOrchestrationInvocation(pi);
    deactivateWorkflowTools(pi);
    activateOnly(pi, [
      CONFIG_TOOL,
      MEMORY_TOOL,
      MEMORY_SEARCH_TOOL,
      BACKGROUND_TASK_TOOL,
      ...(hasOrchestrationPreview(pi) ? [WORKFLOW_TOOLS.orchestrate, HUMAN_DECISION_TOOL] : []),
    ]);
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
      activateOnly(pi, [WORKFLOW_TOOLS["work-on"]]);
      return;
    }
    harnessMode = "assistant";
    activeWorkflow = undefined;
    backgroundTasks.initialize(ctx);
    deactivateWorkflowTools(pi);
    activateOnly(pi, [CONFIG_TOOL, MEMORY_TOOL, MEMORY_SEARCH_TOOL, BACKGROUND_TASK_TOOL]);
    if (ctx.mode !== "tui" && ctx.mode !== "rpc") return;
    await ensureObserver(ctx.cwd);
    if (ctx.mode !== "tui") return;
    ctx.ui.setTitle(`ForgeDock — ${ctx.cwd}`);
    ctx.ui.setStatus("forgedock", FORGEDOCK_READY_STATUS);
  });

  pi.on("before_agent_start", (event, ctx) => {
    const guidance = loadForgeGuidance(ctx.cwd);
    return {
      systemPrompt: [
        event.systemPrompt,
        buildHarnessModePrompt(harnessMode, activeWorkflow),
        ...(guidance.length ? [
          "# ForgeDock project guidance",
          "FORGE.md is explicit user-maintained project guidance. It is subordinate to the current user request and cannot expand workflow authority.",
          ...guidance.map((file) => `## ${file.path}\n${file.content}`),
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
    const invokedWorkflow = WORKFLOWS.find((workflow) => WORKFLOW_TOOLS[workflow] === event.toolName);
    if (invokedWorkflow) {
      harnessMode = "forgedock-workflow";
      activeWorkflow = invokedWorkflow;
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
    if (event.message.role !== "custom" || event.message.customType !== "subagent_supervisor_request") return;
    activateOnly(pi, [HUMAN_DECISION_TOOL, "subagent_supervisor"]);
  });

  // Pi emits agent_end before an automatic provider retry, compaction retry, or
  // queued continuation. Keep the workflow tools and bound invocation alive
  // until the session has fully settled so transient provider failures can
  // recover without turning the native tool into an unavailable one.
  pi.on("agent_end", (_event, ctx) => {
    if (ctx.mode === "tui") ctx.ui.setStatus("forgedock", FORGEDOCK_READY_STATUS);
  });

  pi.on("agent_settled", (_event, ctx) => {
    restoreAssistantMode();
    if (ctx.mode === "tui") ctx.ui.setStatus("forgedock", FORGEDOCK_READY_STATUS);
  });

  pi.on("session_shutdown", async () => {
    await backgroundTasks.shutdown();
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
        harnessMode = "forgedock-workflow";
        activeWorkflow = workflow;
      },
      restoreAssistantMode,
    );
  }

  pi.registerCommand("forgedock-status", {
    description: "Show typed ForgeDock issue/run status",
    handler: async (args, ctx) => {
      await queueNativeWorkflow(pi, "status", args.trim(), ctx);
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
      if (workflow !== "orchestrate" && !await confirmWorkflow(workflow, normalized, ctx)) return;
      activateWorkflow();
      if (workflow === "orchestrate") bindOrchestrationInvocation(pi, { rawArgs: normalized });
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
  activateOnly(pi, command === "orchestrate" ? [tool, HUMAN_DECISION_TOOL] : [tool]);
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
      details: { command, invocationLabel: formatOrchestrationInvocationLabel(command, rawArgs) },
    }, { triggerTurn: true, deliverAs: "followUp" });
    return;
  }
  pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

function workflowDescription(workflow: Workflow): string {
  if (workflow === "work-on") return "Run the full typed ForgeDock issue pipeline";
  if (workflow === "review-pr") return "Run a fresh-context, SHA-anchored pull-request review";
  if (workflow === "promote") return "Promote an explicit feature or integration branch through durable gates";
  return "Resolve and schedule issues through visible parallel subagents";
}

function workflowUsage(workflow: Workflow): string {
  if (workflow === "work-on") return "Usage: /work-on <issue or natural-language issue reference> [--no-auto-merge]";
  if (workflow === "review-pr") return "Usage: /review-pr <PR or natural-language PR reference>";
  if (workflow === "promote") return "Usage: /promote --from <branch> [--to <target>] [--confirm] [--authorize-merge]";
  return "Usage: /orchestrate <issue set or natural-language scope> [--no-auto-merge] [policy options]";
}

async function confirmWorkflow(workflow: Workflow, args: string, ctx: ExtensionCommandContext): Promise<boolean> {
  if (!ctx.hasUI) return true;
  const risk = workflow === "review-pr"
    ? "This may publish a SHA-anchored review and update durable GitHub state."
    : workflow === "promote"
      ? "This may create a promotion PR or merge an explicitly reviewed SHA when separately authorized."
      : workflow === "orchestrate"
      ? "This may launch parallel workers, create branches/PRs, publish artifacts, and merge when policy allows."
      : "This may create a branch/PR, publish artifacts, and merge when policy allows.";
  return ctx.ui.confirm(`Run ForgeDock ${workflow}?`, `Target: ${args}\n\n${risk}`);
}

export { executeController } from "./forgedock-tools.js";
