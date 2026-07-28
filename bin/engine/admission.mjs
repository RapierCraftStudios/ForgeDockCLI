/**
 * Cascade admission policy — orchestration.cascade config surface (forge#2234).
 *
 * `/orchestrate`'s resource limits (`orchestration.max_concurrent`,
 * `pipeline.token_budget_per_batch`, `pipeline.stall_timeout_minutes`, ...)
 * were configurable, but the *admission policy* deciding whether a
 * cascade-spawned review-finding is picked up was not — every rule
 * (generation >= 2 cap, BATCH_FULLY_GATED idle defer, comment/typo keyword
 * heuristic, P3 + same-file overlap) was a hardcoded constant baked into
 * `commands/orchestrate/phase-4-execution.md` prose (see forge#1814,
 * forge#1858, forge#2231). This module gives that policy a typed, unit-tested
 * home: preset expansion + independently-settable granular levers, with the
 * same validate-warn-fall-back idiom the rest of `orchestration.*`/`pipeline.*`
 * already uses (see phase-4-execution.md L108-119 for the bash mirror of this
 * idiom applied to `orchestration.max_concurrent`).
 *
 * This module is the typed reference implementation of the policy the prose
 * specs (`commands/orchestrate/phase-4-execution.md`,
 * `commands/orchestrate/phase-1-resolve.md`) read via `yq` at runtime — the
 * bash blocks in those files mirror the resolution rules below by hand
 * (the orchestrator is LLM-executed prose, not a `bin/engine/` call site),
 * so any change to the preset table or defaults here MUST be mirrored there
 * too. Keeping this module in `bin/engine/` gives the resolution logic a
 * place to be unit-tested in isolation from the prose pipeline.
 *
 * Evidence this config surface addresses (see forge#2234 issue body): a
 * cascade admitted via the pre-#2234 `--allow-gen2` all-or-nothing CLI flag
 * (forge#2231) ran generation 2 -> 3 -> 4, drifting from "the engine silently
 * kills entire batches" (gen 2, real value) to "a log sanitizer does not
 * neutralize Unicode bidi-override characters" (gen 4, diminishing value).
 * A binary flag cannot express "admit gen-2, stop at gen-3" or "admit
 * cascade until N tokens spent" — `max_generation` and `token_budget` below
 * are independent levers precisely so that shape of policy is expressible.
 *
 * Hard invariant (NOT configurable by design): safety exclusions — findings
 * whose `## Problem` section indicates security/billing/anti-bot/auth
 * concerns — are never batched and never auto-admitted by ANY policy,
 * including `all`. That exclusion lives upstream of this module (the P3
 * batching eligibility check in `phase-1-resolve.md` / the surface-area
 * batching check in `phase-4-execution.md`) and is intentionally absent
 * from the levers this module resolves.
 */

/** Sentinel string accepted anywhere an "int | unlimited" lever is read. */
export const UNLIMITED = "unlimited";

/**
 * @typedef {Object} CascadePolicy
 * @property {number|typeof UNLIMITED} maxGeneration - Max cascade generation depth
 *   admitted. 1 = only original (non-review-finding-spawned) issues; a
 *   review-finding whose source is itself a review-finding is generation 2,
 *   and so on up the chain. `unlimited` removes the cap entirely.
 * @property {number|typeof UNLIMITED} tokenBudget - Per-batch token ceiling for
 *   Step 4C's review-finding cascade dispatch (mirrors, and by default reads
 *   through to, `pipeline.token_budget_per_batch`). `unlimited` removes the cap.
 * @property {boolean} deferOnBatchGated - Whether a fully-human-gated original
 *   batch (forge#1814's `BATCH_FULLY_GATED`) suppresses further cascade dispatch.
 * @property {boolean} keywordHeuristic - Whether the comment/typo title keyword
 *   heuristic defers P3-and-below findings.
 * @property {boolean} p3SameFileDefer - Whether a P3 finding sharing a file with
 *   the active batch is deferred.
 */

/**
 * Named presets. Each expands to a full `CascadePolicy` — every field can
 * still be overridden individually on top of a preset (see `resolveCascadePolicy`).
 *
 * - `balanced` (default): the pre-#2234 hardcoded behavior, unchanged so an
 *   absent `orchestration.cascade` section is a no-op.
 * - `all`: "pick up everything" — a maintainer draining a backlog. Removes
 *   both caps and disables every heuristic-based defer. Safety exclusions
 *   (see module docstring) still apply — they are not part of this table.
 * - `conservative`: same admission shape as `balanced`, but a materially
 *   lower token ceiling for cost-sensitive or noisy repos.
 *
 * @type {Record<string, CascadePolicy>}
 */
export const CASCADE_PRESETS = Object.freeze({
  all: Object.freeze({
    maxGeneration: UNLIMITED,
    tokenBudget: UNLIMITED,
    deferOnBatchGated: false,
    keywordHeuristic: false,
    p3SameFileDefer: false,
  }),
  balanced: Object.freeze({
    maxGeneration: 1,
    tokenBudget: 900000,
    deferOnBatchGated: true,
    keywordHeuristic: true,
    p3SameFileDefer: true,
  }),
  conservative: Object.freeze({
    maxGeneration: 1,
    tokenBudget: 450000,
    deferOnBatchGated: true,
    keywordHeuristic: true,
    p3SameFileDefer: true,
  }),
});

export const DEFAULT_CASCADE_POLICY_NAME = "balanced";

/**
 * Parse a raw config value that may be a positive integer, the literal
 * string "unlimited" (case-insensitive), or absent/invalid. Mirrors the
 * validate-warn-fall-back idiom used for `orchestration.max_concurrent`
 * (phase-4-execution.md L112-119: `grep -qP '^[1-9][0-9]*$'` -> warn + default)
 * but additionally threads the `unlimited` sentinel through, which that
 * plain positive-int check would otherwise reject (see forge#2234 "Known
 * Pitfalls": an `unlimited` value hitting the un-updated int-only validator
 * silently degrades to the default and the uncap becomes a no-op).
 *
 * @param {unknown} raw
 * @param {number|typeof UNLIMITED} fallback
 * @returns {{ value: number|typeof UNLIMITED, warning: string|null }}
 */
export function parseIntOrUnlimited(raw, fallback) {
  if (raw === undefined || raw === null || raw === "null" || raw === "") {
    return { value: fallback, warning: null };
  }
  if (typeof raw === "string" && raw.trim().toLowerCase() === UNLIMITED) {
    return { value: UNLIMITED, warning: null };
  }
  const n = typeof raw === "number" ? raw : Number(String(raw).trim());
  if (Number.isInteger(n) && n > 0) {
    return { value: n, warning: null };
  }
  return {
    value: fallback,
    warning: `not a positive integer or "unlimited" ("${raw}") — falling back to default ${fallback}`,
  };
}

/**
 * Expand `orchestration.cascade` config into a fully-resolved `CascadePolicy`.
 * Precedence: explicit granular key > preset value > `balanced` preset value.
 * An unrecognized `policy` name falls back to `balanced` with a warning,
 * following the same validate-warn-fall-back idiom as every other
 * `orchestration.*`/`pipeline.*` key.
 *
 * @param {Object} [config] - Parsed `orchestration.cascade` object from
 *   forge.yaml (or undefined/empty when the section is absent — a no-op
 *   that resolves to `balanced` exactly like today's hardcoded behavior).
 * @param {string} [config.policy]
 * @param {number|string} [config.max_generation]
 * @param {number|string} [config.token_budget]
 * @param {boolean} [config.defer_on_batch_gated]
 * @param {boolean} [config.keyword_heuristic]
 * @param {boolean} [config.p3_same_file_defer]
 * @param {number|string} [legacyTokenBudgetPerBatch] - Deprecated-alias fallback:
 *   `pipeline.token_budget_per_batch`, read when `config.token_budget` is absent
 *   so existing configs keep working unchanged (see forge#1858).
 * @returns {{ policy: CascadePolicy, policyName: string, bothUncapped: boolean, warnings: string[] }}
 */
export function resolveCascadePolicy(config = {}, legacyTokenBudgetPerBatch) {
  const warnings = [];
  const requestedName =
    typeof config.policy === "string" && config.policy.trim() !== ""
      ? config.policy.trim()
      : DEFAULT_CASCADE_POLICY_NAME;

  let policyName = requestedName;
  let preset = CASCADE_PRESETS[requestedName];
  if (!preset) {
    warnings.push(
      `orchestration.cascade.policy "${requestedName}" is not one of: ${Object.keys(CASCADE_PRESETS).join(", ")} — falling back to "${DEFAULT_CASCADE_POLICY_NAME}"`,
    );
    policyName = DEFAULT_CASCADE_POLICY_NAME;
    preset = CASCADE_PRESETS[DEFAULT_CASCADE_POLICY_NAME];
  }

  const maxGen = parseIntOrUnlimited(config.max_generation, preset.maxGeneration);
  if (maxGen.warning) warnings.push(`orchestration.cascade.max_generation ${maxGen.warning}`);

  // token_budget precedence: orchestration.cascade.token_budget (new home) >
  // pipeline.token_budget_per_batch (deprecated alias, forge#1858) > preset default.
  // The legacy fallback is validated through parseIntOrUnlimited itself before use —
  // NOT trusted as-is — so a malformed legacy value (0, negative, NaN, a
  // case-mismatched sentinel like "UNLIMITED") cannot silently bypass validation
  // the way a bare pass-through would (forge#2302).
  const { value: validatedLegacyFallback, warning: legacyWarning } = parseIntOrUnlimited(
    legacyTokenBudgetPerBatch,
    preset.tokenBudget,
  );
  if (legacyWarning) warnings.push(`pipeline.token_budget_per_batch (legacy alias) ${legacyWarning}`);
  const tokenBudgetFallback =
    legacyTokenBudgetPerBatch !== undefined ? validatedLegacyFallback : preset.tokenBudget;
  const tokenBudget = parseIntOrUnlimited(config.token_budget, tokenBudgetFallback);
  if (tokenBudget.warning) warnings.push(`orchestration.cascade.token_budget ${tokenBudget.warning}`);

  const deferOnBatchGated =
    typeof config.defer_on_batch_gated === "boolean" ? config.defer_on_batch_gated : preset.deferOnBatchGated;
  const keywordHeuristic =
    typeof config.keyword_heuristic === "boolean" ? config.keyword_heuristic : preset.keywordHeuristic;
  const p3SameFileDefer =
    typeof config.p3_same_file_defer === "boolean" ? config.p3_same_file_defer : preset.p3SameFileDefer;

  // Both-uncapped notice: neither generation depth nor token spend is bounded this
  // run. This is never a preset default (no preset in CASCADE_PRESETS sets both to
  // UNLIMITED... except "all", which does so deliberately) — surface it loudly so an
  // operator running `policy: all` (or an equivalent granular-override combination)
  // sees the tradeoff explicitly rather than discovering it from an unexpectedly long
  // cascade tail. Distinct from the per-parse `warnings` above (which flag malformed
  // config); this is a policy-shape notice about a valid, fully-resolved configuration.
  const bothUncapped = maxGen.value === UNLIMITED && tokenBudget.value === UNLIMITED;
  if (bothUncapped) {
    warnings.push(
      "orchestration.cascade: both max_generation and token_budget are unlimited — cascade admission has no upper bound on generation depth or token spend for this run.",
    );
  }

  return {
    policy: {
      maxGeneration: maxGen.value,
      tokenBudget: tokenBudget.value,
      deferOnBatchGated,
      keywordHeuristic,
      p3SameFileDefer,
    },
    policyName,
    bothUncapped,
    warnings,
  };
}

/**
 * @param {number|typeof UNLIMITED} generation - 1-indexed cascade depth of the
 *   finding being evaluated (1 = original issue, not spawned from a
 *   review-finding; 2 = spawned from a review-finding; 3 = spawned from a
 *   finding that was itself spawned from a review-finding; ...).
 * @param {CascadePolicy} policy
 * @returns {boolean} true if this generation is admitted by the policy.
 */
export function admitsGeneration(generation, policy) {
  if (policy.maxGeneration === UNLIMITED) return true;
  return generation <= policy.maxGeneration;
}

/**
 * @param {number} projectedSpend - BATCH_TOKEN_SPEND if this unit were admitted.
 * @param {CascadePolicy} policy
 * @returns {boolean} true if there is still headroom under the token budget.
 */
export function admitsTokenSpend(projectedSpend, policy) {
  if (policy.tokenBudget === UNLIMITED) return true;
  return projectedSpend <= policy.tokenBudget;
}

/**
 * Evaluate the Step 4C rule chain for a single cascade-spawned finding.
 * Mirrors `commands/orchestrate/phase-4-execution.md` Step 4C's "Evaluation
 * order" (rules 0-5) exactly, with rules 0/3/4 gated by the policy's
 * corresponding toggle and rule 1 governed by `admitsGeneration`. Rule 1
 * (generation cap) is evaluated for the finding's *computed* generation —
 * NOT hardcoded to a single-hop "is my source a review-finding" boolean —
 * so a `max_generation: 3` policy actually distinguishes gen 2 from gen 3,
 * per the exact gap forge#2234 exists to close (a binary flag cannot say
 * "admit gen-2, stop at gen-3").
 *
 * @param {Object} finding
 * @param {number} finding.generation - 1-indexed, see `admitsGeneration`.
 * @param {"P1"|"P2"|"P3"|string} finding.priority
 * @param {string} finding.title
 * @param {boolean} finding.sameFileAsBatch
 * @param {boolean} finding.batchFullyGated
 * @param {number} finding.projectedTokenSpend
 * @param {CascadePolicy} policy
 * @returns {{ admit: boolean, reason: string|null }}
 */
export function evaluateCascadeFinding(finding, policy) {
  if (policy.deferOnBatchGated && finding.batchFullyGated) {
    return { admit: false, reason: "batch fully human-gated — idle policy" };
  }
  if (!admitsGeneration(finding.generation, policy)) {
    return {
      admit: false,
      reason: `generation ${finding.generation} exceeds orchestration.cascade.max_generation (${policy.maxGeneration})`,
    };
  }
  if (finding.priority === "P1" || finding.priority === "P2") {
    return { admit: true, reason: null };
  }
  if (policy.keywordHeuristic && /comment|typo/i.test(finding.title || "")) {
    return { admit: false, reason: "comment/typo heuristic" };
  }
  if (policy.p3SameFileDefer && finding.priority === "P3" && finding.sameFileAsBatch) {
    return { admit: false, reason: "P3 + same file as batch" };
  }
  if (!admitsTokenSpend(finding.projectedTokenSpend, policy)) {
    return { admit: false, reason: `per-batch token budget exhausted (orchestration.cascade.token_budget=${policy.tokenBudget})` };
  }
  return { admit: true, reason: null };
}

/** Shared, deterministic policy for every P3 review-finding batching admission point. */
export const P3_BATCHING_RULES = Object.freeze({
  maxMembers: 8,
  sameFileMinimum: 2,
  leafDirectoryMinimum: 5,
  staleAfterHours: 72,
});

const BATCH_EXCLUSION = /\b(security|billing|anti-bot|auth|authentication|authorization|authn|authz)\b/i;
const BATCH_EXCLUSION_LABELS = new Set(["security", "billing", "anti-bot", "auth"]);

function priorityOf(labels = []) {
  const names = labels.map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean);
  return names.find((label) => /^priority:P3$/.test(label)) ? "P3" : names.find((label) => /^P3$/.test(label)) ? "P3" : null;
}

function leafDirectory(file) {
  const slash = String(file || "").lastIndexOf("/");
  return slash > 0 ? file.slice(0, slash) : "";
}

/**
 * Determine whether a finding is eligible before it is admitted to the shared batching pool.
 * Callers pass the full title/body/labels so this rule cannot drift by admission point.
 */
export function isBatchableP3Finding(finding) {
  if (!finding || finding.isBatch || priorityOf(finding.labels) !== "P3" || !finding.affectedFile) return false;
  const labels = new Set((finding.labels || []).map((label) => (typeof label === "string" ? label : label?.name)));
  if ([...BATCH_EXCLUSION_LABELS].some((label) => labels.has(label))) return false;
  return !BATCH_EXCLUSION.test(`${finding.title || ""}\n${finding.problem || finding.body || ""}`);
}

function chunk(members, size, minimum) {
  const chunks = [];
  for (let offset = 0; offset < members.length; offset += size) {
    const next = members.slice(offset, offset + size);
    if (next.length >= minimum) chunks.push(next);
  }
  return chunks;
}

/**
 * Plan batching over the complete current candidate set, not only this cycle's arrivals.
 * Open batches are extended before a new batch is created; callers execute the returned
 * actions with GitHub and retain the returned singleton reasons for the run summary.
 */
export function planP3Batches({ candidates = [], openBatches = [], now = Date.now(), rules = P3_BATCHING_RULES } = {}) {
  const repoOf = (item) => item.repo || "default";
  const candidateId = (finding) => finding.id || `${repoOf(finding)}:${finding.number}`;
  const action = (details, members) => ({
    ...details,
    members: members.map((finding) => finding.number),
    memberIds: members.map(candidateId),
  });
  const eligible = [...new Map(candidates.filter(isBatchableP3Finding).map((finding) => [candidateId(finding), finding])).values()]
    .sort((a, b) => `${repoOf(a)}:${a.number}`.localeCompare(`${repoOf(b)}:${b.number}`, undefined, { numeric: true }));
  const remaining = new Map(eligible.map((finding) => [candidateId(finding), finding]));
  const actions = [];

  for (const batch of [...openBatches].sort((a, b) => `${repoOf(a)}:${a.number}`.localeCompare(`${repoOf(b)}:${b.number}`, undefined, { numeric: true }))) {
    // Persistent registries retain every candidate, including members already absorbed by a batch.
    // Remove those members before planning so repeated admission events can only add new findings.
    for (const member of batch.members || []) {
      const memberId = typeof member === "object" ? candidateId(member) : `${repoOf(batch)}:${member}`;
      remaining.delete(memberId);
    }
    const key = batch.affectedFile || batch.key;
    const headroom = rules.maxMembers - Number(batch.memberCount ?? batch.members?.length ?? 0);
    if (!key || headroom <= 0) continue;
    const members = [...remaining.values()].filter((finding) => repoOf(finding) === repoOf(batch) && finding.affectedFile === key).slice(0, headroom);
    if (members.length) {
      actions.push(action({ type: "extend", batch: batch.number, key, ...(repoOf(batch) === "default" ? {} : { repo: repoOf(batch) }) }, members));
      members.forEach((finding) => remaining.delete(candidateId(finding)));
    }
  }

  const byFile = new Map();
  for (const finding of remaining.values()) {
    const key = `${repoOf(finding)} ${finding.affectedFile}`;
    const group = byFile.get(key) || [];
    group.push(finding);
    byFile.set(key, group);
  }
  for (const [compositeKey, members] of [...byFile].sort(([a], [b]) => a.localeCompare(b))) {
    const [repo, key] = compositeKey.split(" ");
    for (const membersChunk of chunk(members, rules.maxMembers, rules.sameFileMinimum)) {
      actions.push(action({ type: "create", grouping: "same-file", key, ...(repo === "default" ? {} : { repo }) }, membersChunk));
      membersChunk.forEach((finding) => remaining.delete(candidateId(finding)));
    }
  }

  const byDirectory = new Map();
  for (const finding of remaining.values()) {
    const directory = leafDirectory(finding.affectedFile);
    if (!directory) continue;
    const key = `${repoOf(finding)} ${directory}`;
    const group = byDirectory.get(key) || [];
    group.push(finding);
    byDirectory.set(key, group);
  }
  for (const [compositeKey, members] of [...byDirectory].sort(([a], [b]) => a.localeCompare(b))) {
    const [repo, key] = compositeKey.split(" ");
    const oldest = Math.min(...members.map((finding) => new Date(finding.createdAt || now).getTime()));
    const stale = now - oldest > rules.staleAfterHours * 60 * 60 * 1000;
    const minimum = stale ? 1 : rules.leafDirectoryMinimum;
    for (const membersChunk of chunk(members, rules.maxMembers, minimum)) {
      actions.push(action({ type: "create", grouping: stale ? "age" : "leaf-directory", key, ...(repo === "default" ? {} : { repo }) }, membersChunk));
      membersChunk.forEach((finding) => remaining.delete(candidateId(finding)));
    }
  }

  const singletons = [...remaining.values()].map((finding) => ({ number: finding.number, id: candidateId(finding), reason: "no same-file, leaf-directory, or age cluster" }));
  return { actions, singletons, eligible: eligible.map(candidateId) };
}

/** Format policy output for the per-run audit record required by the orchestrator. */
export function summarizeP3BatchPlan(plan) {
  const formed = plan.actions.filter((action) => action.type === "create").length;
  const absorbed = plan.actions.reduce((total, action) => total + action.members.length, 0);
  const extended = plan.actions.filter((action) => action.type === "extend").length;
  return { formed, extended, absorbed, singletons: plan.singletons };
}
