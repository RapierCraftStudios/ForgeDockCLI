// SPDX-License-Identifier: AGPL-3.0-or-later

import {
  assertArtifact,
  type BuildPacketPayload,
  type BuildResultPayload,
  type DurableArtifact,
  type IntentPayload,
  type InvestigationPayload,
  type OutcomePayload,
  type RemediationBlockedPayload,
  type VerificationAdjudicationPayload,
  type ReviewVerdictPayload,
} from "./schema.js";

const MARKER = /<!--\s*FORGEDOCK:ARTIFACT\s+v2\s+b64:([A-Za-z0-9_-]+)\s*-->/g;

export function encodeArtifactMarker(artifact: DurableArtifact): string {
  assertArtifact(artifact);
  const encoded = Buffer.from(JSON.stringify(artifact), "utf8").toString("base64url");
  return `<!-- FORGEDOCK:ARTIFACT v2 b64:${encoded} -->`;
}

export function decodeArtifactMarker(marker: string): DurableArtifact {
  const match = /<!--\s*FORGEDOCK:ARTIFACT\s+v2\s+b64:([A-Za-z0-9_-]+)\s*-->/.exec(marker);
  if (!match?.[1]) throw new Error("ForgeDock v2 artifact marker not found");
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(match[1], "base64url").toString("utf8"));
  } catch (error) {
    throw new Error("ForgeDock artifact marker contains invalid JSON", { cause: error });
  }
  assertArtifact(parsed);
  return parsed;
}

export function findArtifacts(text: string): DurableArtifact[] {
  const artifacts: DurableArtifact[] = [];
  for (const match of text.matchAll(MARKER)) {
    if (!match[1]) continue;
    try {
      artifacts.push(decodeArtifactMarker(match[0]));
    } catch {
      // A damaged marker must not hide later valid artifacts.
    }
  }
  return artifacts;
}

export function renderArtifactComment(artifact: DurableArtifact): string {
  return `${escapeArtifactText(renderArtifactMarkdown(artifact))}\n\n${encodeArtifactMarker(artifact)}`;
}

export function renderArtifactMarkdown(artifact: DurableArtifact): string {
  const heading = `## ForgeDock · ${splitKind(artifact.kind)}`;
  const meta = `Run \`${artifact.runId}\` · artifact \`${artifact.id}\``;

  switch (artifact.kind) {
    case "Intent": {
      const payload = artifact.payload as IntentPayload;
      return [heading, meta, "", `### ${payload.title}`, payload.problem,
        listSection("Desired outcome", payload.desiredOutcome ? [payload.desiredOutcome] : []),
        listSection("Constraints", payload.constraints),
        listSection("Acceptance hints", payload.acceptanceHints),
        listSection("Dependencies", payload.dependencies),
      ].filter(Boolean).join("\n");
    }
    case "Investigation": {
      const payload = artifact.payload as InvestigationPayload;
      return [heading, meta, "", `**Outcome:** \`${payload.outcome}\` · **Confidence:** \`${payload.confidence}\``, "", payload.summary,
        listSection("Evidence", payload.evidence.map((item) => `**${item.claim}** — ${item.detail} _(source: ${item.source})_`)),
        payload.rootCause ? `### Root cause\n${payload.rootCause}` : "",
        listSection("Affected surfaces", payload.affectedSurfaces.map(code)),
        listSection("Risks", payload.risks),
        `### Recommendation\n${payload.recommendation}`,
        payload.decomposition ? listSection("Proposed child intents", payload.decomposition.map((child) => `**${child.title}** — ${child.outcome}`)) : "",
      ].filter(Boolean).join("\n\n");
    }
    case "BuildPacket": {
      const payload = artifact.payload as BuildPacketPayload;
      return [heading, meta,
        listSection("Scope", payload.scope),
        checklistSection("Acceptance criteria", payload.acceptanceCriteria),
        listSection("Implementation context", payload.context.map((item) => `**${item.source}** — ${item.relevance}`)),
        listSection("Implementation plan", payload.implementationPlan, true),
        listSection("Expected paths", payload.expectedPaths.map(code)),
        listSection("Verification plan", payload.verificationPlan),
        payload.controllerGates?.length
          ? listSection("Controller-owned gates", payload.controllerGates.map((gate) => `**${gate.id}** — ${gate.description}`))
          : "",
        listSection("Risks and mitigations", payload.risks.map((item) => `**${item.risk}** — ${item.mitigation}`)),
        listSection("Out of scope", payload.outOfScope),
      ].filter(Boolean).join("\n\n");
    }
    case "BuildResult": {
      const payload = artifact.payload as BuildResultPayload;
      return [heading, meta, "", `**Branch:** \`${payload.branch}\` · **Target:** \`${payload.targetBranch ?? "unset"}\`${payload.promotionTarget ? ` · **Promotion:** \`${payload.promotionTarget}\`` : ""}${payload.productionTarget ? ` · **Production:** \`${payload.productionTarget}\`` : ""} · **Head:** \`${payload.headSha}\`${payload.baseSha ? ` · **Frozen base:** \`${payload.baseSha}\`` : ""}`, "", payload.summary,
        listSection("Changed paths", payload.changedPaths.map(code)),
        checklistSection("Acceptance evidence", payload.acceptanceEvidence.map((item) => `${item.criterion} — ${item.status}: ${item.evidence}`), payload.acceptanceEvidence.map((item) => item.status === "passed")),
        checkTable(payload.checks),
        listSection("Decisions", payload.decisions),
        listSection("Residual risks", payload.residualRisks),
      ].filter(Boolean).join("\n\n");
    }
    case "ReviewVerdict": {
      const payload = artifact.payload as ReviewVerdictPayload;
      return [heading, meta, "", `**Disposition:** \`${payload.disposition}\` · **Reviewed SHA:** \`${payload.headSha}\``, "", `**Reviewer roles:** ${payload.reviewerRoles.map(code).join(", ")}`,
        payload.reviewPlan ? reviewPlanMarkdown(payload.reviewPlan) : "",
        payload.findings.length ? `### Findings\n${payload.findings.map((finding) => `- **${finding.severity.toUpperCase()} · ${finding.title}**${finding.blocking ? " · **BLOCKING**" : ""}${finding.reviewerRoles?.length ? ` · reviewers: ${finding.reviewerRoles.map(code).join(", ")}` : ""}\n  ${finding.evidence}${finding.location ? `\n  Location: \`${finding.location}\`` : ""}${finding.sourceFindingIds?.length ? `\n  Sources: ${finding.sourceFindingIds.map(code).join(", ")}` : ""}${finding.sourceSessionRefs?.length ? `\n  Sessions: ${finding.sourceSessionRefs.map(code).join(", ")}` : ""}\n  Remediation: ${finding.remediation}`).join("\n")}` : "### Findings\nNo findings.",
        checkTable(payload.checks),
      ].filter(Boolean).join("\n\n");
    }
    case "VerificationAdjudication": {
      const payload = artifact.payload as VerificationAdjudicationPayload;
      return [heading, meta, "", `**Checkpoint:** \`${payload.checkpoint}\` · **Decision:** \`${payload.decision}\``, `**Supersedes outcome:** \`${payload.supersedesOutcomeId}\``, `### Human rationale\n${payload.reason}`].join("\n\n");
    }
    case "RemediationBlocked": {
      const payload = artifact.payload as RemediationBlockedPayload;
      return [heading, meta, "", `**Status:** \`${payload.status}\` · **Reason:** \`${payload.reason}\``,
        `**Parent:** issue #${payload.parentIssue} · PR #${payload.pullRequest} · head \`${payload.headSha}\``,
        `**Branch:** \`${payload.headBranch}\` → \`${payload.baseBranch}\` · depth ${payload.remediationDepth}/${payload.maxRemediationDepth}`,
        listSection("Findings", payload.findings.map((finding) => `**${finding.severity.toUpperCase()} · ${finding.title}** — ${finding.location ?? "location not recorded"}\n${finding.evidence}\nRemediation: ${finding.remediation}`)),
        listSection("Child issues", payload.childIssues.map((issue) => `#${issue}`)),
        listSection("Approved paths", payload.approvedPaths.map(code)),
        listSection("Child outcomes", payload.childOutcomeIds.map(code)),
      ].filter(Boolean).join("\n\n");
    }
    case "Outcome": {
      const payload = artifact.payload as OutcomePayload;
      return [heading, meta, "", `**Status:** \`${payload.status}\`${payload.targetBranch ? ` · **Target:** \`${payload.targetBranch}\`` : ""}${payload.promotionTarget ? ` · **Promotion:** \`${payload.promotionTarget}\`` : ""}${payload.productionTarget ? ` · **Production:** \`${payload.productionTarget}\`` : ""}`, "", payload.reason,
        payload.finalSha ? `**Final SHA:** \`${payload.finalSha}\`` : "",
        payload.prUrl ? `**Pull request:** ${payload.prUrl}` : "",
        payload.failureEvidence ? [
          `### Retained build attempt`,
          `**Branch:** \`${payload.failureEvidence.branch}\` · **Recovery workspace:** \`${payload.failureEvidence.workspacePath}\`${payload.failureEvidence.baseSha ? ` · **Frozen base:** \`${payload.failureEvidence.baseSha}\`` : ""}`,
          "",
          payload.failureEvidence.builderSummary,
          listSection("Changed paths", payload.failureEvidence.changedPaths.map(code)),
          checkTable(payload.failureEvidence.checks),
        ].filter(Boolean).join("\n\n") : "",
        listSection("Child issues", payload.childIssues),
      ].filter(Boolean).join("\n");
    }
  }
}

function escapeArtifactText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function splitKind(kind: string): string {
  return kind.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function code(value: string): string {
  return `\`${value}\``;
}

function reviewPlanMarkdown(plan: NonNullable<ReviewVerdictPayload["reviewPlan"]>): string {
  const identity = plan.planId
    ? `\n**Identity:** \`${plan.planId}\` · **Generation:** ${plan.generation} · **Frozen:** ${plan.frozen ? "yes" : "no"}`
    : "\n**Compatibility:** legacy Review Plan without frozen-topology metadata";
  const budget = plan.budget
    ? `\n**Absolute budget:** ${plan.budget.maxLogicalReviewerSessions} logical sessions (${plan.budget.maxSpecialistExecutionGroups} specialist groups), ${plan.budget.maxAttemptsPerExecutionGroup} attempts/group`
    : "";
  const capabilities = plan.capabilities?.length
    ? `\n\n**Required capabilities**\n${plan.capabilities.map((capability) => `- **${capability.id}** · score ${capability.score}${capability.required ? " · mandatory evidence" : ""}`).join("\n")}`
    : "";
  const groups = plan.executionGroups?.length
    ? `\n\n**Execution groups**\n${plan.executionGroups.map((group) => `- **${group.id}** (${group.role}) · ${group.capabilities.join(", ")} — ${group.reasons.join("; ")}`).join("\n")}`
    : `\n${plan.selected.map((selection) => `- **${selection.role}** · score ${selection.score}${selection.required ? " · required" : ""} — ${selection.reasons.join("; ")}`).join("\n")}`;
  const skipped = plan.skipped.length
    ? `\n\n**Non-executing specialist roles**\n${plan.skipped.map((selection) => `- **${selection.role}** · score ${selection.score} · ${selection.reason}${selection.evidence.length ? ` — ${selection.evidence.join("; ")}` : " — no qualifying evidence"}`).join("\n")}`
    : "";
  return `### Review plan\n**Risk:** \`${plan.riskTier}\` · **Specialist group budget:** ${plan.specialistBudget}${identity}${budget}${capabilities}${groups}${skipped}`;
}

function listSection(title: string, items: readonly string[], ordered = false): string {
  if (!items.length) return "";
  return `### ${title}\n${items.map((item, index) => `${ordered ? `${index + 1}.` : "-"} ${item}`).join("\n")}`;
}

function checklistSection(title: string, items: readonly string[], passed?: readonly boolean[]): string {
  if (!items.length) return "";
  return `### ${title}\n${items.map((item, index) => `- [${passed ? (passed[index] ? "x" : " ") : " "}] ${item}`).join("\n")}`;
}

function checkTable(checks: readonly { command: string; status: string; durationMs: number; summary?: string; baselineStatus?: string; regression?: boolean }[]): string {
  if (!checks.length) return "";
  const rows = checks.map((check) => {
    const status = check.status === "failed" && check.baselineStatus === "failed" && check.regression === false
      ? "failed (baseline failures unchanged)"
      : check.status;
    return `| \`${check.command.replaceAll("|", "\\|")}\` | ${status} | ${check.durationMs} ms | ${(check.summary ?? "").replaceAll("|", "\\|")} |`;
  });
  return `### Verification\n| Command | Status | Duration | Summary |\n|---|---|---:|---|\n${rows.join("\n")}`;
}
