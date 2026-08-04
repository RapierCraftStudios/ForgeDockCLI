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
// is the authoritative result. A failed optional probe must remain negative
// evidence instead of invalidating an artifact the reviewer subsequently
// completed. Keep this exception scoped to the ForgeDock reviewer; mutating
// or general-purpose subagents retain pi-subagents' fail-on-tool-error policy.
patch(join(root, "src", "runs", "foreground", "execution.ts"), [[
  "\t\tconst errInfo = detectSubagentError(messages);",
  "\t\tconst completedForgeDockReview = agent.name === \"forgedock-reviewer\" && options.structuredOutput !== undefined && structuredOutputToolInvoked && existsSync(options.structuredOutput.outputPath);\n\t\tconst errInfo = completedForgeDockReview ? detectSubagentError([]) : detectSubagentError(messages);",
]]);

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
  ],
]);

function patch(file, replacements) {
  let source = readFileSync(file, "utf8");
  let changed = false;
  for (const [before, after] of replacements) {
    if (source.includes(after)) continue;
    const count = source.split(before).length - 1;
    if (count !== 1) throw new Error(`ForgeDock visibility patch could not find one expected block in ${file}; found ${count}`);
    source = source.replace(before, after);
    changed = true;
  }
  if (changed) writeFileSync(file, source, "utf8");
}
