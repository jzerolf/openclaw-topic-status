import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";

const PLUGIN_ID = "openclaw-topic-status";
const PLUGIN_VERSION = "0.2.1";
const SHARED_STATE_KEY = Symbol.for("openclaw-topic-status.runtime-state.v2");
const DEFAULT_CHANNEL_ID = "telegram";
const DEFAULT_API_ROOT = "https://api.telegram.org";
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_IDLE_DEBOUNCE_MS = 600;
const DEFAULT_RETRY_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_MS = 400;
const DEFAULT_RETRY_MAX_MS = 10_000;
const TARGET_CACHE_TTL_MS = 10 * 60 * 1000;
const TARGET_CACHE_MAX_ENTRIES = 1_000;
const COMPLETED_RUN_TTL_MS = 10 * 60 * 1000;
const COMPLETED_RUN_MAX_ENTRIES = 2_000;

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

function boundedInteger(value, fallback, minimum, maximum) {
  const candidate =
    typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.max(minimum, Math.min(maximum, candidate));
}

function normalizeConfig(rawConfig) {
  const raw = isRecord(rawConfig) ? rawConfig : {};
  const rawIcons = isRecord(raw.icons) ? raw.icons : {};
  const retryBaseMs = boundedInteger(
    raw.telegramRetryBaseMs,
    DEFAULT_RETRY_BASE_MS,
    0,
    30_000,
  );
  return {
    enabled: raw.enabled !== false,
    channelId: cleanString(raw.channelId) ?? DEFAULT_CHANNEL_ID,
    apiRoot: (cleanString(raw.apiRoot) ?? DEFAULT_API_ROOT).replace(/\/+$/, ""),
    botTokenEnv: cleanString(raw.botTokenEnv),
    botTokenFile: cleanString(raw.botTokenFile),
    timeoutMs: boundedInteger(raw.timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, 7_200_000),
    idleDebounceMs: boundedInteger(
      raw.idleDebounceMs,
      DEFAULT_IDLE_DEBOUNCE_MS,
      0,
      10_000,
    ),
    timeoutState:
      raw.timeoutState === "idle" || raw.timeoutState === "error" || raw.timeoutState === "timeout"
        ? raw.timeoutState
        : "timeout",
    telegramRetryAttempts: boundedInteger(
      raw.telegramRetryAttempts,
      DEFAULT_RETRY_ATTEMPTS,
      1,
      5,
    ),
    telegramRetryBaseMs: retryBaseMs,
    telegramRetryMaxMs: boundedInteger(
      raw.telegramRetryMaxMs,
      Math.max(DEFAULT_RETRY_MAX_MS, retryBaseMs),
      retryBaseMs,
      30_000,
    ),
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
        // OpenClaw's default journal output may suppress logger.debug.
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

  const contextChannelId = cleanString(ctx?.channelId);
  const parsedTargets = [
    parseTelegramTarget(ctx?.conversationId),
    parseTelegramTarget(ctx?.sessionKey),
    parseTelegramTarget(event?.sessionKey),
    parseTelegramTarget(metadata.originatingTo),
    parseTelegramTarget(metadata.to),
    parseTelegramTarget(event?.to),
    parseTelegramTarget(event?.from),
    contextChannelId === config.channelId ? {} : parseTelegramTarget(contextChannelId),
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
  const topicKey = `${accountId ?? "default"}:${chatId}:${threadId}`;
  return {
    accountId,
    chatId: String(chatId),
    threadId,
    sessionKey,
    runId,
    topicKey,
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
    log.warn(`cannot read Telegram token file ${tokenFile}: ${safeErrorMessage(error)}`);
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

function safeErrorMessage(error) {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw
    .replace(/bot\d+:[A-Za-z0-9_-]+/gi, "bot<redacted>")
    .replace(/\d+:[A-Za-z0-9_-]{20,}/g, "<redacted>")
    .slice(0, 500);
}

function shortRunId(runId) {
  const normalized = cleanString(runId);
  return normalized
    ? crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 10)
    : "legacy";
}

function responseDescription(response) {
  return (
    cleanString(response?.body?.description) ??
    cleanString(response?.statusText) ??
    "unknown Telegram error"
  );
}

function isSuccessfulTelegramResponse(response) {
  return Boolean(response?.ok && response?.body?.ok === true);
}

function isRetryableTelegramResponse(response) {
  const status = Number(response?.status ?? response?.body?.error_code ?? 0);
  return status === 429 || status >= 500;
}

function retryAfterMs(response) {
  const seconds = response?.body?.parameters?.retry_after;
  return typeof seconds === "number" && Number.isFinite(seconds) && seconds >= 0
    ? Math.trunc(seconds * 1_000)
    : undefined;
}

function delay(ms) {
  if (typeof globalThis.__telegramTopicStatusSleep === "function") {
    return globalThis.__telegramTopicStatusSleep(ms);
  }
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function editForumTopicIcon(api, config, log, state, status, revision, source) {
  const icons = resolveIcons(api, config, state);
  if (!icons) {
    log.warn(`icons unavailable for topic=${state.topicKey}; cannot apply ${status}`);
    return false;
  }
  const iconCustomEmojiId = icons[status];
  if (!iconCustomEmojiId) {
    log.warn(`icon unavailable for state=${status} topic=${state.topicKey}`);
    return false;
  }
  const token = resolveTelegramToken(api, config, state, log);
  if (!token) {
    log.warn(`Telegram token unavailable; cannot update topic=${state.topicKey}`);
    return false;
  }

  for (let attempt = 1; attempt <= config.telegramRetryAttempts; attempt += 1) {
    log.debug(
      `write start topic=${state.topicKey} gen=${state.generation} rev=${revision} status=${status} source=${source} attempt=${attempt}`,
    );
    let response;
    try {
      response = await postJson(`${config.apiRoot}/bot${token}/editForumTopic`, {
        chat_id: state.chatId,
        message_thread_id: state.threadId,
        icon_custom_emoji_id: iconCustomEmojiId,
      });
    } catch (error) {
      if (attempt >= config.telegramRetryAttempts) {
        log.warn(
          `editForumTopic transport failure topic=${state.topicKey} status=${status} after ${attempt} attempt(s): ${safeErrorMessage(error)}`,
        );
        return false;
      }
      const backoffMs = Math.min(
        config.telegramRetryMaxMs,
        config.telegramRetryBaseMs * 2 ** (attempt - 1),
      );
      log.debug(
        `write retry topic=${state.topicKey} gen=${state.generation} rev=${revision} status=${status} in=${backoffMs}ms reason=transport`,
      );
      await delay(backoffMs);
      continue;
    }

    if (isSuccessfulTelegramResponse(response)) {
      log.debug(
        `write success topic=${state.topicKey} gen=${state.generation} rev=${revision} status=${status}`,
      );
      return true;
    }

    const canRetry =
      attempt < config.telegramRetryAttempts && isRetryableTelegramResponse(response);
    if (!canRetry) {
      const statusCode = Number(response?.status ?? response?.body?.error_code ?? 0);
      log.warn(
        `editForumTopic rejected topic=${state.topicKey} status=${status}: ${statusCode} ${safeErrorMessage(responseDescription(response))}`,
      );
      return false;
    }

    const explicitRetryAfterMs = retryAfterMs(response);
    const backoffMs =
      explicitRetryAfterMs ??
      Math.min(
        config.telegramRetryMaxMs,
        config.telegramRetryBaseMs * 2 ** (attempt - 1),
      );
    log.debug(
      `write retry topic=${state.topicKey} gen=${state.generation} rev=${revision} status=${status} in=${backoffMs}ms reason=${Number(response?.status ?? response?.body?.error_code ?? 0)}`,
    );
    await delay(backoffMs);
  }
  return false;
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

function createRuntimeState() {
  return {
    schemaVersion: 2,
    byTopic: new Map(),
    byRun: new Map(),
    runsBySession: new Map(),
    targetsBySession: new Map(),
    targetsByRun: new Map(),
    completedRuns: new Map(),
  };
}

function getSharedRuntimeState() {
  const existing = globalThis[SHARED_STATE_KEY];
  if (existing?.schemaVersion === 2) {
    return existing;
  }
  const sharedState = createRuntimeState();
  globalThis[SHARED_STATE_KEY] = sharedState;
  return sharedState;
}

function createRuntime(api, runtimeState = createRuntimeState()) {
  const config = normalizeConfig(api.pluginConfig);
  const log = makeLog(api, config);
  const {
    byTopic,
    byRun,
    runsBySession,
    targetsBySession,
    targetsByRun,
    completedRuns,
  } = runtimeState;
  let stopping = false;

  function createTopicState(target) {
    return {
      ...target,
      generation: 1,
      activeRuns: new Map(),
      sessionKeys: new Set(),
      desiredStatus: undefined,
      desiredRevision: 0,
      processedRevision: 0,
      appliedStatus: undefined,
      writerPromise: null,
      revisionWaiters: [],
      idleTimer: null,
      rescueTimer: null,
      terminal: false,
    };
  }

  function updateTopicTarget(state, target) {
    state.accountId = target.accountId;
    state.chatId = target.chatId;
    state.threadId = target.threadId;
    state.topicKey = target.topicKey;
    if (target.sessionKey) {
      state.sessionKey = target.sessionKey;
      state.sessionKeys.add(target.sessionKey);
    }
  }

  function clearIdleTimer(state) {
    if (state.idleTimer) {
      clearTimeout(state.idleTimer);
      state.idleTimer = null;
    }
  }

  function clearRescueTimer(state) {
    if (state.rescueTimer) {
      clearTimeout(state.rescueTimer);
      state.rescueTimer = null;
    }
  }

  function settleRevisionWaiters(state) {
    const remaining = [];
    for (const waiter of state.revisionWaiters) {
      if (waiter.revision <= state.processedRevision) {
        waiter.resolve();
      } else {
        remaining.push(waiter);
      }
    }
    state.revisionWaiters = remaining;
  }

  function waitForRevision(state, revision) {
    if (state.processedRevision >= revision) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      state.revisionWaiters.push({ revision, resolve });
    });
  }

  async function drainWriter(state) {
    while (state.processedRevision < state.desiredRevision) {
      const revision = state.desiredRevision;
      const status = state.desiredStatus;
      const source = state.desiredSource;
      let applied = state.appliedStatus === status;
      if (!applied) {
        applied = await editForumTopicIcon(api, config, log, state, status, revision, source);
      } else {
        log.debug(
          `write skip topic=${state.topicKey} gen=${state.generation} rev=${revision} status=${status} reason=already-applied`,
        );
      }
      if (applied) {
        state.appliedStatus = status;
      }
      state.processedRevision = Math.max(state.processedRevision, revision);
      settleRevisionWaiters(state);
    }
  }

  function ensureWriter(state) {
    if (state.writerPromise) {
      return;
    }
    state.writerPromise = drainWriter(state)
      .catch((error) => {
        log.warn(`writer failure topic=${state.topicKey}: ${safeErrorMessage(error)}`);
        state.processedRevision = state.desiredRevision;
        settleRevisionWaiters(state);
      })
      .finally(() => {
        state.writerPromise = null;
        if (state.processedRevision < state.desiredRevision) {
          ensureWriter(state);
        }
      });
  }

  function queueStatus(state, status, source) {
    state.desiredRevision += 1;
    state.desiredStatus = status;
    state.desiredSource = source;
    const revision = state.desiredRevision;
    log.debug(
      `transition topic=${state.topicKey} gen=${state.generation} rev=${revision} desired=${status} applied=${state.appliedStatus ?? "none"} source=${source}`,
    );
    ensureWriter(state);
    return { revision, done: waitForRevision(state, revision) };
  }

  function pruneTargetCache() {
    const cutoff = Date.now() - TARGET_CACHE_TTL_MS;
    for (const [key, record] of targetsBySession) {
      if (record.at < cutoff) {
        targetsBySession.delete(key);
      }
    }
    for (const [key, record] of targetsByRun) {
      if (record.at < cutoff) {
        targetsByRun.delete(key);
      }
    }
    while (targetsBySession.size > TARGET_CACHE_MAX_ENTRIES) {
      targetsBySession.delete(targetsBySession.keys().next().value);
    }
    while (targetsByRun.size > TARGET_CACHE_MAX_ENTRIES) {
      targetsByRun.delete(targetsByRun.keys().next().value);
    }
  }

  function cacheTarget(target) {
    const record = { target, at: Date.now() };
    if (target.sessionKey) {
      targetsBySession.set(target.sessionKey, record);
    }
    if (target.runId) {
      targetsByRun.set(target.runId, record);
    }
    pruneTargetCache();
  }

  function resolveStartTarget(event, ctx) {
    const direct = resolveTopicState(event, ctx, config);
    if (direct) {
      return direct;
    }
    const runId = cleanString(ctx?.runId) ?? cleanString(event?.runId);
    if (runId && targetsByRun.has(runId)) {
      return targetsByRun.get(runId).target;
    }
    const sessionKey = cleanString(ctx?.sessionKey) ?? cleanString(event?.sessionKey);
    return sessionKey ? targetsBySession.get(sessionKey)?.target ?? null : null;
  }

  function removeRun(runId, record) {
    byRun.delete(runId);
    completedRuns.delete(runId);
    completedRuns.set(runId, Date.now());
    const completedCutoff = Date.now() - COMPLETED_RUN_TTL_MS;
    for (const [completedRunId, completedAt] of completedRuns) {
      if (completedAt >= completedCutoff && completedRuns.size <= COMPLETED_RUN_MAX_ENTRIES) {
        break;
      }
      completedRuns.delete(completedRunId);
    }
    record.state.activeRuns.delete(runId);
    const sessionKey = record.sessionKey;
    if (sessionKey) {
      const sessionRuns = runsBySession.get(sessionKey);
      sessionRuns?.delete(runId);
      if (sessionRuns?.size === 0) {
        runsBySession.delete(sessionKey);
      }
    }
  }

  function removeAllRuns(state) {
    for (const [runId] of state.activeRuns) {
      const record = byRun.get(runId);
      if (record) {
        removeRun(runId, record);
      } else {
        state.activeRuns.delete(runId);
      }
    }
  }

  function cleanupTopic(state, generation) {
    if (
      state.generation !== generation ||
      !state.terminal ||
      state.activeRuns.size > 0 ||
      state.processedRevision < state.desiredRevision
    ) {
      return;
    }
    clearIdleTimer(state);
    clearRescueTimer(state);
    if (byTopic.get(state.topicKey) === state) {
      byTopic.delete(state.topicKey);
    }
    for (const sessionKey of state.sessionKeys) {
      const record = targetsBySession.get(sessionKey);
      if (record?.target.topicKey === state.topicKey) {
        targetsBySession.delete(sessionKey);
      }
    }
    for (const [runId, record] of targetsByRun) {
      if (record.target.topicKey === state.topicKey) {
        targetsByRun.delete(runId);
      }
    }
    state.revisionWaiters.splice(0).forEach((waiter) => waiter.resolve());
    log.debug(`cleanup topic=${state.topicKey} gen=${generation}`);
  }

  function finalizeGeneration(state, status, source) {
    if (state.terminal) {
      return waitForRevision(state, state.desiredRevision);
    }
    const generation = state.generation;
    state.terminal = true;
    clearIdleTimer(state);
    clearRescueTimer(state);
    removeAllRuns(state);
    const transition = queueStatus(state, status, source);
    void transition.done.then(() => cleanupTopic(state, generation));
    return transition.done;
  }

  function rescueGeneration(state, generation, source = "rescue_timeout") {
    if (
      state.generation !== generation ||
      state.terminal ||
      state.activeRuns.size === 0
    ) {
      return Promise.resolve();
    }
    state.rescueTimer = null;
    log.debug(
      `rescue topic=${state.topicKey} gen=${generation} active=${state.activeRuns.size}`,
    );
    return finalizeGeneration(state, config.timeoutState, source);
  }

  function scheduleRescue(state) {
    if (state.terminal || state.activeRuns.size === 0) {
      clearRescueTimer(state);
      return;
    }
    clearRescueTimer(state);
    const generation = state.generation;
    const timer = setTimeout(() => {
      void rescueGeneration(state, generation);
    }, config.timeoutMs);
    timer.unref?.();
    state.rescueTimer = timer;
  }

  function beginNewGeneration(state, target) {
    clearIdleTimer(state);
    clearRescueTimer(state);
    removeAllRuns(state);
    state.generation += 1;
    state.terminal = false;
    state.activeRuns.clear();
    state.sessionKeys.clear();
    updateTopicTarget(state, target);
    log.debug(`generation start topic=${state.topicKey} gen=${state.generation}`);
  }

  function ensureTopic(target) {
    let state = byTopic.get(target.topicKey);
    if (!state) {
      state = createTopicState(target);
      updateTopicTarget(state, target);
      byTopic.set(target.topicKey, state);
      log.debug(`generation start topic=${state.topicKey} gen=${state.generation}`);
    } else if (state.terminal) {
      beginNewGeneration(state, target);
    } else {
      updateTopicTarget(state, target);
    }
    return state;
  }

  function activeRecordForTerminal(event, ctx, source, options = {}) {
    const runId = cleanString(ctx?.runId) ?? cleanString(event?.runId);
    if (runId) {
      const completedAt = completedRuns.get(runId);
      if (completedAt && completedAt >= Date.now() - COMPLETED_RUN_TTL_MS) {
        log.debug(`${source} ignored run=${shortRunId(runId)} reason=already-completed`);
        return null;
      }
      if (completedAt) {
        completedRuns.delete(runId);
      }
      const record = byRun.get(runId);
      if (!record || record.state.generation !== record.generation) {
        if (!options.deferUnknownLog) {
          log.debug(`${source} ignored run=${shortRunId(runId)} reason=unknown-or-stale`);
        }
        return null;
      }
      return { runId, record };
    }

    const sessionKey = cleanString(ctx?.sessionKey) ?? cleanString(event?.sessionKey);
    const candidates = sessionKey
      ? [...(runsBySession.get(sessionKey) ?? [])].filter((candidate) => byRun.has(candidate))
      : [];
    if (candidates.length !== 1) {
      log.debug(
        `${source} ignored run=legacy reason=${candidates.length === 0 ? "unmatched" : "ambiguous"}`,
      );
      return null;
    }
    const legacyRunId = candidates[0];
    return { runId: legacyRunId, record: byRun.get(legacyRunId) };
  }

  function scheduleIdle(state) {
    clearRescueTimer(state);
    clearIdleTimer(state);
    const generation = state.generation;
    const finish = () => {
      state.idleTimer = null;
      if (
        state.generation === generation &&
        !state.terminal &&
        state.activeRuns.size === 0
      ) {
        void finalizeGeneration(state, "idle", "agent_end");
      }
    };
    if (config.idleDebounceMs === 0) {
      finish();
      return;
    }
    state.idleTimer = setTimeout(finish, config.idleDebounceMs);
  }

  function onMessageReceived(event, ctx) {
    if (stopping) {
      return;
    }
    const target = resolveTopicState(event, ctx, config);
    if (!target) {
      return;
    }
    cacheTarget(target);
    log.debug(
      `message_received cached topic=${target.topicKey} run=${shortRunId(target.runId)}`,
    );
  }

  function onBeforeAgentRun(event, ctx) {
    if (stopping) {
      return { outcome: "pass" };
    }
    const runId = cleanString(ctx?.runId) ?? cleanString(event?.runId);
    if (!runId) {
      log.debug("before_agent_run ignored run=legacy reason=missing-runId");
      return { outcome: "pass" };
    }

    const existing = byRun.get(runId);
    if (existing) {
      const state = existing.state;
      clearIdleTimer(state);
      scheduleRescue(state);
      queueStatus(state, "working", "before_agent_run_duplicate");
      log.debug(
        `before_agent_run duplicate topic=${state.topicKey} gen=${state.generation} run=${shortRunId(runId)}`,
      );
      return { outcome: "pass" };
    }
    completedRuns.delete(runId);

    const target = resolveStartTarget(event, ctx);
    if (!target) {
      log.debug(`before_agent_run ignored run=${shortRunId(runId)} reason=topic-unresolved`);
      return { outcome: "pass" };
    }
    const state = ensureTopic({ ...target, runId });
    clearIdleTimer(state);
    const sessionKey = cleanString(ctx?.sessionKey) ?? cleanString(event?.sessionKey) ?? target.sessionKey;
    state.activeRuns.set(runId, { sessionKey });
    byRun.set(runId, { state, generation: state.generation, sessionKey });
    if (sessionKey) {
      state.sessionKeys.add(sessionKey);
      const sessionRuns = runsBySession.get(sessionKey) ?? new Set();
      sessionRuns.add(runId);
      runsBySession.set(sessionKey, sessionRuns);
    }
    targetsByRun.delete(runId);
    scheduleRescue(state);
    queueStatus(state, "working", "before_agent_run");
    log.debug(
      `before_agent_run topic=${state.topicKey} gen=${state.generation} run=${shortRunId(runId)} active=${state.activeRuns.size}`,
    );
    return { outcome: "pass" };
  }

  function onMessageSent(event, ctx) {
    if (!config.observeMessageSent || event?.success === false || stopping) {
      return;
    }
    const match = activeRecordForTerminal(event, ctx, "message_sent");
    if (!match) {
      return;
    }
    scheduleRescue(match.record.state);
    log.debug(
      `message_sent refresh topic=${match.record.state.topicKey} run=${shortRunId(match.runId)}`,
    );
  }

  function onAgentEnd(event, ctx) {
    if (stopping) {
      return;
    }
    const match = activeRecordForTerminal(event, ctx, "agent_end", {
      deferUnknownLog: true,
    });
    if (!match) {
      const terminalRunId = cleanString(ctx?.runId) ?? cleanString(event?.runId);
      const completedAt = terminalRunId ? completedRuns.get(terminalRunId) : undefined;
      if (completedAt && completedAt >= Date.now() - COMPLETED_RUN_TTL_MS) {
        return;
      }
      const target = resolveTopicState(event, ctx, config);
      if (!target) {
        return;
      }
      const existing = byTopic.get(target.topicKey);
      if (existing?.activeRuns.size > 0) {
        log.debug(
          `agent_end ignored topic=${target.topicKey} run=${shortRunId(ctx?.runId ?? event?.runId)} reason=unknown-run-with-active-topic`,
        );
        return;
      }
      if (existing?.terminal) {
        return;
      }
      const state = existing ?? createTopicState(target);
      if (!existing) {
        updateTopicTarget(state, target);
        byTopic.set(target.topicKey, state);
      }
      const finalState = event?.success === false ? "error" : "idle";
      log.debug(
        `agent_end stateless topic=${target.topicKey} gen=${state.generation} run=${shortRunId(ctx?.runId ?? event?.runId)} final=${finalState}`,
      );
      void finalizeGeneration(state, finalState, "agent_end_stateless");
      return;
    }
    const { runId, record } = match;
    const state = record.state;
    removeRun(runId, record);
    log.debug(
      `agent_end topic=${state.topicKey} gen=${state.generation} run=${shortRunId(runId)} success=${event?.success !== false} remaining=${state.activeRuns.size}`,
    );
    if (state.activeRuns.size > 0) {
      scheduleRescue(state);
      return;
    }
    if (event?.success === false) {
      void finalizeGeneration(state, "error", "agent_end");
      return;
    }
    scheduleIdle(state);
  }

  function onSessionEnd(event, ctx) {
    const sessionKey = cleanString(ctx?.sessionKey) ?? cleanString(event?.sessionKey);
    if (sessionKey) {
      targetsBySession.delete(sessionKey);
    }
    const activeCount = sessionKey
      ? [...(runsBySession.get(sessionKey) ?? [])].filter((runId) => byRun.has(runId)).length
      : 0;
    log.debug(
      `session_end bookkeeping reason=${cleanString(event?.reason) ?? "unknown"} active=${activeCount}`,
    );
  }

  async function stop() {
    if (stopping) {
      return;
    }
    stopping = true;
    const pending = [];
    for (const state of byTopic.values()) {
      clearIdleTimer(state);
      clearRescueTimer(state);
      if (state.activeRuns.size > 0) {
        pending.push(finalizeGeneration(state, config.timeoutState, "gateway_stop"));
      } else if (!state.terminal) {
        pending.push(finalizeGeneration(state, "idle", "gateway_stop"));
      } else if (state.writerPromise) {
        pending.push(state.writerPromise);
      }
    }
    await Promise.allSettled(pending);
    for (const state of byTopic.values()) {
      clearIdleTimer(state);
      clearRescueTimer(state);
      state.revisionWaiters.splice(0).forEach((waiter) => waiter.resolve());
    }
    byTopic.clear();
    byRun.clear();
    runsBySession.clear();
    targetsBySession.clear();
    targetsByRun.clear();
    completedRuns.clear();
    if (globalThis[SHARED_STATE_KEY] === runtimeState) {
      delete globalThis[SHARED_STATE_KEY];
    }
  }

  async function waitForWrites() {
    for (let pass = 0; pass < 20; pass += 1) {
      const writers = [...byTopic.values()].map((state) => state.writerPromise).filter(Boolean);
      if (writers.length === 0) {
        await new Promise((resolve) => setImmediate(resolve));
        const stillWriting = [...byTopic.values()].some((state) => state.writerPromise);
        if (!stillWriting) {
          return;
        }
        continue;
      }
      await Promise.allSettled(writers);
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error("topic-status writers did not settle");
  }

  log.info(
    `v${PLUGIN_VERSION} started (idleDebounceMs=${config.idleDebounceMs}, retryAttempts=${config.telegramRetryAttempts})`,
  );

  return {
    onMessageReceived,
    onBeforeAgentRun,
    onMessageSent,
    onAgentEnd,
    onSessionEnd,
    stop,
    _state: {
      byTopic,
      byRun,
      runsBySession,
      targetsBySession,
      targetsByRun,
      completedRuns,
    },
    _test: {
      waitForWrites,
      rescueTopic(topicKey) {
        const state = byTopic.get(topicKey);
        return state ? rescueGeneration(state, state.generation, "test_rescue") : Promise.resolve();
      },
    },
  };
}

const entry = {
  id: PLUGIN_ID,
  name: "OpenClaw Topic Status",
  description:
    "Updates Telegram forum topic custom emoji icons from OpenClaw runtime state.",
  register(api) {
    const runtime = createRuntime(api, getSharedRuntimeState());
    api.on("message_received", runtime.onMessageReceived, { priority: 10, timeoutMs: 5_000 });
    api.on("before_agent_run", runtime.onBeforeAgentRun, { priority: 10, timeoutMs: 5_000 });
    api.on("message_sent", runtime.onMessageSent, { priority: -10, timeoutMs: 5_000 });
    api.on("agent_end", runtime.onAgentEnd, { priority: -10, timeoutMs: 5_000 });
    api.on("session_end", runtime.onSessionEnd, { priority: -10, timeoutMs: 5_000 });
    api.on("gateway_stop", () => runtime.stop(), { priority: 0, timeoutMs: 30_000 });
  },
};

export { createRuntime, normalizeConfig, parseTelegramTarget, resolveTopicState };
export default entry;
