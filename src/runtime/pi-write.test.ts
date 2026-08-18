import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { createWriteToolDefinition, type WriteOperations } from "@earendil-works/pi-coding-agent";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { createToolHtmlRenderer } from "../../vendor/pi-runtime/dist/core/export-html/tool-renderer.js";
import { initTheme } from "../../vendor/pi-runtime/dist/modes/interactive/theme/theme.js";

initTheme("dark");

const theme = {
  fg: (_color: string, text: string) => text,
  bg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

type WriteResult = Awaited<ReturnType<ReturnType<typeof createWriteToolDefinition>["execute"]>>;

function renderContext(cwd: string, isError: boolean, lastComponent?: unknown, expanded = false) {
  return {
    args: undefined,
    toolCallId: "write-test",
    invalidate: () => {},
    lastComponent,
    state: {},
    cwd,
    executionStarted: true,
    argsComplete: true,
    isPartial: false,
    expanded,
    showImages: false,
    isError,
  } as any;
}

function rendered(component: { render: (width: number) => string[] }) {
  return component.render(120).join("\n");
}

function result(content: Array<{ type: string; text?: string }>, details: unknown = undefined): WriteResult {
  return { content, details, isError: false } as WriteResult;
}

async function execute(
  cwd: string,
  operations: WriteOperations,
  path: string,
  content: string,
  signal?: AbortSignal,
) {
  const definition = createWriteToolDefinition(cwd, { operations });
  return { definition, result: await definition.execute("write-test", { path, content }, signal, undefined, {} as never) };
}

describe("write result rendering", () => {
  it("renders every success text block when diff metadata is absent and preserves a prior component", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-write-render-"));
    try {
      const operations: WriteOperations = {
        mkdir: async () => {},
        writeFile: async () => {},
      };
      const { definition, result: writeResult } = await execute(cwd, operations, "new.txt", "new file");
      assert.equal(writeResult.details, undefined);
      const prior = definition.renderResult!(
        result([{ type: "text", text: "prior result" }]),
        { expanded: false, isPartial: false },
        theme,
        renderContext(cwd, false),
      );
      const executeRendered = definition.renderResult!(
        writeResult,
        { expanded: false, isPartial: false },
        theme,
        renderContext(cwd, false, prior),
      );
      const output = rendered(executeRendered);
      assert.equal(executeRendered, prior);
      assert.notEqual(output.trim(), "");
      assert.match(output, /Successfully wrote 8 bytes to new\.txt/);

      const allTexts = definition.renderResult!(
        result([{ type: "text", text: "first block" }, { type: "image" }, { type: "text", text: "second block" }]),
        { expanded: false, isPartial: false },
        theme,
        renderContext(cwd, false, executeRendered),
      );
      assert.equal(allTexts, executeRendered);
      assert.match(rendered(allTexts), /first block/);
      assert.match(rendered(allTexts), /second block/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("renders success text before the existing formatted diff", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-write-diff-"));
    try {
      const operations: WriteOperations = {
        mkdir: async () => {},
        readFile: async () => Buffer.from("before\n"),
        writeFile: async () => {},
      };
      const { definition, result: writeResult } = await execute(cwd, operations, "changed.txt", "after\n");
      assert.ok(writeResult.details?.diff);
      const output = rendered(definition.renderResult!(writeResult, { expanded: false, isPartial: false }, theme, renderContext(cwd, false)));
      assert.match(output, /Successfully wrote 6 bytes to changed\.txt/);
      assert.match(output, /-1 before/);
      assert.match(output, /\+1 after/);
      assert.ok(output.indexOf("Successfully wrote") < output.indexOf("-1 before"));
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps execute-backed no-diff variants successful", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-write-variants-"));
    try {
      const identical = await execute(cwd, {
        mkdir: async () => {},
        readFile: async () => Buffer.from("same"),
        writeFile: async () => {},
      }, "same.txt", "same");
      assert.equal(identical.result.details, undefined);
      assert.match(rendered(identical.definition.renderResult!(identical.result, { expanded: true, isPartial: false }, theme, renderContext(cwd, false, undefined, true))), /Successfully wrote 4 bytes/);

      const oversized = await execute(cwd, {
        mkdir: async () => {},
        readFile: async () => Buffer.from("old"),
        writeFile: async () => {},
      }, "large.txt", "x".repeat(1_000_001));
      assert.equal(oversized.result.details, undefined);
      assert.match(rendered(oversized.definition.renderResult!(oversized.result, { expanded: false, isPartial: false }, theme, renderContext(cwd, false))), /Successfully wrote 1000001 bytes/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("keeps filesystem failures and post-await aborts out of the success path", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-write-errors-"));
    try {
      await assert.rejects(execute(cwd, {
        mkdir: async () => { throw new Error("filesystem failed"); },
        writeFile: async () => {},
      }, "failed.txt", "content"));

      const controller = new AbortController();
      await assert.rejects(execute(cwd, {
        mkdir: async () => {},
        writeFile: async () => { controller.abort(); },
      }, "aborted.txt", "content", controller.signal), /Operation aborted/);

      const definition = createWriteToolDefinition(cwd, { operations: {
        mkdir: async () => { throw new Error("filesystem failed"); },
        writeFile: async () => {},
      } });
      const error = definition.renderResult!(
        { content: [{ type: "text", text: "filesystem failed" }], details: undefined },
        { expanded: false, isPartial: false },
        theme,
        renderContext(cwd, true),
      );
      const output = rendered(error);
      assert.match(output, /filesystem failed/);
      assert.doesNotMatch(output, /Successfully wrote/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("holds the same-path mutation queue until the first asynchronous write settles", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-write-queue-"));
    try {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      let firstStarted!: () => void;
      const started = new Promise<void>((resolve) => { firstStarted = resolve; });
      let calls = 0;
      const definition = createWriteToolDefinition(cwd, { operations: {
        mkdir: async () => {},
        writeFile: async () => {
          calls += 1;
          if (calls === 1) {
            firstStarted();
            await gate;
          }
        },
      } });
      const first = definition.execute("first", { path: "same.txt", content: "one" }, undefined, undefined, {} as never);
      await started;
      const second = definition.execute("second", { path: "same.txt", content: "two" }, undefined, undefined, {} as never);
      await new Promise<void>((resolve) => setImmediate(resolve));
      assert.equal(calls, 1);
      release();
      await Promise.all([first, second]);
      assert.equal(calls, 2);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("write renderer integration boundaries", () => {
  it("renders through interactive-shaped contexts and the HTML adapter", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-write-adapters-"));
    try {
      const definition = createWriteToolDefinition(cwd, { operations: {
        mkdir: async () => {},
        writeFile: async () => {},
      } });
      const writeResult = await definition.execute("adapter", { path: "adapter.txt", content: "adapter" }, undefined, undefined, {} as never);
      for (const expanded of [false, true]) {
        const component = definition.renderResult!(writeResult, { expanded, isPartial: false }, theme, renderContext(cwd, false, undefined, expanded));
        assert.match(rendered(component), /Successfully wrote 7 bytes to adapter\.txt/);
      }

      const html = createToolHtmlRenderer({
        getToolDefinition: (name) => name === "write" ? definition as any : undefined,
        theme,
        cwd,
      }).renderResult("adapter", "write", writeResult.content, writeResult.details, false);
      assert.ok(html);
      const htmlExpanded = html.expanded;
      assert.ok(htmlExpanded);
      assert.match(htmlExpanded, /Successfully wrote 7 bytes to adapter\.txt/);
      assert.match(html.collapsed ?? htmlExpanded, /Successfully wrote 7 bytes to adapter\.txt/);

      const errorHtml = createToolHtmlRenderer({ getToolDefinition: () => definition as any, theme, cwd })
        .renderResult("error", "write", [{ type: "text", text: "write failed" }], undefined, true);
      assert.ok(errorHtml);
      const errorHtmlExpanded = errorHtml.expanded;
      assert.ok(errorHtmlExpanded);
      assert.match(errorHtmlExpanded, /write failed/);
      assert.doesNotMatch(errorHtmlExpanded, /Successfully wrote/);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
