// SPDX-License-Identifier: AGPL-3.0-or-later

import type { CheckResult } from "./verification.js";

export type PromotionMode = "feature" | "production";

export type PromotionPhase =
  | "planned"
  | "pr-created"
  | "verifying"
  | "reviewing"
  | "awaiting-merge"
  | "completed"
  | "failed"
  | "cancelled";

export interface PromotionPullRequestRecord {
  number: number;
  url: string;
  headSha: string;
  baseBranch: string;
}

export interface PromotionReviewRecord {
  runId: string;
  verdictId: string;
  disposition: "approve" | "request_changes" | "blocked";
  headSha: string;
  baseBranch: string;
}

/** Durable checkpoint for an explicit branch promotion, separate from issue delivery RunState. */
export interface PromotionRecord {
  schema: "forgedock.promotion/v1";
  promotionId: string;
  repository: string;
  mode: PromotionMode;
  sourceBranch: string;
  targetBranch: string;
  sourceHeadSha: string;
  targetHeadSha: string;
  pullRequest?: PromotionPullRequestRecord;
  verification?: CheckResult[];
  /** Full configured verification commands are retained so resume can re-run the same plan exactly. */
  verificationCommands?: Array<{
    id: string;
    command: string;
    args: string[];
    timeoutMs: number;
    required: boolean;
    planId?: string;
    coveredBy?: string[];
  }>;
  /** Stable identity of the frozen verification plan. */
  verificationPlanId?: string;
  /** Number of explicit checkpoint restart attempts. */
  restartCount?: number;
  lastRestartAt?: string;
  review?: PromotionReviewRecord;
  authorized: boolean;
  mergeAuthorized: boolean;
  phase: PromotionPhase;
  /** Phase to retry after a transient controller failure. */
  resumePhase?: Exclude<PromotionPhase, "completed" | "failed" | "cancelled">;
  cancelledAt?: string;
  cancellationReason?: string;
  version: number;
  createdAt: string;
  updatedAt: string;
  failure?: string;
}

export interface PromotionRepository {
  createPromotion(record: PromotionRecord): Promise<void>;
  loadPromotion(promotionId: string): Promise<PromotionRecord | undefined>;
  savePromotion(expectedVersion: number, record: PromotionRecord): Promise<void>;
  listPromotions(limit?: number): Promise<PromotionRecord[]>;
}

export class ConcurrentPromotionUpdateError extends Error {
  constructor(readonly promotionId: string, readonly expected: number, readonly actual: number) {
    super(`Promotion ${promotionId} changed concurrently (expected v${expected}, found v${actual})`);
    this.name = "ConcurrentPromotionUpdateError";
  }
}

export class InMemoryPromotionRepository implements PromotionRepository {
  readonly records = new Map<string, PromotionRecord>();

  async createPromotion(record: PromotionRecord): Promise<void> {
    if (this.records.has(record.promotionId)) throw new Error(`Promotion already exists: ${record.promotionId}`);
    this.records.set(record.promotionId, structuredClone(record));
  }

  async loadPromotion(promotionId: string): Promise<PromotionRecord | undefined> {
    const record = this.records.get(promotionId);
    return record ? structuredClone(record) : undefined;
  }

  async savePromotion(expectedVersion: number, record: PromotionRecord): Promise<void> {
    const current = this.records.get(record.promotionId);
    if (!current) throw new Error(`Unknown promotion: ${record.promotionId}`);
    if (record.version !== expectedVersion + 1) throw new Error("Promotion save must advance exactly one version");
    if (current.version !== expectedVersion) throw new ConcurrentPromotionUpdateError(record.promotionId, expectedVersion, current.version);
    this.records.set(record.promotionId, structuredClone(record));
  }

  async listPromotions(limit = 50): Promise<PromotionRecord[]> {
    return [...this.records.values()].slice(-limit).reverse().map((record) => structuredClone(record));
  }
}
