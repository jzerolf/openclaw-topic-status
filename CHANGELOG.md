# Changelog

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
