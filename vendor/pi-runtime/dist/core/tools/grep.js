import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { Text } from "@earendil-works/pi-tui";
import { spawn } from "child_process";
import path from "path";
import { Type } from "typebox";
import { keyHint } from "../../modes/interactive/components/keybinding-hints.js";
import { ensureTool } from "../../utils/tools-manager.js";
import { resolveToCwd } from "./path-utils.js";
import { getTextOutput, invalidArgText, shortenPath, str } from "./render-utils.js";
import { wrapToolDefinition } from "./tool-definition-wrapper.js";
import { DEFAULT_MAX_BYTES, formatSize, GREP_MAX_LINE_LENGTH, truncateHead, truncateLine, } from "./truncate.js";
const grepSchema = Type.Object({
    pattern: Type.String({ description: "Search pattern (regex or literal string)" }),
    path: Type.Optional(Type.String({ description: "Directory or file to search (default: current directory)" })),
    glob: Type.Optional(Type.String({ description: "Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'" })),
    ignoreCase: Type.Optional(Type.Boolean({ description: "Case-insensitive search (default: false)" })),
    literal: Type.Optional(Type.Boolean({ description: "Treat pattern as literal string instead of regex (default: false)" })),
    context: Type.Optional(Type.Number({ description: "Number of lines to show before and after each match (default: 0)" })),
    limit: Type.Optional(Type.Number({ description: "Maximum number of matches to return (default: 100)" })),
});
const DEFAULT_LIMIT = 100;
const defaultGrepOperations = {
    isDirectory: async (p) => (await fsStat(p)).isDirectory(),
    readFile: (p) => fsReadFile(p, "utf-8"),
};
function formatGrepCall(args, theme) {
    const pattern = str(args?.pattern);
    const rawPath = str(args?.path);
    const path = rawPath !== null ? shortenPath(rawPath || ".") : null;
    const glob = str(args?.glob);
    const limit = args?.limit;
    const invalidArg = invalidArgText(theme);
    let text = theme.fg("toolTitle", theme.bold("grep")) +
        " " +
        (pattern === null ? invalidArg : theme.fg("accent", `/${pattern || ""}/`)) +
        theme.fg("toolOutput", ` in ${path === null ? invalidArg : path}`);
    if (glob)
        text += theme.fg("toolOutput", ` (${glob})`);
    if (limit !== undefined)
        text += theme.fg("toolOutput", ` limit ${limit}`);
    return text;
}
function formatGrepResult(result, options, theme, showImages, isError = false) {
    const output = getTextOutput(result, showImages).trim();
    let text = "";
    if (output) {
        const lines = output.split("\n");
        if (!options.expanded && !isError) {
            const count = result.details?.matchCount;
            if (typeof count === "number") text += `\n${theme.fg("muted", `↳ ${count} ${count === 1 ? "match" : "matches"} ·`)} ${keyHint("app.tools.expand", "to preview")}`;
        }
        else {
            const maxLines = options.expanded ? lines.length : 15;
            const displayLines = lines.slice(0, maxLines);
            const remaining = lines.length - maxLines;
            text += `\n${displayLines.map((line) => theme.fg("toolOutput", line)).join("\n")}`;
            if (remaining > 0) {
                text += `${theme.fg("muted", `\n... (${remaining} more lines,`)} ${keyHint("app.tools.expand", "to expand")}${theme.fg("muted", ")")}`;
            }
        }
    }
    const matchLimit = result.details?.matchLimitReached;
    const truncation = result.details?.truncation;
    const linesTruncated = result.details?.linesTruncated;
    if (matchLimit || truncation?.truncated || linesTruncated) {
        const warnings = [];
        if (matchLimit)
            warnings.push(`${matchLimit} matches limit`);
        if (truncation?.truncated)
            warnings.push(`${formatSize(truncation.maxBytes ?? DEFAULT_MAX_BYTES)} limit`);
        if (linesTruncated)
            warnings.push("some lines truncated");
        text += `\n${theme.fg("warning", `[Truncated: ${warnings.join(", ")}]`)}`;
    }
    return text;
}
export function createGrepToolDefinition(cwd, options) {
    const customOps = options?.operations;
    return {
        name: "grep",
        label: "grep",
        description: `Search file contents for a pattern. Returns matching lines with file paths and line numbers. Respects .gitignore. Output is truncated to ${DEFAULT_LIMIT} matches or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Long lines are truncated to ${GREP_MAX_LINE_LENGTH} chars.`,
        promptSnippet: "Search file contents for patterns (respects .gitignore)",
        parameters: grepSchema,
        async execute(_toolCallId, { pattern, path: searchDir, glob, ignoreCase, literal, context, limit, }, signal, _onUpdate, _ctx) {
            return new Promise((resolve, reject) => {
                if (signal?.aborted) {
                    reject(new Error("Operation aborted"));
                    return;
                }
                let settled = false;
                let stopChild;
                const onAbort = () => {
                    stopChild?.();
                    settle(() => reject(new Error("Operation aborted")));
                };
                const settle = (fn) => {
                    if (!settled) {
                        settled = true;
                        signal?.removeEventListener("abort", onAbort);
                        stopChild = undefined;
                        fn();
                    }
                };
                signal?.addEventListener("abort", onAbort, { once: true });
                (async () => {
                    try {
                        const searchPath = resolveToCwd(searchDir || ".", cwd);
                        const ops = customOps ?? defaultGrepOperations;
                        let isDirectory;
                        try {
                            isDirectory = await ops.isDirectory(searchPath);
                        }
                        catch {
                            settle(() => reject(new Error(`Path not found: ${searchPath}`)));
                            return;
                        }
                        if (settled)
                            return;
                        const contextValue = context && context > 0 ? context : 0;
                        const effectiveLimit = Math.max(1, limit ?? DEFAULT_LIMIT);
                        const formatPath = (filePath) => {
                            if (isDirectory) {
                                const relative = path.relative(searchPath, filePath);
                                if (relative && !relative.startsWith("..")) {
                                    return relative.replace(/\\/g, "/");
                                }
                            }
                            return path.basename(filePath);
                        };
                        let linesTruncated = false;
                        const fileCache = new Map();
                        const getFileLines = async (filePath) => {
                            let lines = fileCache.get(filePath);
                            if (!lines) {
                                try {
                                    const content = await ops.readFile(filePath);
                                    lines = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
                                }
                                catch {
                                    lines = [];
                                }
                                fileCache.set(filePath, lines);
                            }
                            return lines;
                        };
                        const formatBlock = async (filePath, lineNumber) => {
                            const relativePath = formatPath(filePath);
                            const lines = await getFileLines(filePath);
                            if (!lines.length)
                                return [`${relativePath}:${lineNumber}: (unable to read file)`];
                            const block = [];
                            const start = contextValue > 0 ? Math.max(1, lineNumber - contextValue) : lineNumber;
                            const end = contextValue > 0 ? Math.min(lines.length, lineNumber + contextValue) : lineNumber;
                            for (let current = start; current <= end; current++) {
                                const lineText = lines[current - 1] ?? "";
                                const sanitized = lineText.replace(/\r/g, "");
                                const isMatchLine = current === lineNumber;
                                const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
                                if (wasTruncated)
                                    linesTruncated = true;
                                if (isMatchLine)
                                    block.push(`${relativePath}:${current}: ${truncatedText}`);
                                else
                                    block.push(`${relativePath}-${current}- ${truncatedText}`);
                            }
                            return block;
                        };
                        const finishMatches = async (matches, matchLimitReached) => {
                            if (settled)
                                return;
                            if (signal?.aborted)
                                throw new Error("Operation aborted");
                            if (matches.length === 0) {
                                settle(() => resolve({ content: [{ type: "text", text: "No matches found" }], details: { matchCount: 0 } }));
                                return;
                            }
                            const outputLines = [];
                            for (const match of matches) {
                                if (signal?.aborted)
                                    throw new Error("Operation aborted");
                                if (contextValue === 0 && match.lineText !== undefined) {
                                    const relativePath = formatPath(match.filePath);
                                    const sanitized = match.lineText
                                        .replace(/\r\n/g, "\n")
                                        .replace(/\r/g, "")
                                        .replace(/\n$/, "");
                                    const { text: truncatedText, wasTruncated } = truncateLine(sanitized);
                                    if (wasTruncated)
                                        linesTruncated = true;
                                    outputLines.push(`${relativePath}:${match.lineNumber}: ${truncatedText}`);
                                }
                                else {
                                    const block = await formatBlock(match.filePath, match.lineNumber);
                                    outputLines.push(...block);
                                }
                            }
                            const rawOutput = outputLines.join("\n");
                            const truncation = truncateHead(rawOutput, { maxLines: Number.MAX_SAFE_INTEGER });
                            let output = truncation.content;
                            const details = { matchCount: matches.length };
                            const notices = [];
                            if (matchLimitReached) {
                                notices.push(`${effectiveLimit} matches limit reached. Use limit=${effectiveLimit * 2} for more, or refine pattern`);
                                details.matchLimitReached = effectiveLimit;
                            }
                            if (truncation.truncated) {
                                notices.push(`${formatSize(DEFAULT_MAX_BYTES)} limit reached`);
                                details.truncation = truncation;
                            }
                            if (linesTruncated) {
                                notices.push(`Some lines truncated to ${GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines`);
                                details.linesTruncated = true;
                            }
                            if (notices.length > 0)
                                output += `\n\n[${notices.join(". ")}]`;
                            settle(() => resolve({
                                content: [{ type: "text", text: output }],
                                details: Object.keys(details).length > 0 ? details : undefined,
                            }));
                        };
                        if (customOps?.search) {
                            const result = await customOps.search({
                                pattern,
                                path: searchPath,
                                glob,
                                ignoreCase: ignoreCase ?? false,
                                literal: literal ?? false,
                                maxResults: effectiveLimit,
                                signal,
                            });
                            if (settled)
                                return;
                            const matches = result.matches.slice(0, effectiveLimit);
                            await finishMatches(matches, result.truncated === true || result.matches.length > effectiveLimit);
                            return;
                        }
                        const rgPath = await ensureTool("rg", true);
                        if (settled)
                            return;
                        if (!rgPath) {
                            settle(() => reject(new Error("ripgrep (rg) is not available and could not be downloaded")));
                            return;
                        }
                        const args = ["--json", "--line-number", "--color=never", "--hidden"];
                        if (ignoreCase)
                            args.push("--ignore-case");
                        if (literal)
                            args.push("--fixed-strings");
                        if (glob)
                            args.push("--glob", glob);
                        args.push("--", pattern, searchPath);
                        const child = spawn(rgPath, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
                        const rl = createInterface({ input: child.stdout });
                        let stderr = "";
                        let matchCount = 0;
                        let matchLimitReached = false;
                        let killedDueToLimit = false;
                        const cleanup = () => {
                            rl.close();
                        };
                        stopChild = (dueToLimit = false) => {
                            if (!child.killed) {
                                killedDueToLimit = dueToLimit;
                                child.kill();
                            }
                        };
                        child.stderr?.on("data", (chunk) => {
                            stderr += chunk.toString();
                        });
                        // Collect matches during streaming, then format them after rg exits.
                        const matches = [];
                        rl.on("line", (line) => {
                            if (!line.trim() || matchCount >= effectiveLimit)
                                return;
                            let event;
                            try {
                                event = JSON.parse(line);
                            }
                            catch {
                                return;
                            }
                            if (event.type === "match") {
                                matchCount++;
                                const filePath = event.data?.path?.text;
                                const lineNumber = event.data?.line_number;
                                const lineText = event.data?.lines?.text;
                                if (filePath && typeof lineNumber === "number")
                                    matches.push({ filePath, lineNumber, lineText });
                                if (matchCount >= effectiveLimit) {
                                    matchLimitReached = true;
                                    stopChild?.(true);
                                }
                            }
                        });
                        child.on("error", (error) => {
                            cleanup();
                            settle(() => reject(new Error(`Failed to run ripgrep: ${error.message}`)));
                        });
                        child.on("close", async (code) => {
                            cleanup();
                            if (settled || signal?.aborted)
                                return;
                            if (!killedDueToLimit && code !== 0 && code !== 1) {
                                const errorMsg = stderr.trim() || `ripgrep exited with code ${code}`;
                                settle(() => reject(new Error(errorMsg)));
                                return;
                            }
                            try {
                                await finishMatches(matches, matchLimitReached);
                            }
                            catch (err) {
                                const error = signal?.aborted ? new Error("Operation aborted") : err;
                                settle(() => reject(error));
                            }
                        });
                    }
                    catch (err) {
                        const error = signal?.aborted ? new Error("Operation aborted") : err;
                        settle(() => reject(error));
                    }
                })();
            });
        },
        renderCall(args, theme, context) {
            const text = context.lastComponent ?? new Text("", 0, 0);
            text.setText(formatGrepCall(args, theme));
            return text;
        },
        renderResult(result, options, theme, context) {
            const text = context.lastComponent ?? new Text("", 0, 0);
            text.setText(formatGrepResult(result, options, theme, context.showImages, context.isError));
            return text;
        },
    };
}
export function createGrepTool(cwd, options) {
    return wrapToolDefinition(createGrepToolDefinition(cwd, options));
}
//# sourceMappingURL=grep.js.map