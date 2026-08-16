// SPDX-License-Identifier: AGPL-3.0-or-later

import { randomUUID } from "node:crypto";
import type {
  DurableOrchestrationNodeStatus,
  OrchestrationExecutionAdmission,
  OrchestrationExecutionClaim,
  OrchestrationNodeRecord,
  OrchestrationPlanMetadata,
  OrchestrationRecord,
  OrchestrationRecoveryMode,
  OrchestrationRepository,
  OrchestrationWorkerAttemptRecord,
  OrchestrationWorkerAttemptStatus,
} from "../../core/ports/orchestration.js";
import {
  orchestrationEventFromSchedule,
  type OrchestrationEvent,
  type OrchestrationEventSink,
} from "./events.js";
import {
  isLeaseContinuityFailure,
  materializeClaimDependencies,
  runSchedule,
  validateGraph,
  type ClaimSerializationEdge,
  type ScheduleEvent,
  type ScheduleResult,
  type ScheduleWorkerContext,
  type ScheduleWorkerResult,
  type ScheduledStatus,
  type ScheduledWorkItem,
} from "./scheduler.js";
import { buildOrchestrationSnapshot } from "./view-model.js";

export interface CreateOrchestrationInput {
  orchestrationId?: string;
  repository: string;
  requestedIssueNumbers?: readonly number[];
  items: readonly ScheduledWorkItem[];
  /** Omit to derive deterministic release-only edges from frozen claims. */
  serializationEdges?: readonly ClaimSerializationEdge[];
  maxParallel: number;
  autoMerge?: boolean;
  productionTarget?: string;
  /** Opaque, JSON-safe authorisation/evidence supplied by the planning layer. */
  plan?: OrchestrationPlanMetadata;
}

export interface OrchestrationTaskIdentity {
  taskId?: string;
  controllerTaskId?: string;
  agentTaskId?: string;
  runId?: string;
  sessionId?: string;
}

export interface OrchestrationWorkerContext extends ScheduleWorkerContext {
  orchestrationId: string;
  attemptId: string;
  recovery: OrchestrationRecoveryMode;
  /** Persist transport identity immediately after the caller launches work-on. */
  recordTask(identity: OrchestrationTaskIdentity): Promise<void>;
  /** Persist a heartbeat correlated to this exact orchestration/node/attempt. */
  heartbeat(at?: string): Promise<void>;
}

export type OrchestrationWorkOnWorker = (
  item: ScheduledWorkItem,
  context: OrchestrationWorkerContext,
) => Promise<ScheduleWorkerResult>;

export interface OrchestrationWorkerReconciliationInput {
  orchestration: Readonly<OrchestrationRecord>;
  node: Readonly<OrchestrationNodeRecord>;
  item: ScheduledWorkItem;
  attempt?: Readonly<OrchestrationWorkerAttemptRecord>;
}

export interface OrchestrationRouteSnapshot {
  targetBranch: string;
  lane: "fast" | "feature";
  promotionTarget?: string;
  productionTarget?: string;
}

export type OrchestrationRouteRevalidator = (input: {
  orchestration: Readonly<OrchestrationRecord>;
  node: Readonly<OrchestrationNodeRecord>;
  item: ScheduledWorkItem;
}) => Promise<OrchestrationRouteSnapshot>;

export type OrchestrationWorkerReconciliation =
  | {
      disposition: "live";
      /** Wait for the already-running worker. The work-on worker is not invoked. */
      wait(context: OrchestrationWorkerContext): Promise<ScheduleWorkerResult>;
      attemptId?: string;
      identity?: OrchestrationTaskIdentity;
      heartbeatAt?: string;
    }
  | {
      disposition: "interrupted";
      reason?: string;
    }
  | {
      disposition: "terminal";
      result: Exclude<ScheduleWorkerResult, void>;
      reason?: string;
    };

export type OrchestrationWorkerReconciler = (
  input: OrchestrationWorkerReconciliationInput,
) => Promise<OrchestrationWorkerReconciliation>;

export interface OrchestrationDecompositionExpansion {
  /** Authoritative replacement issue numbers reported by the worker/artifacts. */
  childIssues: readonly number[];
  /** Frozen scheduler nodes for the replacement scope. */
  items: readonly ScheduledWorkItem[];
  /** Optional claim-only ordering derived for the replacement nodes. */
  serializationEdges?: readonly ClaimSerializationEdge[];
}

export type OrchestrationDecompositionResolver = (input: {
  orchestration: Readonly<OrchestrationRecord>;
  node: Readonly<OrchestrationNodeRecord>;
  item: ScheduledWorkItem;
  /** Omitted only when recovering a legacy skipped node from authoritative artifacts. */
  childIssues?: readonly number[];
}) => Promise<OrchestrationDecompositionExpansion | undefined>;

export interface OrchestrationControllerDependencies {
  repository: OrchestrationRepository;
  worker: OrchestrationWorkOnWorker;
  /** Durable, cross-process fencing for one active execution of a DAG. */
  executionAdmission: OrchestrationExecutionAdmission;
  /** Required to safely resume a record containing running/suspended nodes. */
  reconcileWorker?: OrchestrationWorkerReconciler;
  /** Refresh queued delivery routes from authoritative issue/config evidence before resumed dispatch. */
  revalidateRoute?: OrchestrationRouteRevalidator;
  /** Resolve and materialize authoritative replacement nodes after decomposition. */
  resolveDecomposition?: OrchestrationDecompositionResolver;
  /** Maximum replacement children accepted from one decomposition outcome. */
  maxDecompositionChildren?: number;
  /** Maximum replacement lineage depth (root nodes are depth zero). */
  maxDecompositionDepth?: number;
  /** Available worker slots in the caller's process/RPC/subagent transport. */
  transportCapacity: number | (() => number | Promise<number>);
  onEvent?: OrchestrationEventSink;
  /** Observer failures are diagnostic only and never change workflow state. */
  onEventError?: (error: unknown, event: OrchestrationEvent) => void;
  now?: () => string;
  createOrchestrationId?: () => string;
  createAttemptId?: () => string;
}

export interface OrchestrationControllerResult {
  orchestrationId: string;
  effectiveMaxParallel: number;
  schedule: ScheduleResult;
  record: OrchestrationRecord;
}

interface PersistenceState {
  record: OrchestrationRecord;
  claim: OrchestrationExecutionClaim;
  pending: Promise<void>;
  error?: unknown;
}

type PreparedAction =
  | { kind: "launch"; recovery: OrchestrationRecoveryMode; recoveryOfAttemptId?: string }
  | { kind: "live"; reconciliation: Extract<OrchestrationWorkerReconciliation, { disposition: "live" }> }
  | { kind: "terminal"; result: Exclude<ScheduleWorkerResult, void> };

interface PreparedExecution {
  items: ScheduledWorkItem[];
  serializationEdges: ClaimSerializationEdge[];
  actions: Map<string, PreparedAction>;
  resumedItemIds: string[];
}

/**
 * Headless orchestration domain service. Scope resolution, GitHub truth, and
 * worker transport stay behind caller-supplied dependencies; this class owns
 * only the frozen DAG, durable execution identity, scheduling, and recovery.
 */
export class OrchestrationController {
  private readonly active = new Set<string>();
  private readonly now: () => string;
  private readonly createOrchestrationId: () => string;
  private readonly createAttemptId: () => string;

  constructor(private readonly dependencies: OrchestrationControllerDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.createOrchestrationId = dependencies.createOrchestrationId ?? (() => `dag_${randomUUID()}`);
    this.createAttemptId = dependencies.createAttemptId ?? (() => `attempt_${randomUUID()}`);
  }

  async create(input: CreateOrchestrationInput): Promise<OrchestrationRecord> {
    if (!input.repository.trim()) throw new Error("Orchestration repository is required");
    assertPositiveInteger(input.maxParallel, "maxParallel");
    if (!input.items.length) throw new Error("Orchestration requires at least one work item");

    const suppliedItems = input.items.map(cloneScheduledItem);
    const graph = input.serializationEdges === undefined
      ? materializeClaimDependencies(suppliedItems)
      : {
          items: suppliedItems,
          edges: input.serializationEdges.map(cloneSerializationEdge),
        };
    validateGraph(graph.items, graph.edges);
    for (const item of graph.items) assertProtectedProductionRoute(item, input.productionTarget);

    const requestedIssueNumbers = uniqueIssueNumbers(
      input.requestedIssueNumbers
      ?? graph.items.flatMap((item) => [item.issue, ...(item.memberIssues ?? [])]),
    );
    if (!requestedIssueNumbers.length) throw new Error("Orchestration requires at least one requested issue");
    const now = this.now();
    const orchestrationId = input.orchestrationId ?? this.createOrchestrationId();
    if (!orchestrationId.trim()) throw new Error("Orchestration id is required");
    const record: OrchestrationRecord = {
      schema: "forgedock.orchestration/v1",
      orchestrationId,
      repository: input.repository,
      requestedIssueNumbers,
      issueNumbers: [...requestedIssueNumbers],
      maxParallel: input.maxParallel,
      autoMerge: input.autoMerge ?? true,
      ...(input.plan !== undefined ? { plan: structuredClone(input.plan) } : {}),
      ...(input.productionTarget !== undefined ? { productionTarget: input.productionTarget } : {}),
      executionAttempt: 0,
      status: "running",
      createdAt: now,
      updatedAt: now,
      serializationEdges: graph.edges.map((edge) => ({
        predecessor: edge.predecessor,
        successor: edge.successor,
        overlappingClaims: [...edge.overlappingClaims],
      })),
      nodes: graph.items.map((item) => nodeRecordFromItem(item)),
    };
    await this.dependencies.repository.createOrchestration(record);
    this.emitSnapshot(record);
    return structuredClone(record);
  }

  async createAndRun(input: CreateOrchestrationInput): Promise<OrchestrationControllerResult> {
    const record = await this.create(input);
    return this.run(record.orchestrationId);
  }

  async run(orchestrationId: string): Promise<OrchestrationControllerResult> {
    return this.execute(orchestrationId, false);
  }

  async resume(orchestrationId: string): Promise<OrchestrationControllerResult> {
    return this.execute(orchestrationId, true);
  }

  private async execute(orchestrationId: string, resume: boolean): Promise<OrchestrationControllerResult> {
    if (this.active.has(orchestrationId)) throw new Error(`Orchestration ${orchestrationId} is already active in this controller`);
    // Claim process-local admission before the first await so two callers on
    // this controller cannot both pass the preflight check.
    this.active.add(orchestrationId);
    let claim: OrchestrationExecutionClaim | undefined;
    let state: PersistenceState | undefined;
    try {
      try {
        claim = await this.dependencies.executionAdmission.acquire(orchestrationId);
      } catch (error) {
        // A newly created DAG must not remain indistinguishably "running" when
        // execution admission fails before the controller can own it.
        const unstarted = await this.dependencies.repository.loadOrchestration(orchestrationId).catch(() => undefined);
        if (unstarted
          && unstarted.executionAttempt === 0
          && unstarted.nodes.every((node) => node.status === "queued" && !(node.attempts?.length))) {
          await this.dependencies.repository.saveOrchestration({
            ...unstarted,
            status: "failed",
            updatedAt: this.now(),
          }).catch(() => undefined);
        }
        throw error;
      }
      if (!claim) throw new Error(`Orchestration ${orchestrationId} is already active in another controller`);
      if (!claim.claimId.trim()) throw new Error(`Execution admission returned an empty claim id for ${orchestrationId}`);
      claim.assertValid();

      const loaded = await this.dependencies.repository.loadOrchestration(orchestrationId);
      if (!loaded) throw new Error(`Unknown orchestration: ${orchestrationId}`);
      if (loaded.status === "cancelled") throw new Error(`Orchestration ${orchestrationId} is cancelled`);
      if (resume && loaded.status === "completed") throw new Error(`Orchestration ${orchestrationId} is already complete`);
      if (!resume && loaded.nodes.some((node) => node.status !== "queued" || (node.attempts?.length ?? 0) > 0)) {
        throw new Error(`Orchestration ${orchestrationId} has already started; use resume`);
      }

      state = { record: structuredClone(loaded), claim, pending: Promise.resolve() };
      const transportCapacity = await this.resolveTransportCapacity();
      const effectiveMaxParallel = Math.min(state.record.maxParallel, transportCapacity);
      assertPositiveInteger(effectiveMaxParallel, "effectiveMaxParallel");
      this.replaceRecord(state, {
        ...state.record,
        status: "running",
        executionAttempt: (state.record.executionAttempt ?? 0) + 1,
        transportCapacity,
        effectiveMaxParallel,
        executionClaimId: claim.claimId,
        updatedAt: this.now(),
      });
      await this.flush(state);

      const prepared = resume
        ? await this.prepareResume(state)
        : this.prepareInitial(state.record);
      await this.flush(state);

      if (!prepared.items.length) {
        const schedule = scheduleResultFromRecord(state.record, []);
        this.finalizeRecord(state);
        await this.flush(state);
        return {
          orchestrationId,
          effectiveMaxParallel,
          schedule,
          record: structuredClone(state.record),
        };
      }

      const executionState = state;
      const startOrder: string[] = [];
      let schedule: ScheduleResult = scheduleResultFromRecord(state.record, []);
      let pass = prepared;
      while (pass.items.length) {
        const current = await runSchedule(
          pass.items,
          effectiveMaxParallel,
          (item, schedulerContext) => this.executePreparedWorker(executionState, item, schedulerContext, pass.actions.get(item.id)),
          {
            serializationEdges: pass.serializationEdges,
            resumedItemIds: pass.resumedItemIds,
            onClaimsPromoted: async (itemId, claims) => {
              this.updateNode(executionState, itemId, (node) => ({ ...node, claims: [...claims] }));
              this.emitSnapshot(executionState.record, executionState);
              await this.flush(executionState);
            },
            onEvent: (event) => this.handleScheduleEvent(executionState, event, pass.actions),
          },
        );
        startOrder.push(...current.startOrder);
        this.applyScheduleResult(state, current);
        schedule = current;
        const expanded = await this.expandDecompositions(state, current);
        if (!expanded) break;
        await this.flush(state);
        pass = this.prepareFollowup(state);
        if (!pass.items.length) break;
      }
      this.finalizeRecord(state);
      await this.flush(state);
      return {
        orchestrationId,
        effectiveMaxParallel,
        schedule: mergeResultWithRecord({ ...schedule, startOrder }, state.record),
        record: structuredClone(state.record),
      };
    } catch (error) {
      if (state && state.error === undefined) {
        this.replaceRecord(state, { ...state.record, status: "failed", updatedAt: this.now() });
        this.emitSnapshot(state.record, state);
        try {
          await this.flush(state);
        } catch {
          // Preserve the controller/reconciliation failure that triggered the
          // terminal transition. Persistence failure remains in state.error.
        }
      }
      throw error;
    } finally {
      try {
        if (state) await state.pending;
        if (claim) await claim.release();
      } finally {
        this.active.delete(orchestrationId);
      }
    }
  }

  private prepareInitial(record: OrchestrationRecord): PreparedExecution {
    const items = record.nodes.map(itemFromNodeRecord);
    const serializationEdges = (record.serializationEdges ?? []).map(cloneSerializationEdge);
    validateGraph(items, serializationEdges);
    for (const item of items) assertProtectedProductionRoute(item, record.productionTarget);
    return {
      items,
      serializationEdges,
      actions: new Map(items.map((item) => [item.id, { kind: "launch", recovery: "initial" } as const])),
      resumedItemIds: [],
    };
  }

  private async prepareResume(state: PersistenceState): Promise<PreparedExecution> {
    const actions = new Map<string, PreparedAction>();
    const completed = new Set(state.record.nodes.filter((node) => node.status === "completed").map((node) => node.id));

    for (const storedNode of [...state.record.nodes]) {
      if (storedNode.status === "completed") continue;
      const node = await this.revalidateNodeRoute(state, storedNode);
      const item = itemFromNodeRecord(node);
      if (node.status === "running" || node.status === "suspended") {
        const attemptEvidence = referencedAttempt(node);
        if (attemptEvidence
          && isTerminalAttempt(attemptEvidence)
          && attemptEvidence.status !== "failed"
          && attemptEvidence.status !== "interrupted"
          && attemptEvidence.status !== "suspended") {
          const terminal = scheduleResultFromAttempt(attemptEvidence);
          if (terminal) {
            this.applyTerminalAttemptEvidence(state, node.id, attemptEvidence, terminal);
            if (terminal.status === "completed") {
              completed.add(node.id);
            } else {
              actions.set(node.id, { kind: "terminal", result: terminal });
            }
            continue;
          }
        }

        const reconcile = this.dependencies.reconcileWorker;
        if (!reconcile) {
          throw new Error(`Cannot safely resume ${node.id}: authoritative worker reconciliation is required for ${node.status} work`);
        }
        state.claim.assertValid();
        const attempt = attemptEvidence;
        const reconciliation = await reconcile({
          orchestration: structuredClone(state.record),
          node: structuredClone(node),
          item,
          ...(attempt !== undefined ? { attempt: structuredClone(attempt) } : {}),
        });
        state.claim.assertValid();
        if (reconciliation.disposition === "live") {
          this.applyLiveReconciliation(state, node.id, reconciliation);
          actions.set(node.id, { kind: "live", reconciliation });
          continue;
        }
        if (reconciliation.disposition === "interrupted") {
          const recoveryOfAttemptId = this.applyInterruptedReconciliation(
            state,
            node.id,
            reconciliation.reason,
            attemptEvidence,
          );
          actions.set(node.id, {
            kind: "launch",
            recovery: "relaunch",
            ...(recoveryOfAttemptId !== undefined ? { recoveryOfAttemptId } : {}),
          });
          continue;
        }
        this.applyTerminalReconciliation(
          state,
          node.id,
          reconciliation.result,
          reconciliation.reason,
          attemptEvidence,
        );
        if (reconciliation.result.status === "completed") {
          completed.add(node.id);
        } else {
          actions.set(node.id, { kind: "terminal", result: reconciliation.result });
        }
        continue;
      }

      if (node.status === "skipped") {
        if (node.decompositionChildren?.length) {
          assertPersistedDecomposition(state.record, node);
          continue;
        }
        const expansion = await this.resolveDecomposition(state, node, item);
        if (expansion) continue;
        actions.set(node.id, {
          kind: "terminal",
          result: { status: node.status, ...(node.error !== undefined ? { error: node.error } : {}) },
        });
        continue;
      }

      if (node.status === "invalid") {
        actions.set(node.id, {
          kind: "terminal",
          result: { status: node.status, ...(node.error !== undefined ? { error: node.error } : {}) },
        });
        continue;
      }

      const recovery: OrchestrationRecoveryMode = node.status === "queued" && !(node.attempts?.length)
        ? "initial"
        : "resume";
      this.updateNode(state, node.id, (current) => clearNodeForRetry(current));
      actions.set(node.id, { kind: "launch", recovery });
    }

    const remainingIds = new Set(state.record.nodes
      .filter((node) => !completed.has(node.id)
        && !(node.status === "skipped" && node.decompositionChildren?.length))
      .map((node) => node.id));
    const items = state.record.nodes
      .filter((node) => remainingIds.has(node.id))
      .map((node) => ({
        ...itemFromNodeRecord(node),
        dependencies: node.dependencies.filter((dependency) => remainingIds.has(dependency)),
      }));
    // A legacy skipped node may have been expanded during the loop above,
    // adding queued children that were not present in the original snapshot.
    // Give those durable nodes an explicit launch action before scheduling.
    for (const item of items) {
      if (actions.has(item.id)) continue;
      const node = requiredNode(state.record, item.id);
      if (node.status === "queued") {
        actions.set(item.id, {
          kind: "launch",
          recovery: node.attempts?.length ? "resume" : "initial",
        });
      } else {
        const status = node.status === "running" ? "suspended" : node.status;
        actions.set(item.id, {
          kind: "terminal",
          result: { status, ...(node.error !== undefined ? { error: node.error } : {}) },
        });
      }
    }
    const serializationEdges = (state.record.serializationEdges ?? [])
      .filter((edge) => remainingIds.has(edge.predecessor) && remainingIds.has(edge.successor))
      .map(cloneSerializationEdge);
    validateGraph(items, serializationEdges);
    return {
      items,
      serializationEdges,
      actions,
      resumedItemIds: items.map((item) => item.id),
    };
  }

  /**
   * Build the next scheduler pass after a live decomposition. Terminal nodes
   * remain in the graph as blockers, while the replacement children and any
   * dependency descendants reopened by the replacement are dispatched.
   */
  private prepareFollowup(state: PersistenceState): PreparedExecution {
    const included = new Set(
      state.record.nodes
        .filter((node) => node.status !== "completed"
          && !(node.status === "skipped" && node.decompositionChildren?.length))
        .map((node) => node.id),
    );
    const items = state.record.nodes
      .filter((node) => included.has(node.id))
      .map((node) => ({
        ...itemFromNodeRecord(node),
        dependencies: node.dependencies.filter((dependency) => included.has(dependency)),
      }));
    const actions = new Map<string, PreparedAction>();
    for (const node of state.record.nodes) {
      if (!included.has(node.id)) continue;
      if (node.status === "queued") {
        actions.set(node.id, {
          kind: "launch",
          recovery: node.attempts?.length ? "resume" : "initial",
        });
      } else {
        const status = node.status === "running" ? "suspended" : node.status;
        actions.set(node.id, {
          kind: "terminal",
          result: {
            status,
            ...(node.error !== undefined ? { error: node.error } : {}),
          },
        });
      }
    }
    const serializationEdges = (state.record.serializationEdges ?? [])
      .filter((edge) => included.has(edge.predecessor) && included.has(edge.successor))
      .map(cloneSerializationEdge);
    validateGraph(items, serializationEdges);
    return {
      items,
      serializationEdges,
      actions,
      resumedItemIds: items.map((item) => item.id),
    };
  }

  private async expandDecompositions(state: PersistenceState, result: ScheduleResult): Promise<boolean> {
    if (!result.decompositions?.size) return false;
    for (const [nodeId, childIssues] of result.decompositions) {
      const node = requiredNode(state.record, nodeId);
      const item = itemFromNodeRecord(node);
      const expansion = await this.resolveDecomposition(state, node, item, childIssues);
      if (!expansion) {
        throw new Error(`Decomposition of ${node.id} produced child issues but no resolver materialized them`);
      }
    }
    return true;
  }

  private async resolveDecomposition(
    state: PersistenceState,
    node: OrchestrationNodeRecord,
    item: ScheduledWorkItem,
    childIssues?: readonly number[],
  ): Promise<OrchestrationDecompositionExpansion | undefined> {
    const resolver = this.dependencies.resolveDecomposition;
    if (!resolver) {
      if (childIssues?.length) {
        throw new Error(`Decomposition of ${node.id} requires a durable child-scope resolver`);
      }
      return undefined;
    }
    state.claim.assertValid();
    const expansion = await resolver({
      orchestration: structuredClone(state.record),
      node: structuredClone(node),
      item: structuredClone(item),
      ...(childIssues !== undefined ? { childIssues: [...childIssues] } : {}),
    });
    state.claim.assertValid();
    if (!expansion) {
      if (childIssues?.length) throw new Error(`Decomposition resolver returned no replacement scope for ${node.id}`);
      return undefined;
    }
    this.applyDecompositionExpansion(state, node.id, expansion, childIssues);
    return expansion;
  }

  private applyDecompositionExpansion(
    state: PersistenceState,
    nodeId: string,
    expansion: OrchestrationDecompositionExpansion,
    expectedChildIssues?: readonly number[],
  ): void {
    const parent = requiredNode(state.record, nodeId);
    if (parent.status !== "skipped") throw new Error(`Cannot expand non-skipped orchestration node ${nodeId}`);
    const children = normalizeChildIssues(expansion.childIssues, parent.issue);
    if (expectedChildIssues !== undefined && !sameNumbers(children, normalizeChildIssues(expectedChildIssues, parent.issue))) {
      throw new Error(`Decomposition resolver changed the authoritative child scope for ${nodeId}`);
    }
    if (parent.decompositionChildren?.length) {
      if (!sameNumbers(parent.decompositionChildren, children)) {
        throw new Error(`Orchestration node ${nodeId} already has a different durable child scope`);
      }
      assertPersistedDecomposition(state.record, parent);
      return;
    }
    const maxChildren = this.dependencies.maxDecompositionChildren ?? 100;
    const maxDepth = this.dependencies.maxDecompositionDepth ?? 4;
    assertPositiveInteger(maxChildren, "maxDecompositionChildren");
    if (!Number.isSafeInteger(maxDepth) || maxDepth < 0) throw new Error("maxDecompositionDepth must be a non-negative integer");
    if (!children.length) throw new Error(`Decomposition of ${nodeId} produced no replacement children`);
    if (children.length > maxChildren) throw new Error(`Decomposition of ${nodeId} exceeds the ${maxChildren}-child limit`);
    const depth = (parent.decompositionDepth ?? 0) + 1;
    if (depth > maxDepth) throw new Error(`Decomposition of ${nodeId} exceeds the ${maxDepth}-level depth limit`);

    const childSet = new Set(children);
    const existingByIssue = new Map(state.record.nodes.map((candidate) => [candidate.issue, candidate.id] as const));
    const childItems = expansion.items.map(cloneScheduledItem);
    if (childItems.length !== children.length) {
      throw new Error(`Decomposition of ${nodeId} returned ${childItems.length} scheduler nodes for ${children.length} child issues`);
    }
    const childIds = new Set<string>();
    const childIssuesSeen = new Set<number>();
    for (const child of childItems) {
      if (!childSet.has(child.issue)) throw new Error(`Decomposition of ${nodeId} returned unreported child issue #${child.issue}`);
      if (childIds.has(child.id)) throw new Error(`Decomposition of ${nodeId} returned duplicate child node ${child.id}`);
      if (childIssuesSeen.has(child.issue)) throw new Error(`Decomposition of ${nodeId} returned duplicate child issue #${child.issue}`);
      if (existingByIssue.has(child.issue)) throw new Error(`Decomposition of ${nodeId} returned existing issue #${child.issue}`);
      if (child.dependencies.includes(parent.id)) throw new Error(`Decomposition child ${child.id} depends on its skipped parent ${parent.id}`);
      childIds.add(child.id);
      childIssuesSeen.add(child.issue);
    }
    if (childIssuesSeen.size !== childSet.size) throw new Error(`Decomposition of ${nodeId} did not materialize every child issue`);
    const originalDependencies = new Map(state.record.nodes.map((candidate) => [candidate.id, [...candidate.dependencies]] as const));
    const descendants = new Set(state.record.nodes
      .filter((candidate) => candidate.status === "blocked" && dependsOn(originalDependencies, candidate.id, parent.id))
      .map((candidate) => candidate.id));
    const replacementIds = [...childIds];
    const replaceParentDependency = (dependencies: readonly string[]): string[] => [
      ...new Set(dependencies.flatMap((dependency) => dependency === parent.id ? replacementIds : [dependency])),
    ];
    const expandedNodes = state.record.nodes.map((candidate) => {
      if (candidate.id === parent.id) {
        return {
          ...candidate,
          decompositionChildren: [...children],
          decompositionDepth: depth - 1,
          waitReason: { kind: "decomposition-replan" as const, children: [...children] },
        };
      }
      const dependencies = replaceParentDependency(candidate.dependencies);
      if (descendants.has(candidate.id)) {
        const reopened = clearNodeForRetry(candidate);
        return { ...reopened, dependencies };
      }
      return dependencies.length === candidate.dependencies.length
        ? candidate
        : { ...candidate, dependencies };
    });
    const childNodes = childItems.map((child) => ({
      ...nodeRecordFromItem(child),
      decompositionDepth: depth,
    }));
    const rewrittenEdges = rewriteDecompositionEdges(state.record.serializationEdges ?? [], parent.id, replacementIds);
    const suppliedEdges = (expansion.serializationEdges ?? []).map(cloneSerializationEdge);
    const serializationEdges = mergeSerializationEdges([...rewrittenEdges, ...suppliedEdges]);
    const allItems = expandedNodes.concat(childNodes).map(itemFromNodeRecord);
    validateGraph(allItems, serializationEdges);
    this.replaceRecord(state, {
      ...state.record,
      issueNumbers: uniqueIssueNumbers([...state.record.issueNumbers, ...children]),
      nodes: [...expandedNodes, ...childNodes],
      serializationEdges: serializationEdges.map((edge) => ({
        predecessor: edge.predecessor,
        successor: edge.successor,
        overlappingClaims: [...edge.overlappingClaims],
      })),
      updatedAt: this.now(),
    });
    this.emitSnapshot(state.record, state);
  }

  private async revalidateNodeRoute(
    state: PersistenceState,
    node: OrchestrationNodeRecord,
  ): Promise<OrchestrationNodeRecord> {
    const revalidate = this.dependencies.revalidateRoute;
    if (!revalidate) {
      assertProtectedProductionRoute(itemFromNodeRecord(node), state.record.productionTarget);
      return node;
    }
    state.claim.assertValid();
    const route = await revalidate({
      orchestration: structuredClone(state.record),
      node: structuredClone(node),
      item: itemFromNodeRecord(node),
    });
    state.claim.assertValid();
    const candidate: ScheduledWorkItem = {
      ...itemFromNodeRecord(node),
      targetBranch: route.targetBranch,
      lane: route.lane,
      ...(route.promotionTarget !== undefined ? { promotionTarget: route.promotionTarget } : {}),
      ...(route.productionTarget !== undefined ? { productionTarget: route.productionTarget } : {}),
    };
    assertProtectedProductionRoute(candidate, state.record.productionTarget);
    if (route.productionTarget !== state.record.productionTarget) {
      throw new Error(
        `Authoritative route for ${node.id} reports production target ${route.productionTarget ?? "unset"}, but orchestration ${state.record.orchestrationId} is frozen to ${state.record.productionTarget ?? "unset"}`,
      );
    }
    const changed = node.targetBranch !== route.targetBranch
      || node.lane !== route.lane
      || node.promotionTarget !== route.promotionTarget
      || node.productionTarget !== route.productionTarget;
    if (!changed) return node;
    const active = node.activeAttemptId === undefined
      ? undefined
      : node.attempts?.find((attempt) => attempt.attemptId === node.activeAttemptId);
    const hasSemanticExecution = node.childRunIds.length > 0
      || (node.attempts ?? []).some((attempt) => attempt.runId !== undefined || attempt.agentTaskId !== undefined || attempt.sessionId !== undefined);
    const hasActiveTransportIdentity = active !== undefined
      && [active.taskId, active.controllerTaskId, active.agentTaskId, active.runId, active.sessionId].some((value) => value !== undefined);
    if (hasSemanticExecution || hasActiveTransportIdentity) {
      throw new Error(
        `Durable route drift for ${node.id}: frozen ${node.lane ?? "unknown"}:${node.targetBranch ?? "unset"} now classifies to ${route.lane}:${route.targetBranch}; refusing to retarget started work`,
      );
    }
    this.updateNode(state, node.id, (current) => {
      const {
        targetBranch: _targetBranch,
        lane: _lane,
        promotionTarget: _promotionTarget,
        productionTarget: _productionTarget,
        ...retained
      } = current;
      return {
        ...retained,
        targetBranch: route.targetBranch,
        lane: route.lane,
        ...(route.promotionTarget !== undefined ? { promotionTarget: route.promotionTarget } : {}),
        ...(route.productionTarget !== undefined ? { productionTarget: route.productionTarget } : {}),
      };
    });
    return requiredNode(state.record, node.id);
  }

  private async executePreparedWorker(
    state: PersistenceState,
    item: ScheduledWorkItem,
    schedulerContext: ScheduleWorkerContext,
    action: PreparedAction | undefined,
  ): Promise<ScheduleWorkerResult> {
    if (!action) throw new Error(`No prepared worker action for ${item.id}`);
    if (action.kind === "terminal") return action.result;
    state.claim.assertValid();

    if (action.kind === "live") {
      const attempt = activeAttempt(requiredNode(state.record, item.id));
      if (!attempt) throw new Error(`Live reconciliation for ${item.id} has no durable attempt identity`);
      const context = this.workerContext(state, item, schedulerContext, attempt.attemptId, "reattach");
      let result: ScheduleWorkerResult;
      try {
        result = await action.reconciliation.wait(context);
      } catch (error) {
        await this.failAttempt(state, item.id, attempt.attemptId, error);
        throw error;
      }
      await this.finishAttempt(state, item.id, attempt.attemptId, result);
      return result;
    }

    const existingAttempts = requiredNode(state.record, item.id).attempts ?? [];
    const recovery = action.recovery === "initial" && existingAttempts.length > 0
      ? "resume"
      : action.recovery;
    const attempt = await this.beginAttempt(state, item.id, recovery, action.recoveryOfAttemptId);
    const context = this.workerContext(state, item, schedulerContext, attempt.attemptId, recovery);
    let result: ScheduleWorkerResult;
    try {
      result = await this.dependencies.worker(item, context);
    } catch (error) {
      await this.failAttempt(state, item.id, attempt.attemptId, error);
      throw error;
    }
    await this.finishAttempt(state, item.id, attempt.attemptId, result);
    return result;
  }

  private workerContext(
    state: PersistenceState,
    item: ScheduledWorkItem,
    schedulerContext: ScheduleWorkerContext,
    attemptId: string,
    recovery: OrchestrationRecoveryMode,
  ): OrchestrationWorkerContext {
    return {
      orchestrationId: state.record.orchestrationId,
      attemptId,
      recovery,
      promoteClaims: async (claims) => {
        assertAttemptActive(state.record, item.id, attemptId);
        state.claim.assertValid();
        await schedulerContext.promoteClaims(claims);
      },
      recordTask: async (identity) => {
        const identityValues = Object.values(identity);
        if (!identityValues.length
          || identityValues.some((value) => typeof value !== "string" || value.trim().length === 0)) {
          throw new Error(`Worker ${item.id} reported an empty or invalid task identity`);
        }
        assertAttemptActive(state.record, item.id, attemptId);
        state.claim.assertValid();
        const nextIdentity = definedIdentity(identity);
        this.updateNode(state, item.id, (node) => {
          assertAttemptActiveInNode(node, item.id, attemptId);
          const attempts = (node.attempts ?? []).map((attempt) => attempt.attemptId === attemptId
            ? {
                ...attempt,
                ...compatibleIdentity(attempt, nextIdentity, item.id),
                status: "running" as const,
                updatedAt: this.now(),
              }
            : attempt);
          return {
            ...node,
            attempts,
            ...(nextIdentity.runId
              ? { childRunIds: [...new Set([...node.childRunIds, nextIdentity.runId])] }
              : {}),
          };
        });
        await this.flush(state);
        this.emitSnapshot(state.record);
      },
      heartbeat: async (at = this.now()) => {
        assertAttemptActive(state.record, item.id, attemptId);
        state.claim.assertValid();
        this.updateAttempt(state, item.id, attemptId, (attempt) => ({
          ...attempt,
          status: "running",
          updatedAt: at,
          lastHeartbeatAt: at,
          heartbeatSequence: (attempt.heartbeatSequence ?? 0) + 1,
        }));
        await this.flush(state);
        this.emitSnapshot(state.record);
      },
    };
  }

  private async beginAttempt(
    state: PersistenceState,
    nodeId: string,
    recovery: OrchestrationRecoveryMode,
    recoveryOfAttemptId?: string,
  ): Promise<OrchestrationWorkerAttemptRecord> {
    const node = requiredNode(state.record, nodeId);
    const now = this.now();
    const attemptId = this.createAttemptId();
    assertAttemptIdAvailable(node, attemptId);
    const attempt: OrchestrationWorkerAttemptRecord = {
      attemptId,
      attempt: (node.attempts?.reduce((maximum, candidate) => Math.max(maximum, candidate.attempt), 0) ?? 0) + 1,
      recovery,
      status: "launching",
      startedAt: now,
      updatedAt: now,
      ...(recoveryOfAttemptId !== undefined ? { recoveryOfAttemptId } : {}),
    };
    this.updateNode(state, nodeId, (current) => ({
      ...current,
      attempts: [...(current.attempts ?? []), attempt],
      activeAttemptId: attempt.attemptId,
    }));
    await this.flush(state);
    this.emitSnapshot(state.record);
    return attempt;
  }

  private async finishAttempt(
    state: PersistenceState,
    nodeId: string,
    attemptId: string,
    result: ScheduleWorkerResult,
  ): Promise<void> {
    const normalized = normalizeWorkerResult(result);
    const status: DurableOrchestrationNodeStatus = normalized.status === "failed" && isLeaseContinuityFailure(normalized.error)
      ? "suspended"
      : normalized.status;
    this.completeActiveAttempt(
      state,
      nodeId,
      attemptId,
      status,
      normalized.error,
      (attempt, now) => ({
        ...attempt,
        status,
        updatedAt: now,
        completedAt: now,
        ...(normalized.error !== undefined ? { error: errorMessage(normalized.error) } : {}),
      }),
    );
    await this.flush(state);
  }

  private async failAttempt(state: PersistenceState, nodeId: string, attemptId: string, error: unknown): Promise<void> {
    const status: DurableOrchestrationNodeStatus = isLeaseContinuityFailure(error) ? "suspended" : "failed";
    this.completeActiveAttempt(
      state,
      nodeId,
      attemptId,
      status,
      error,
      (attempt, now) => ({
        ...attempt,
        status,
        updatedAt: now,
        completedAt: now,
        error: errorMessage(error),
      }),
    );
    await this.flush(state);
  }

  private applyLiveReconciliation(
    state: PersistenceState,
    nodeId: string,
    reconciliation: Extract<OrchestrationWorkerReconciliation, { disposition: "live" }>,
  ): void {
    const node = requiredNode(state.record, nodeId);
    const existing = activeAttempt(node);
    const now = this.now();
    if (existing && reconciliation.attemptId && reconciliation.attemptId !== existing.attemptId) {
      throw new Error(
        `Live reconciliation attempt ${reconciliation.attemptId} does not match durable attempt ${existing.attemptId} for ${nodeId}`,
      );
    }
    const attemptId = existing?.attemptId ?? reconciliation.attemptId ?? this.createAttemptId();
    if (!existing) assertAttemptIdAvailable(node, attemptId);
    const identity = definedIdentity(reconciliation.identity ?? {});
    const attempt: OrchestrationWorkerAttemptRecord = existing
      ? resumedLiveAttempt(existing, identity, now, reconciliation.heartbeatAt)
      : {
          attemptId,
          attempt: (node.attempts?.reduce((maximum, candidate) => Math.max(maximum, candidate.attempt), 0) ?? 0) + 1,
          recovery: "reattach",
          status: "running",
          startedAt: now,
          updatedAt: now,
          ...identity,
          ...(reconciliation.heartbeatAt !== undefined ? { lastHeartbeatAt: reconciliation.heartbeatAt } : {}),
        };
    this.updateNode(state, nodeId, (current) => ({
      ...current,
      status: "running",
      attempts: existing
        ? (current.attempts ?? []).map((candidate) => candidate.attemptId === attemptId ? attempt : candidate)
        : [...(current.attempts ?? []), attempt],
      activeAttemptId: attemptId,
      lastRecovery: {
        mode: "reattach",
        reconciledAt: now,
        attemptId,
        ...(attempt.taskId !== undefined ? { taskId: attempt.taskId } : {}),
      },
      ...(reconciliation.identity?.runId
        ? { childRunIds: [...new Set([...current.childRunIds, reconciliation.identity.runId])] }
        : {}),
    }));
  }

  private applyInterruptedReconciliation(
    state: PersistenceState,
    nodeId: string,
    reason?: string,
    attemptEvidence?: OrchestrationWorkerAttemptRecord,
  ): string | undefined {
    const node = requiredNode(state.record, nodeId);
    const attempt = attemptEvidence ?? activeAttempt(node);
    const now = this.now();
    this.updateNode(state, nodeId, (current) => {
      const { activeAttemptId: _activeAttemptId, error: _error, waitReason: _waitReason, ...rest } = current;
      return {
        ...rest,
        status: "queued",
        attempts: (current.attempts ?? []).map((candidate) => candidate.attemptId === attempt?.attemptId
          ? {
              ...candidate,
              status: "interrupted",
              updatedAt: now,
              completedAt: now,
              ...(reason !== undefined ? { error: reason } : {}),
            }
          : candidate),
        lastRecovery: {
          mode: "relaunch",
          reconciledAt: now,
          ...(attempt !== undefined ? { attemptId: attempt.attemptId } : {}),
          ...(attempt?.taskId !== undefined ? { taskId: attempt.taskId } : {}),
          ...(reason !== undefined ? { reason } : {}),
        },
      };
    });
    return attempt?.attemptId;
  }

  private applyTerminalReconciliation(
    state: PersistenceState,
    nodeId: string,
    result: Exclude<ScheduleWorkerResult, void>,
    reason?: string,
    attemptEvidence?: OrchestrationWorkerAttemptRecord,
  ): void {
    const node = requiredNode(state.record, nodeId);
    const attempt = attemptEvidence ?? activeAttempt(node);
    const now = this.now();
    this.updateNode(state, nodeId, (current) => {
      const { activeAttemptId: _activeAttemptId, error: _error, waitReason: _waitReason, ...rest } = current;
      const error = result.error ?? reason;
      return {
        ...rest,
        status: durableStatus(result.status),
        attempts: (current.attempts ?? []).map((candidate) => {
          if (candidate.attemptId !== attempt?.attemptId) return candidate;
          const { error: _attemptError, ...attemptWithoutError } = candidate;
          return {
            ...attemptWithoutError,
            status: workerAttemptStatus(result),
            updatedAt: now,
            completedAt: now,
            ...(result.error !== undefined ? { error: errorMessage(result.error) } : {}),
          };
        }),
        ...(error !== undefined ? { error: errorMessage(error) } : {}),
        lastRecovery: {
          mode: "terminal",
          reconciledAt: now,
          ...(attempt !== undefined ? { attemptId: attempt.attemptId } : {}),
          ...(attempt?.taskId !== undefined ? { taskId: attempt.taskId } : {}),
          ...(reason !== undefined ? { reason } : {}),
        },
      };
    });
  }

  /**
   * Repairs the narrow crash window left by older controllers that persisted a
   * terminal attempt before clearing activeAttemptId/updating the node. The
   * worker result is already durable, so recovery must not redispatch it as if
   * it were still live.
   */
  private applyTerminalAttemptEvidence(
    state: PersistenceState,
    nodeId: string,
    attempt: OrchestrationWorkerAttemptRecord,
    result: Exclude<ScheduleWorkerResult, void>,
  ): void {
    const now = this.now();
    this.updateNode(state, nodeId, (current) => {
      const { activeAttemptId: _activeAttemptId, error: _error, waitReason: _waitReason, ...rest } = current;
      return {
        ...rest,
        status: durableStatus(result.status),
        ...(result.error !== undefined ? { error: errorMessage(result.error) } : {}),
        lastRecovery: {
          mode: "terminal",
          reconciledAt: now,
          attemptId: attempt.attemptId,
          ...(attempt.taskId !== undefined ? { taskId: attempt.taskId } : {}),
          reason: "recovered from a durable terminal worker attempt",
        },
      };
    });
  }

  private handleScheduleEvent(
    state: PersistenceState,
    event: ScheduleEvent,
    actions: ReadonlyMap<string, PreparedAction>,
  ): void {
    const now = this.now();
    this.replaceRecord(state, {
      ...state.record,
      updatedAt: now,
      nodes: state.record.nodes.map((node) => {
        const scheduledStatus = event.status.get(node.id);
        if (scheduledStatus === undefined) return node;
        const action = actions.get(node.id);
        // Do not erase a durable live/terminal reconciliation merely because
        // the fresh in-memory scheduler first emits its synthetic queued view.
        if (action?.kind === "terminal" && (scheduledStatus === "queued" || scheduledStatus === "running")) return node;
        if (scheduledStatus === "queued" && action?.kind === "live") return node;
        // A parallel worker can emit an event after this node has durably
        // completed but before the scheduler observes its callback return.
        // Never regress that atomic terminal transition to the event's stale
        // running/queued projection.
        const retryingPromotedClaimConflict = event.type === "resumed"
          && event.itemId === node.id
          && scheduledStatus === "queued"
          && node.status === "suspended"
          && event.waitReasons?.get(node.id)?.kind === "active-claim-conflict";
        if ((scheduledStatus === "queued" || scheduledStatus === "running")
          && isDurablyTerminalNode(node)
          && !retryingPromotedClaimConflict) return node;
        const error = event.errors.get(node.id);
        const waitReason = event.waitReasons?.get(node.id);
        const { error: _error, waitReason: _waitReason, ...rest } = node;
        return {
          ...rest,
          status: durableStatus(scheduledStatus),
          ...(error !== undefined ? { error: error.message } : {}),
          ...(waitReason !== undefined ? { waitReason: structuredClone(waitReason) } : {}),
        };
      }),
    });

    const fullEvent = scheduleEventFromRecord(event, state.record);
    const snapshot = buildOrchestrationSnapshot({
      orchestrationId: state.record.orchestrationId,
      items: state.record.nodes.map(itemFromNodeRecord),
      serializationEdges: (state.record.serializationEdges ?? []).map(cloneSerializationEdge),
      result: {
        status: new Map(fullEvent.status),
        errors: new Map(fullEvent.errors),
        ...(fullEvent.waitReasons !== undefined ? { waitReasons: new Map(fullEvent.waitReasons) } : {}),
      },
      updatedAt: now,
    });
    this.queueEvent(state, orchestrationEventFromSchedule(fullEvent, snapshot));
  }

  private applyScheduleResult(state: PersistenceState, result: ScheduleResult): void {
    this.replaceRecord(state, {
      ...state.record,
      updatedAt: this.now(),
      nodes: state.record.nodes.map((node) => {
        const status = result.status.get(node.id);
        if (status === undefined) return node;
        const error = result.errors.get(node.id);
        const waitReason = result.waitReasons?.get(node.id);
        const { error: _error, waitReason: _waitReason, ...rest } = node;
        return {
          ...rest,
          status: durableStatus(status),
          ...(error !== undefined ? { error: error.message } : {}),
          ...(waitReason !== undefined ? { waitReason: structuredClone(waitReason) } : {}),
        };
      }),
    });
    this.emitSnapshot(state.record, state);
  }

  private finalizeRecord(state: PersistenceState): void {
    const failed = state.record.nodes.some((node) =>
      node.status === "failed"
      || node.status === "blocked"
      || node.status === "suspended"
      || node.status === "invalid"
      || node.status === "running"
      || node.status === "queued");
    this.replaceRecord(state, {
      ...state.record,
      status: failed ? "failed" : "completed",
      updatedAt: this.now(),
    });
    this.emitSnapshot(state.record, state);
  }

  private updateNode(
    state: PersistenceState,
    nodeId: string,
    update: (node: OrchestrationNodeRecord) => OrchestrationNodeRecord,
  ): void {
    let matched = false;
    const record = {
      ...state.record,
      updatedAt: this.now(),
      nodes: state.record.nodes.map((node) => {
        if (node.id !== nodeId) return node;
        matched = true;
        return update(node);
      }),
    };
    if (!matched) throw new Error(`Unknown orchestration node: ${nodeId}`);
    this.replaceRecord(state, record);
  }

  private updateAttempt(
    state: PersistenceState,
    nodeId: string,
    attemptId: string,
    update: (attempt: OrchestrationWorkerAttemptRecord) => OrchestrationWorkerAttemptRecord,
  ): void {
    this.updateNode(state, nodeId, (node) => {
      let matched = false;
      const attempts = (node.attempts ?? []).map((attempt) => {
        if (attempt.attemptId !== attemptId) return attempt;
        matched = true;
        return update(attempt);
      });
      if (!matched) throw new Error(`Unknown orchestration attempt ${attemptId} for ${nodeId}`);
      return { ...node, attempts };
    });
  }

  private completeActiveAttempt(
    state: PersistenceState,
    nodeId: string,
    attemptId: string,
    status: DurableOrchestrationNodeStatus,
    error: unknown,
    update: (attempt: OrchestrationWorkerAttemptRecord, now: string) => OrchestrationWorkerAttemptRecord,
  ): void {
    const now = this.now();
    this.updateNode(state, nodeId, (node) => {
      assertAttemptActiveInNode(node, nodeId, attemptId);
      let matched = false;
      const attempts = (node.attempts ?? []).map((attempt) => {
        if (attempt.attemptId !== attemptId) return attempt;
        matched = true;
        return update(attempt, now);
      });
      if (!matched) throw new Error(`Unknown orchestration attempt ${attemptId} for ${nodeId}`);
      const { activeAttemptId: _activeAttemptId, error: _error, waitReason: _waitReason, ...rest } = node;
      return {
        ...rest,
        status,
        attempts,
        ...(error !== undefined ? { error: errorMessage(error) } : {}),
      };
    });
  }

  private replaceRecord(state: PersistenceState, record: OrchestrationRecord): void {
    state.record = record;
    const snapshot = structuredClone(record);
    state.pending = state.pending.then(async () => {
      if (state.error !== undefined) return;
      try {
        state.claim.assertValid();
        await this.dependencies.repository.saveOrchestration(snapshot);
      } catch (error) {
        state.error = error;
      }
    });
  }

  private async flush(state: PersistenceState): Promise<void> {
    await state.pending;
    if (state.error !== undefined) throw state.error;
  }

  private async resolveTransportCapacity(): Promise<number> {
    const source = this.dependencies.transportCapacity;
    const capacity = typeof source === "function" ? await source() : source;
    assertPositiveInteger(capacity, "transportCapacity");
    return capacity;
  }

  private emitSnapshot(record: OrchestrationRecord, state?: PersistenceState): void {
    const snapshot = buildOrchestrationSnapshot({
      orchestrationId: record.orchestrationId,
      items: record.nodes.map(itemFromNodeRecord),
      serializationEdges: (record.serializationEdges ?? []).map(cloneSerializationEdge),
      result: scheduleResultFromRecord(record, []),
      updatedAt: record.updatedAt,
    });
    const event: OrchestrationEvent = {
      name: "snapshot",
      orchestrationId: record.orchestrationId,
      snapshot,
      at: record.updatedAt,
    };
    if (state) {
      this.queueEvent(state, event);
      return;
    }
    this.emitEventSafely(event);
  }

  private queueEvent(state: PersistenceState, event: OrchestrationEvent): void {
    const durableEvent = structuredClone(event);
    state.pending = state.pending.then(() => {
      if (state.error === undefined) this.emitEventSafely(durableEvent);
    });
  }

  private emitEventSafely(event: OrchestrationEvent): void {
    try {
      const delivery = this.dependencies.onEvent?.(event) as void | Promise<void>;
      if (delivery) void Promise.resolve(delivery).catch((error: unknown) => this.reportEventError(error, event));
    } catch (error) {
      this.reportEventError(error, event);
    }
  }

  private reportEventError(error: unknown, event: OrchestrationEvent): void {
    try {
      const reporting = this.dependencies.onEventError?.(error, event) as void | Promise<void>;
      if (reporting) void Promise.resolve(reporting).catch(() => undefined);
    } catch {
      // Event observers are diagnostics, never orchestration authority.
    }
  }
}

function nodeRecordFromItem(item: ScheduledWorkItem): OrchestrationNodeRecord {
  return {
    id: item.id,
    issue: item.issue,
    priority: item.priority,
    dependencies: [...item.dependencies],
    claims: [...item.claims],
    ...(item.targetBranch !== undefined ? { targetBranch: item.targetBranch } : {}),
    ...(item.lane !== undefined ? { lane: item.lane } : {}),
    ...(item.promotionTarget !== undefined ? { promotionTarget: item.promotionTarget } : {}),
    ...(item.productionTarget !== undefined ? { productionTarget: item.productionTarget } : {}),
    ...(item.affectedFiles !== undefined ? { affectedFiles: [...item.affectedFiles] } : {}),
    ...(item.memberIssues !== undefined ? { memberIssues: [...item.memberIssues] } : {}),
    ...(item.title !== undefined ? { title: item.title } : {}),
    ...(item.summary !== undefined ? { summary: item.summary } : {}),
    ...(item.plan !== undefined ? { plan: structuredClone(item.plan) } : {}),
    status: "queued",
    childRunIds: [],
    attempts: [],
  };
}

function itemFromNodeRecord(node: OrchestrationNodeRecord): ScheduledWorkItem {
  return {
    id: node.id,
    issue: node.issue,
    priority: node.priority,
    dependencies: [...node.dependencies],
    claims: [...node.claims],
    ...(node.targetBranch !== undefined ? { targetBranch: node.targetBranch } : {}),
    ...(node.lane !== undefined ? { lane: node.lane } : {}),
    ...(node.promotionTarget !== undefined ? { promotionTarget: node.promotionTarget } : {}),
    ...(node.productionTarget !== undefined ? { productionTarget: node.productionTarget } : {}),
    ...(node.affectedFiles !== undefined ? { affectedFiles: [...node.affectedFiles] } : {}),
    ...(node.memberIssues !== undefined ? { memberIssues: [...node.memberIssues] } : {}),
    ...(node.title !== undefined ? { title: node.title } : {}),
    ...(node.summary !== undefined ? { summary: node.summary } : {}),
    ...(node.plan !== undefined ? { plan: structuredClone(node.plan) } : {}),
  };
}

function cloneScheduledItem(item: ScheduledWorkItem): ScheduledWorkItem {
  return itemFromNodeRecord(nodeRecordFromItem(item));
}

function cloneSerializationEdge(edge: ClaimSerializationEdge): ClaimSerializationEdge {
  return {
    predecessor: edge.predecessor,
    successor: edge.successor,
    overlappingClaims: [...edge.overlappingClaims],
  };
}

function normalizeChildIssues(values: readonly number[], parentIssue: number): number[] {
  if (!Array.isArray(values)) throw new Error(`Decomposition children for #${parentIssue} must be an array`);
  const seen = new Set<number>();
  const children: number[] = [];
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new Error(`Decomposition child for #${parentIssue} is not a positive issue number: ${String(value)}`);
    }
    if (value === parentIssue) throw new Error(`Decomposition child for #${parentIssue} points back to its parent`);
    if (seen.has(value)) throw new Error(`Decomposition for #${parentIssue} contains duplicate child #${value}`);
    seen.add(value);
    children.push(value);
  }
  return children;
}

function sameNumbers(left: readonly number[], right: readonly number[]): boolean {
  return [...left].sort((a, b) => a - b).join(",") === [...right].sort((a, b) => a - b).join(",");
}

function assertPersistedDecomposition(record: OrchestrationRecord, parent: OrchestrationNodeRecord): void {
  const children = parent.decompositionChildren;
  if (!children?.length) throw new Error(`Decomposed node ${parent.id} has no durable child issue references`);
  const childSet = new Set(children);
  if (childSet.size !== children.length) throw new Error(`Decomposed node ${parent.id} has duplicate durable child issue references`);
  for (const childIssue of children) {
    const child = record.nodes.find((candidate) => candidate.issue === childIssue);
    if (!child) throw new Error(`Decomposed node ${parent.id} is missing durable child node #${childIssue}`);
    if (child.id === parent.id) throw new Error(`Decomposed node ${parent.id} points to itself`);
  }
}

function dependsOn(
  dependencies: ReadonlyMap<string, readonly string[]>,
  nodeId: string,
  targetId: string,
): boolean {
  const pending = [...(dependencies.get(nodeId) ?? [])];
  const visited = new Set<string>();
  while (pending.length) {
    const dependency = pending.pop()!;
    if (dependency === targetId) return true;
    if (visited.has(dependency)) continue;
    visited.add(dependency);
    pending.push(...(dependencies.get(dependency) ?? []));
  }
  return false;
}

function rewriteDecompositionEdges(
  edges: readonly ClaimSerializationEdge[],
  parentId: string,
  replacementIds: readonly string[],
): ClaimSerializationEdge[] {
  const rewritten: ClaimSerializationEdge[] = [];
  for (const edge of edges) {
    const predecessors = edge.predecessor === parentId ? replacementIds : [edge.predecessor];
    const successors = edge.successor === parentId ? replacementIds : [edge.successor];
    for (const predecessor of predecessors) {
      for (const successor of successors) {
        if (predecessor === successor) continue;
        rewritten.push({
          predecessor,
          successor,
          overlappingClaims: [...edge.overlappingClaims],
        });
      }
    }
  }
  return rewritten;
}

function mergeSerializationEdges(edges: readonly ClaimSerializationEdge[]): ClaimSerializationEdge[] {
  const merged = new Map<string, ClaimSerializationEdge>();
  for (const edge of edges) {
    const key = `${edge.predecessor}\u0000${edge.successor}`;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, cloneSerializationEdge(edge));
      continue;
    }
    existing.overlappingClaims = [...new Set([...existing.overlappingClaims, ...edge.overlappingClaims])];
  }
  return [...merged.values()];
}

function activeAttempt(node: OrchestrationNodeRecord): OrchestrationWorkerAttemptRecord | undefined {
  if (node.activeAttemptId) {
    const referenced = node.attempts?.find((attempt) => attempt.attemptId === node.activeAttemptId);
    return referenced && isActiveAttempt(referenced) ? referenced : undefined;
  }
  return [...(node.attempts ?? [])].reverse().find(isActiveAttempt);
}

function referencedAttempt(node: OrchestrationNodeRecord): OrchestrationWorkerAttemptRecord | undefined {
  if (node.activeAttemptId) {
    return node.attempts?.find((attempt) => attempt.attemptId === node.activeAttemptId);
  }
  return [...(node.attempts ?? [])].reverse()[0];
}

function isActiveAttempt(attempt: OrchestrationWorkerAttemptRecord): boolean {
  return attempt.status === "launching" || attempt.status === "running" || attempt.status === "suspended";
}

function isTerminalAttempt(attempt: OrchestrationWorkerAttemptRecord): boolean {
  return !isActiveAttempt(attempt);
}

function scheduleResultFromAttempt(
  attempt: OrchestrationWorkerAttemptRecord,
): Exclude<ScheduleWorkerResult, void> | undefined {
  const error = attempt.error;
  switch (attempt.status) {
    case "completed":
    case "skipped":
    case "failed":
    case "blocked":
    case "invalid":
      return {
        status: attempt.status,
        ...(error !== undefined ? { error } : {}),
      };
    case "interrupted":
      return { status: "failed", error: error ?? "worker attempt was interrupted" };
    case "launching":
    case "running":
    case "suspended":
      return undefined;
  }
}

function assertAttemptActive(record: OrchestrationRecord, nodeId: string, attemptId: string): void {
  assertAttemptActiveInNode(requiredNode(record, nodeId), nodeId, attemptId);
}

function assertAttemptIdAvailable(node: OrchestrationNodeRecord, attemptId: string): void {
  if (!attemptId.trim()) throw new Error(`Orchestration attempt id is required for ${node.id}`);
  if (node.attempts?.some((candidate) => candidate.attemptId === attemptId)) {
    throw new Error(`Orchestration attempt id ${attemptId} is already present for ${node.id}`);
  }
}

function assertAttemptActiveInNode(node: OrchestrationNodeRecord, nodeId: string, attemptId: string): void {
  const attempt = node.attempts?.find((candidate) => candidate.attemptId === attemptId);
  if (node.activeAttemptId !== attemptId || !attempt || !isActiveAttempt(attempt)) {
    throw new Error(`Stale orchestration worker context for ${nodeId}/${attemptId}`);
  }
}

function requiredNode(record: OrchestrationRecord, nodeId: string): OrchestrationNodeRecord {
  const node = record.nodes.find((candidate) => candidate.id === nodeId);
  if (!node) throw new Error(`Unknown orchestration node: ${nodeId}`);
  return node;
}

function isDurablyTerminalNode(node: OrchestrationNodeRecord): boolean {
  return node.status !== "queued" && node.status !== "running" && node.activeAttemptId === undefined;
}

function clearNodeForRetry(node: OrchestrationNodeRecord): OrchestrationNodeRecord {
  const { error: _error, waitReason: _waitReason, activeAttemptId: _activeAttemptId, ...rest } = node;
  return { ...rest, status: "queued" };
}

function definedIdentity(identity: OrchestrationTaskIdentity): OrchestrationTaskIdentity {
  return {
    ...(identity.taskId !== undefined ? { taskId: identity.taskId } : {}),
    ...(identity.controllerTaskId !== undefined ? { controllerTaskId: identity.controllerTaskId } : {}),
    ...(identity.agentTaskId !== undefined ? { agentTaskId: identity.agentTaskId } : {}),
    ...(identity.runId !== undefined ? { runId: identity.runId } : {}),
    ...(identity.sessionId !== undefined ? { sessionId: identity.sessionId } : {}),
  };
}

function compatibleIdentity(
  attempt: OrchestrationWorkerAttemptRecord,
  identity: OrchestrationTaskIdentity,
  nodeId: string,
): OrchestrationTaskIdentity {
  const keys = ["taskId", "controllerTaskId", "agentTaskId", "runId", "sessionId"] as const;
  for (const key of keys) {
    const current = attempt[key];
    const next = identity[key];
    if (current !== undefined && next !== undefined && current !== next) {
      throw new Error(`Worker identity ${key} for ${nodeId}/${attempt.attemptId} is immutable`);
    }
  }
  return identity;
}

function resumedLiveAttempt(
  attempt: OrchestrationWorkerAttemptRecord,
  identity: OrchestrationTaskIdentity,
  now: string,
  heartbeatAt?: string,
): OrchestrationWorkerAttemptRecord {
  const { completedAt: _completedAt, error: _error, ...active } = attempt;
  return {
    ...active,
    ...compatibleIdentity(attempt, identity, "reconciliation"),
    status: "running",
    updatedAt: now,
    ...(heartbeatAt !== undefined ? { lastHeartbeatAt: heartbeatAt } : {}),
  };
}

function normalizeWorkerResult(result: ScheduleWorkerResult): Exclude<ScheduleWorkerResult, void> {
  return result ?? { status: "completed" };
}

function workerAttemptStatus(result: Exclude<ScheduleWorkerResult, void>): OrchestrationWorkerAttemptStatus {
  return result.status === "failed" && isLeaseContinuityFailure(result.error) ? "suspended" : result.status;
}

function durableStatus(status: ScheduledStatus): DurableOrchestrationNodeStatus {
  return status;
}

function scheduleEventFromRecord(event: ScheduleEvent, record: OrchestrationRecord): ScheduleEvent {
  const status = new Map(record.nodes.map((node) => [node.id, node.status] as const));
  const errors = new Map(
    record.nodes
      .filter((node) => node.error !== undefined)
      .map((node) => [node.id, new Error(node.error!)] as const),
  );
  const waitReasons = new Map(
    record.nodes
      .filter((node) => node.waitReason !== undefined)
      .map((node) => [node.id, structuredClone(node.waitReason!)] as const),
  );
  return {
    type: event.type,
    ...(event.itemId !== undefined ? { itemId: event.itemId } : {}),
    status,
    errors,
    ...(waitReasons.size ? { waitReasons } : {}),
  };
}

function scheduleResultFromRecord(record: OrchestrationRecord, startOrder: string[]): ScheduleResult {
  const status = new Map(record.nodes.map((node) => [node.id, node.status] as const));
  const errors = new Map(
    record.nodes
      .filter((node) => node.error !== undefined)
      .map((node) => [node.id, new Error(node.error!)] as const),
  );
  const waitReasons = new Map(
    record.nodes
      .filter((node) => node.waitReason !== undefined)
      .map((node) => [node.id, structuredClone(node.waitReason!)] as const),
  );
  return { status, errors, startOrder, ...(waitReasons.size ? { waitReasons } : {}) };
}

function mergeResultWithRecord(result: ScheduleResult, record: OrchestrationRecord): ScheduleResult {
  const merged = scheduleResultFromRecord(record, [...result.startOrder]);
  for (const [nodeId, error] of result.errors) merged.errors.set(nodeId, error);
  return merged;
}

function uniqueIssueNumbers(values: readonly number[]): number[] {
  const result: number[] = [];
  const seen = new Set<number>();
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid issue number: ${value}`);
    if (seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function assertProtectedProductionRoute(item: ScheduledWorkItem, productionTarget?: string): void {
  if (item.productionTarget !== undefined && item.productionTarget !== productionTarget) {
    throw new Error(
      `Scheduled route for ${item.id} reports production target ${item.productionTarget}, but the orchestration is frozen to ${productionTarget ?? "unset"}`,
    );
  }
  const protectedTarget = productionTarget ?? item.productionTarget;
  if (protectedTarget !== undefined && item.targetBranch === protectedTarget) {
    throw new Error(
      `Scheduled route for ${item.id} directly targets protected production branch ${protectedTarget}; ordinary orchestration delivery must target an integration branch`,
    );
  }
}

function assertPositiveInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
