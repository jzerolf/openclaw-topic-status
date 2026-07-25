# Reliability plan for v0.2

Status: implemented for v0.2.0.

Reviewed against:

- `openclaw-topic-status` v0.1.1 (`11268fa`)
- OpenClaw 2026.7.1
- OpenClaw's current plugin hook, Codex harness, and Telegram ingress contracts

## Verdict

The plugin needs a state-management hardening pass before its next release.

The reported `working -> idle` jump cannot be safely attributed to the
`editForumTopic` call being treated as an agent reply:

- the plugin calls the Telegram Bot API directly, outside OpenClaw's outbound
  message pipeline, so the call does not emit `message_sent`;
- OpenClaw 2026.7.1 recognizes Telegram `forum_topic_edited` service messages;
  an icon-only service message has no agent body and is discarded before agent
  dispatch.

The stronger failure candidates are inside the plugin:

1. Terminal events use permissive fallback correlation. An unknown or stale
   `agent_end` can fall through from `runId` to the current `sessionKey` or
   sender record and close a newer run in the same topic.
2. `working`, `idle`, `error`, and `timeout` writes are launched without a
   per-topic queue. OpenClaw explicitly allows observation hooks to overlap, so
   Telegram requests can be in flight concurrently and finish out of order.
3. `session_end` is treated as a normal turn-completion signal even though it
   describes session lifecycle, not agent-run completion, and does not provide
   the same exact run correlation.
4. The current test suite uses an immediately resolving fake transport, so it
   cannot expose ordering races.

The exact historical event that caused each visible jump is not recoverable
with the current `info` logging: transition sources, run correlation, and
Telegram request ordering are not recorded. The implementation should add safe
diagnostic logging so future reports are attributable.

## Current contract that matters

OpenClaw 2026.7.1 documents and implements these guarantees:

- `message_received` is an observation hook and may run fire-and-forget.
- `before_agent_run` runs after prompt construction and before model input.
- `agent_end` is the terminal observation hook for one end-to-end agent turn.
- `runId` is unique to that turn and remains stable through model retries,
  tool iterations, and multi-payload replies.
- Current inbound message and agent hooks carry `runId` when available.
- Observation-only hooks run in parallel; priority must not be used to order
  their side effects.
- `message_sent` is not reliably correlated to `agent_end` by `runId` yet.
- `session_end` represents session boundaries such as reset, idle, compaction,
  deletion, shutdown, or restart. It is not a substitute for `agent_end`.

References:

- <https://docs.openclaw.ai/plugins/hooks>
- <https://docs.openclaw.ai/concepts/agent-loop>
- <https://docs.openclaw.ai/plugins/codex-harness-runtime>
- <https://docs.openclaw.ai/channels/telegram>
- <https://github.com/openclaw/openclaw/blob/main/src/plugins/hook-types.ts>
- <https://github.com/openclaw/openclaw/blob/main/extensions/telegram/src/forum-service-message.ts>
- <https://github.com/openclaw/openclaw/blob/main/extensions/telegram/src/bot-message-context.body.ts>

## Required implementation changes

### P0: make `runId` authoritative for terminal events

Split the current general-purpose `lookup()` into event-specific resolution:

- start/resume events may resolve a Telegram target from typed context and
  `sessionKey`;
- terminal events with a `runId` must match that exact tracked run;
- if a terminal event supplies an unknown `runId`, ignore it and log a safe
  diagnostic; do not fall back to the current session, sender, or topic;
- only support a missing-`runId` legacy fallback when the session maps
  unambiguously to one active run. Otherwise leave the topic working and let
  the rescue timeout handle it.

Remove the current behavior that invents an idle transition from an
`agent_end` received by a fresh plugin runtime with no tracked state.

### P0: track active runs, not one mutable topic record

Use one topic state with an active-run set:

```text
TopicState
  topic identity: accountId + chatId + threadId
  generation
  desired status
  applied status
  active runs: Map<runId, RunState>
  idle debounce timer
  rescue timer
  serialized writer
```

Rules:

- `before_agent_run` adds the exact `runId`, cancels pending idle, and requests
  `working`;
- duplicate events for the same `runId` are idempotent;
- `agent_end` removes only its own `runId`;
- successful completion requests `idle` only when no active runs remain;
- a failed run requests `error` only when no other run remains active;
- a late terminal event from an older generation cannot change the current
  topic state.

This also covers a new message arriving while an older run is still
finalizing.

### P0: serialize and coalesce Telegram writes per topic

Never call `editForumTopic` concurrently for the same topic.

The writer should:

1. store the latest desired status and a monotonic transition revision;
2. enqueue at most one worker per topic;
3. skip an API call when the desired status is already applied;
4. apply transitions in revision order, or coalesce queued transitions to the
   newest desired state before the next request starts;
5. after each request, re-check whether a newer desired state exists;
6. keep newer transitions authoritative even if an older HTTP request
   completes late.

`gateway_stop` must use the same queue instead of bypassing it.

### P0: stop using `session_end` as clean turn completion

`agent_end` should be the normal `idle`/`error` authority.

For `session_end`:

- `compaction`: no icon transition;
- `idle`, `daily`, `new`, `reset`, or `deleted`: clean bookkeeping only, and
  never close a currently active run;
- `shutdown`/`restart`: let the Gateway shutdown path and `gateway_stop`
  coordinate one final timeout transition;
- `unknown`: do not overwrite an active state.

Removing the normal `session_end -> idle` transition entirely is preferable
unless a concrete uncovered lifecycle case requires it.

### P0: make start semantics intentional

The icon should mean "an agent run is active", not merely "Telegram delivered
an update".

Recommended behavior:

- `message_received`: cache the typed Telegram target and exact `runId`, but do
  not make it the sole authority for `working`;
- `before_agent_run`: request `working`, because this is the documented gate
  immediately before model input;
- retain the fast `message_received -> working` transition only if tests prove
  it cannot leave a topic active when a later gate blocks dispatch.

Starting at `before_agent_run` is the safer default. The visual delay should be
negligible and the meaning is accurate.

### P1: add a short idle debounce

After the last matching `agent_end`, wait a small configurable grace period
before requesting `idle` (recommended default: 500-750 ms).

A new run in the same topic cancels the pending idle. This absorbs lifecycle
handoffs without masking real completion.

Suggested config:

```jsonc
{
  "idleDebounceMs": 600
}
```

This is a guard, not the primary fix. Exact run correlation and serialized
writes remain mandatory.

### P1: make rescue timeout terminal and leak-free

When the rescue timer fires:

- verify the topic generation and active-run set still match;
- request the configured timeout status through the serialized writer;
- mark the generation terminal;
- clear run, session, sender, timer, and topic indexes after the final write
  settles or after bounded retry exhaustion.

Current cleanup issues to remove:

- `completedTopicSeq` grows by one entry per completed run;
- fired timers remain referenced in `timeoutByTopic`;
- timed-out topic state remains available to later unrelated fallback lookup;
- `latestBySender` retains stale records and can cross topics for the same
  sender in the same chat.

Prefer deleting `latestBySender`; current OpenClaw provides better `runId`,
`sessionKey`, `chatId`, and typed thread context. If a sender fallback must
remain for legacy compatibility, include `threadId` and never use it for a
terminal event.

### P1: handle Telegram failures without discarding state first

Do not delete tracked state before the final Telegram write has an outcome.

Add bounded retry behavior for transient transport errors, HTTP 429, and 5xx
responses. Respect Telegram `retry_after` when present. Do not retry permanent
4xx configuration/permission errors indefinitely.

Treat a Telegram response as successful only when both the HTTP response and
Bot API body indicate success.

Keep the direct Bot API transport for v0.2. OpenClaw exposes
`editForumTopic` as a Telegram action, but does not currently document a stable
generic plugin-runtime method for an external feature plugin to invoke that
channel-owned action. Importing bundled Telegram internals would create a more
fragile dependency than the current HTTP boundary.

### P1: add useful, safe diagnostics

At debug level, record:

- hook source;
- topic key;
- transition revision/generation;
- short or hashed `runId`;
- desired/applied status;
- reason a stale or ambiguous event was ignored;
- Telegram request start, success, retry, and terminal failure.

Never log message content, bot tokens, token-file contents, or full secrets.

At info level, log plugin startup/version and terminal Telegram failures only.

## Test plan

Replace the single happy-path smoke sequence with focused state-machine tests.
At minimum:

1. `before_agent_run -> agent_end` produces `working -> idle`.
2. A stale `agent_end(run-A)` arriving after `before_agent_run(run-B)` does
   not set idle.
3. Two overlapping runs in one topic remain working until both end.
4. Two topics used by the same sender never share state.
5. Duplicate `message_received`/`before_agent_run` events for one `runId` do
   not duplicate Telegram writes.
6. An unknown terminal `runId` is ignored.
7. A `session_end(idle|compaction|reset)` cannot close a current active run.
8. Delayed fake HTTP responses cannot reorder the final applied status.
9. A new run during the idle debounce cancels idle.
10. Timeout transitions clean all indexes and timers.
11. A transient Telegram failure retries in order and preserves the newest
    desired state.
12. `gateway_stop` cannot finish with an older queued `working` write.

The fake transport must support manually controlled promises so tests can
complete requests in adversarial order.

## Compatibility and release

The current package declares OpenClaw `>=2026.5.27`, but the reliable design
should use the current exact `runId` contract. For v0.2, choose one of:

- recommended: raise `peerDependencies.openclaw` and
  `minGatewayVersion` to `>=2026.7.1`;
- alternative: retain older support but make all missing/ambiguous terminal
  correlation fail safe and cover that legacy path with separate tests.

Reliability is more valuable here than preserving broad compatibility with
older hook behavior. The recommended release target is v0.2.0 because the
state and lifecycle semantics change materially.

## Rollout checklist

1. Implement the state machine and tests on a feature branch.
2. Run `npm test` and `npm run pack:dry-run`.
3. Review the diff for token/content logging.
4. Enable debug logging only for a short controlled validation window.
5. Install/link the reviewed version.
6. Restart the Gateway once, during the agreed maintenance window.
7. Test:
   - a normal short answer;
   - a long tool-using answer with commentary;
   - two quick consecutive messages in one topic;
   - activity in two topics by the same sender;
   - an induced failed run if a safe test path is available.
8. Return logging to `info`.
9. Publish v0.2.0 only after the live sequence remains stable.
