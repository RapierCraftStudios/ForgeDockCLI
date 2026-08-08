// SPDX-License-Identifier: AGPL-3.0-or-later

import { BuildPacketPayloadSchema, createArtifact, type BuildPacketPayload, type DurableArtifact } from "../../core/artifacts/schema.js";
import type { ArtifactRepository, RunRepository } from "../../core/ports/repositories.js";
import { attachArtifact, transition, type RunState } from "../../core/state/machine.js";
import { assertConcreteScopePaths, scopeManifestFor, type AgentEventSink, type AgentRuntime, type ScopeHints } from "../../runtime/agent-runtime.js";
import { WorkflowExecutionError } from "./investigate.js";

export async function prepareBuildPacket(
  input: {
    run: RunState;
    intent: DurableArtifact<"Intent">;
    investigation: DurableArtifact<"Investigation">;
    cwd: string;
    scopeHints?: ScopeHints;
    provider?: string;
    model?: string;
    signal?: AbortSignal;
  },
  dependencies: {
    runtime: AgentRuntime;
    artifacts: ArtifactRepository;
    runs: RunRepository;
    onAgentEvent?: AgentEventSink;
  },
): Promise<{ run: RunState; packet: DurableArtifact<"BuildPacket">; sessionRef: string }> {
  if (input.run.state !== "preparing") throw new Error(`Build Packet requires preparing state, found ${input.run.state}`);
  let run = input.run;
  try {
    const result = await dependencies.runtime.run<BuildPacketPayload>({
      id: `${run.runId}:build-packet:${run.attempt}`,
      role: "packet-author",
      objective: "Freeze a buildable, reviewable contract from the proven issue intent and investigation.",
      instructions: [
        "Every acceptance criterion must be observable and testable.",
        "Include implementation-specific history and consistency constraints only when relevant.",
        "Expected paths must be concrete repository-relative files and are the frozen write/conflict boundary; never emit globs, absolute paths, traversal, or line-location suffixes.",
        "When a shared interface or contract changes, include every affected implementation and test-double path that may need edits, especially all paths declared by the issue. The builder cannot edit a path omitted from this packet.",
        "Put each executable verification command in backticks. The controller safely supports git diff --check and package.json scripts named lint, typecheck, check, build, docs:build, or test; unsupported executable plans block rather than being reported as run.",
        "State exclusions explicitly. Do not modify the repository.",
      ].join("\n"),
      context: [input.intent, input.investigation],
      workspace: {
        cwd: input.cwd,
        mode: "read-only",
        scope: scopeManifestFor("issue-hints", {
          affectedFiles: [
            ...(input.scopeHints?.affectedFiles ?? []),
            ...input.investigation.payload.affectedSurfaces,
          ],
          ...(input.scopeHints?.claims ? { claims: [...input.scopeHints.claims] } : {}),
          metadataRoots: ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "tsconfig.json", "forge.yaml", "FORGE.md"],
        }),
      },
      tools: ["read", "grep", "find", "ls"],
      outputSchema: BuildPacketPayloadSchema,
      modelPolicy: {
        ...(input.provider !== undefined ? { provider: input.provider } : {}),
        ...(input.model !== undefined ? { model: input.model } : {}),
      },
    }, {
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
      ...(dependencies.onAgentEvent !== undefined ? { onEvent: dependencies.onAgentEvent } : {}),
    });

    if (!result.output.expectedPaths.length) throw new Error("Build Packet must declare at least one concrete expected path");
    assertConcreteScopePaths(result.output.expectedPaths);
    const packet = createArtifact({
      kind: "BuildPacket",
      runId: run.runId,
      subject: run.subject,
      producer: { role: "packet-author", runtime: "pi-compatible", provider: result.provider, model: result.model },
      payload: result.output,
    });
    await dependencies.artifacts.append(packet);
    run = attachArtifact(run, "BuildPacket", packet.id);
    const advanced = transition(run, "BUILD_PACKET_READY");
    await dependencies.runs.commit(run.version, advanced.state, advanced.record);
    return { run: advanced.state, packet, sessionRef: result.sessionRef };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failed = transition(run, "FAIL", { reason });
    await dependencies.runs.commit(run.version, failed.state, failed.record);
    throw new WorkflowExecutionError(reason, failed.state, { cause: error });
  }
}
