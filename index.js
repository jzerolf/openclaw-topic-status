import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const PLUGIN_ID = "openclaw-topic-status";
const DEFAULT_CHANNEL_ID = "telegram";
const DEFAULT_API_ROOT = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function cleanString(value) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function cleanStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map(cleanString).filter(Boolean);
}

function normalizeConfig(rawConfig) {
  const raw = isRecord(rawConfig) ? rawConfig : {};
  const rawIcons = isRecord(raw.icons) ? raw.icons : {};
  return {
    enabled: raw.enabled !== false,
    channelId: cleanString(raw.channelId) ?? DEFAULT_CHANNEL_ID,
    apiRoot: (cleanString(raw.apiRoot) ?? DEFAULT_API_ROOT).replace(/\/+$/, ""),
    botTokenEnv: cleanString(raw.botTokenEnv),
    botTokenFile: cleanString(raw.botTokenFile),
    timeoutMs:
      typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)
        ? Math.max(1000, Math.min(7_200_000, Math.trunc(raw.timeoutMs)))
        : DEFAULT_TIMEOUT_MS,
    timeoutState:
      raw.timeoutState === "idle" || raw.timeoutState === "error" || raw.timeoutState === "timeout"
        ? raw.timeoutState
        : "timeout",
    onlyAccountIds: cleanStringList(raw.onlyAccountIds),
    allowedChatIds: cleanStringList(raw.allowedChatIds),
    observeMessageSent: raw.observeMessageSent !== false,
    logLevel:
      raw.logLevel === "off" || raw.logLevel === "debug" || raw.logLevel === "info"
        ? raw.logLevel
        : "info",
    icons: {
      working: cleanString(rawIcons.working) ?? cleanString(rawIcons.workingIconCustomEmojiId),
      idle: cleanString(rawIcons.idle) ?? cleanString(rawIcons.idleIconCustomEmojiId),
      error: cleanString(rawIcons.error) ?? cleanString(rawIcons.errorIconCustomEmojiId),
      timeout: cleanString(rawIcons.timeout) ?? cleanString(rawIcons.timeoutIconCustomEmojiId),
    },
  };
}

function makeLog(api, config) {
  const logger = api.logger ?? console;
  return {
    info(message) {
      if (config.logLevel === "info" || config.logLevel === "debug") {
        logger.info?.(`[${PLUGIN_ID}] ${message}`);
      }
    },
    debug(message) {
      if (config.logLevel === "debug") {
        // OpenClaw's default journal output may suppress logger.debug; when
        // explicit debug logging is enabled for this plugin, keep it visible.
        (logger.info ?? logger.debug)?.(`[${PLUGIN_ID}] debug: ${message}`);
      }
    },
    warn(message) {
      if (config.logLevel !== "off") {
        logger.warn?.(`[${PLUGIN_ID}] ${message}`);
      }
    },
  };
}

function normalizeInteger(value) {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  const text = cleanString(value);
  if (!text || !/^\d+$/.test(text)) {
    return undefined;
  }
  const parsed = Number(text);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function parseTelegramTarget(value) {
  let text = cleanString(value);
  if (!text) {
    return {};
  }

  const sessionMatch = text.match(
    /(?:^|:)telegram:(?:direct|dm|chat|user|group|channel):([^:]+)(?::(?:topic|thread):(?:(?:[^:]+):)?(\d+))?(?:$|:)/i,
  );
  if (sessionMatch) {
    return {
      chatId: cleanString(sessionMatch[1]),
      threadId: normalizeInteger(sessionMatch[2]),
    };
  }

  const topicMatch = text.match(/:(?:topic|thread):(?:(?:[^:]+):)?(\d+)(?:$|:)/);
  const threadId = topicMatch ? normalizeInteger(topicMatch[1]) : undefined;
  text = text.replace(/:(?:topic|thread):(?:(?:[^:]+):)?\d+(?::$|$).*/, "");
  text = text.replace(/:(?:sender|user):.+$/, "");

  for (const prefix of ["telegram:", "group:", "direct:", "dm:", "chat:", "user:"]) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
    }
  }
  for (const prefix of ["group:", "direct:", "dm:", "chat:", "user:"]) {
    if (text.startsWith(prefix)) {
      text = text.slice(prefix.length);
    }
  }

  return {
    chatId: cleanString(text),
    threadId,
  };
}

function readMetadata(event) {
  return isRecord(event?.metadata) ? event.metadata : {};
}

function matchesConfiguredChannel(event, ctx, metadata, config) {
  const candidates = [
    cleanString(ctx?.channelId),
    cleanString(ctx?.messageProvider),
    cleanString(event?.channel),
    cleanString(event?.channelId),
    cleanString(metadata.provider),
    cleanString(metadata.surface),
    cleanString(metadata.originatingChannel),
  ];
  if (candidates.includes(config.channelId)) {
    return true;
  }
  return Boolean(
    parseTelegramTarget(ctx?.sessionKey).chatId ??
      parseTelegramTarget(event?.sessionKey).chatId,
  );
}

function resolveTopicState(event, ctx, config) {
  const metadata = readMetadata(event);
  if (!config.enabled || !matchesConfiguredChannel(event, ctx, metadata, config)) {
    return null;
  }

  const accountId = cleanString(ctx?.accountId) ?? cleanString(event?.accountId);
  if (config.onlyAccountIds.length > 0 && (!accountId || !config.onlyAccountIds.includes(accountId))) {
    return null;
  }

  const parsedTargets = [
    parseTelegramTarget(ctx?.conversationId),
    parseTelegramTarget(ctx?.channelId),
    parseTelegramTarget(ctx?.sessionKey),
    parseTelegramTarget(event?.sessionKey),
    parseTelegramTarget(metadata.originatingTo),
    parseTelegramTarget(metadata.to),
    parseTelegramTarget(event?.to),
    parseTelegramTarget(event?.from),
  ];

  const chatId = parsedTargets.find((target) => target.chatId)?.chatId;
  const threadId =
    normalizeInteger(event?.threadId) ??
    normalizeInteger(metadata.threadId) ??
    parsedTargets.find((target) => target.threadId !== undefined)?.threadId;

  if (!chatId || threadId === undefined) {
    return null;
  }
  if (config.allowedChatIds.length > 0 && !config.allowedChatIds.includes(String(chatId))) {
    return null;
  }

  const sessionKey = cleanString(ctx?.sessionKey) ?? cleanString(event?.sessionKey);
  const runId = cleanString(ctx?.runId) ?? cleanString(event?.runId);
  const senderId = cleanString(ctx?.senderId) ?? cleanString(event?.senderId);
  const topicKey = `${accountId ?? "default"}:${chatId}:${threadId}`;
  return {
    accountId,
    chatId: String(chatId),
    threadId,
    sessionKey,
    runId,
    senderId,
    topicKey,
    seq: 0,
  };
}

function resolveTelegramConfig(api) {
  const channels = isRecord(api.config?.channels) ? api.config.channels : {};
  return isRecord(channels.telegram) ? channels.telegram : {};
}

function accountConfig(telegramConfig, accountId) {
  const accounts = isRecord(telegramConfig.accounts) ? telegramConfig.accounts : {};
  const account = accountId && isRecord(accounts[accountId]) ? accounts[accountId] : undefined;
  return account ?? {};
}

function directConfigFor(telegramConfig, account, chatId) {
  const accountDirect = isRecord(account.direct) ? account.direct : {};
  if (isRecord(accountDirect[chatId])) {
    return accountDirect[chatId];
  }
  const rootDirect = isRecord(telegramConfig.direct) ? telegramConfig.direct : {};
  return isRecord(rootDirect[chatId]) ? rootDirect[chatId] : {};
}

function normalizeIcons(value) {
  if (!isRecord(value) || value.enabled === false) {
    return null;
  }
  const working = cleanString(value.working) ?? cleanString(value.workingIconCustomEmojiId);
  const idle = cleanString(value.idle) ?? cleanString(value.idleIconCustomEmojiId);
  if (!working || !idle) {
    return null;
  }
  const error = cleanString(value.error) ?? cleanString(value.errorIconCustomEmojiId) ?? idle;
  return {
    working,
    idle,
    error,
    timeout: cleanString(value.timeout) ?? cleanString(value.timeoutIconCustomEmojiId) ?? error,
  };
}

function resolveIcons(api, config, state) {
  const pluginIcons = normalizeIcons({ enabled: true, ...config.icons });
  if (pluginIcons) {
    return pluginIcons;
  }

  const telegramConfig = resolveTelegramConfig(api);
  const account = accountConfig(telegramConfig, state.accountId);
  const direct = directConfigFor(telegramConfig, account, state.chatId);
  return (
    normalizeIcons(direct.topicStatusIcons) ??
    normalizeIcons(account.topicStatusIcons) ??
    normalizeIcons(telegramConfig.topicStatusIcons)
  );
}

function readTokenFromFile(filePath, log) {
  const tokenFile = cleanString(filePath);
  if (!tokenFile) {
    return undefined;
  }
  try {
    return cleanString(fs.readFileSync(tokenFile, "utf8"));
  } catch (error) {
    log.warn(`cannot read Telegram token file ${tokenFile}: ${String(error)}`);
    return undefined;
  }
}

function resolveTelegramToken(api, config, state, log) {
  const envNames = [
    config.botTokenEnv,
    state.accountId ? `TELEGRAM_${state.accountId.toUpperCase().replace(/[^A-Z0-9]/g, "_")}_BOT_TOKEN` : undefined,
    "TELEGRAM_BOT_TOKEN",
    "OPENCLAW_TELEGRAM_BOT_TOKEN",
  ].filter(Boolean);
  for (const name of envNames) {
    const token = cleanString(process.env[name]);
    if (token) {
      return token;
    }
  }

  const telegramConfig = resolveTelegramConfig(api);
  const account = accountConfig(telegramConfig, state.accountId);
  return (
    readTokenFromFile(config.botTokenFile, log) ??
    readTokenFromFile(account.tokenFile, log) ??
    readTokenFromFile(telegramConfig.tokenFile, log) ??
    cleanString(account.botToken) ??
    cleanString(telegramConfig.botToken)
  );
}

async function editForumTopicIcon(api, config, log, state, status) {
  const icons = resolveIcons(api, config, state);
  if (!icons) {
    log.debug(`no icons configured for ${state.topicKey}; skipping ${status}`);
    return;
  }
  const iconCustomEmojiId = icons[status];
  if (!iconCustomEmojiId) {
    return;
  }
  const token = resolveTelegramToken(api, config, state, log);
  if (!token) {
    log.warn("Telegram token unavailable; cannot update topic icon");
    return;
  }

  const response = await postJson(`${config.apiRoot}/bot${token}/editForumTopic`, {
    chat_id: state.chatId,
    message_thread_id: state.threadId,
    icon_custom_emoji_id: iconCustomEmojiId,
  });

  if (!response.ok) {
    const description = cleanString(response.body?.description) ?? response.statusText;
    log.warn(
      `editForumTopic failed for ${state.chatId}/${state.threadId} (${status}): ${response.status} ${description}`,
    );
    return;
  }
  log.debug(`set ${status} icon for ${state.chatId}/${state.threadId}`);
}

function postJson(url, payload) {
  if (typeof globalThis.__telegramTopicStatusPostJson === "function") {
    return globalThis.__telegramTopicStatusPostJson(url, payload);
  }

  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const body = JSON.stringify(payload);
    const transport = parsed.protocol === "http:" ? http : https;
    const req = transport.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || undefined,
        path: `${parsed.pathname}${parsed.search}`,
        method: "POST",
        family: 4,
        timeout: 10_000,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
        },
      },
      (res) => {
        let responseText = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          responseText += chunk;
        });
        res.on("end", () => {
          let parsedBody = {};
          try {
            parsedBody = responseText ? JSON.parse(responseText) : {};
          } catch {
            parsedBody = {};
          }
          resolve({
            ok: Boolean(res.statusCode && res.statusCode >= 200 && res.statusCode < 300),
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            body: parsedBody,
          });
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("Telegram Bot API request timed out"));
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

function createRuntime(api) {
  const config = normalizeConfig(api.pluginConfig);
  const log = makeLog(api, config);
  const bySession = new Map();
  const byRun = new Map();
  const byTopic = new Map();
  const latestBySender = new Map();
  const topicSeq = new Map();
  const timeoutByTopic = new Map();
  const completedTopicSeq = new Set();

  function senderKey(state) {
    return state.senderId
      ? `${state.accountId ?? "default"}:${state.chatId}:${state.senderId}`
      : undefined;
  }

  function remember(state) {
    const seq = (topicSeq.get(state.topicKey) ?? 0) + 1;
    const next = { ...state, seq };
    topicSeq.set(next.topicKey, seq);
    completedTopicSeq.delete(`${next.topicKey}:${next.seq}`);
    if (next.sessionKey) {
      bySession.set(next.sessionKey, next);
    }
    if (next.runId) {
      byRun.set(next.runId, next);
    }
    byTopic.set(next.topicKey, next);
    const key = senderKey(next);
    if (key) {
      latestBySender.set(key, { state: next, at: Date.now() });
    }
    return next;
  }

  function associateRun(state, runId) {
    const normalizedRunId = cleanString(runId);
    if (!normalizedRunId) {
      return state;
    }
    const next = { ...state, runId: normalizedRunId };
    byRun.set(normalizedRunId, next);
    if (next.sessionKey) {
      bySession.set(next.sessionKey, next);
    }
    byTopic.set(next.topicKey, next);
    return next;
  }

  function lookup(event, ctx) {
    const runId = cleanString(ctx?.runId) ?? cleanString(event?.runId);
    if (runId && byRun.has(runId)) {
      return byRun.get(runId);
    }
    const sessionKey = cleanString(ctx?.sessionKey) ?? cleanString(event?.sessionKey);
    if (sessionKey && bySession.has(sessionKey)) {
      return bySession.get(sessionKey);
    }
    const senderId = cleanString(ctx?.senderId) ?? cleanString(event?.senderId);
    const accountId = cleanString(ctx?.accountId) ?? "default";
    if (senderId) {
      for (const record of latestBySender.values()) {
        const state = record.state;
        if (
          state.senderId === senderId &&
          (state.accountId ?? "default") === accountId &&
          Date.now() - record.at < 120_000
        ) {
          return state;
        }
      }
    }
    const resolved = resolveTopicState(event, ctx, config);
    if (!resolved) {
      return null;
    }
    return byTopic.get(resolved.topicKey) ?? resolved;
  }

  function clearTimeoutFor(state) {
    const existing = timeoutByTopic.get(state.topicKey);
    if (existing) {
      clearTimeout(existing);
      timeoutByTopic.delete(state.topicKey);
    }
  }

  function scheduleRescue(state) {
    if (config.timeoutMs <= 0) {
      return;
    }
    if (completedTopicSeq.has(`${state.topicKey}:${state.seq}`)) {
      return;
    }
    const currentSeq = topicSeq.get(state.topicKey);
    if (currentSeq !== undefined && currentSeq !== state.seq) {
      log.debug(
        `skip rescue for stale ${state.topicKey}: current seq=${currentSeq}, state seq=${state.seq}`,
      );
      return;
    }
    clearTimeoutFor(state);
    const timer = setTimeout(() => {
      if (topicSeq.get(state.topicKey) !== state.seq) {
        return;
      }
      const rescueStatus = config.timeoutState;
      void editForumTopicIcon(api, config, log, state, rescueStatus).catch((error) => {
        log.warn(`timeout rescue failed for ${state.topicKey}: ${String(error)}`);
      });
    }, config.timeoutMs);
    timer.unref?.();
    timeoutByTopic.set(state.topicKey, timer);
  }

  function applyStatus(state, status) {
    const currentSeq = topicSeq.get(state.topicKey);
    if (currentSeq !== undefined && currentSeq !== state.seq) {
      log.debug(
        `skip ${status} for stale ${state.topicKey}: current seq=${currentSeq}, state seq=${state.seq}`,
      );
      return;
    }
    if (status === "idle" || status === "error") {
      clearTimeoutFor(state);
      completedTopicSeq.add(`${state.topicKey}:${state.seq}`);
      if (state.runId) {
        byRun.delete(state.runId);
      }
      if (state.sessionKey) {
        bySession.delete(state.sessionKey);
      }
      byTopic.delete(state.topicKey);
    } else {
      scheduleRescue(state);
    }
    void editForumTopicIcon(api, config, log, state, status).catch((error) => {
      log.warn(`failed setting ${status} for ${state.topicKey}: ${String(error)}`);
    });
  }

  function onMessageReceived(event, ctx) {
    const state = resolveTopicState(event, ctx, config);
    if (!state) {
      return;
    }
    const remembered = remember(state);
    log.debug(`message_received -> working ${remembered.topicKey}`);
    applyStatus(remembered, "working");
  }

  function onBeforeAgentRun(event, ctx) {
    const state = lookup(event, ctx);
    if (state) {
      const associated = associateRun(state, ctx?.runId);
      log.debug(`before_agent_run -> keep working ${associated.topicKey}`);
      applyStatus(associated, "working");
    }
    return { outcome: "pass" };
  }

  function onMessageSent(event, ctx) {
    if (!config.observeMessageSent || event?.success === false) {
      return;
    }
    const state = lookup(event, ctx);
    if (!state) {
      return;
    }
    log.debug(`message_sent -> refresh timeout ${state.topicKey}`);
    scheduleRescue(state);
  }

  function onAgentEnd(event, ctx) {
    const state = lookup(event, ctx);
    if (!state) {
      return;
    }
    const finalState = event?.success === false ? "error" : "idle";
    log.debug(`agent_end -> ${finalState} ${state.topicKey}`);
    applyStatus(state, finalState);
  }

  function stop() {
    for (const timer of timeoutByTopic.values()) {
      clearTimeout(timer);
    }
    timeoutByTopic.clear();
    byTopic.clear();
  }

  return {
    onMessageReceived,
    onBeforeAgentRun,
    onMessageSent,
    onAgentEnd,
    stop,
    _state: { bySession, byRun, byTopic, topicSeq, timeoutByTopic },
  };
}

const entry = {
  id: PLUGIN_ID,
  name: "OpenClaw Topic Status",
  description:
    "Updates Telegram forum topic custom emoji icons from OpenClaw runtime state.",
  register(api) {
    const runtime = createRuntime(api);
    api.on("message_received", runtime.onMessageReceived, { priority: 10, timeoutMs: 5_000 });
    api.on("before_agent_run", runtime.onBeforeAgentRun, { priority: 10, timeoutMs: 5_000 });
    api.on("message_sent", runtime.onMessageSent, { priority: -10, timeoutMs: 5_000 });
    api.on("agent_end", runtime.onAgentEnd, { priority: -10, timeoutMs: 5_000 });
    api.on("gateway_stop", () => runtime.stop(), { priority: 0, timeoutMs: 2_000 });
  },
};

export { createRuntime, normalizeConfig, parseTelegramTarget, resolveTopicState };
export default entry;
