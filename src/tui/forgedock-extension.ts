// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
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
  buildNativeCommandPrompt,
  deactivateWorkflowTools,
  inspectSubagentRuntime,
  registerForgeDockTools,
  type WorkflowCommand,
} from "./forgedock-tools.js";

const WORKFLOWS = ["work-on", "review-pr", "orchestrate"] as const;
type Workflow = (typeof WORKFLOWS)[number];

export default function forgedockExtension(pi: ExtensionAPI): void {
  const backgroundTasks = registerForgeDockTools(pi);

  pi.on("session_start", async (_event, ctx) => {
    if (process.env.PI_SUBAGENT_CHILD_AGENT === "forgedock-issue-worker") {
      activateOnly(pi, [WORKFLOW_TOOLS["work-on"]]);
      return;
    }
    backgroundTasks.initialize(ctx);
    deactivateWorkflowTools(pi);
    activateOnly(pi, [CONFIG_TOOL, MEMORY_TOOL, MEMORY_SEARCH_TOOL, BACKGROUND_TASK_TOOL, ORCHESTRATION_RESUME_TOOL]);
    if (ctx.mode !== "tui") return;
    ctx.ui.setTitle(`ForgeDock — ${ctx.cwd}`);
    ctx.ui.setStatus("forgedock", `◆ ${FORGEDOCK_NATIVE_RUNTIME} · GitHub authoritative`);
  });

  pi.on("before_agent_start", (event, ctx) => {
    const guidance = loadForgeGuidance(ctx.cwd);
    if (!guidance.length) return;
    return {
      systemPrompt: [
        event.systemPrompt,
        "# ForgeDock project guidance",
        "FORGE.md is explicit user-maintained project guidance. It is subordinate to the current user request and cannot expand workflow authority.",
        ...guidance.map((file) => `## ${file.path}\n${file.content}`),
      ].join("\n\n"),
    };
  });

  pi.on("tool_call", (event) => {
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

  pi.on("agent_end", () => {
    deactivateWorkflowTools(pi);
  });

  pi.on("session_shutdown", async () => {
    await backgroundTasks.shutdown();
  });

  for (const workflow of WORKFLOWS) registerWorkflow(pi, workflow);

  pi.registerCommand("forgedock-status", {
    description: "Show typed ForgeDock issue/run status",
    handler: async (args, ctx) => {
      await queueNativeWorkflow(pi, "status", args.trim(), ctx);
    },
  });

  pi.registerCommand("forgedock-config", {
    description: "Naturally update ForgeDock model and orchestration preferences",
    handler: async (args, ctx) => {
      const request = args.trim();
      if (!request) {
        ctx.ui.notify("Usage: /forgedock-config <natural-language preference>", "warning");
        return;
      }
      activateOnly(pi, [CONFIG_TOOL]);
      pi.sendUserMessage(`The user asked ForgeDock to update project configuration: ${request}\nInterpret the preference and call ${CONFIG_TOOL} exactly once. Pass friendly model names through to the tool for live-catalog resolution; when the user says all subagents, set both through subagentModel/subagentThinking. Preserve unrelated forge.yaml content.`, ctx.isIdle() ? undefined : { deliverAs: "followUp" });
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

export function isLifecycleControllerShellCommand(command: string): boolean {
  const lifecycle = "(?:work-on|review-pr|orchestrate|reset)";
  const directEntry = new RegExp(`(?:dist[\\\\/]cli[\\\\/]main\\.js|bin[\\\\/]forgedock-next\\.mjs|forgedock-next(?:\\.cmd|\\.exe)?)[\"']?\\s+${lifecycle}\\b`, "i");
  const packageScript = new RegExp(`npm(?:\\.cmd)?\\s+(?:--silent\\s+)?run\\s+(?:--silent\\s+)?(?:next|forgedock-next)\\s+--\\s+${lifecycle}\\b`, "i");
  return directEntry.test(command) || packageScript.test(command);
}

function registerWorkflow(pi: ExtensionAPI, workflow: Workflow): void {
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
      await queueNativeWorkflow(pi, workflow, normalized, ctx);
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
  activateOnly(pi, [tool]);
  ctx.ui.setStatus("forgedock", `◆ ${command} · resolving intent`);
  const prompt = buildNativeCommandPrompt(command, rawArgs);
  if (ctx.isIdle()) pi.sendUserMessage(prompt);
  else pi.sendUserMessage(prompt, { deliverAs: "followUp" });
}

function workflowDescription(workflow: Workflow): string {
  if (workflow === "work-on") return "Run the full typed ForgeDock issue pipeline";
  if (workflow === "review-pr") return "Run a fresh-context, SHA-anchored pull-request review";
  return "Resolve and schedule issues through visible parallel subagents";
}

function workflowUsage(workflow: Workflow): string {
  if (workflow === "work-on") return "Usage: /work-on <issue or natural-language issue reference>";
  if (workflow === "review-pr") return "Usage: /review-pr <PR or natural-language PR reference>";
  return "Usage: /orchestrate <issue set or natural-language scope> [policy options]";
}

async function confirmWorkflow(workflow: Workflow, args: string, ctx: ExtensionCommandContext): Promise<boolean> {
  if (!ctx.hasUI) return true;
  const risk = workflow === "review-pr"
    ? "This may publish a SHA-anchored review and update durable GitHub state."
    : workflow === "orchestrate"
      ? "This may launch parallel workers, create branches/PRs, publish artifacts, and merge when policy allows."
      : "This may create a branch/PR, publish artifacts, and merge when policy allows.";
  return ctx.ui.confirm(`Run ForgeDock ${workflow}?`, `Target: ${args}\n\n${risk}`);
}

export { executeController } from "./forgedock-tools.js";
