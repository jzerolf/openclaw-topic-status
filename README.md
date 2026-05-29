# openclaw-topic-status

OpenClaw plugin that updates Telegram forum topic icons from real agent runtime
state.

It watches OpenClaw message and agent lifecycle hooks, then calls Telegram's
`editForumTopic` Bot API method with configurable `custom_emoji_id` values.
The plugin is meant for Telegram forum topics where each topic represents a
conversation or agent thread.

## What It Does

- Sets a topic icon when a message is received.
- Keeps the topic marked as active while an agent turn is running.
- Sets a final idle or error icon when the agent turn ends.
- Sets a timeout icon if OpenClaw never emits a final `agent_end` event.
- Avoids treating `message_sent` as "done"; outgoing messages only refresh the
  watchdog timer.
- Works as an external OpenClaw plugin without patching OpenClaw core or the
  Telegram channel plugin.

## Supported States

| State | Trigger | Meaning |
| --- | --- | --- |
| `working` | `message_received`, `before_agent_run` | A user message arrived or an agent turn is active. |
| `idle` | `agent_end` with success | The agent finished cleanly. |
| `error` | `agent_end` with failure | The agent turn ended with an error. |
| `timeout` | rescue timer | No final `agent_end` arrived before `timeoutMs`. |

`message_sent` is observed only to refresh the timeout while progress updates
are delivered. It is not a reliable completion signal.

## Install

During early development, install from Git:

```bash
openclaw plugins install git:github.com/jzerolf/openclaw-topic-status@main
openclaw plugins enable openclaw-topic-status
openclaw gateway restart
```

For local development:

```bash
git clone https://github.com/jzerolf/openclaw-topic-status.git
cd openclaw-topic-status
npm test
openclaw plugins install --link .
openclaw plugins enable openclaw-topic-status
openclaw gateway restart
```

The intended public distribution target is ClawHub once the package has its
first reviewed release.

## Agent-Friendly Installation

When an operator asks an OpenClaw agent to "install this plugin", the agent
should do the following:

1. Inspect the current OpenClaw installation and find its active config file,
   plugin directory, gateway service, and Telegram channel/account settings.
2. Install the plugin from this repository:

   ```bash
   openclaw plugins install git:github.com/jzerolf/openclaw-topic-status@main
   ```

   If the plugin manager is not available, clone this repository into the
   instance's external/local plugin directory and add that path to
   `plugins.load.paths`.
3. Enable the plugin as `openclaw-topic-status`.
4. Add a `plugins.entries.openclaw-topic-status` config block with:
   - `enabled: true`
   - `hooks.allowConversationAccess: true`
   - a safe bot token source, preferably an existing Telegram `tokenFile`
   - the desired `icons` map
5. Never paste, print, or commit the Telegram bot token. Prefer `botTokenFile`
   or an existing Telegram account token file.
6. Restart the OpenClaw gateway.
7. Verify with a real Telegram forum topic: user message should switch to
   `working`, and `agent_end` should switch to `idle` or `error`.

## Configure

Minimal config:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-topic-status": {
        "enabled": true,
        "hooks": {
          "allowConversationAccess": true
        },
        "config": {
          "botTokenFile": "/path/to/telegram.bot_token",
          "icons": {
            "working": "5309832892262654231",
            "idle": "5357121491508928442",
            "error": "5312241539987020022",
            "timeout": "5312241539987020022"
          }
        }
      }
    }
  }
}
```

The plugin can read the Telegram bot token from:

1. `config.botTokenEnv`
2. `config.botTokenFile`
3. the configured Telegram account `tokenFile`
4. the root Telegram channel `tokenFile`

Never commit bot tokens to a repo.

## Choosing Topic Icons

Telegram only accepts forum topic icon IDs returned by
`getForumTopicIconStickers` for the bot/account you are using. You can list
the available icons with:

```bash
curl -s "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/getForumTopicIconStickers" \
  | jq -r '.result[] | "\(.emoji)\t\(.custom_emoji_id)"'
```

Known working examples:

| Suggested state | Emoji | `custom_emoji_id` | Why it works well |
| --- | --- | --- | --- |
| `working` | 🤖 | `5309832892262654231` | Clear signal that the agent is handling the topic. |
| `idle` | 👀 | `5357121491508928442` | Quiet "watching/available" state after a clean finish. |
| `error` | 🔥 | `5312241539987020022` | Visible enough for failed turns or operational attention. |
| `timeout` | 🔥 | `5312241539987020022` | Reuse the error icon when the runtime did not emit a final event. |

Use those values as examples, then replace them with any
`custom_emoji_id` returned by your own bot.

## Changing Icons Later

This plugin does not interpret natural language itself. An OpenClaw agent can
still follow natural-language requests such as "change my working icon to the
rocket" by editing the plugin config.

Agent procedure:

1. Read the current OpenClaw config.
2. Find `plugins.entries.openclaw-topic-status.config.icons`.
3. Resolve the requested icon to a valid Telegram `custom_emoji_id`.
   Use `getForumTopicIconStickers` if the ID is not already known.
4. Update only the requested state keys:

   ```jsonc
   {
     "icons": {
       "working": "5309832892262654231",
       "idle": "5357121491508928442",
       "error": "5312241539987020022",
       "timeout": "5312241539987020022"
     }
   }
   ```

5. Restart or reload the OpenClaw gateway.
6. Confirm the change with a real forum topic or a controlled test event.

Supported icon states are `working`, `idle`, `error`, and `timeout`.

## Configuration Reference

| Key | Type | Default | Notes |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | Disable the plugin logic without unloading it. |
| `channelId` | string | `telegram` | OpenClaw channel/provider id to watch. |
| `apiRoot` | string | `https://api.telegram.org` | Override for Telegram-compatible API roots. |
| `botTokenEnv` | string | unset | Env var that contains the Telegram bot token. |
| `botTokenFile` | string | unset | File containing the Telegram bot token. |
| `timeoutMs` | integer | `1800000` | Rescue timeout, 30 minutes by default. |
| `timeoutState` | string | `timeout` | One of `idle`, `error`, or `timeout`. |
| `onlyAccountIds` | string[] | `[]` | Restrict to specific OpenClaw Telegram account ids. |
| `allowedChatIds` | string[] | `[]` | Restrict to specific Telegram chat ids. |
| `observeMessageSent` | boolean | `true` | Refresh timeout when outgoing messages are delivered. |
| `logLevel` | string | `info` | One of `off`, `info`, or `debug`. |
| `icons.working` | string | required | Telegram custom emoji id for active work. |
| `icons.idle` | string | required | Telegram custom emoji id for clean completion. |
| `icons.error` | string | falls back to `idle` | Telegram custom emoji id for failed turns. |
| `icons.timeout` | string | falls back to `error` | Telegram custom emoji id for timeout rescue. |

The legacy keys `workingIconCustomEmojiId`, `idleIconCustomEmojiId`,
`errorIconCustomEmojiId`, and `timeoutIconCustomEmojiId` are still accepted for
compatibility.

## Telegram Requirements

- The chat must be a Telegram forum/supergroup with topics enabled.
- The bot must be able to call `editForumTopic` for the topic.
- The icon values must be Telegram `custom_emoji_id` strings accepted by
  `editForumTopic`.
- The hook event must include enough topic context for OpenClaw to resolve
  `chat_id` and `message_thread_id`.

## Development

```bash
npm test
npm run pack:dry-run
```

The smoke test uses an injected fake Telegram API transport, so it does not send
real Telegram requests.

## License

MIT
