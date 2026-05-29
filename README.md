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
`getForumTopicIconStickers`. These `custom_emoji_id` values are Telegram-wide
identifiers for the allowed forum topic icon stickers, so the examples below
should work anywhere while Telegram keeps them in that allowed set.

You can list the current allowed icons with:

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

Current icon reference, captured from `getForumTopicIconStickers` on
2026-05-29:

<details>
<summary>Show full Telegram forum topic icon table</summary>

| Emoji | `custom_emoji_id` |
| --- | --- |
| 📰 | `5434144690511290129` |
| 💡 | `5312536423851630001` |
| ⚡️ | `5312016608254762256` |
| 🎙 | `5377544228505134960` |
| 🔝 | `5418085807791545980` |
| 🗣 | `5370870893004203704` |
| 🆒 | `5420216386448270341` |
| ❗️ | `5379748062124056162` |
| 📝 | `5373251851074415873` |
| 📆 | `5433614043006903194` |
| 📁 | `5357315181649076022` |
| 🔎 | `5309965701241379366` |
| 📣 | `5309984423003823246` |
| 🔥 | `5312241539987020022` |
| ❤️ | `5312138559556164615` |
| ❓ | `5377316857231450742` |
| 📈 | `5350305691942788490` |
| 📉 | `5350713563512052787` |
| 💎 | `5309958691854754293` |
| 💰 | `5350452584119279096` |
| 💸 | `5309929258443874898` |
| 🪙 | `5377690785674175481` |
| 💱 | `5310107765874632305` |
| ⁉️ | `5377438129928020693` |
| 🎮 | `5309950797704865693` |
| 💻 | `5350554349074391003` |
| 📱 | `5409357944619802453` |
| 🚗 | `5312322066328853156` |
| 🏠 | `5312486108309757006` |
| 💘 | `5310029292527164639` |
| 🎉 | `5310228579009699834` |
| ‼️ | `5377498341074542641` |
| 🏆 | `5312315739842026755` |
| 🏁 | `5408906741125490282` |
| 🎬 | `5368653135101310687` |
| 🎵 | `5310045076531978942` |
| 🔞 | `5420331611830886484` |
| 📚 | `5350481781306958339` |
| 👑 | `5357107601584693888` |
| ⚽️ | `5375159220280762629` |
| 🏀 | `5384327463629233871` |
| 📺 | `5350513667144163474` |
| 👀 | `5357121491508928442` |
| 🫦 | `5357185426392096577` |
| 🍓 | `5310157398516703416` |
| 💄 | `5310262535021142850` |
| 👠 | `5368741306484925109` |
| ✈️ | `5348436127038579546` |
| 🧳 | `5357120306097956843` |
| 🏖 | `5310303848311562896` |
| ⛅️ | `5350424168615649565` |
| 🦄 | `5413625003218313783` |
| 🛍 | `5350699789551935589` |
| 👜 | `5377478880577724584` |
| 🛒 | `5431492767249342908` |
| 🚂 | `5350497316203668441` |
| 🛥 | `5350422527938141909` |
| 🏔 | `5418196338774907917` |
| 🏕 | `5350648297189023928` |
| 🤖 | `5309832892262654231` |
| 🪩 | `5350751634102166060` |
| 🎟 | `5377624166436445368` |
| 🏴‍☠️ | `5386395194029515402` |
| 🗳 | `5350387571199319521` |
| 🎓 | `5357419403325481346` |
| 🔭 | `5368585403467048206` |
| 🔬 | `5377580546748588396` |
| 🎶 | `5377317729109811382` |
| 🎤 | `5382003830487523366` |
| 🕺 | `5357298525765902091` |
| 💃 | `5357370526597653193` |
| 🪖 | `5357188789351490453` |
| 💼 | `5348227245599105972` |
| 🧪 | `5411138633765757782` |
| 👨‍👩‍👧‍👦 | `5386435923204382258` |
| 👶 | `5377675010259297233` |
| 🤰 | `5386609083400856174` |
| 💅 | `5368808634392257474` |
| 🏛 | `5350548830041415279` |
| 🧮 | `5355127101970194557` |
| 🖨 | `5386379624773066504` |
| 👮‍♂️ | `5377494501373780436` |
| 🩺 | `5350307998340226571` |
| 💊 | `5310094636159607472` |
| 💉 | `5310139157790596888` |
| 🧼 | `5377468357907849200` |
| 🪪 | `5418115271267197333` |
| 🛃 | `5372819184658949787` |
| 🍽 | `5350344462612570293` |
| 🐟 | `5384574037701696503` |
| 🎨 | `5310039132297242441` |
| 🎭 | `5350658016700013471` |
| 🎩 | `5357504778685392027` |
| 🔮 | `5350367161514732241` |
| 🍹 | `5350520238444126134` |
| 🎂 | `5310132165583840589` |
| ☕️ | `5350392020785437399` |
| 🍣 | `5350406176997646350` |
| 🍔 | `5350403544182694064` |
| 🍕 | `5350444672789519765` |
| 🦠 | `5312424913615723286` |
| 💬 | `5417915203100613993` |
| 🎄 | `5312054580060625569` |
| 🎃 | `5309744892677727325` |
| ✍️ | `5238156910363950406` |
| ⭐️ | `5235579393115438657` |
| ✅ | `5237699328843200968` |
| 🎖 | `5238027455754680851` |
| 🤡 | `5238234236955148254` |
| 🧠 | `5237889595894414384` |
| 🦮 | `5237999392438371490` |
| 🐈 | `5235912661102773458` |

</details>

Use those values directly, or replace them with any other `custom_emoji_id`
returned by `getForumTopicIconStickers`.

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
