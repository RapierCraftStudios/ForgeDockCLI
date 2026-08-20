// SPDX-License-Identifier: AGPL-3.0-or-later
import type { EffectiveReviewCiConfig, RequiredChecksMode } from "../../core/config/forgedock-config.js";
import { pullRequestMergeability, type PullRequestMergeGate, type PullRequestSnapshot } from "../../core/ports/forge-host.js";
export type PullRequestKind = "delivery" | "promotion" | "deployment";
export type PullRequestCheck = PullRequestMergeGate["requiredChecks"][number];
export interface PullRequestCiAssessment { kind: PullRequestKind; mode: RequiredChecksMode; selected: readonly PullRequestCheck[]; pending: readonly PullRequestCheck[]; failed: readonly PullRequestCheck[]; warnings: readonly string[]; mergeable: boolean; ready: boolean; }
export class PullRequestCiBlockedError extends Error { constructor(readonly assessment: PullRequestCiAssessment, readonly failureAction: EffectiveReviewCiConfig["failureAction"], phase: "before" | "after") { super(formatPullRequestCiBlock(assessment, failureAction, phase)); this.name = "PullRequestCiBlockedError"; } }
export function classifyPullRequest(pr: Pick<PullRequestSnapshot, "headBranch" | "baseBranch">, lanes: { featurePromotionTarget?: string; productionTarget?: string } = {}): PullRequestKind { const integration = lanes.featurePromotionTarget ?? "staging"; const production = lanes.productionTarget ?? "main"; if (pr.headBranch === integration && pr.baseBranch === production) return "deployment"; if (pr.baseBranch === integration || pr.headBranch.startsWith("milestone/")) return "promotion"; return "delivery"; }
export function requiredChecksMode(policy: EffectiveReviewCiConfig, targetBranch: string): RequiredChecksMode { return policy.requiredChecksTargets?.[targetBranch] ?? policy.requiredChecksDefault ?? "require"; }
export function hasKnownEmptyRequiredChecks(gate: PullRequestMergeGate): boolean { return gate.requiredChecksProvenance === "github-none" && gate.requiredChecksHeadSha?.toLowerCase() === gate.headSha.toLowerCase() && gate.requiredChecks.length === 0; }
export function noRequiredChecksReviewWarning(pr: Pick<PullRequestSnapshot, "number" | "headBranch" | "baseBranch" | "headSha">): string { return `GitHub reported no required checks for PR #${pr.number} (${pr.headBranch} → ${pr.baseBranch}) when review started at ${pr.headSha}. ForgeDock is proceeding with advisory review; this does not establish merge authority.`; }
export function assessPullRequestCi(pr: Pick<PullRequestSnapshot, "number" | "headBranch" | "baseBranch" | "headSha">, gate: PullRequestMergeGate, policy: EffectiveReviewCiConfig, lanes: { featurePromotionTarget?: string; productionTarget?: string } = {}): PullRequestCiAssessment {
  const kind = classifyPullRequest(pr, lanes);
  const mode = requiredChecksMode(policy, pr.baseBranch);
  const mergeability = pullRequestMergeability(gate);
  const exactHead = gate.requiredChecksHeadSha?.toLowerCase() === pr.headSha.toLowerCase() && gate.headSha.toLowerCase() === pr.headSha.toLowerCase();
  if (mode === "if-present" && exactHead && hasKnownEmptyRequiredChecks(gate)) return { kind, mode, selected: [], pending: [], failed: [], warnings: [noRequiredChecksReviewWarning(pr)], mergeable: mergeability === "mergeable", ready: mergeability === "mergeable" };
  const selectors = (kind === "deployment" ? policy.deploymentChecks : kind === "promotion" ? policy.promotionChecks : policy.deliveryChecks).map((selector) => selector.trim());
  const eligible = gate.requiredChecks;
  const selected = eligible.filter((check) => selectors.some((selector) => checkMatches(selector, check.name)));
  const missing = selectors.filter((selector) => selector !== "*" && !eligible.some((check) => checkMatches(selector, check.name))).map((name): PullRequestCheck => ({ name, state: "unavailable" }));
  if (selectors.includes("*") && eligible.length === 0) missing.push({ name: "repository PR checks", state: "unavailable" });
  const authoritative = [...selected, ...missing];
  const pending = authoritative.filter((check) => check.state === "pending");
  const failed = authoritative.filter((check) => check.state !== "passed" && check.state !== "pending");
  const malformed = !exactHead || gate.requiredChecksProvenance !== "github-required" || eligible.length === 0;
  if (malformed) failed.push({ name: "required-checks-authority", state: "unavailable" });
  return { kind, mode, selected: authoritative, pending, failed, warnings: [], mergeable: mergeability === "mergeable", ready: mergeability === "mergeable" && !pending.length && !failed.length && !malformed };
}
/** Shared pure merge-admission assessment used by delivery completion and promotion. It evaluates every authoritative required check, not advisory selectors. */
export function assessMergeAdmission(pr: Pick<PullRequestSnapshot, "number" | "headBranch" | "baseBranch" | "headSha">, gate: PullRequestMergeGate, policy: EffectiveReviewCiConfig, lanes: { featurePromotionTarget?: string; productionTarget?: string } = {}): PullRequestCiAssessment {
  const kind = classifyPullRequest(pr, lanes);
  const mode = requiredChecksMode(policy, pr.baseBranch);
  const mergeability = pullRequestMergeability(gate);
  const exactHead = gate.headSha.toLowerCase() === pr.headSha.toLowerCase() && gate.requiredChecksHeadSha?.toLowerCase() === pr.headSha.toLowerCase();
  if (mode === "if-present" && exactHead && hasKnownEmptyRequiredChecks(gate)) return { kind, mode, selected: [], pending: [], failed: [], warnings: [], mergeable: mergeability === "mergeable", ready: mergeability === "mergeable" };
  const selected = [...gate.requiredChecks];
  const pending = selected.filter((check) => check.state === "pending");
  const failed = selected.filter((check) => check.state !== "passed" && check.state !== "pending");
  if (!exactHead || gate.requiredChecksProvenance !== "github-required" || selected.length === 0) {
    const name = gate.requiredChecksProvenance === "github-none" && selected.length === 0
      ? `GitHub reported no required checks for reviewed ${pr.headSha}`
      : "required-checks-authority (not immutably bound)";
    failed.push({ name, state: "unavailable" });
  }
  return { kind, mode, selected, pending, failed, warnings: [], mergeable: mergeability === "mergeable", ready: mergeability === "mergeable" && !pending.length && !failed.length && exactHead && gate.requiredChecksProvenance === "github-required" && selected.length > 0 };
}
export function assertPullRequestCiReady(a: PullRequestCiAssessment, action: EffectiveReviewCiConfig["failureAction"], phase: "before" | "after"): void { if (!a.ready) throw new PullRequestCiBlockedError(a, action, phase); }
export function formatPullRequestCiBlock(a: PullRequestCiAssessment, action: EffectiveReviewCiConfig["failureAction"], phase: "before" | "after"): string { const reasons = [...(!a.mergeable ? [`mergeability=${a.selected.length ? "conflicting" : "unavailable"}`] : []), ...a.pending.map((c) => `${c.name}=pending${c.detailsUrl ? ` (${c.detailsUrl})` : ""}`), ...a.failed.map((c) => `${c.name}=${c.state}${c.detailsUrl ? ` (${c.detailsUrl})` : ""}`)]; const next = action === "auto-fix" ? "ForgeDock auto-fix was enabled but could not safely make the selected checks green. Fix the listed checks on the PR head, then rerun /review-pr." : "Please fix the listed PR CI/mechanical checks on the PR head, then rerun /review-pr. To let ForgeDock attempt bounded repairs, set next.review.ci.failure_action to auto-fix with /forgedock-config."; return `ForgeDock ${a.kind} PR checks are not green ${phase === "before" ? "before independent review" : "after independent review of the exact head"}: ${reasons.join(", ") || "no authoritative passing checks were observed"}. ${next}`; }
function checkMatches(selector: string, name: string): boolean { const pattern = selector.trim().toLowerCase(); const candidate = name.trim().toLowerCase(); if (pattern === "*") return true; const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", ".*"); return new RegExp(`^${escaped}$`, "i").test(candidate); }
