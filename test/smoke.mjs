import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import plugin from "../index.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "topic-status-hooks-"));
const tokenFile = path.join(dir, "token.txt");
fs.writeFileSync(tokenFile, "123456:test-token\n", "utf8");

const calls = [];
globalThis.__telegramTopicStatusPostJson = async (url, body) => {
  calls.push({ url, body });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body: { ok: true },
  };
};

const hooks = new Map();
const api = {
  pluginConfig: {
    botTokenFile: tokenFile,
    timeoutMs: 50,
    logLevel: "off",
    icons: {
      working: "working",
      idle: "idle",
      error: "error",
      timeout: "timeout",
    },
  },
  config: { channels: { telegram: { tokenFile } } },
  logger: console,
  on(name, handler) {
    hooks.set(name, handler);
  },
};

plugin.register(api);

hooks.get("message_received")(
  {
    from: "telegram:5966150195",
    threadId: 9847,
    sessionKey: "agent:main:telegram:direct:5966150195:thread:5966150195:9847",
    senderId: "5966150195",
    metadata: {
      originatingTo: "telegram:5966150195",
      threadId: 9847,
    },
  },
  {
    channelId: "telegram",
    accountId: "default",
    conversationId: "telegram:5966150195",
    sessionKey: "agent:main:telegram:direct:5966150195:thread:5966150195:9847",
    senderId: "5966150195",
  },
);

await new Promise((resolve) => setImmediate(resolve));
assert.equal(calls.length, 1);
assert.equal(calls[0].body.chat_id, "5966150195");
assert.equal(calls[0].body.message_thread_id, 9847);
assert.equal(calls[0].body.icon_custom_emoji_id, "working");

const pass = hooks.get("before_agent_run")(
  { prompt: "ping", senderId: "5966150195" },
  {
    channelId: "5966150195:thread:5966150195:9847",
    messageProvider: "telegram",
    accountId: "default",
    sessionKey: "agent:main:telegram:direct:5966150195:thread:5966150195:9847",
    runId: "run-1",
  },
);
assert.deepEqual(pass, { outcome: "pass" });

hooks.get("message_sent")(
  { to: "5966150195", content: "trabajando", success: true },
  { channelId: "telegram", accountId: "default", conversationId: "5966150195" },
);

hooks.get("agent_end")(
  { runId: "run-1", messages: [], success: true },
  {
    channelId: "5966150195:thread:5966150195:9847",
    messageProvider: "telegram",
    accountId: "default",
    sessionKey: "agent:main:telegram:direct:5966150195:thread:5966150195:9847",
    runId: "run-1",
  },
);

await new Promise((resolve) => setImmediate(resolve));
assert.equal(calls.length, 3);
assert.equal(calls.at(-1).body.icon_custom_emoji_id, "idle");

hooks.get("message_received")(
  {
    from: "telegram:5966150195",
    sessionKey: "agent:main:telegram:direct:5966150195:thread:5966150195:10002",
    senderId: "5966150195",
  },
  {
    channelId: "telegram",
    accountId: "default",
    conversationId: "telegram:5966150195:topic:10002",
    sessionKey: "agent:main:telegram:direct:5966150195:thread:5966150195:10002",
    senderId: "5966150195",
  },
);

hooks.get("agent_end")(
  { messages: [], success: true },
  {
    channelId: "5966150195:thread:5966150195:10002",
    messageProvider: "telegram",
    accountId: "default",
    sessionKey: "agent:main:telegram:direct:5966150195:thread:5966150195:10002",
  },
);

await new Promise((resolve) => setImmediate(resolve));
assert.equal(calls.length, 5);
assert.equal(calls.at(-1).body.message_thread_id, 10002);
assert.equal(calls.at(-1).body.icon_custom_emoji_id, "idle");

hooks.get("gateway_stop")({}, {});

const isolatedHooks = new Map();
plugin.register({
  ...api,
  on(name, handler) {
    isolatedHooks.set(name, handler);
  },
});

isolatedHooks.get("agent_end")(
  { messages: [], success: true },
  {
    channelId: "5966150195:thread:5966150195:20003",
    messageProvider: "telegram",
    accountId: "default",
    sessionKey: "agent:main:telegram:direct:5966150195:thread:5966150195:20003",
  },
);

await new Promise((resolve) => setImmediate(resolve));
assert.equal(calls.length, 6);
assert.equal(calls.at(-1).body.message_thread_id, 20003);
assert.equal(calls.at(-1).body.icon_custom_emoji_id, "idle");

isolatedHooks.get("gateway_stop")({}, {});

const timeoutHooks = new Map();
plugin.register({
  ...api,
  pluginConfig: {
    ...api.pluginConfig,
    timeoutMs: 1000,
    timeoutState: "timeout",
  },
  on(name, handler) {
    timeoutHooks.set(name, handler);
  },
});

timeoutHooks.get("message_received")(
  {
    from: "telegram:5966150195",
    threadId: 30004,
    sessionKey: "agent:main:telegram:direct:5966150195:thread:5966150195:30004",
    senderId: "5966150195",
  },
  {
    channelId: "telegram",
    accountId: "default",
    conversationId: "telegram:5966150195",
    sessionKey: "agent:main:telegram:direct:5966150195:thread:5966150195:30004",
    senderId: "5966150195",
  },
);

await new Promise((resolve) => setTimeout(resolve, 1100));
assert.equal(calls.length, 8);
assert.equal(calls.at(-2).body.icon_custom_emoji_id, "working");
assert.equal(calls.at(-1).body.message_thread_id, 30004);
assert.equal(calls.at(-1).body.icon_custom_emoji_id, "timeout");

timeoutHooks.get("gateway_stop")({}, {});
delete globalThis.__telegramTopicStatusPostJson;
fs.rmSync(dir, { recursive: true, force: true });
