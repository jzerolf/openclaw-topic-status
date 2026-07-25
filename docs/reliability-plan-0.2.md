# Reliability design and implementation record for v0.2

Status: implemented for v0.2.0, with cross-registration terminal handling
hardened in v0.2.1 and Codex harness activation added in v0.2.2.

This document preserves the diagnosis and design decisions behind the v0.2
series. The required changes are no longer pending: they shipped across
v0.2.0-v0.2.2 and are covered by the current test suite.

Reviewed against:

- `openclaw-topic-status` v0.1.1 (`11268fa`)
- OpenClaw 2026.7.1
- OpenClaw's current plugin hook, Codex harness, and Telegram ingress contracts

## Verdict (resolved)

The plugin needed a state-management hardening pass after v0.1.1. That work
shipped in v0.2.0-v0.2.2.

The reported `working -> idle` jump cannot be safely attributed to the
`editForumTopic` call being treated as an agent reply:

- the plugin calls the Telegram Bot API directly, outside OpenClaw's outbound
  message pipeline, so the call does not emit `message_sent`;
- OpenClaw 2026.7.1 recognizes Telegram `forum_topic_edited` service messages;
  an icon-only service message has no agent body and is discarded before agent
  dispatch.

The stronger failure candidates were inside the v0.1.1 plugin:

1. Terminal events used permissive fallback correlation. An unknown or stale
   `agent_end` could fall through from `runId` to the current `sessionKey` or
   sender record and close a newer run in the same topic.
2. `working`, `idle`, `error`, and `timeout` writes were launched without a
   per-topic queue. Because OpenClaw allows observation hooks to overlap,
   Telegram requests could finish out of order.
3. `session_end` was treated as a normal turn-completion signal even though it
   describes session lifecycle, not agent-run completion, and does not provide
   the same exact run correlation.
4. The test suite used an immediately resolving fake transport, so it could
   not expose ordering races.

The exact historical event that caused each visible jump was not recoverable
from the v0.1.1 `info` logging. The v0.2 series added safe debug diagnostics
for transition sources, run correlation, and Telegram request ordering.

## Current contract that matters

OpenClaw 2026.7.1 documents and implements these guarantees:

- `message_received` is an observation hook and may run fire-and-forget.
- `before_agent_start` is available to external plugins on the Codex harness
  path and may be emitted even when `before_agent_run` is absent.
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

## Implemented reliability changes

### P0: make `runId` authoritative for terminal events

The implementation split the v0.1.1 general-purpose `lookup()` into
event-specific resolution:

- start/resume events may resolve a Telegram target from typed context and
  `sessionKey`;
- terminal events with a `runId` must match that exact tracked run;
- if a terminal event supplies an unknown `runId` while the resolved topic has
  a known active run, ignore it and log a safe diagnostic;
- if OpenClaw rebuilt the plugin registry between lifecycle phases and the
  resolved topic has no known active run, allow a stateless terminal write only
  to the exact Telegram topic carried by the hook context;
- only support a missing-`runId` legacy fallback when the session maps
  unambiguously to one active run. Otherwise leave the topic working and let
  the rescue timeout handle it.

Never use sender-wide or cross-topic fallback for this compatibility path.

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

Implemented rules:

- `before_agent_start` adds the exact `runId`, cancels pending idle, and
  requests `working`; `before_agent_run` remains an idempotent fallback;
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

Implemented behavior:

- `message_received` caches the exact Telegram target and OpenClaw `runId`;
- the Codex-compatible `before_agent_start` phase registers that run and
  requests `working`;
- `before_agent_run` and sanitized `model_call_started` remain idempotent early
  start and fallback signals for runtimes that emit them.

The original `before_agent_run`-only design proved insufficient in live use:
the Codex app-server path emitted `message_received`, `before_agent_start`, and
`agent_end` for the turn but did not emit `before_agent_run` or
`model_call_started` to the external plugin. Waiting for an agent-harness hook
also avoids marking command-only or fast-abort messages as active merely
because they reached Telegram ingress. The exact `runId` preserves strict
correlation without relying on message text, sender fallbacks, or an untracked
provisional state.

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

The v0.1.1 cleanup issues addressed here were:

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

## Implemented test coverage

The current suite contains 19 focused state-machine tests covering:

- the Codex `before_agent_start -> agent_end` lifecycle and the legacy
  `before_agent_run` fallback;
- stale, unknown, duplicate, overlapping, and ambiguous run correlation;
- isolation between topics used by the same sender;
- shared state and exact stateless terminal handling across rebuilt plugin
  registrations;
- `session_end` bookkeeping without premature completion;
- adversarial Telegram response ordering, idle debounce cancellation, and
  serialized generations;
- terminal timeout cleanup, transient retries, and Bot API errors returned
  with HTTP 200;
- `gateway_stop` winning over older queued writes.

The fake transport supports manually controlled promises so tests can complete
requests in adversarial order.

## Compatibility and release

The v0.2 series chose the stricter compatibility path:

- `peerDependencies.openclaw` is `>=2026.7.1`;
- `openclaw.compat.pluginApi` is `>=2026.7.1`;
- `openclaw.compat.minGatewayVersion` is `2026.7.1`.

Reliability is more valuable here than preserving broad compatibility with
older hook behavior. The state and lifecycle redesign shipped as v0.2.0, the
cross-registration terminal fix as v0.2.1, and Codex harness activation as
v0.2.2.

## Rollout result

- The state machine and focused tests shipped across v0.2.0-v0.2.2.
- `npm test` passes all 19 tests.
- `npm run pack:dry-run` validates the release contents.
- Logging was reviewed to exclude tokens and message content.
- v0.2.2 was installed and validated with a real Telegram
  `working -> idle` cycle.
- Normal operation uses `info` logging.
- v0.2.2 is published as the latest GitHub release:
  <https://github.com/jzerolf/openclaw-topic-status/releases/tag/v0.2.2>.
