// SPDX-License-Identifier: AGPL-3.0-or-later

import type { ForgeDockNextConfig, ThinkingLevel } from "../config/forgedock-config.js";
import { splitConfiguredModel } from "../config/forgedock-config.js";
import type { LeaseWitness } from "../ports/lease.js";
import type { AgentRuntime } from "../../runtime/agent-runtime.js";
import { assertRuntimeInstallAsync } from "../../runtime/runtime-install.js";

/** Native controller roles which must agree on one resolved runtime contract. */
export type DispatchRole = "worker" | "reviewer" | "planning";

export interface DispatchModelOverrides {
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
}

export interface DispatchRuntimeResolutionInput {
  config?: ForgeDockNextConfig;
  environment?: NodeJS.ProcessEnv;
  activeModel?: string;
  invocation?: {
    provider?: string;
    model?: string;
    thinking?: ThinkingLevel;
    workerModel?: string;
    worker?: DispatchModelOverrides;
    reviewer?: DispatchModelOverrides;
    planning?: DispatchModelOverrides;
  };
  durable?: {
    workerProvider?: string;
    workerModel?: string;
    workerThinking?: ThinkingLevel;
    reviewerProvider?: string;
    reviewerModel?: string;
    reviewerThinking?: ThinkingLevel;
    planningProvider?: string;
    planningModel?: string;
    planningThinking?: ThinkingLevel;
  };
}

export interface ResolvedDispatchRole {
  role: DispatchRole;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  source: string;
  invalidReference?: string;
}

export interface ResolvedDispatchRuntime {
  worker: ResolvedDispatchRole;
  reviewer: ResolvedDispatchRole;
  planning: ResolvedDispatchRole;
}

export function dispatchModelReference(role: ResolvedDispatchRole): string | undefined {
  if (!role.provider || !role.model) return undefined;
  return `${role.provider}/${role.model}${role.thinking ? `:${role.thinking}` : ""}`;
}

export type DispatchDiagnosticCode =
  | "config-invalid"
  | "lease-witness-missing"
  | "lease-witness-invalid"
  | "runtime-unavailable"
  | "runtime-install"
  | "provider-model-missing"
  | "provider-model-unavailable"
  | "provider-auth"
  | "github-auth"
  | "github-access";

export interface DispatchDiagnostic {
  code: DispatchDiagnosticCode;
  component: "config" | "lease" | "runtime" | "github";
  role?: DispatchRole;
  message: string;
  action: string;
}

export interface DispatchReadinessReport {
  checkoutRoot: string;
  runtime: ResolvedDispatchRuntime;
  diagnostics: readonly DispatchDiagnostic[];
  ready: boolean;
  repository?: unknown;
}

export interface DispatchReadinessInput extends DispatchRuntimeResolutionInput {
  checkoutRoot: string;
  configError?: unknown;
  requireLeaseWitness?: boolean;
  leaseWitness?: LeaseWitness;
  leaseError?: unknown;
  runtime?: Pick<AgentRuntime, "preflight">;
  runtimeInstallCheck?: () => Promise<unknown>;
  githubProbe?: () => Promise<unknown>;
}

export class DispatchReadinessError extends Error {
  constructor(readonly report: DispatchReadinessReport) {
    super(formatDispatchReadiness(report));
    this.name = "DispatchReadinessError";
  }
}

/**
 * Resolve the exact role settings that both interactive and headless
 * controllers pass to workers. Invocation and durable values win over
 * project configuration, while environment and the interactive model are
 * explicit fallbacks rather than hidden per-surface behavior.
 */
export function resolveDispatchRuntime(input: DispatchRuntimeResolutionInput = {}): ResolvedDispatchRuntime {
  const environment = input.environment ?? process.env;
  const config = input.config ?? {};
  const invocation = input.invocation ?? {};
  const durable = input.durable ?? {};
  const active = input.activeModel;

  const genericInvocation: DispatchModelOverrides = {
    ...(invocation.provider !== undefined ? { provider: invocation.provider } : {}),
    ...(invocation.model !== undefined ? { model: invocation.model } : {}),
    ...(invocation.thinking !== undefined ? { thinking: invocation.thinking } : {}),
  };

  const invocationRole = (specific?: DispatchModelOverrides): DispatchModelOverrides => ({
    ...genericInvocation,
    ...specific,
  });

  const worker = resolveRole("worker", [
    source("invocation", invocationRole(invocation.worker), invocation.workerModel),
    source("durable plan", overrides(durable.workerProvider, durable.workerModel, durable.workerThinking)),
    source("forge.yaml", overrides(undefined, undefined, config.workerThinking), config.workerModel, true),
    source("environment", overrides(
      environment.FORGEDOCK_WORKER_PROVIDER,
      environment.FORGEDOCK_WORKER_MODEL,
      parseThinking(environment.FORGEDOCK_WORKER_THINKING),
    )),
    source("environment", overrides(environment.PI_PROVIDER, environment.PI_MODEL, undefined)),
    source("interactive session", overrides(undefined, active, undefined)),
  ]);

  const reviewer = resolveRole("reviewer", [
    source("invocation", invocationRole(invocation.reviewer)),
    source("durable plan", overrides(durable.reviewerProvider, durable.reviewerModel, durable.reviewerThinking)),
    source("forge.yaml", overrides(undefined, undefined, config.reviewerThinking), config.reviewerModel, true),
    source("environment", overrides(
      environment.FORGEDOCK_REVIEWER_PROVIDER,
      environment.FORGEDOCK_REVIEWER_MODEL,
      parseThinking(environment.FORGEDOCK_REVIEWER_THINKING),
    )),
    fallbackSource(worker, "worker fallback"),
  ]);

  const planning = resolveRole("planning", [
    source("invocation", invocation.planning),
    source("durable plan", overrides(durable.planningProvider, durable.planningModel, durable.planningThinking)),
    source("forge.yaml", overrides(undefined, undefined, config.planningThinking), config.planningModel, true),
    source("environment", overrides(
      environment.FORGEDOCK_PLANNING_PROVIDER,
      environment.FORGEDOCK_PLANNING_MODEL,
      parseThinking(environment.FORGEDOCK_PLANNING_THINKING),
    )),
    fallbackSource(worker, "worker fallback"),
  ]);

  return { worker, reviewer, planning };
}

/** Collect every independent dispatch prerequisite without mutating GitHub. */
export async function collectDispatchReadiness(input: DispatchReadinessInput): Promise<DispatchReadinessReport> {
  const runtime = resolveDispatchRuntime(input);
  const diagnostics: DispatchDiagnostic[] = [];
  const add = (diagnostic: DispatchDiagnostic): void => {
    const sanitized: DispatchDiagnostic = {
      ...diagnostic,
      message: safeError(diagnostic.message),
      action: safeError(diagnostic.action),
    };
    const duplicate = diagnostics.some((existing) => existing.code === diagnostic.code
      && existing.role === diagnostic.role
      && existing.message === sanitized.message);
    if (!duplicate) diagnostics.push(sanitized);
  };

  if (input.configError !== undefined) {
    add({
      code: "config-invalid",
      component: "config",
      message: `ForgeDock configuration could not be read: ${safeError(input.configError)}`,
      action: "Repair the managed ForgeDock section in forge.yaml, then rerun the controller.",
    });
  }
  for (const role of [runtime.worker, runtime.reviewer, runtime.planning]) {
    if (role.invalidReference !== undefined) {
      add({
        code: "config-invalid",
        component: "config",
        role: role.role,
        message: `${role.role} model reference '${role.invalidReference}' is not provider/model (or a provider plus model pair).`,
        action: `Set ${role.role}Model to provider/model in forge.yaml or pass an explicit provider/model override.`,
      });
    }
    if (!role.provider || !role.model) {
      add({
        code: "provider-model-missing",
        component: "runtime",
        role: role.role,
        message: `${role.role} runtime has no complete provider/model selection (source: ${role.source}).`,
        action: `Configure ${role.role}Model as provider/model or set the corresponding FORGEDOCK_${role.role.toUpperCase()}_PROVIDER/MODEL variables.`,
      });
    }
  }

  if (input.requireLeaseWitness) {
    if (input.leaseError !== undefined) {
      add({
        code: "lease-witness-invalid",
        component: "lease",
        message: `Lease witness configuration is invalid: ${safeError(input.leaseError)}`,
        action: "Repair the checkout witness or configure all FORGEDOCK_LEASE_WITNESS_* variables, then rerun.",
      });
    } else if (!input.leaseWitness) {
      add({
        code: "lease-witness-missing",
        component: "lease",
        message: `No authenticated lease witness is configured for ${input.checkoutRoot}.`,
        action: "Run forgedock-next lease-witness-bootstrap in this checkout or configure all FORGEDOCK_LEASE_WITNESS_* variables.",
      });
    } else {
      try {
        const snapshot = input.leaseWitness.verify();
        if (snapshot.state !== "verified") {
          add({
            code: "lease-witness-invalid",
            component: "lease",
            message: `Lease witness is not verifiable: ${safeError(snapshot.reason ?? "unknown continuity failure")}`,
            action: "Re-enroll the witness with an authenticated higher checkpoint before dispatch.",
          });
        }
      } catch (error) {
        add({
          code: "lease-witness-invalid",
          component: "lease",
          message: `Lease witness verification failed: ${safeError(error)}`,
          action: "Repair or re-enroll the checkout witness before dispatch.",
        });
      }
    }
  }

  try {
    await (input.runtimeInstallCheck ?? assertRuntimeInstallAsync)();
  } catch (error) {
    add({
      code: "runtime-install",
      component: "runtime",
      message: `ForgeDock runtime installation preflight failed: ${safeError(error)}`,
      action: "Repair the staged runtime with npm ci --ignore-scripts --no-audit --no-fund and npm run build, then restart.",
    });
  }

  if (input.runtime?.preflight) {
    for (const role of [runtime.worker, runtime.reviewer, runtime.planning]) {
      if (!role.provider || !role.model || role.invalidReference !== undefined) continue;
      try {
        const result = await input.runtime.preflight({ provider: role.provider, model: role.model });
        if (result.provider !== role.provider || result.model !== role.model) {
          add({
            code: "provider-model-unavailable",
            component: "runtime",
            role: role.role,
            message: `${role.role} runtime resolved ${result.provider}/${result.model}, not the frozen ${role.provider}/${role.model}.`,
            action: "Use one explicit provider/model selection across TUI, headless workers, and the durable plan.",
          });
        }
        for (const detail of result.diagnostics ?? []) {
          add({
            code: "provider-model-unavailable",
            component: "runtime",
            role: role.role,
            message: `${role.role} runtime diagnostic: ${safeError(detail)}`,
            action: "Authenticate the provider or select an installed model, then rerun dispatch.",
          });
        }
      } catch (error) {
        const message = safeError(error);
        const authFailure = /auth|credential|authentication|unauthorized|not logged in/i.test(errorMessage(error));
        add({
          code: /install|dispatcher|node_modules/i.test(message) ? "runtime-install" : authFailure ? "provider-auth" : "provider-model-unavailable",
          component: "runtime",
          role: role.role,
          message: `${role.role} runtime preflight failed: ${message}`,
          action: /install|dispatcher|node_modules/i.test(message)
            ? "Repair the staged runtime with npm ci --ignore-scripts --no-audit --no-fund and npm run build, then restart."
            : authFailure
              ? "Authenticate the provider (or configure its credentials) before rerunning dispatch."
              : "Select an installed provider/model, then rerun dispatch.",
        });
      }
    }
  }

  let repository: unknown;
  if (input.githubProbe) {
    try {
      repository = await input.githubProbe();
    } catch (error) {
      const message = safeError(error);
      const auth = /auth|credential|bad credentials|unauthorized|not logged in|permission denied/i.test(errorMessage(error));
      add({
        code: auth ? "github-auth" : "github-access",
        component: "github",
        message: `GitHub dispatch preflight failed: ${message}`,
        action: auth ? "Run gh auth status/login for the target account, then rerun dispatch." : "Verify repository access and the resolved checkout/repository, then rerun dispatch.",
      });
    }
  }

  return {
    checkoutRoot: input.checkoutRoot,
    runtime,
    diagnostics,
    ready: diagnostics.length === 0,
    ...(repository !== undefined ? { repository } : {}),
  };
}

export async function assertDispatchReady(input: DispatchReadinessInput): Promise<DispatchReadinessReport> {
  const report = await collectDispatchReadiness(input);
  if (!report.ready) throw new DispatchReadinessError(report);
  return report;
}

export function formatDispatchReadiness(report: DispatchReadinessReport): string {
  if (report.ready) return `ForgeDock dispatch readiness passed for ${report.checkoutRoot}.`;
  const lines = [
    `ForgeDock dispatch readiness failed for ${report.checkoutRoot}:`,
    ...report.diagnostics.map((diagnostic) => [
      `- [${diagnostic.code}${diagnostic.role ? `/${diagnostic.role}` : ""}] ${diagnostic.message}`,
      `  Action: ${diagnostic.action}`,
    ].join("\n")),
    "Resolved runtime roles:",
    ...[report.runtime.worker, report.runtime.reviewer, report.runtime.planning].map((role) =>
      `- ${role.role}: ${role.provider && role.model ? safeError(`${role.provider}/${role.model}`) : "missing provider/model"} (source: ${safeError(role.source)})`),
    "Dispatch was not started and no GitHub mutation was requested by the readiness check.",
  ];
  return lines.join("\n");
}

function source(name: string, overrides?: DispatchModelOverrides, reference?: string, strictReference = false): ModelSource {
  return {
    name,
    ...(overrides?.provider !== undefined ? { provider: overrides.provider } : {}),
    ...(overrides?.model !== undefined ? { model: overrides.model } : {}),
    ...(overrides?.thinking !== undefined ? { thinking: overrides.thinking } : {}),
    ...(reference !== undefined ? { reference } : {}),
    ...(strictReference ? { strictReference } : {}),
  };
}

function overrides(
  provider: string | undefined,
  model: string | undefined,
  thinking: ThinkingLevel | undefined,
): DispatchModelOverrides {
  return {
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
  };
}

function fallbackSource(role: ResolvedDispatchRole, name: string): ModelSource {
  return {
    name,
    ...(role.provider !== undefined ? { provider: role.provider } : {}),
    ...(role.model !== undefined ? { model: role.model } : {}),
    ...(role.thinking !== undefined ? { thinking: role.thinking } : {}),
  };
}

interface ModelSource {
  name: string;
  provider?: string;
  model?: string;
  thinking?: ThinkingLevel;
  reference?: string;
  strictReference?: boolean;
}

function resolveRole(role: DispatchRole, sources: readonly ModelSource[]): ResolvedDispatchRole {
  // A runtime selection is one atomic contract. Never borrow a provider from
  // one precedence level and a model from another: that can preflight a pair
  // which no caller actually configured and dispatch different work later.
  const selected = sources.find((candidate) => candidate.reference !== undefined
    || candidate.provider !== undefined
    || candidate.model !== undefined);
  let provider = selected?.provider;
  let model: string | undefined;
  let invalidReference: string | undefined;
  let parsedThinking: ThinkingLevel | undefined;
  let sourceName = selected?.name ?? "default";
  if (selected?.reference !== undefined) {
    const parsed = parseModelReference(selected.reference, provider);
    if (parsed) {
      provider = parsed.provider;
      model = parsed.model;
      parsedThinking = parsed.thinking;
    } else {
      invalidReference = selected.reference;
      model = selected.reference;
    }
  } else if (selected?.model !== undefined) {
    const parsed = parseModelReference(selected.model, provider);
    if (parsed) {
      provider = parsed.provider;
      model = parsed.model;
      parsedThinking = parsed.thinking;
    } else {
      model = selected.model;
      if (selected.strictReference) invalidReference = selected.model;
    }
  }
  // Thinking is an independent tuning override; only the provider/model pair
  // is indivisible. This preserves role-specific thinking configuration when
  // the role intentionally falls back to the worker's runtime contract.
  const thinking = sources.find((candidate) => candidate.thinking !== undefined)?.thinking ?? parsedThinking;
  return {
    role,
    ...(provider !== undefined ? { provider } : {}),
    ...(model !== undefined ? { model } : {}),
    ...(thinking !== undefined ? { thinking } : {}),
    source: sourceName,
    ...(invalidReference !== undefined ? { invalidReference } : {}),
  };
}

function parseModelReference(
  value: string,
  fallbackProvider?: string,
): { provider: string; model: string; thinking?: ThinkingLevel } | undefined {
  const parsed = splitConfiguredModel(value);
  if (!parsed) {
    if (!fallbackProvider || !value.trim()) return undefined;
    const suffix = value.match(/:(off|minimal|low|medium|high|xhigh|max)$/)?.[1] as ThinkingLevel | undefined;
    return {
      provider: fallbackProvider,
      model: suffix ? value.slice(0, -(suffix.length + 1)) : value,
      ...(suffix !== undefined ? { thinking: suffix } : {}),
    };
  }
  const suffix = parsed.model.match(/:(off|minimal|low|medium|high|xhigh|max)$/)?.[1] as ThinkingLevel | undefined;
  return {
    provider: parsed.provider,
    model: suffix ? parsed.model.slice(0, -(suffix.length + 1)) : parsed.model,
    ...(suffix !== undefined ? { thinking: suffix } : {}),
  };
}

function parseThinking(value: string | undefined): ThinkingLevel | undefined {
  return value === "off" || value === "minimal" || value === "low" || value === "medium"
    || value === "high" || value === "xhigh" || value === "max" ? value : undefined;
}

function safeError(error: unknown): string {
  const message = errorMessage(error);
  return message
    // URL userinfo, authorization headers, common credential assignments and
    // recognizable provider tokens are all untrusted diagnostic input.
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[redacted]@")
    .replace(/\b(authorization\s*[:=]\s*)(?:bearer|basic)\s+[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [redacted]")
    .replace(/\b((?:(?:[a-z0-9]+[_-])*(?:api[-_ ]?key|access[-_ ]?token|auth[-_ ]?token|token|password|passwd|secret|client[-_ ]?secret|private[-_ ]?key))\s*[=:]\s*)["']?[^\s,;&"']+["']?/gi, "$1[redacted]")
    .replace(/([?&](?:api[-_]?key|access[-_]?token|auth[-_]?token|token|password|secret)=)[^&#\s]+/gi, "$1[redacted]")
    .replace(/\b(?:github_pat_[A-Za-z0-9_]+|gh[pousr]_[A-Za-z0-9]+|sk-[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]+|AKIA[A-Z0-9]{16})\b/g, "[redacted]")
    .replace(/[\r\n]+/g, " ")
    .slice(0, 600);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
