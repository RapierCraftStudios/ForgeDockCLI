# ForgeDock Observer

ForgeDock Observer is a renderer-neutral operational view of ForgeDock activity. It is not a workflow engine and it is not a source of semantic truth.

## Authority boundary

Typed controllers, `RunState`, DAG records, validated artifacts, claims, leases, and review policy remain authoritative. The observer journal, SQLite records, process logs, Pi sessions, and fleet projections are rebuildable operational state.

Observer controls are routed through `ObservationControlGateway`. Closing a pane or detaching a workspace never stops work. Workflow actions must use typed ForgeDock adapters; pi-subagents controls are allowed only for explicitly bounded leaf runs.

## Runtime

The internal workspace is opened with:

```text
/forgedock-observe
```

It provides a run tree, semantic overview, structured events, channel-preserving output, attention items, process health, independent scrolling, and explicit cancellation confirmation. The workspace is read-only unless a control gateway is configured.

The optional tmux frontend is represented by a renderer plan and is intentionally not a runtime dependency:

```text
forgedock observe <run-id> --renderer=tmux
```

The future tmux client will attach to the observer feed and will never own controller or worker processes.

## Observation envelope

`src/observability/contracts.ts` defines `forgedock.observation/v1`. Every envelope preserves:

- canonical workflow, work-unit, agent, controller, Pi, reviewer, and artifact identities;
- producer-local sequence and journal-assigned run sequence;
- occurred and ingested timestamps;
- source and channel identity;
- bounded, redacted payloads;
- explicit truncation, coalescing, and dropped-output metadata.

Private model reasoning is not persisted. Thinking events become activity summaries; user-visible text, tools, lifecycle, decisions, artifacts, and bounded process output remain observable.

## Persistence

`SqliteObservationStore` uses SQLite WAL and is operational only. Lifecycle events and attention records are indexed separately from output chunks. Retention is explicit through the store API; output is never silently treated as semantic state.

The default database is `.forgedock/observations.db`. It can be deleted and rebuilt from controller and artifact state.

## Source adapters

`src/observability/adapters.ts` contains adapters for:

- `AgentEventSink`;
- native ForgeDock controller output;
- native background task lifecycle/output;
- pi-subagents async lifecycle;
- nested reviewer lifecycle;
- artifact submission.

Adapters must preserve source identity and must not infer workflow transitions from raw output when typed state is available.
