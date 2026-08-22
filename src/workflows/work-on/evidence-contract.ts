// SPDX-License-Identifier: AGPL-3.0-or-later

import type {
  BuildPacketPayload,
  EvidencePathDeclaration,
  InvariantMatrixRow,
  VerificationEvidenceContract,
  VerificationEvidenceCriterion,
  VerificationEvidenceDiagnostic,
  VerificationEvidenceKind,
  VerificationRequirement,
} from "../../core/artifacts/schema.js";
import type {
  VerificationEvidenceCapability,
  VerificationCommand,
} from "../../core/ports/verification.js";
import type { VerificationCapability } from "../../core/ports/verification-capabilities.js";
import { invariantMatrixIdentities } from "./invariant-matrix.js";

export const EVIDENCE_CONTRACT_VERSION = "forgedock.evidence/v1" as const;

export interface EvidenceContractInput {
  acceptanceCriteria: readonly string[];
  verificationRequirements?: readonly VerificationRequirement[];
  controllerGates?: readonly { id: string }[];
  /** The explicit controller catalog or its safe capability projection. */
  commands: readonly (Pick<VerificationCommand, "id"> & Partial<Pick<VerificationCommand, "targets" | "evidenceCapability">> | VerificationCapability)[];
  invariantMatrices?: readonly InvariantMatrixRow[];
  expectedPaths: readonly string[];
  evidencePaths?: readonly EvidencePathDeclaration[];
}

export interface EvidenceContractDerivation {
  contract: VerificationEvidenceContract;
  diagnostics: VerificationEvidenceDiagnostic[];
}

/** Return a stable concrete repository-relative path, or a diagnostic-free error. */
export function canonicalEvidencePath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized.includes("\\")
    || normalized.split("/").some((part) => part === ".." || part === "." || part === "")
    || /[*?{}[\]]/.test(normalized) || normalized.includes(":")) {
    throw new Error(`Evidence path is not a concrete repository-relative path: ${path}`);
  }
  return normalized;
}

export function canonicalEvidencePaths(paths: readonly string[]): string[] {
  return [...new Set(paths.map(canonicalEvidencePath))].sort();
}

/** Matrix identities are controller-owned; model prose cannot create or alter them. */
export function normalizeInvariantMatrixIdentities(rows: readonly InvariantMatrixRow[]): {
  rowIds: string[];
  testIds: string[];
  caseIds: string[];
} {
  const ordered = [...rows].sort((a, b) => a.id.localeCompare(b.id));
  return invariantMatrixIdentities(ordered);
}

export function invariantMatrixIdentitiesForCriterion(
  rows: readonly InvariantMatrixRow[],
  criterionId: string,
): Pick<VerificationEvidenceCriterion, "invariantRowIds" | "invariantTestIds" | "invariantCaseIds"> {
  return normalizeInvariantMatrixIdentities(rows.filter((row) => row.criterionId === criterionId)).rowIds.length
    ? (() => {
      const selected = rows.filter((row) => row.criterionId === criterionId);
      const identities = normalizeInvariantMatrixIdentities(selected);
      return { invariantRowIds: identities.rowIds, invariantTestIds: identities.testIds, invariantCaseIds: identities.caseIds };
    })()
    : { invariantRowIds: [], invariantTestIds: [], invariantCaseIds: [] };
}

function strongestEvidenceKind(kinds: readonly (VerificationEvidenceKind | undefined)[]): VerificationEvidenceKind {
  if (kinds.includes("temporal")) return "temporal";
  if (kinds.includes("behavioral")) return "behavioral";
  return "structural";
}

function capabilityOf(command: EvidenceContractInput["commands"][number]): VerificationEvidenceCapability {
  // Missing metadata is intentionally generic. Semantic meaning must never be inferred from IDs.
  return command.evidenceCapability ?? "generic";
}

function capabilityIsUsable(command: EvidenceContractInput["commands"][number]): boolean {
  const capability = capabilityOf(command);
  const targets = "targets" in command ? command.targets : undefined;
  return (capability !== "targeted-test" && capability !== "path-bound")
    || Boolean(targets?.length);
}

function diagnostic(
  code: string,
  criterionId: string | undefined,
  message: string,
  details?: Record<string, unknown>,
): VerificationEvidenceDiagnostic {
  return { code, ...(criterionId ? { criterionId } : {}), message, ...(details ? { details } : {}) };
}

function evidencePathsForCriterion(
  declarations: readonly EvidencePathDeclaration[],
  criterionId: string,
  diagnostics: VerificationEvidenceDiagnostic[],
): string[] {
  const result: string[] = [];
  for (const declaration of declarations.filter(({ criterionIds }) => criterionIds.includes(criterionId))) {
    try {
      result.push(canonicalEvidencePath(declaration.path));
    } catch (error) {
      diagnostics.push(diagnostic("invalid-evidence-path", criterionId, error instanceof Error ? error.message : String(error), { path: declaration.path }));
    }
  }
  return [...new Set(result)].sort();
}

/** Deterministically derive the additive contract and report every criterion defect. */
export function deriveEvidenceContract(input: EvidenceContractInput): EvidenceContractDerivation {
  const diagnostics: VerificationEvidenceDiagnostic[] = [];
  let expectedPaths: string[] = [];
  for (const path of input.expectedPaths) {
    try {
      expectedPaths.push(canonicalEvidencePath(path));
    } catch (error) {
      diagnostics.push(diagnostic("invalid-write-path", undefined, error instanceof Error ? error.message : String(error), { path }));
    }
  }
  expectedPaths = [...new Set(expectedPaths)].sort();
  const commands = new Map(input.commands.map((command) => [command.id, command]));
  const gates = new Set((input.controllerGates ?? []).map(({ id }) => id));
  const rows = input.invariantMatrices ?? [];
  const criterionIds = new Set(input.acceptanceCriteria.map((_, index) => `criterion-${index + 1}`));
  for (const declaration of input.evidencePaths ?? []) {
    for (const criterionId of declaration.criterionIds) {
      if (!criterionIds.has(criterionId)) {
        diagnostics.push(diagnostic("unknown-criterion", criterionId, `Evidence path declaration references unknown criterion ${criterionId}`, { path: declaration.path }));
      }
    }
  }
  for (const requirement of input.verificationRequirements ?? []) {
    for (const criterionId of requirement.criterionIds) {
      if (!criterionIds.has(criterionId)) {
        diagnostics.push(diagnostic("unknown-criterion", criterionId, `Verification requirement references unknown criterion ${criterionId}`, { requirementId: requirement.id }));
      }
    }
  }
  const criteria: VerificationEvidenceCriterion[] = input.acceptanceCriteria.map((_, index) => {
    const criterionId = `criterion-${index + 1}`;
    const requirements = (input.verificationRequirements ?? []).filter(({ criterionIds }) => criterionIds.includes(criterionId));
    const requiredCommandIds = [...new Set(requirements.filter(({ kind }) => kind === "command").map(({ id }) => id))].sort();
    const controllerGateIds = [...new Set(requirements.filter(({ kind }) => kind === "controller-gate").map(({ id }) => id))].sort();
    const evidenceKind = strongestEvidenceKind(requirements.map(({ evidenceKind }) => evidenceKind));
    const semanticCommandIds = requiredCommandIds.filter((id) => {
      const command = commands.get(id);
      return command !== undefined && capabilityOf(command) !== "generic" && capabilityIsUsable(command);
    }).sort();
    const unknownCommands = requiredCommandIds.filter((id) => !commands.has(id));
    const unknownGates = controllerGateIds.filter((id) => !gates.has(id));
    const unusableCommands = requiredCommandIds.filter((id) => {
      const command = commands.get(id);
      return command !== undefined && capabilityOf(command) !== "generic" && !capabilityIsUsable(command);
    });
    if (!requirements.length) diagnostics.push(diagnostic("missing-requirement", criterionId, `Criterion ${criterionId} has no controller evidence requirement`));
    if (unknownCommands.length) diagnostics.push(diagnostic("unknown-command", criterionId, `Criterion ${criterionId} references unavailable command IDs`, { ids: unknownCommands }));
    if (unknownGates.length) diagnostics.push(diagnostic("unknown-controller-gate", criterionId, `Criterion ${criterionId} references unavailable controller gates`, { ids: unknownGates }));
    if (unusableCommands.length) diagnostics.push(diagnostic("unusable-semantic-command", criterionId, `Criterion ${criterionId} references semantic commands without controller-derived targets`, { ids: unusableCommands }));
    // A gate is itself authoritative evidence. A command-backed criterion needs
    // an explicitly semantic command, including when it also has a gate.
    if (requiredCommandIds.length > 0 && semanticCommandIds.length === 0) {
      diagnostics.push(diagnostic("generic-only-command", criterionId, `Criterion ${criterionId} is backed only by generic verification commands`));
    }
    if ((evidenceKind === "behavioral" || evidenceKind === "temporal") && semanticCommandIds.length === 0) {
      diagnostics.push(diagnostic("semantic-evidence-command-missing", criterionId, `Criterion ${criterionId} requires a controller targeted-test, regression, or invariant command for ${evidenceKind} evidence`));
    }
    const invariant = invariantMatrixIdentitiesForCriterion(rows, criterionId);
    if (invariant.invariantRowIds.length && !requiredCommandIds.some((id) => {
      const capability = commands.get(id);
      return capability !== undefined && capabilityIsUsable(capability)
        && (capabilityOf(capability) === "targeted-test" || capabilityOf(capability) === "invariant");
    })) {
      diagnostics.push(diagnostic("invariant-command-missing", criterionId, `Criterion ${criterionId} has invariant rows but no targeted-test or invariant command capable of proving them`));
    }
    return {
      criterionId,
      ...(evidenceKind !== "structural" ? { evidenceKind } : {}),
      requiredCommandIds,
      semanticCommandIds,
      controllerGateIds,
      allowedWritePaths: expectedPaths,
      allowedEvidencePaths: evidencePathsForCriterion(input.evidencePaths ?? [], criterionId, diagnostics),
      ...invariant,
    };
  });
  return { contract: { version: EVIDENCE_CONTRACT_VERSION, criteria }, diagnostics };
}

export function validateEvidenceContract(
  contract: VerificationEvidenceContract,
  input: EvidenceContractInput,
): VerificationEvidenceDiagnostic[] {
  const derived = deriveEvidenceContract(input);
  const diagnostics = [...derived.diagnostics];
  if (contract.version !== EVIDENCE_CONTRACT_VERSION) {
    diagnostics.push(diagnostic("contract-version", undefined, `Unsupported evidence contract version ${contract.version}`));
  } else if (JSON.stringify(contract) !== JSON.stringify(derived.contract)) {
    diagnostics.push(diagnostic("contract-mismatch", undefined, "Evidence contract does not match controller-derived canonical evidence"));
  }
  return diagnostics;
}

/** Alias used by callers that want an explicit re-derivation operation. */
export const rederiveEvidenceContract = deriveEvidenceContract;
export const validateEvidenceContractEquality = validateEvidenceContract;

export type EvidenceContractPacketInput = Pick<BuildPacketPayload, "acceptanceCriteria" | "verificationRequirements" | "controllerGates" | "expectedPaths" | "evidencePaths" | "invariantMatrices"> & {
  commands: EvidenceContractInput["commands"];
};

export function deriveEvidenceContractFromPacket(input: EvidenceContractPacketInput): EvidenceContractDerivation {
  return deriveEvidenceContract(input);
}
