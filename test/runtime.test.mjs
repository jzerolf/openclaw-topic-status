import assert from "node:assert/strict";
import test from "node:test";
import plugin, { createRuntime } from "../index.js";

const CHAT_ID = "5966150195";

function successfulResponse() {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body: { ok: true },
  };
}

function sessionKey(topicId) {
  return `agent:main:telegram:direct:${CHAT_ID}:thread:${CHAT_ID}:${topicId}`;
}

function agentContext(topicId, runId, overrides = {}) {
  return {
    channelId: `${CHAT_ID}:thread:${CHAT_ID}:${topicId}`,
    messageProvider: "telegram",
    accountId: "default",
    sessionKey: sessionKey(topicId),
    runId,
    ...overrides,
  };
}

function createHarness({ config = {}, transport } = {}) {
  const calls = [];
  const activeTransport =
    transport ??
    (async (url, body) => {
      calls.push({ url, body });
      return successfulResponse();
    });
  globalThis.__telegramTopicStatusPostJson = async (url, body) => {
    if (transport) {
      calls.push({ url, body });
    }
    return activeTransport(url, body);
  };
  globalThis.__telegramTopicStatusSleep = async () => {};

  const api = {
    pluginConfig: {
      idleDebounceMs: 0,
      timeoutMs: 60_000,
      telegramRetryBaseMs: 0,
      telegramRetryMaxMs: 0,
      logLevel: "off",
      icons: {
        working: "working",
        idle: "idle",
        error: "error",
        timeout: "timeout",
      },
      ...config,
    },
    config: {
      channels: {
        telegram: {
          botToken: "123456:test-token",
        },
      },
    },
    logger: {
      info() {},
      warn() {},
    },
  };
  return { runtime: createRuntime(api), calls };
}

async function usingHarness(options, callback) {
  const harness = createHarness(options);
  try {
    await callback(harness);
  } finally {
    await harness.runtime.stop();
    delete globalThis.__telegramTopicStatusPostJson;
    delete globalThis.__telegramTopicStatusSleep;
  }
}

function receive(runtime, topicId, runId, senderId = CHAT_ID) {
  runtime.onMessageReceived(
    {
      from: `telegram:${CHAT_ID}`,
      threadId: topicId,
      sessionKey: sessionKey(topicId),
      senderId,
      runId,
      metadata: {
        originatingTo: `telegram:${CHAT_ID}`,
        threadId: topicId,
      },
    },
    {
      channelId: "telegram",
      accountId: "default",
      conversationId: `telegram:${CHAT_ID}`,
      sessionKey: sessionKey(topicId),
      senderId,
      runId,
    },
  );
}

function start(runtime, topicId, runId, overrides = {}) {
  receive(runtime, topicId, runId, overrides.senderId);
  return runtime.onBeforeAgentRun(
    { prompt: "ping", runId },
    agentContext(topicId, runId, overrides),
  );
}

function end(runtime, topicId, runId, success = true, overrides = {}) {
  runtime.onAgentEnd(
    { runId, messages: [], success },
    agentContext(topicId, runId, overrides),
  );
}

function icons(calls) {
  return calls.map((call) => call.body.icon_custom_emoji_id);
}

async function waitUntil(predicate, message = "condition was not met") {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error(message);
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test("message receipt is cache-only and one run produces working -> idle", { concurrency: false }, async () => {
  await usingHarness({}, async ({ runtime, calls }) => {
    receive(runtime, 9847, "run-1");
    await runtime._test.waitForWrites();
    assert.equal(calls.length, 0);

    assert.deepEqual(
      runtime.onBeforeAgentRun(
        { prompt: "ping", runId: "run-1" },
        agentContext(9847, "run-1"),
      ),
      { outcome: "pass" },
    );
    await runtime._test.waitForWrites();
    assert.deepEqual(icons(calls), ["working"]);

    end(runtime, 9847, "run-1");
    await runtime._test.waitForWrites();
    assert.deepEqual(icons(calls), ["working", "idle"]);
    assert.equal(runtime._state.byTopic.size, 0);
    assert.equal(runtime._state.byRun.size, 0);
  });
});

test("a stale terminal event cannot close a newer run", { concurrency: false }, async () => {
  await usingHarness({}, async ({ runtime, calls }) => {
    start(runtime, 10001, "run-A");
    await runtime._test.waitForWrites();
    start(runtime, 10001, "run-B");
    await runtime._test.waitForWrites();

    end(runtime, 10001, "run-A");
    await runtime._test.waitForWrites();
    assert.deepEqual(icons(calls), ["working"]);

    end(runtime, 10001, "run-B");
    await runtime._test.waitForWrites();
    assert.deepEqual(icons(calls), ["working", "idle"]);

    end(runtime, 10001, "run-A");
    await runtime._test.waitForWrites();
    assert.deepEqual(icons(calls), ["working", "idle"]);
  });
});

test("overlapping runs remain working until both have ended", { concurrency: false }, async () => {
  await usingHarness({}, async ({ runtime, calls }) => {
    start(runtime, 10002, "run-A");
    start(runtime, 10002, "run-B");
    await runtime._test.waitForWrites();
    assert.equal(runtime._state.byRun.size, 2);
    assert.deepEqual(icons(calls), ["working"]);

    end(runtime, 10002, "run-B");
    await runtime._test.waitForWrites();
    assert.deepEqual(icons(calls), ["working"]);
    assert.equal(runtime._state.byRun.size, 1);

    end(runtime, 10002, "run-A");
    await runtime._test.waitForWrites();
    assert.deepEqual(icons(calls), ["working", "idle"]);
  });
});

test("two topics from the same sender never share state", { concurrency: false }, async () => {
  await usingHarness({}, async ({ runtime, calls }) => {
    start(runtime, 11001, "run-topic-1", { senderId: "same-sender" });
    start(runtime, 11002, "run-topic-2", { senderId: "same-sender" });
    await runtime._test.waitForWrites();
    assert.equal(runtime._state.byTopic.size, 2);

    end(runtime, 11001, "run-topic-1");
    await runtime._test.waitForWrites();
    assert.deepEqual(
      calls.map((call) => [call.body.message_thread_id, call.body.icon_custom_emoji_id]),
      [
        [11001, "working"],
        [11002, "working"],
        [11001, "idle"],
      ],
    );
    assert.equal(runtime._state.byRun.has("run-topic-2"), true);

    end(runtime, 11002, "run-topic-2");
    await runtime._test.waitForWrites();
  });
});

test("duplicate start hooks are idempotent", { concurrency: false }, async () => {
  await usingHarness({}, async ({ runtime, calls }) => {
    start(runtime, 12001, "run-duplicate");
    start(runtime, 12001, "run-duplicate");
    await runtime._test.waitForWrites();
    assert.deepEqual(icons(calls), ["working"]);
    assert.equal(runtime._state.byRun.size, 1);

    end(runtime, 12001, "run-duplicate");
    await runtime._test.waitForWrites();
  });
});

test("an unknown runId is ignored even when its topic matches", { concurrency: false }, async () => {
  await usingHarness({}, async ({ runtime, calls }) => {
    start(runtime, 13001, "run-current");
    await runtime._test.waitForWrites();

    end(runtime, 13001, "run-unknown");
    await runtime._test.waitForWrites();
    assert.deepEqual(icons(calls), ["working"]);
    assert.equal(runtime._state.byRun.has("run-current"), true);
  });
});

test("agent_end can close its exact topic after a runtime rebuild", { concurrency: false }, async () => {
  await usingHarness({}, async ({ runtime, calls }) => {
    end(runtime, 14001, "run-never-seen");
    await runtime._test.waitForWrites();
    assert.deepEqual(icons(calls), ["idle"]);
    assert.equal(runtime._state.byTopic.size, 0);
  });
});

test("separate plugin registrations share start and terminal state", { concurrency: false }, async () => {
  const calls = [];
  globalThis.__telegramTopicStatusPostJson = async (url, body) => {
    calls.push({ url, body });
    return successfulResponse();
  };
  globalThis.__telegramTopicStatusSleep = async () => {};

  const makeApi = (hooks) => ({
    pluginConfig: {
      idleDebounceMs: 0,
      timeoutMs: 60_000,
      logLevel: "off",
      icons: {
        working: "working",
        idle: "idle",
        error: "error",
        timeout: "timeout",
      },
    },
    config: {
      channels: {
        telegram: {
          botToken: "123456:test-token",
        },
      },
    },
    logger: {
      info() {},
      warn() {},
    },
    on(name, handler) {
      hooks.set(name, handler);
    },
  });

  const firstHooks = new Map();
  const secondHooks = new Map();
  plugin.register(makeApi(firstHooks));
  plugin.register(makeApi(secondHooks));
  try {
    firstHooks.get("message_received")(
      {
        from: `telegram:${CHAT_ID}`,
        threadId: 14501,
        sessionKey: sessionKey(14501),
        runId: "run-split-registry",
      },
      {
        channelId: "telegram",
        accountId: "default",
        conversationId: `telegram:${CHAT_ID}`,
        sessionKey: sessionKey(14501),
        runId: "run-split-registry",
      },
    );
    firstHooks.get("before_agent_run")(
      { prompt: "ping", runId: "run-split-registry" },
      agentContext(14501, "run-split-registry"),
    );
    await waitUntil(() => calls.length === 1);

    secondHooks.get("agent_end")(
      { runId: "run-split-registry", messages: [], success: true },
      agentContext(14501, "run-split-registry"),
    );
    await waitUntil(() => calls.length === 2);
    assert.deepEqual(icons(calls), ["working", "idle"]);
  } finally {
    await secondHooks.get("gateway_stop")({}, {});
    delete globalThis.__telegramTopicStatusPostJson;
    delete globalThis.__telegramTopicStatusSleep;
  }
});

test("session_end reasons perform bookkeeping without closing active work", { concurrency: false }, async () => {
  await usingHarness({}, async ({ runtime, calls }) => {
    start(runtime, 15001, "run-session");
    await runtime._test.waitForWrites();

    for (const reason of ["idle", "compaction", "reset", "restart", "shutdown", "unknown"]) {
      runtime.onSessionEnd(
        {
          reason,
          sessionKey: sessionKey(15001),
        },
        {
          sessionKey: sessionKey(15001),
        },
      );
    }
    await runtime._test.waitForWrites();
    assert.deepEqual(icons(calls), ["working"]);
    assert.equal(runtime._state.byRun.has("run-session"), true);

    end(runtime, 15001, "run-session");
    await runtime._test.waitForWrites();
  });
});

test("delayed Telegram responses cannot reorder final state", { concurrency: false }, async () => {
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  await usingHarness(
    {
      transport: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const pending = deferred();
        requests.push(pending);
        const response = await pending.promise;
        inFlight -= 1;
        return response;
      },
    },
    async ({ runtime, calls }) => {
      start(runtime, 16001, "run-delayed");
      await waitUntil(() => calls.length === 1);
      end(runtime, 16001, "run-delayed");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls.length, 1);

      requests[0].resolve(successfulResponse());
      await waitUntil(() => calls.length === 2);
      assert.deepEqual(icons(calls), ["working", "idle"]);
      requests[1].resolve(successfulResponse());
      await runtime._test.waitForWrites();
      assert.equal(maxInFlight, 1);
    },
  );
});

test("a new run cancels the idle debounce", { concurrency: false }, async () => {
  await usingHarness(
    { config: { idleDebounceMs: 30 } },
    async ({ runtime, calls }) => {
      start(runtime, 17001, "run-first");
      await runtime._test.waitForWrites();
      end(runtime, 17001, "run-first");

      await new Promise((resolve) => setTimeout(resolve, 5));
      start(runtime, 17001, "run-second");
      await runtime._test.waitForWrites();
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.deepEqual(icons(calls), ["working"]);

      end(runtime, 17001, "run-second");
      await new Promise((resolve) => setTimeout(resolve, 40));
      await runtime._test.waitForWrites();
      assert.deepEqual(icons(calls), ["working", "idle"]);
    },
  );
});

test("a new generation stays serialized behind an in-flight idle write", { concurrency: false }, async () => {
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  await usingHarness(
    {
      transport: async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const pending = deferred();
        requests.push(pending);
        const response = await pending.promise;
        inFlight -= 1;
        return response;
      },
    },
    async ({ runtime, calls }) => {
      start(runtime, 17501, "run-generation-A");
      await waitUntil(() => calls.length === 1);
      requests[0].resolve(successfulResponse());
      await runtime._test.waitForWrites();

      end(runtime, 17501, "run-generation-A");
      await waitUntil(() => calls.length === 2);
      start(runtime, 17501, "run-generation-B");
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(calls.length, 2);

      requests[1].resolve(successfulResponse());
      await waitUntil(() => calls.length === 3);
      assert.deepEqual(icons(calls), ["working", "idle", "working"]);
      assert.equal(runtime._state.byRun.has("run-generation-B"), true);
      requests[2].resolve(successfulResponse());
      await runtime._test.waitForWrites();
      assert.equal(maxInFlight, 1);

      end(runtime, 17501, "run-generation-B");
      await waitUntil(() => calls.length === 4);
      requests[3].resolve(successfulResponse());
      await runtime._test.waitForWrites();
    },
  );
});

test("rescue timeout is terminal and cleans all indexes", { concurrency: false }, async () => {
  await usingHarness({}, async ({ runtime, calls }) => {
    start(runtime, 18001, "run-timeout");
    await runtime._test.waitForWrites();

    await runtime._test.rescueTopic(`default:${CHAT_ID}:18001`);
    await runtime._test.waitForWrites();
    assert.deepEqual(icons(calls), ["working", "timeout"]);
    assert.equal(runtime._state.byTopic.size, 0);
    assert.equal(runtime._state.byRun.size, 0);
    assert.equal(runtime._state.runsBySession.size, 0);
  });
});

test("transient Telegram failures retry before newer state is applied", { concurrency: false }, async () => {
  const requests = [];
  await usingHarness(
    {
      transport: async () => {
        const pending = deferred();
        requests.push(pending);
        return pending.promise;
      },
    },
    async ({ runtime, calls }) => {
      start(runtime, 19001, "run-retry");
      await waitUntil(() => calls.length === 1);
      end(runtime, 19001, "run-retry");

      requests[0].resolve({
        ok: false,
        status: 500,
        statusText: "Server Error",
        body: { ok: false, error_code: 500, description: "temporary" },
      });
      await waitUntil(() => calls.length === 2);
      assert.deepEqual(icons(calls), ["working", "working"]);

      requests[1].resolve(successfulResponse());
      await waitUntil(() => calls.length === 3);
      assert.deepEqual(icons(calls), ["working", "working", "idle"]);
      requests[2].resolve(successfulResponse());
      await runtime._test.waitForWrites();
    },
  );
});

test("Telegram body errors are failures even with HTTP 200", { concurrency: false }, async () => {
  await usingHarness(
    {
      transport: async () => ({
        ok: true,
        status: 200,
        statusText: "OK",
        body: { ok: false, error_code: 400, description: "bad icon" },
      }),
    },
    async ({ runtime, calls }) => {
      start(runtime, 20001, "run-body-error");
      await runtime._test.waitForWrites();
      assert.deepEqual(icons(calls), ["working"]);
    },
  );
});

test("legacy terminal fallback requires exactly one active run in the session", { concurrency: false }, async () => {
  await usingHarness({}, async ({ runtime, calls }) => {
    start(runtime, 21001, "run-legacy");
    await runtime._test.waitForWrites();

    runtime.onAgentEnd(
      { messages: [], success: true },
      {
        channelId: `${CHAT_ID}:thread:${CHAT_ID}:21001`,
        messageProvider: "telegram",
        accountId: "default",
        sessionKey: sessionKey(21001),
      },
    );
    await runtime._test.waitForWrites();
    assert.deepEqual(icons(calls), ["working", "idle"]);
  });
});

test("ambiguous legacy terminal events are ignored", { concurrency: false }, async () => {
  await usingHarness({}, async ({ runtime, calls }) => {
    start(runtime, 22001, "run-legacy-A");
    start(runtime, 22001, "run-legacy-B");
    await runtime._test.waitForWrites();

    runtime.onAgentEnd(
      { messages: [], success: true },
      {
        messageProvider: "telegram",
        accountId: "default",
        sessionKey: sessionKey(22001),
      },
    );
    await runtime._test.waitForWrites();
    assert.deepEqual(icons(calls), ["working"]);
    assert.equal(runtime._state.byRun.size, 2);
  });
});

test("gateway_stop uses the same serial writer and wins over queued working", { concurrency: false }, async () => {
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const { runtime, calls } = createHarness({
    transport: async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const pending = deferred();
      requests.push(pending);
      const response = await pending.promise;
      inFlight -= 1;
      return response;
    },
  });
  try {
    start(runtime, 23001, "run-stop");
    await waitUntil(() => calls.length === 1);
    const stopping = runtime.stop();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.length, 1);

    requests[0].resolve(successfulResponse());
    await waitUntil(() => calls.length === 2);
    assert.deepEqual(icons(calls), ["working", "timeout"]);
    requests[1].resolve(successfulResponse());
    await stopping;
    assert.equal(maxInFlight, 1);
  } finally {
    delete globalThis.__telegramTopicStatusPostJson;
    delete globalThis.__telegramTopicStatusSleep;
  }
});
