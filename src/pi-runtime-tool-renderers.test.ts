import assert from "node:assert/strict";
import { test } from "node:test";
import { createToolHtmlRenderer } from "../vendor/pi-runtime/dist/core/export-html/tool-renderer.js";
import { createGrepToolDefinition } from "../vendor/pi-runtime/dist/core/tools/grep.js";
import { createLsToolDefinition } from "../vendor/pi-runtime/dist/core/tools/ls.js";
import type { LsToolDetails } from "../vendor/pi-runtime/dist/core/tools/ls.js";
import { initTheme } from "../vendor/pi-runtime/dist/modes/interactive/theme/theme.js";

initTheme("dark");

const cwd = "/workspace";
const theme = {
    fg: (_color: string, text: string) => text,
    bold: (text: string) => text,
} as any;

function renderResult(definition: any, result: any, expanded = false, isError = false): string {
    const component = definition.renderResult(result, { expanded, isPartial: false }, theme, {
        cwd,
        showImages: false,
        isError,
        lastComponent: undefined,
    });
    return component.render(200).map((line: string) => line.trimEnd()).join("\n");
}

function renderHtml(definitions: Map<string, any>, id: string, name: string, result: any, isError = false) {
    return createToolHtmlRenderer({
        getToolDefinition: (toolName) => definitions.get(toolName),
        theme,
        cwd,
        width: 200,
    }).renderResult(id, name, result.content, result.details, isError);
}

async function execute(definition: any, args: any, signal?: AbortSignal): Promise<any> {
    return definition.execute("test-call", args, signal, undefined, undefined);
}

type LsResult = Awaited<ReturnType<ReturnType<typeof createLsToolDefinition>["execute"]>>;

function readLsEntryCount(result: LsResult): number | undefined {
    const details: LsToolDetails | undefined = result.details;
    return details?.entryCount;
}

function grepDefinition(search: (request: any) => Promise<any> | any, readFile = "before\nneedle\nafter") {
    return createGrepToolDefinition(cwd, {
        operations: {
            isDirectory: () => true,
            readFile: () => readFile,
            search,
        },
    });
}

function lsDefinition(entries: string[], stat: (path: string) => { isDirectory: () => boolean } = () => ({ isDirectory: () => false })) {
    return createLsToolDefinition(cwd, {
        operations: {
            exists: () => true,
            stat: (path) => path === cwd ? { isDirectory: () => true } : stat(path),
            readdir: () => [...entries],
        },
    });
}

test("invariant:matrix-chunk-boundary-773e1a6c0ac0 ls declaration keeps entryCount optional", () => {
    const olderDetails: LsToolDetails = { entryLimitReached: 1 };
    const olderResult: LsResult = { content: [], details: olderDetails };
    assert.equal(readLsEntryCount(olderResult), undefined);
});

test("grep exposes semantic counts and excludes context and limit notices", async () => {
    const definition = grepDefinition(() => ({
        matches: [
            { filePath: "/workspace/file.txt", lineNumber: 2, lineText: "needle" },
            { filePath: "/workspace/file.txt", lineNumber: 3, lineText: "needle two" },
        ],
        truncated: true,
    }));
    const result = await execute(definition, { pattern: "needle", context: 1, limit: 1 });

    assert.equal(result.details.matchCount, 1);
    assert.equal(result.details.matchLimitReached, 1);
    assert.match(result.content[0].text, /file\.txt-1- before/);
    assert.match(result.content[0].text, /\[1 matches limit reached/);
    assert.match(renderResult(definition, result), /↳ 1 match/);
    assert.doesNotMatch(renderResult(definition, result), /↳ 3 matches/);
    assert.match(renderResult(definition, result, true), /file\.txt-1- before/);
});

test("grep no-match sentinel has a zero count", async () => {
    const definition = grepDefinition(() => ({ matches: [] }));
    const result = await execute(definition, { pattern: "missing" });

    assert.deepEqual(result.details, { matchCount: 0 });
    assert.equal(result.content[0].text, "No matches found");
    assert.match(renderResult(definition, result), /↳ 0 matches/);
    assert.match(renderResult(definition, result, true), /No matches found/);
});

test("grep line and byte warnings retain actual match count", async () => {
    const lineDefinition = grepDefinition(() => ({
        matches: [{ filePath: "/workspace/file.txt", lineNumber: 1, lineText: "x".repeat(501) }],
    }));
    const lineResult = await execute(lineDefinition, { pattern: "x" });
    assert.equal(lineResult.details.matchCount, 1);
    assert.equal(lineResult.details.linesTruncated, true);
    assert.match(renderResult(lineDefinition, lineResult), /↳ 1 match/);
    assert.match(renderResult(lineDefinition, lineResult), /some lines truncated/);

    const byteDefinition = grepDefinition(() => ({
        matches: Array.from({ length: 120 }, (_, index) => ({
            filePath: "/workspace/file.txt",
            lineNumber: index + 1,
            lineText: "y".repeat(500),
        })),
    }));
    const byteResult = await execute(byteDefinition, { pattern: "y", limit: 200 });
    assert.equal(byteResult.details.matchCount, 120);
    assert.equal(byteResult.details.truncation.truncatedBy, "bytes");
    assert.match(renderResult(byteDefinition, byteResult), /↳ 120 matches/);
});

test("ls exposes semantic counts for empty, ordinary, and limited listings", async () => {
    const empty = lsDefinition([]);
    const emptyResult = await execute(empty, {});
    assert.deepEqual(emptyResult.details, { entryCount: 0 });
    assert.equal(readLsEntryCount(emptyResult), 0);
    assert.equal(emptyResult.content[0].text, "(empty directory)");
    assert.match(renderResult(empty, emptyResult), /↳ 0 entries/);
    assert.match(renderResult(empty, emptyResult, true), /\(empty directory\)/);

    const ordinary = lsDefinition(["z.txt", "alpha", "folder"], (path) => ({
        isDirectory: () => path.endsWith("folder"),
    }));
    const ordinaryResult = await execute(ordinary, {});
    assert.equal(readLsEntryCount(ordinaryResult), 3);
    assert.equal(ordinaryResult.content[0].text, "alpha\nfolder/\nz.txt");
    assert.match(renderResult(ordinary, ordinaryResult), /↳ 3 entries/);
    assert.match(renderResult(ordinary, ordinaryResult, true), /alpha\nfolder\/\nz\.txt/);

    const limited = lsDefinition(["a", "b", "c"]);
    const limitedResult = await execute(limited, { limit: 2 });
    assert.equal(readLsEntryCount(limitedResult), 2);
    assert.equal(limitedResult.details.entryLimitReached, 2);
    assert.match(renderResult(limited, limitedResult), /↳ 2 entries/);
    assert.match(renderResult(limited, limitedResult), /\[Truncated: 2 entries limit\]/);
    assert.match(renderResult(limited, limitedResult, true), /a\nb/);
    assert.match(renderResult(limited, limitedResult, true), /\[Truncated: 2 entries limit\]/);
});

test("ls byte warning does not inflate its entry count", async () => {
    const definition = lsDefinition(Array.from({ length: 200 }, (_, index) => `${String(index).padStart(3, "0")}-${"z".repeat(300)}`));
    const result = await execute(definition, {});

    assert.equal(readLsEntryCount(result), 200);
    assert.equal(result.details.truncation.truncatedBy, "bytes");
    assert.match(renderResult(definition, result), /↳ 200 entries/);
    assert.doesNotMatch(renderResult(definition, result), /↳ 2000 entries/);
    assert.match(renderResult(definition, result), /\[Truncated: 50\.0KB limit\]/);
    assert.match(renderResult(definition, result, true), /\[Truncated: 50\.0KB limit\]/);
});

test("TUI and HTML renderers preserve expanded text and suppress success summaries for errors", async () => {
    const grep = grepDefinition(() => ({ matches: [] }));
    const ls = lsDefinition([]);
    const definitions = new Map<string, any>([["grep", grep], ["ls", ls]]);
    const grepResult = await execute(grep, { pattern: "missing" });
    const lsResult = await execute(ls, {});

    const grepHtml = renderHtml(definitions, "grep-call", "grep", grepResult);
    const lsHtml = renderHtml(definitions, "ls-call", "ls", lsResult);
    assert.match(grepHtml?.collapsed ?? "", /↳ 0 matches/);
    assert.match(grepHtml?.expanded ?? "", /No matches found/);
    assert.match(lsHtml?.collapsed ?? "", /↳ 0 entries/);
    assert.match(lsHtml?.expanded ?? "", /\(empty directory\)/);

    const error = { content: [{ type: "text", text: "permission denied" }], details: { matchCount: 3 } };
    assert.doesNotMatch(renderResult(grep, error, false, true), /↳/);
    assert.doesNotMatch(renderResult(grep, { content: [{ type: "text", text: "one result" }] }), /↳/);
    await assert.rejects(execute(createLsToolDefinition(cwd, {
        operations: {
            exists: () => false,
            stat: () => ({ isDirectory: () => false }),
            readdir: () => [],
        },
    }), {}), /Path not found/);
    const errorHtml = renderHtml(definitions, "error-call", "grep", error, true);
    assert.doesNotMatch(errorHtml?.collapsed ?? "", /↳/);
    assert.match(errorHtml?.expanded ?? "", /permission denied/);
});

test("ls missing paths, non-directories, and readdir failures reject", async () => {
    const missing = createLsToolDefinition(cwd, {
        operations: {
            exists: () => false,
            stat: () => ({ isDirectory: () => true }),
            readdir: () => [],
        },
    });
    await assert.rejects(execute(missing, {}), /Path not found: \/workspace/);

    const nonDirectory = createLsToolDefinition(cwd, {
        operations: {
            exists: () => true,
            stat: () => ({ isDirectory: () => false }),
            readdir: () => [],
        },
    });
    await assert.rejects(execute(nonDirectory, {}), /Not a directory: \/workspace/);

    const unreadable = createLsToolDefinition(cwd, {
        operations: {
            exists: () => true,
            stat: () => ({ isDirectory: () => true }),
            readdir: () => { throw new Error("permission denied"); },
        },
    });
    await assert.rejects(execute(unreadable, {}), /Cannot read directory: permission denied/);
});

test("ls concurrent executions retain independent counts and output", async () => {
    const entrySets = new Map([
        ["/workspace/one", ["one-a", "one-b"]],
        ["/workspace/two", ["two-a", "two-b", "two-c"]],
    ]);
    let release!: () => void;
    const bothReadsStarted = new Promise<void>((resolve) => { release = resolve; });
    let readsStarted = 0;
    const definition = createLsToolDefinition(cwd, {
        operations: {
            exists: (path) => entrySets.has(path),
            stat: (path) => ({ isDirectory: () => path === cwd || entrySets.has(path) }),
            readdir: async (path) => {
                readsStarted += 1;
                if (readsStarted === 2) release();
                await bothReadsStarted;
                return [...entrySets.get(path)!];
            },
        },
    });

    const [one, two] = await Promise.all([
        execute(definition, { path: "one" }),
        execute(definition, { path: "two" }),
    ]);
    assert.equal(readLsEntryCount(one), 2);
    assert.equal(readLsEntryCount(two), 3);
    assert.equal(one.content[0].text, "one-a\none-b");
    assert.equal(two.content[0].text, "two-a\ntwo-b\ntwo-c");
});

test("grep and ls abort paths reject without publishing a successful result", async () => {
    const preAborted = new AbortController();
    preAborted.abort();
    const preAbortedLs = lsDefinition(["should-not-be-returned"]);
    await assert.rejects(execute(preAbortedLs, {}, preAborted.signal), /Operation aborted/);

    const grepController = new AbortController();
    const grep = grepDefinition(({ signal }: any) => new Promise((resolve) => {
        signal?.addEventListener("abort", () => resolve({ matches: [] }), { once: true });
    }));
    const grepPromise = execute(grep, { pattern: "needle" }, grepController.signal);
    grepController.abort();
    await assert.rejects(grepPromise, /Operation aborted/);

    const lsController = new AbortController();
    const ls = createLsToolDefinition(cwd, {
        operations: {
            exists: () => new Promise((resolve) => {
                lsController.signal.addEventListener("abort", () => resolve(true), { once: true });
            }),
            stat: () => ({ isDirectory: () => true }),
            readdir: () => [],
        },
    });
    const lsPromise = execute(ls, {}, lsController.signal);
    lsController.abort();
    await assert.rejects(lsPromise, /Operation aborted/);
});
