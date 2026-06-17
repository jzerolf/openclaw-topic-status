# Changelog

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
