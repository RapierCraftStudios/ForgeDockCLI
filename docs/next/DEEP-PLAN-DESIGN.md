# ForgeDock Native Planning Subsystem

**Status:** Design proposal
**Product entrypoint:** `/deep-plan`
**Primary runtime:** ForgeDock Next terminal and typed controller

This design adapts useful planning ideas from external agent workflows without importing their skill files, names, frontmatter, prompt contracts, or state model. ForgeDock's typed controllers, artifact schemas, GitHub authority, native decision interview, and ForgeDock-specific project memory remain authoritative.

## 1. Product shape

Deep Plan is one user-facing planning mode with six native capabilities:

| Capability | ForgeDock responsibility |
| --- | --- |
| Decision frontier | Build and advance a dependency-aware set of user decisions in bounded rounds. |
| Evidence pass | Inspect repository, GitHub, `FORGE.md`, and reference-only `devdocs/` before asking for facts. |
| Domain vocabulary | Resolve overloaded ForgeDock terms and preserve accepted terminology as typed planning context. |
| Prototype checkpoint | Produce a disposable artifact when a behavior or presentation decision cannot be settled through conversation. |
| Decision map | Represent work larger than one planning session as a typed map of decisions and dependencies. |
| Plan handoff | Convert a confirmed plan into existing Intent, Build Packet, and orchestration-DAG contracts. |

These are internal capabilities, not six unrelated slash commands. Only `/deep-plan` is required for the first release.

External skills are inspiration and research references only. They are not runtime dependencies and must not be copied into `.agents/skills/`, `commands/`, or the native prompt verbatim.

## 2. Goals and non-goals

### Goals

- Let a user explicitly request a deep plan for a vague or consequential change.
- Let the foreground supervisor recommend Deep Plan when ambiguity, blast radius, or decision count warrants it.
- Ask bounded MCQ-style questions through the existing native decision interview.
- Show an evidence-backed recommendation for every question.
- Always allow a custom answer, notes, review, and elaboration.
- Preserve prior answers while recomputing the next decision frontier.
- Prevent implementation, GitHub mutation, or worker dispatch until the user confirms the plan.
- Produce a typed planning packet that can hand off to `/work-on` or `/orchestrate` without inventing a second issue/DAG system.
- Keep active planning state separate from delivery `RunState` and delivery artifacts.

### Non-goals for the first release

- A 1:1 port of any third-party skill or prompt.
- A new generic skill-loader or Markdown skill runtime.
- Automatic writes to `FORGE.md` or `devdocs/`.
- Automatic issue creation for every question or planning step.
- Automatic worker dispatch or merge after planning.
- Planner swarms, unbounded prototypes, or a second orchestration scheduler.
- A new TUI component: `src/tui/decision-flow.ts` is the native presentation layer.
- Unsupervised Deep Plan sessions inside background issue workers.

## 3. Authority model

The authority order for a planning decision is:

1. Current user request and explicit answers.
2. Typed Deep Plan session state and controller validation.
3. Repository and GitHub evidence.
4. `FORGE.md` project guidance, which is user-maintained and subordinate to current intent.
5. `devdocs/`, which is reference-only historical memory and cannot authorize a decision or action.
6. Model recommendations and defaults.

Prompt text cannot grant authority, widen a scope, create an issue, dispatch a worker, or change a delivery state.

The Deep Plan controller owns:

- session status and round sequencing;
- question limits and answer application;
- unresolved-frontier detection;
- plan schema validation;
- explicit confirmation gates; and
- conversion to existing ForgeDock handoff contracts.

The model may propose evidence summaries, questions, recommendations, terms, prototypes, and plan nodes. The controller validates and accepts only typed output.

## 4. Native session lifecycle

```text
START
  -> EVIDENCE
  -> QUESTIONING
  -> [PROTOTYPE_CHECKPOINT] (optional)
  -> QUESTIONING (recompute frontier)
  -> READY_FOR_REVIEW
  -> CONFIRMED
  -> SAVED or HANDED_OFF
```

Terminal states are `cancelled`, `blocked`, and `failed`.

A round contains at most six independent questions. Questions whose prerequisites depend on an unanswered question move to a later round. The existing decision UI already provides the appropriate tabbed interaction for a round.

The controller should use bounded budgets for safety, but the budget must be explicit and surfaced to the user. Initial defaults:

- six questions per round;
- six rounds per session;
- one elaboration request per question per round;
- one disposable prototype at a time;
- no automatic plan handoff.

A budget exhaustion is `blocked`, not implicit completion. The user may explicitly continue, narrow scope, or accept the plan with unresolved questions recorded as risks.

## 5. Native contracts

Create planning-only types under `src/core/planning/`. Do not put planning concepts into the delivery state machine unless a later implementation proves that a transition is required.

### 5.1 Evidence

```ts
interface PlanningEvidence {
  id: string;
  authority: "user" | "github" | "repository" | "forge-guidance" | "devdocs" | "prototype";
  source: string;
  locator: string;
  claim: string;
  detail: string;
}
```

Evidence is bounded and citable. Raw transcripts are not evidence. `devdocs` hits retain their reference-only classification.

### 5.2 Domain vocabulary

```ts
interface PlanningTerm {
  id: string;
  term: string;
  definition: string;
  aliases: string[];
  evidenceIds: string[];
  status: "proposed" | "accepted" | "rejected";
}
```

A term becomes `accepted` only through the user's confirmation or an existing authoritative project decision. Accepted terms are planning context; they do not automatically rewrite project files.

### 5.3 Decision resolutions

Reuse the answer shape from `src/tui/decision-flow.ts` rather than defining a second answer format.

```ts
interface PlanningDecision {
  round: number;
  questionId: string;
  values: string[];
  labels: string[];
  customText?: string;
  note?: string;
  authority: "user" | "explicit-controller-default";
  evidenceIds: string[];
}
```

The UI's custom-answer row is native behavior and must not be duplicated as an LLM-supplied option.

### 5.4 Planning packet

```ts
interface PlanningNode {
  id: string;
  title: string;
  outcome: string;
  dependsOn: string[];
  acceptanceCriteria: string[];
  affectedFiles: string[];
  claims: string[];
  verificationPlan: string[];
  priority: number;
  riskClass: "routine" | "security" | "auth" | "billing";
  evidenceIds: string[];
}

interface PlanningPacket {
  schema: "forgedock.planning/v1";
  sessionId: string;
  revision: number;
  status: "draft" | "ready" | "confirmed" | "handed-off" | "blocked";
  objective: string;
  assumptions: string[];
  evidence: PlanningEvidence[];
  vocabulary: PlanningTerm[];
  decisions: PlanningDecision[];
  outOfScope: string[];
  openQuestions: string[];
  nodes: PlanningNode[];
}
```

`PlanningPacket` maps to existing ForgeDock contracts:

- one-node packet → existing `Intent` plus `BuildPacket` preparation;
- multiple nodes → existing orchestration `executionPlan` and `ScheduledWorkItem` inputs;
- dependencies and claims → `materializeClaimDependencies()` and `validateGraph()`;
- acceptance and verification → existing Build Packet fields.

Deep Plan must not create a parallel ticket schema or scheduler.

## 6. Durable state

An active, unconfirmed session is operational state. It may live in the supervisor session/background-task record while the user is present. It cannot authorize delivery.

A user-confirmed or explicitly saved packet becomes semantic planning state. The durable representation should be a new additive `DeepPlan` artifact kind only if restart/resume is required. It must:

- use the existing `forgedock.artifact/v2` envelope and codec;
- be excluded from delivery `RunState` transitions and delivery-artifact admission rules;
- carry immutable revisions rather than mutating earlier plans;
- publish through typed GitHub ports when the plan has an issue target; and
- require an explicit target for repository-only plans.

A loose `/deep-plan` request may begin without an issue. Durable save or handoff requires either a resolved issue or an explicitly confirmed ForgeDock planning target. No hidden GitHub issue is created.

## 7. Native capability behavior

### 7.1 Decision frontier

Implement a pure reducer under `src/core/planning/frontier.ts`:

- validate stable question IDs and dependencies;
- reject more than six questions in one round;
- apply user answers without changing prior decisions;
- recompute only questions whose prerequisites are settled;
- identify unresolved high-impact questions; and
- determine whether the session is ready for confirmation.

The model supplies question wording and recommendations through the typed native bridge. The reducer, not the model, decides whether an answer is accepted and whether a frontier remains.

### 7.2 Evidence pass

The evidence pass uses bounded read-only tools and existing memory boundaries:

- repository reads/searches through the read-only runtime;
- GitHub issue/PR reads through typed adapters;
- `FORGE.md` through `loadForgeGuidance()`;
- `devdocs` through `searchDevdocsMemory()`;
- existing artifacts through the artifact repository.

Every question that could be answered from those sources must be answered by evidence before it reaches the user.

### 7.3 Domain vocabulary

The native planner flags ambiguous terms and offers precise alternatives. It records accepted terms in the packet. A user may explicitly promote a durable decision through the existing `/forgedock-remember` path; Deep Plan must not silently edit project memory.

### 7.4 Prototype checkpoint

A prototype is a temporary, bounded experiment—not a delivery worktree and not a PR. Add a separate `PrototypeWorkspace` port rather than weakening `GitWorkspaceManager`:

```ts
interface PrototypeWorkspace {
  path: string;
  remove(): Promise<void>;
}

interface PrototypeWorkspaceManager {
  create(input: { sessionId: string; purpose: string }): Promise<PrototypeWorkspace>;
}
```

The prototype role receives only an explicit temporary workspace and allowlisted verification operations. It cannot push, publish, merge, modify GitHub, or alter `FORGE.md`. The packet stores only a bounded receipt, findings, and output digest.

### 7.5 Decision map

A decision map is initially an in-session typed structure. It becomes a GitHub issue/dependency graph only after explicit confirmation and only when the effort is too large for one session or the user requests durable tracking.

Materialization must reuse typed `ForgeHost` issue/dependency operations and deterministic idempotency keys. It must never use an in-memory callback as the only parent/child relationship.

### 7.6 Plan handoff

Handoff renders:

- selected objective and assumptions;
- accepted decisions and unresolved risks;
- affected paths and claims;
- node dependencies;
- verification plan; and
- proposed work units.

The user explicitly chooses whether to save, refine, hand off to one `/work-on`, or hand off to `/orchestrate`. Deep Plan does not automatically dispatch either workflow.

## 8. Native invocation

Add `forgedock_deep_plan` as a supervisor-only native tool and `/deep-plan` as its explicit command.

Explicit invocation:

```text
/deep-plan <natural-language request>
```

Model invocation is allowed when the foreground task has one or more of:

- multiple plausible architectural approaches;
- unresolved product or acceptance intent;
- changes spanning multiple subsystems or public contracts;
- migrations, security, auth, billing, concurrency, or high-blast-radius behavior;
- a decision that is expensive or difficult to reverse; or
- a request that is too large for a reliable one-pass plan.

For a model-triggered session, the model must tell the user why Deep Plan is warranted before opening the interview. It must not invoke it as a hidden detour.

Background issue workers cannot open a user interview. They must use the existing supervisor escalation path with `interview_request` or `need_decision`.

The native prompt should be ForgeDock-owned and short. It should describe authority, evidence lookup, frontier rounds, recommendation requirements, confirmation, and handoff. It must not contain third-party names or assume Markdown skill loading.

## 9. Integration points

### First implementation slice

- `src/core/planning/schema.ts` — planning types and TypeBox validation.
- `src/core/planning/frontier.ts` — pure question/dependency reducer.
- `src/workflows/deep-plan/deep-plan.ts` — session sequencing and confirmation policy.
- `src/workflows/deep-plan/prompts.ts` — ForgeDock-native prompt contracts.
- `src/tui/forgedock-tools.ts` — register `forgedock_deep_plan` and its typed parameters.
- `src/tui/forgedock-extension.ts` — register `/deep-plan`, activation, and model-trigger guidance.
- `src/tui/decision-flow.ts` — only extend if round title/progress metadata is needed; do not replace it.

### Later slices

- `src/core/artifacts/schema.ts` and `codec.ts` — additive `DeepPlan` artifact after the session contract is dogfooded.
- `src/workflows/deep-plan/evidence.ts` — bounded evidence aggregation.
- `src/workflows/deep-plan/vocabulary.ts` — terminology resolution and durable-decision handoff.
- `src/workflows/deep-plan/prototype.ts` — disposable experiment receipt.
- `src/workflows/deep-plan/wayfinding.ts` — confirmed decision-map materialization.
- `src/workflows/deep-plan/handoff.ts` — typed conversion into existing orchestration inputs.
- `src/cli/main.ts` — headless packet validation/resume only after interactive semantics are stable.

`src/tui/forgedock-extension.ts` remains a registration boundary. Planning authority belongs in `src/core/planning/` and `src/workflows/deep-plan/`.

## 10. Verification plan

### Pure planning tests

- frontier questions are dependency ordered;
- independent questions share a round;
- dependent questions wait for later rounds;
- custom answers override options and remain authoritative;
- elaboration preserves prior answers;
- duplicate/unknown question IDs are rejected;
- question and round budgets block rather than silently complete;
- unresolved high-impact decisions prevent confirmation;
- DAG conversion rejects unknown dependencies, cycles, missing acceptance criteria, and unbounded claims.

### Native terminal tests

- `/deep-plan` activates only the Deep Plan tool;
- model-triggered Deep Plan is supervisor-only;
- issue-worker children cannot access it;
- the existing decision interview displays recommendations and custom answers;
- cancellation and second-dismissal behavior remain intact;
- no handoff occurs without explicit confirmation;
- handoff produces the same typed schedule inputs as direct orchestration for equivalent nodes.

### Durability tests, after the artifact slice

- `DeepPlan` codec round-trips and renders bounded Markdown;
- revisions are immutable and latest-valid revision wins;
- GitHub publication is idempotent;
- a restart reconstructs the latest confirmed plan without trusting Pi transcripts;
- plan artifacts do not alter delivery state-machine admission.

## 11. Acceptance criteria

The native subsystem is ready for implementation handoff when:

1. `/deep-plan` and model-triggered invocation share one controller and one decision-flow UI.
2. Every user-facing question has evidence context, options, a recommendation, and a custom-answer path.
3. The model cannot advance to mutation by prompt compliance alone.
4. A plan can be refined across rounds without losing prior answers.
5. Confirmed plans map directly to existing ForgeDock Intent/Build Packet/orchestration contracts.
6. No external skill file, frontmatter convention, or duplicate ticket/DAG system is required.
7. Background workers escalate decisions to the supervisor rather than asking users directly.
8. Tests prove the authority, budget, confirmation, dependency, and handoff boundaries.
