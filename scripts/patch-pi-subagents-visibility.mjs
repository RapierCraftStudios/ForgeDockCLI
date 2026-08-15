#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "node_modules", "pi-subagents");
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (manifest.version !== "0.40.0") {
  throw new Error(`ForgeDock visibility patch expects pi-subagents 0.40.0, found ${manifest.version}`);
}

patch(join(root, "src", "shared", "child-transcript.ts"), [
  [
    'type ChildTranscriptRecordType = "message" | "tool_start" | "tool_end" | "stdout" | "stderr" | "truncated";',
    'type ChildTranscriptRecordType = "message" | "tool_start" | "tool_update" | "tool_end" | "stdout" | "stderr" | "truncated";',
  ],
  [
    'interface ChildTranscriptEvent {\n\ttype?: string;\n\tmessage?: ChildTranscriptMessage;\n\ttoolCallId?: string;\n\ttoolName?: string;\n\targs?: unknown;\n\tisError?: boolean;\n}',
    'interface ChildTranscriptEvent {\n\ttype?: string;\n\tmessage?: ChildTranscriptMessage;\n\ttoolCallId?: string;\n\ttoolName?: string;\n\targs?: unknown;\n\tpartialResult?: unknown;\n\tisError?: boolean;\n}',
  ],
  [
    'function eventArgs(event: ChildTranscriptEvent): Record<string, unknown> {\n\treturn event.args && typeof event.args === "object" && !Array.isArray(event.args)\n\t\t? event.args as Record<string, unknown>\n\t\t: {};\n}\n',
    'function eventArgs(event: ChildTranscriptEvent): Record<string, unknown> {\n\treturn event.args && typeof event.args === "object" && !Array.isArray(event.args)\n\t\t? event.args as Record<string, unknown>\n\t\t: {};\n}\n\nfunction toolUpdateText(value: unknown): string | undefined {\n\tif (!value || typeof value !== "object" || Array.isArray(value)) return undefined;\n\tconst content = (value as { content?: unknown }).content;\n\tif (!Array.isArray(content)) return undefined;\n\tconst text = content\n\t\t.filter((item): item is { type: "text"; text: string } => Boolean(item) && typeof item === "object" && (item as { type?: unknown }).type === "text" && typeof (item as { text?: unknown }).text === "string")\n\t\t.map((item) => item.text)\n\t\t.join("\\n");\n\treturn boundedPayload(text);\n}\n',
  ],
  [
    '\t\t\tif (event.type === "tool_execution_end") {\n\t\t\t\twriteRecord({',
    '\t\t\tif (event.type === "tool_execution_update") {\n\t\t\t\tconst text = toolUpdateText(event.partialResult);\n\t\t\t\tif (text) writeRecord({\n\t\t\t\t\t...baseRecord("tool_update"),\n\t\t\t\t\tsourceEventType: event.type,\n\t\t\t\t\t...(event.toolCallId ? { toolCallId: event.toolCallId } : {}),\n\t\t\t\t\t...(event.toolName ? { toolName: event.toolName } : {}),\n\t\t\t\t\ttext,\n\t\t\t\t\toutputTruncated: text.includes("… payload truncated"),\n\t\t\t\t});\n\t\t\t\treturn;\n\t\t\t}\n\t\t\tif (event.type === "tool_execution_end") {\n\t\t\t\twriteRecord({',
  ],
]);

patch(join(root, "src", "tui", "fleet-transcript.ts"), [[
  '\t\tif (recordType === "tool_end") {\n\t\t\tconst tool = findTool(events, stringValue(record.toolCallId), stringValue(record.toolName));',
  '\t\tif (recordType === "tool_update") {\n\t\t\tconst tool = findTool(events, stringValue(record.toolCallId), stringValue(record.toolName));\n\t\t\tconst text = stringValue(record.text);\n\t\t\tif (tool && text) {\n\t\t\t\ttool.output = clipMessage(text);\n\t\t\t\ttool.outputTruncated = record.outputTruncated === true || text.includes("… payload truncated") || text.includes("[Showing lines");\n\t\t\t\ttool.status = "running";\n\t\t\t}\n\t\t\tcontinue;\n\t\t}\n\t\tif (recordType === "tool_end") {\n\t\t\tconst tool = findTool(events, stringValue(record.toolCallId), stringValue(record.toolName));',
]]);

patch(join(root, "src", "tui", "fleet.ts"), [[
  "\tprivate expandedTools = false;",
  "\tprivate expandedTools = true;",
]]);

// ForgeDock worktrees must contain only product changes. Keep operational
// transcripts in user-scoped temp storage even when the user's global
// pi-subagents preference still uses the project directory.
patch(join(root, "src", "shared", "types.ts"), [[
  '\tdir: "project",',
  '\tdir: "temp",',
]]);
patch(join(root, "src", "extension", "index.ts"), [[
  "\tconst config = loadConfig();",
  '\tconst config = { ...loadConfig(), artifactDir: "temp" as const };',
]]);

// A ForgeDock reviewer is read-only and its schema-valid structured submission
// is the authoritative terminal result. Once the terminating tool has written
// that result, a later provider/context/process error cannot invalidate it.
// Cancellation, operator stop, and timeout remain authoritative. Keep this
// exception scoped to ForgeDock reviewers; mutating and general-purpose agents
// retain pi-subagents' ordinary fail-on-error policy.
patchAny(join(root, "src", "runs", "foreground", "execution.ts"), [
  "\tresult.exitCode = exitCode;\n\tif (interruptedByControl) {",
  "\tresult.exitCode = exitCode;\n\tconst recoveredForgeDockTransportReview = agent.name === \"forgedock-reviewer\"\n\t\t&& options.structuredOutput !== undefined\n\t\t&& structuredOutputToolInvoked\n\t\t&& existsSync(options.structuredOutput.outputPath)\n\t\t&& !result.timedOut\n\t\t&& !result.stopped\n\t\t&& !options.signal?.aborted\n\t\t&& /websocket|socket hang up|econnreset|etimedout|transport failed|response failed|network error/i.test(result.error ?? \"\");\n\tif (recoveredForgeDockTransportReview) {\n\t\t// The terminating structured artifact is authoritative for a read-only\n\t\t// reviewer. A transport failure after that tool completed must not burn\n\t\t// the finished session; normal schema validation still runs below.\n\t\tresult.exitCode = 0;\n\t\tresult.error = undefined;\n\t}\n\tif (interruptedByControl) {",
  "\tresult.exitCode = exitCode;\n\tconst completedForgeDockStructuredReview = agent.name === \"forgedock-reviewer\"\n\t\t&& options.structuredOutput !== undefined\n\t\t&& structuredOutputToolInvoked\n\t\t&& existsSync(options.structuredOutput.outputPath)\n\t\t&& !result.timedOut\n\t\t&& !result.stopped\n\t\t&& !options.signal?.aborted;\n\tif (completedForgeDockStructuredReview) {\n\t\t// structured_output is the terminating contract for this read-only role.\n\t\t// Validate the captured file below and ignore only errors that happened\n\t\t// after the tool completed (including context overflow during teardown).\n\t\tresult.exitCode = 0;\n\t\tresult.error = undefined;\n\t}\n\tif (interruptedByControl) {",
], "\tresult.exitCode = exitCode;\n\tconst completedForgeDockStructuredReview = agent.name === \"forgedock-reviewer\"\n\t\t&& options.structuredOutput !== undefined\n\t\t&& structuredOutputToolInvoked\n\t\t&& existsSync(options.structuredOutput.outputPath)\n\t\t&& !result.timedOut\n\t\t&& !result.stopped\n\t\t&& !interruptedByControl\n\t\t&& !options.signal?.aborted;\n\tif (completedForgeDockStructuredReview) {\n\t\t// structured_output is the terminating contract for this read-only role.\n\t\t// Validate the captured file below and ignore only errors that happened\n\t\t// after the tool completed (including context overflow during teardown).\n\t\tresult.exitCode = 0;\n\t\tresult.error = undefined;\n\t}\n\tif (interruptedByControl) {");

patch(join(root, "src", "runs", "foreground", "execution.ts"), [
  [
    "\t\tconst errInfo = detectSubagentError(messages);",
    "\t\tconst completedForgeDockReview = agent.name === \"forgedock-reviewer\" && options.structuredOutput !== undefined && structuredOutputToolInvoked && existsSync(options.structuredOutput.outputPath);\n\t\tconst errInfo = completedForgeDockReview ? detectSubagentError([]) : detectSubagentError(messages);",
  ],
]);

// ForgeDock's typed review controller, not the interactive parent model, owns
// scope classification and reviewer synthesis. Do not inject the generic
// supervisor/intercom tools into reviewer children: their progress remains
// visible in the fleet while their sole handoff is structured_output.
patch(join(root, "src", "runs", "foreground", "subagent-executor.ts"), [[
  "\t\tconst agents = intercomBridge.active\n\t\t\t? discoveredAgents.map((agent) => applyIntercomBridgeToAgent(agent, intercomBridge))\n\t\t\t: discoveredAgents;",
  "\t\tconst agents = intercomBridge.active\n\t\t\t? discoveredAgents.map((agent) => agent.name === \"forgedock-reviewer\" ? agent : applyIntercomBridgeToAgent(agent, intercomBridge))\n\t\t\t: discoveredAgents;",
]]);

// Reviewer shards are implementation details of ForgeDock's typed review
// controller. Keep them visible in the fleet, but do not wake or steer the
// foreground parent through pi-subagents' generic completion/control channels.
patch(join(root, "src", "runs", "foreground", "subagent-executor.ts"), [
  [
    '}): void {\n\tif (!shouldNotifyControlEvent(input.controlConfig, input.event)) return;',
    '}): void {\n\tif (input.event.agent === "forgedock-reviewer") return;\n\tif (!shouldNotifyControlEvent(input.controlConfig, input.event)) return;',
    'if (input.event.agent === "forgedock-reviewer") return;',
  ],
  [
    '\t\tconst effectiveAsync = requestedAsync && effectiveParams.clarify !== true;\n\t\tconst foregroundTimeout = resolveForegroundTimeout(\n\t\t\teffectiveParams,\n\t\t\teffectiveAsync ? undefined : DEFAULT_FOREGROUND_TIMEOUT_MS,\n\t\t);',
    '\t\tconst effectiveAsync = requestedAsync && effectiveParams.clarify !== true;\n\t\tconst requestedAgentNames = collectRequestedAgentNames(effectiveParams);\n\t\tconst forgeDockReviewerOnly = requestedAgentNames.length > 0\n\t\t\t&& requestedAgentNames.every((name) => name === "forgedock-reviewer");\n\t\tconst foregroundTimeout = resolveForegroundTimeout(\n\t\t\teffectiveParams,\n\t\t\teffectiveAsync || forgeDockReviewerOnly ? undefined : DEFAULT_FOREGROUND_TIMEOUT_MS,\n\t\t);',
    'const forgeDockReviewerOnly = requestedAgentNames.length > 0',
  ],
]);

patch(join(root, "src", "runs", "background", "async-job-tracker.ts"), [[
  '\t\t\t\tif (!record.event || !Array.isArray(record.channels)) return;\n\t\t\t\tconst payload = {',
  '\t\t\t\tif (!record.event || !Array.isArray(record.channels)) return;\n\t\t\t\tif (record.event.agent === "forgedock-reviewer") return;\n\t\t\t\tconst payload = {',
]]);

patch(join(root, "src", "runs", "background", "result-watcher.ts"), [
  [
    '\t\t\tconst resultChildren: ResultFileChild[] = hasResultChildren\n\t\t\t\t? data.results!\n\t\t\t\t: [{ agent: data.agent ?? undefined, output: data.summary, outputState: "unknown", success: data.success }];\n\t\t\tconst normalizedChildren =',
    '\t\t\tconst resultChildren: ResultFileChild[] = hasResultChildren\n\t\t\t\t? data.results!\n\t\t\t\t: [{ agent: data.agent ?? undefined, output: data.summary, outputState: "unknown", success: data.success }];\n\t\t\tconst internalForgeDockReview = resultChildren.length > 0\n\t\t\t\t&& resultChildren.every((result) => result.agent === "forgedock-reviewer");\n\t\t\tconst normalizedChildren =',
    'const internalForgeDockReview = resultChildren.length > 0',
  ],
  [
    '\t\t\tif (deliverIntercomResults && intercomTarget && triggerTurn) {',
    '\t\t\tif (!internalForgeDockReview && deliverIntercomResults && intercomTarget && triggerTurn) {',
  ],
  [
    '\t\t\tconst accepted = await notifier.deliver({',
    '\t\t\tconst accepted = internalForgeDockReview ? true : await notifier.deliver({',
  ],
  [
    '\t\t\ttry {\n\t\t\t\tpi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {',
    '\t\t\tif (!internalForgeDockReview) {\n\t\t\t\ttry {\n\t\t\t\t\tpi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT, {',
    'if (!internalForgeDockReview) {\n\t\t\t\ttry {\n\t\t\t\t\tpi.events.emit(SUBAGENT_ASYNC_COMPLETE_EVENT',
  ],
  [
    '\t\t\t\t});\n\t\t\t} catch (error) {\n\t\t\t\tconsole.error(`Completion observer failed for \'${resultPath}\':`, error);\n\t\t\t}\n\t\t\tif (!ownsSession',
    '\t\t\t\t\t});\n\t\t\t\t} catch (error) {\n\t\t\t\t\tconsole.error(`Completion observer failed for \'${resultPath}\':`, error);\n\t\t\t\t}\n\t\t\t}\n\t\t\tif (!ownsSession',
    '\t\t\t\t\tconsole.error(`Completion observer failed for \'${resultPath}\':`, error);\n\t\t\t\t}\n\t\t\t}',
  ],
]);

patch(join(root, "src", "extension", "fanout-child.ts"), [
  [
    'import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";',
    'import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";',
  ],
  [
    'import { SubagentParams } from "./schemas.ts";',
    'import { SubagentParams } from "./schemas.ts";\nimport { registerPromptTemplateDelegationBridge } from "../slash/prompt-template-bridge.ts";',
  ],
  [
    '\tconst tool: ToolDefinition<typeof SubagentParams, Details> = {',
    '\tlet lastContext: ExtensionContext | null = null;\n\tpi.on("session_start", (_event, ctx) => {\n\t\tlastContext = ctx;\n\t\tstate.baseCwd = ctx.cwd;\n\t\tstate.currentSessionId = ctx.sessionManager.getSessionId() ?? null;\n\t\tstate.parentSessionFile = ctx.sessionManager.getSessionFile() ?? null;\n\t\tstate.lastUiContext = ctx;\n\t});\n\tregisterPromptTemplateDelegationBridge({\n\t\tevents: pi.events,\n\t\tgetContext: () => lastContext,\n\t\texecute: (requestId, params, signal, ctx, onUpdate) =>\n\t\t\texecutor.execute(requestId, params, signal, onUpdate, ctx),\n\t\texecuteVersioned: (requestId, params, signal, ctx, onUpdate) =>\n\t\t\texecutor.executeDelegated(requestId, params, signal, onUpdate, ctx),\n\t});\n\n\tconst tool: ToolDefinition<typeof SubagentParams, Details> = {',
    '\tlet lastContext: ExtensionContext | null = null;',
  ],
]);

// ForgeDock's controller bridge runs inside the child-safe issue-worker process.
// Fresh V2 delegation is already registered there, but persisted-session resume
// uses pi-subagents' RPC seam. Register that seam against the same child-local
// executor; otherwise a resume request has no listener and waits forever.
patch(join(root, "src", "extension", "fanout-child.ts"), [
  [
    'import { registerPromptTemplateDelegationBridge } from "../slash/prompt-template-bridge.ts";',
    'import { registerPromptTemplateDelegationBridge } from "../slash/prompt-template-bridge.ts";\nimport { registerSubagentRpcBridge } from "./rpc.ts";',
  ],
  [
    '\tregisterPromptTemplateDelegationBridge({\n\t\tevents: pi.events,\n\t\tgetContext: () => lastContext,\n\t\texecute: (requestId, params, signal, ctx, onUpdate) =>\n\t\t\texecutor.execute(requestId, params, signal, onUpdate, ctx),\n\t\texecuteVersioned: (requestId, params, signal, ctx, onUpdate) =>\n\t\t\texecutor.executeDelegated(requestId, params, signal, onUpdate, ctx),\n\t});\n\n\tconst tool: ToolDefinition<typeof SubagentParams, Details> = {',
    '\tregisterPromptTemplateDelegationBridge({\n\t\tevents: pi.events,\n\t\tgetContext: () => lastContext,\n\t\texecute: (requestId, params, signal, ctx, onUpdate) =>\n\t\t\texecutor.execute(requestId, params, signal, onUpdate, ctx),\n\t\texecuteVersioned: (requestId, params, signal, ctx, onUpdate) =>\n\t\t\texecutor.executeDelegated(requestId, params, signal, onUpdate, ctx),\n\t});\n\tregisterSubagentRpcBridge({\n\t\tevents: pi.events,\n\t\tgetContext: () => lastContext,\n\t\texecute: (requestId, params, signal, onUpdate, ctx) =>\n\t\t\texecutor.execute(requestId, params, signal, onUpdate, ctx),\n\t\tstate,\n\t});\n\n\tconst tool: ToolDefinition<typeof SubagentParams, Details> = {',
  ],
]);

// Preserve nested foreground children as first-class fleet data. ForgeDock's
// issue worker is itself an async child, so reviewer grandchildren otherwise
// collapse into a registry-only implementation detail.
patch(join(root, "src", "shared", "types.ts"), [
  [
    '"id" | "parentRunId" | "parentStepIndex" | "parentAgent" | "depth" | "path" | "asyncDir" | "sessionId" | "sessionFile" | "intercomTarget" | "ownerIntercomTarget" | "leafIntercomTarget" | "ownerState" | "mode" | "state" | "agent" | "agents" | "currentStep" | "chainStepCount" | "parallelGroups" | "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath" | "turnCount" | "toolCount" | "toolBudget" | "toolBudgetBlocked" | "totalTokens" | "totalCost" | "startedAt" | "endedAt" | "lastUpdate" | "error" | "timeoutMs" | "deadlineAt" | "timedOut" | "stopped" | "turnBudget" | "turnBudgetExceeded" | "wrapUpRequested"',
    '"id" | "parentRunId" | "parentStepIndex" | "parentAgent" | "depth" | "path" | "asyncDir" | "sessionId" | "sessionFile" | "intercomTarget" | "ownerIntercomTarget" | "leafIntercomTarget" | "ownerState" | "mode" | "state" | "agent" | "description" | "agents" | "currentStep" | "chainStepCount" | "parallelGroups" | "activityState" | "lastActivityAt" | "currentTool" | "currentToolStartedAt" | "currentPath" | "turnCount" | "toolCount" | "toolBudget" | "toolBudgetBlocked" | "totalTokens" | "totalCost" | "startedAt" | "endedAt" | "lastUpdate" | "error" | "timeoutMs" | "deadlineAt" | "timedOut" | "stopped" | "turnBudget" | "turnBudgetExceeded" | "wrapUpRequested"',
  ],
  [
    '\tstate: NestedRunState;\n\tagent?: string;\n\tagents?: string[];',
    '\tstate: NestedRunState;\n\tagent?: string;\n\t/** Bounded launch description used only for fleet identity and observability. */\n\tdescription?: string;\n\tagents?: string[];',
  ],
]);
patch(join(root, "src", "runs", "shared", "nested-events.ts"), [[
  '\t\t...(stringValue(raw.agent, 128) ? { agent: stringValue(raw.agent, 128) } : {}),\n\t\t...(Array.isArray(raw.agents)',
  '\t\t...(stringValue(raw.agent, 128) ? { agent: stringValue(raw.agent, 128) } : {}),\n\t\t...(stringValue(raw.description, 2048) ? { description: stringValue(raw.description, 2048) } : {}),\n\t\t...(Array.isArray(raw.agents)',
]]);
patch(join(root, "src", "runs", "foreground", "subagent-executor.ts"), [[
  '\t\t\t\t\t\tagent: agentsForSummary[0],\n\t\t\t\t\t\tagents: agentsForSummary,',
  '\t\t\t\t\t\tagent: agentsForSummary[0],\n\t\t\t\t\t\t...(foregroundDescription ? { description: foregroundDescription.slice(0, 2048) } : {}),\n\t\t\t\t\t\tagents: agentsForSummary,',
]]);

patch(join(root, "src", "tui", "fleet.ts"), [
  [
    'type Details, type ForegroundChildControl',
    'type Details, type ForegroundChildControl, type NestedRunSummary',
  ],
  [
    '| { key: string; kind: "async"; runId: string; index?: number; agent: string; state: string; updatedAt: number; run: AsyncRunSummary; step?: AsyncStep }\n) & { description?: string };',
    '| { key: string; kind: "async"; runId: string; index?: number; agent: string; state: string; updatedAt: number; run: AsyncRunSummary; step?: AsyncStep; nested?: NestedRunSummary }\n) & { description?: string; nestedCount?: number; treePrefix?: string };',
  ],
  [
    '\treturn run.steps.map((step) => ({\n\t\tkey: `async:${run.id}:${step.index}`,\n\t\tkind: "async" as const,\n\t\trunId: run.id,\n\t\tindex: step.index,\n\t\tagent: step.label ? `${step.label} (${step.agent})` : step.agent,\n\t\tstate: step.status,\n\t\tupdatedAt: step.lastActivityAt ?? updatedAt,\n\t\trun,\n\t\tstep,\n\t\t...(description ? { description } : {}),\n\t}));\n}',
    '\tconst parents: FleetItem[] = run.steps.map((step) => ({\n\t\tkey: `async:${run.id}:${step.index}`,\n\t\tkind: "async" as const,\n\t\trunId: run.id,\n\t\tindex: step.index,\n\t\tagent: step.label ? `${step.label} (${step.agent})` : step.agent,\n\t\tstate: step.status,\n\t\tupdatedAt: step.lastActivityAt ?? updatedAt,\n\t\trun,\n\t\tstep,\n\t\t...(description ? { description } : {}),\n\t}));\n\tif (!run.nestedChildren?.length) return parents;\n\tconst assigned = new Set<string>();\n\tconst output: FleetItem[] = [];\n\tfor (const parent of parents) {\n\t\tconst children = run.nestedChildren.filter((child) => child.parentStepIndex === parent.index\n\t\t\t|| (run.steps.length === 1 && child.parentStepIndex === undefined));\n\t\tconst count = countNestedChildren(children);\n\t\toutput.push(count ? { ...parent, nestedCount: count } : parent);\n\t\toutput.push(...nestedFleetItems(run, children));\n\t\tfor (const child of children) assigned.add(child.id);\n\t}\n\tconst unassigned = run.nestedChildren.filter((child) => !assigned.has(child.id));\n\tif (unassigned.length) {\n\t\tif (output[0]) output[0] = { ...output[0], nestedCount: (output[0].nestedCount ?? 0) + countNestedChildren(unassigned) };\n\t\toutput.splice(1, 0, ...nestedFleetItems(run, unassigned));\n\t}\n\treturn output;\n}\n\nfunction countNestedChildren(children: readonly NestedRunSummary[]): number {\n\treturn children.reduce((count, child) => count + 1 + countNestedChildren(child.children ?? []), 0);\n}\n\nfunction nestedFleetItems(\n\trun: AsyncRunSummary,\n\tchildren: readonly NestedRunSummary[],\n\tancestorLast: readonly boolean[] = [],\n): FleetItem[] {\n\treturn children.flatMap((child, index) => {\n\t\tconst last = index === children.length - 1;\n\t\tconst treePrefix = `${ancestorLast.map((ancestorWasLast) => ancestorWasLast ? "   " : "│  ").join("")}${last ? "└─ " : "├─ "}`;\n\t\tconst firstLine = child.description?.split(/\\r?\\n/, 1)[0]?.trim();\n\t\tconst reviewLabel = /^ForgeDock review · (?:cycle \\d+\\/\\d+ · )?([^·\\r\\n]+?)(?: ·|$)/i.exec(firstLine ?? "")?.[1]?.trim();\n\t\tconst item: FleetItem = {\n\t\t\tkey: `nested:${run.id}:${child.id}`,\n\t\t\tkind: "async",\n\t\t\trunId: child.id,\n\t\t\tagent: reviewLabel ? `review · ${reviewLabel}` : child.agent ?? child.mode ?? "nested agent",\n\t\t\tstate: child.state,\n\t\t\tupdatedAt: child.lastUpdate ?? child.endedAt ?? child.startedAt ?? run.lastUpdate ?? run.startedAt,\n\t\t\trun,\n\t\t\tnested: child,\n\t\t\ttreePrefix,\n\t\t\t...(child.description ? { description: child.description } : {}),\n\t\t\t...(child.children?.length ? { nestedCount: countNestedChildren(child.children) } : {}),\n\t\t};\n\t\treturn [item, ...nestedFleetItems(run, child.children ?? [], [...ancestorLast, last])];\n\t});\n}',
    "function nestedFleetItems",
  ],
]);

patch(join(root, "src", "tui", "fleet.ts"), [
  [
    '\tif (run.steps.length === 0) {\n\t\treturn [{ key: `async:${run.id}`, kind: "async", runId: run.id, agent: run.mode, state: run.state, updatedAt, run, ...(description ? { description } : {}) }];\n\t}',
    '\tif (run.steps.length === 0) {\n\t\tconst parent: FleetItem = { key: `async:${run.id}`, kind: "async", runId: run.id, agent: run.mode, state: run.state, updatedAt, run, ...(description ? { description } : {}) };\n\t\tif (!run.nestedChildren?.length) return [parent];\n\t\treturn [{ ...parent, nestedCount: countNestedChildren(run.nestedChildren) }, ...nestedFleetItems(run, run.nestedChildren)];\n\t}',
  ],
  [
    'function asyncDetail(item: Extract<FleetItem, { kind: "async" }>): string[] {\n\tconst status = readStatus(item.run.asyncDir);',
    'function asyncDetail(item: Extract<FleetItem, { kind: "async" }>): string[] {\n\tif (item.nested) {\n\t\tconst child = item.nested;\n\t\tconst sessionFile = child.sessionFile ?? child.steps?.find((step) => step.sessionFile)?.sessionFile;\n\t\treturn [\n\t\t\t`Nested run: ${child.id}`,\n\t\t\t`Parent: ${child.parentAgent ?? child.parentRunId}`,\n\t\t\t`State: ${child.state}`,\n\t\t\t`Depth: ${child.depth}`,\n\t\t\tchild.mode ? `Mode: ${child.mode}` : undefined,\n\t\t\tchild.currentTool ? `Current tool: ${child.currentTool}${child.currentPath ? ` · ${shortenPath(child.currentPath)}` : ""}` : undefined,\n\t\t\tchild.turnCount !== undefined ? `Turns: ${child.turnCount}` : undefined,\n\t\t\tchild.toolCount !== undefined ? `Tools: ${child.toolCount}` : undefined,\n\t\t\tchild.startedAt !== undefined ? `Started: ${new Date(child.startedAt).toISOString()}` : undefined,\n\t\t\tchild.endedAt !== undefined ? `Ended: ${new Date(child.endedAt).toISOString()}` : undefined,\n\t\t\tsessionFile ? `Session: ${sessionFile}` : undefined,\n\t\t\tchild.error ? `Error: ${child.error}` : undefined,\n\t\t\t"",\n\t\t\t"Nested agent activity",\n\t\t\tchild.state === "running" ? "This child is live. Status and elapsed time refresh automatically." : "The nested child has settled; its session path is retained above.",\n\t\t].filter((line): line is string => line !== undefined);\n\t}\n\tconst status = readStatus(item.run.asyncDir);',
  ],
  [
    '\tconst step = item.step ?? (item.run.steps.length === 1 ? item.run.steps[0] : undefined);',
    '\tif (item.nested) return undefined;\n\tconst step = item.step ?? (item.run.steps.length === 1 ? item.run.steps[0] : undefined);',
  ],
  [
    'if (item.kind === "async") return contextModeLabel(item.step?.context ?? item.run.context);',
    'if (item.kind === "async") return item.nested ? undefined : contextModeLabel(item.step?.context ?? item.run.context);',
  ],
  [
    'return item.kind === "foreground-active" ? item.control.mode : item.run.mode;',
    'return item.kind === "foreground-active" ? item.control.mode : item.kind === "async" && item.nested ? item.nested.mode ?? "nested" : item.run.mode;',
  ],
  [
    'if (item.kind === "async") return "background";',
    'if (item.kind === "async") return item.nested ? "nested child" : "background";',
  ],
  [
    '\t} else {\n\t\tmodel = item.step?.model;\n\t\ttokens = item.step?.tokens?.total ?? (item.index === undefined ? item.run.totalTokens?.total : undefined);\n\t\ttools = item.step?.toolCount ?? (item.index === undefined ? item.run.toolCount : undefined);\n\t\tconst terminalRun = item.state !== "queued" && item.state !== "running" && item.state !== "pending";\n\t\tconst endTime = item.run.endedAt ?? (terminalRun ? item.run.lastUpdate : undefined) ?? Date.now();\n\t\tdurationMs = item.step?.durationMs ?? Math.max(0, endTime - item.run.startedAt);\n\t}',
    '\t} else if (item.nested) {\n\t\ttokens = item.nested.totalTokens?.total;\n\t\ttools = item.nested.toolCount;\n\t\tconst terminalRun = item.state !== "queued" && item.state !== "running" && item.state !== "pending";\n\t\tconst startTime = item.nested.startedAt ?? item.updatedAt;\n\t\tconst endTime = item.nested.endedAt ?? (terminalRun ? item.nested.lastUpdate : undefined) ?? Date.now();\n\t\tdurationMs = Math.max(0, endTime - startTime);\n\t} else {\n\t\tmodel = item.step?.model;\n\t\ttokens = item.step?.tokens?.total ?? (item.index === undefined ? item.run.totalTokens?.total : undefined);\n\t\ttools = item.step?.toolCount ?? (item.index === undefined ? item.run.toolCount : undefined);\n\t\tconst terminalRun = item.state !== "queued" && item.state !== "running" && item.state !== "pending";\n\t\tconst endTime = item.run.endedAt ?? (terminalRun ? item.run.lastUpdate : undefined) ?? Date.now();\n\t\tdurationMs = item.step?.durationMs ?? Math.max(0, endTime - item.run.startedAt);\n\t}',
  ],
  [
    'if (item.kind !== "async") return { reason: "Fleet controls are available for current-session top-level async runs only." };\n\t\tif (!isActionableAsyncState',
    'if (item.kind !== "async" || item.nested) return { reason: "Fleet controls are available for current-session top-level async runs only." };\n\t\tif (!isActionableAsyncState',
  ],
  [
    'const context = item.kind === "async" ? contextModeBadge(this.theme, item.step?.context ?? item.run.context) : item.kind === "foreground-recent" ? contextModeBadge(this.theme, item.child.context) : "";\n\t\t\tconst agent = index === this.selected ? this.theme.bold(item.agent) : item.agent;\n\t\t\tconst identity = item.description?.replace(/\\s+/g, " ").trim() || item.runId.slice(0, 8);\n\t\t\tconst left = `${marker} ${statusGlyph(item, this.theme)} ${agent}${context} ${this.theme.fg("dim", `· ${identity}`)}`;',
    'const context = item.kind === "async" && !item.nested ? contextModeBadge(this.theme, item.step?.context ?? item.run.context) : item.kind === "foreground-recent" ? contextModeBadge(this.theme, item.child.context) : "";\n\t\t\tconst agent = index === this.selected ? this.theme.bold(item.agent) : item.agent;\n\t\t\tconst identity = item.nested ? item.runId.slice(0, 8) : item.description?.replace(/\\s+/g, " ").trim() || item.runId.slice(0, 8);\n\t\t\tconst descendants = item.nestedCount ? this.theme.fg("dim", ` (+${item.nestedCount} agent${item.nestedCount === 1 ? "" : "s"})`) : "";\n\t\t\tconst left = `${marker} ${item.treePrefix ?? ""}${statusGlyph(item, this.theme)} ${agent}${context}${descendants} ${this.theme.fg("dim", `· ${identity}`)}`;',
  ],
]);

patch(join(root, "src", "tui", "fleet-status.ts"), [
  [
    'type { AsyncJobStep, FleetViewPlacement, SubagentState }',
    'type { AsyncJobState, AsyncJobStep, FleetViewPlacement, SubagentState }',
  ],
  [
    '\ttokens: number;\n};',
    '\ttokens: number;\n\tnestedCount?: number;\n};',
    "nestedCount?: number;",
  ],
  [
    'export function collectFleetStatusEntries(state: SubagentState): FleetStatusEntry[] {',
    'function nestedCount(children: AsyncJobState["nestedChildren"]): number {\n\treturn (children ?? []).reduce((count, child) => count + 1 + nestedCount(child.children), 0);\n}\n\nfunction nestedCountForStep(job: AsyncJobState, index: number, stepCount: number): number {\n\tconst children = (job.nestedChildren ?? []).filter((child) => child.parentStepIndex === index\n\t\t|| (stepCount === 1 && child.parentStepIndex === undefined));\n\treturn nestedCount(children);\n}\n\nexport function collectFleetStatusEntries(state: SubagentState): FleetStatusEntry[] {',
    "function activeNestedChild",
  ],
  [
    '\t\t\t\ttokens: job.totalTokens?.total ?? 0,\n\t\t\t});',
    '\t\t\t\ttokens: job.totalTokens?.total ?? 0,\n\t\t\t\t...(nestedCount(job.nestedChildren) > 0 ? { nestedCount: nestedCount(job.nestedChildren) } : {}),\n\t\t\t});',
    "nestedCount(job.nestedChildren)",
  ],
  [
    '\t\t\t\ttokens: step.tokens?.total ?? (steps.length === 1 ? job.totalTokens?.total ?? 0 : 0),\n\t\t\t});',
    '\t\t\t\ttokens: step.tokens?.total ?? (steps.length === 1 ? job.totalTokens?.total ?? 0 : 0),\n\t\t\t\t...(nestedCountForStep(job, index, steps.length) > 0 ? { nestedCount: nestedCountForStep(job, index, steps.length) } : {}),\n\t\t\t});',
    "nestedCountForStep(job, index, steps.length)",
  ],
  [
    'const agent = entry.modelThinking ? `${entry.agent} (${entry.modelThinking})` : entry.agent;\n\t\tconst left = `  ${this.bullet(rosterIndex, selectedIndex, theme)} ${theme.fg("muted", agent)}${description ? `  ${description}` : ""}`;',
    'const agent = entry.modelThinking ? `${entry.agent} (${entry.modelThinking})` : entry.agent;\n\t\tconst descendants = entry.nestedCount ? theme.fg("dim", ` (+${entry.nestedCount} agent${entry.nestedCount === 1 ? "" : "s"})`) : "";\n\t\tconst left = `  ${this.bullet(rosterIndex, selectedIndex, theme)} ${theme.fg("muted", agent)}${descendants}${description ? `  ${description}` : ""}`;',
    "const descendants = entry.nestedCount",
  ],
  [
    '\t\t\t\tentry.tokens,\n\t\t\t]),',
    '\t\t\t\tentry.tokens,\n\t\t\t\tentry.nestedCount,\n\t\t\t]),',
    "entry.tokens,\n\t\t\t\tentry.nestedCount",
  ],
]);

patch(join(root, "src", "tui", "fleet-status.ts"), [
  [
    'description: job.description,',
    'description: activeNestedChild(job)?.description ?? job.description,',
  ],
  [
    'description: step.description ?? job.description,',
    'description: activeNestedChild(job)?.description ?? step.description ?? job.description,',
  ],
  [
    '\ttokens: number;\n\tnestedCount?: number;\n};',
    '\ttokens: number;\n\tnestedCount?: number;\n\tcurrentTool?: string;\n\tcurrentPath?: string;\n\tactiveChild?: string;\n};',
    "currentTool?: string;",
  ],
  [
    'function nestedCountForStep(job: AsyncJobState, index: number, stepCount: number): number {\n\tconst children = (job.nestedChildren ?? []).filter((child) => child.parentStepIndex === index\n\t\t|| (stepCount === 1 && child.parentStepIndex === undefined));\n\treturn nestedCount(children);\n}\n\nexport function collectFleetStatusEntries',
    'function nestedCountForStep(job: AsyncJobState, index: number, stepCount: number): number {\n\tconst children = (job.nestedChildren ?? []).filter((child) => child.parentStepIndex === index\n\t\t|| (stepCount === 1 && child.parentStepIndex === undefined));\n\treturn nestedCount(children);\n}\n\nfunction activeNestedChild(job: AsyncJobState): { agent?: string; currentTool?: string; currentPath?: string; lastActivityAt?: number } | undefined {\n\tconst children = (job.nestedChildren ?? []).flatMap((child) => [child, ...(child.children ?? [])]);\n\treturn children.filter((child) => child.state === "running").sort((left, right) => (right.lastActivityAt ?? right.startedAt ?? 0) - (left.lastActivityAt ?? left.startedAt ?? 0))[0];\n}\n\nexport function collectFleetStatusEntries',
  ],
  [
    '\t\t\t\ttokens: job.totalTokens?.total ?? 0,\n\t\t\t\t...(nestedCount(job.nestedChildren) > 0 ? { nestedCount: nestedCount(job.nestedChildren) } : {}),',
    '\t\t\t\ttokens: job.totalTokens?.total ?? 0,\n\t\t\t\t...(nestedCount(job.nestedChildren) > 0 ? { nestedCount: nestedCount(job.nestedChildren) } : {}),\n\t\t\t\t...(job.currentTool || activeNestedChild(job)?.currentTool ? { currentTool: job.currentTool ?? activeNestedChild(job)?.currentTool } : {}),\n\t\t\t\t...(job.currentPath || activeNestedChild(job)?.currentPath ? { currentPath: job.currentPath ?? activeNestedChild(job)?.currentPath } : {}),\n\t\t\t\t...(activeNestedChild(job)?.agent ? { activeChild: activeNestedChild(job)?.agent } : {}),',
  ],
  [
    '\t\t\t\ttokens: step.tokens?.total ?? (steps.length === 1 ? job.totalTokens?.total ?? 0 : 0),\n\t\t\t\t...(nestedCountForStep(job, index, steps.length) > 0 ? { nestedCount: nestedCountForStep(job, index, steps.length) } : {}),',
    '\t\t\t\ttokens: step.tokens?.total ?? (steps.length === 1 ? job.totalTokens?.total ?? 0 : 0),\n\t\t\t\t...(nestedCountForStep(job, index, steps.length) > 0 ? { nestedCount: nestedCountForStep(job, index, steps.length) } : {}),\n\t\t\t\t...(step.currentTool || job.currentTool || activeNestedChild(job)?.currentTool ? { currentTool: step.currentTool ?? job.currentTool ?? activeNestedChild(job)?.currentTool } : {}),\n\t\t\t\t...(step.currentPath || job.currentPath || activeNestedChild(job)?.currentPath ? { currentPath: step.currentPath ?? job.currentPath ?? activeNestedChild(job)?.currentPath } : {}),\n\t\t\t\t...(activeNestedChild(job)?.agent ? { activeChild: activeNestedChild(job)?.agent } : {}),',
  ],
  [
    '\t\tconst descendants = entry.nestedCount ? theme.fg("dim", ` (+${entry.nestedCount} agent${entry.nestedCount === 1 ? "" : "s"})`) : "";\n\t\tconst left = `  ${this.bullet(rosterIndex, selectedIndex, theme)} ${theme.fg("muted", agent)}${descendants}${description ? `  ${description}` : ""}`;',
    '\t\tconst descendants = entry.nestedCount ? theme.fg("dim", ` (+${entry.nestedCount} agent${entry.nestedCount === 1 ? "" : "s"})`) : "";\n\t\tconst activity = entry.currentTool ? theme.fg("accent", ` · ${entry.activeChild ? `${entry.activeChild} ` : ""}${entry.currentTool}${entry.currentPath ? ` · ${entry.currentPath}` : ""}`) : "";\n\t\tconst left = `  ${this.bullet(rosterIndex, selectedIndex, theme)} ${theme.fg("muted", agent)}${descendants}${activity}${description ? `  ${description}` : ""}`;',
  ],
  [
    '\t\t\t\tentry.nestedCount,\n\t\t\t]),',
    '\t\t\t\tentry.nestedCount,\n\t\t\t\tentry.currentTool,\n\t\t\t\tentry.currentPath,\n\t\t\t\tentry.activeChild,\n\t\t\t]),',
  ],
]);

function patch(file, replacements) {
  let source = readFileSync(file, "utf8");
  let changed = false;
  for (const [before, after, appliedMarker = after] of replacements) {
    // Some patches deliberately extend an earlier inserted block. In that case
    // the full earlier `after` text no longer survives contiguously, so use a
    // stable marker to keep repeated postinstall runs idempotent.
    if (file.endsWith("fleet.ts") && before.startsWith("function asyncDetail") && source.includes("\tif (item.nested) {")) continue;
    if (source.includes(appliedMarker)) continue;
    const count = source.split(before).length - 1;
    if (count !== 1) throw new Error(`ForgeDock visibility patch could not find one expected block in ${file}; found ${count}`);
    source = source.replace(before, after);
    changed = true;
  }
  if (changed) writeFileSync(file, source, "utf8");
}

function patchAny(file, candidates, after) {
  let source = readFileSync(file, "utf8");
  if (source.includes(after)) return;
  const matches = candidates.filter((candidate) => source.includes(candidate));
  if (matches.length !== 1) throw new Error(`ForgeDock visibility patch could not find one supported block in ${file}; found ${matches.length}`);
  source = source.replace(matches[0], after);
  writeFileSync(file, source, "utf8");
}
