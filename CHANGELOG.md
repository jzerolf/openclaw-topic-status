# Changelog

## 0.2.2 - 2026-07-25

- Cache the exact Telegram target and `runId` at `message_received`, then use
  the Codex-compatible `before_agent_start` lifecycle hook as the authoritative
  start of real agent work.
- Keep `before_agent_run` and sanitized `model_call_started` as idempotent
  early start/fallback signals for runtimes that emit them.
- Cover Codex app-server lifecycle ordering, where `message_received` and
  `before_agent_start`/`agent_end` are emitted but `before_agent_run` and
  `model_call_started` may be absent.

## 0.2.1 - 2026-07-25

- Share topic and run indexes across repeated plugin registrations in the same
  OpenClaw process.
- Allow `agent_end` to apply a stateless terminal transition only when its
  exact Telegram topic has no known active run.
- Keep the short idle debounce referenced until it fires so one-shot and
  rebuilt plugin runtimes cannot exit before applying `idle`.
- Keep bounded, expiring completed-run tombstones so duplicate late terminal
  events cannot create a second stateless write.
- Add regression coverage for split start/end registries and the real
  untracked terminal-hook shape.

## 0.2.0 - 2026-07-25

- Make exact OpenClaw `runId` correlation authoritative for terminal events.
- Track overlapping active runs per Telegram topic and ignore stale or
  ambiguous completion hooks.
- Serialize and coalesce Telegram icon writes per topic so responses cannot
  apply out of order.
- Start `working` at `before_agent_run`, debounce clean idle transitions, and
  stop treating `session_end` as agent completion.
- Add bounded retry handling for transport errors, rate limits, and Telegram
  5xx responses.
- Make rescue timeouts and shutdown transitions use the same writer and clean
  all run, session, timer, and topic state.
- Raise the supported OpenClaw runtime to 2026.7.1 and add focused lifecycle,
  race, retry, timeout, and cleanup tests.

## 0.1.1 - 2026-06-17

- Stop treating OpenClaw `before_agent_finalize` as a completion signal.
- Keep Telegram topics in `working` state while Codex is preparing intermediate
  progress messages and may continue with tools or more work.
- Leave clean completion on `agent_end` and `session_end`, with `gateway_stop`
  and timeout rescue behavior unchanged.

## 0.1.0 - 2026-05-29

- Initial public OpenClaw Topic Status plugin.
- Update Telegram forum topic icons from OpenClaw message and agent lifecycle
  hooks.
- Support configurable `working`, `idle`, `error`, and `timeout` topic icons.
