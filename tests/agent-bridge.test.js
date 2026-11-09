'use strict';

/**
 * Harness Agent Bridge：绑定存储、Cursor stub、/dsh 命令与流水线短路。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const { createCursorStub } = require('../src/adapters/agentBackend');
const { createAgentBridge } = require('../src/services/agentBridge');
const { extractCommand } = require('../src/core/commands');
const { Bot } = require('../src/pipeline/chat');
const { Store } = require('../src/memory/store');
const { DEFAULT_CONFIG } = require('../src/infra/config');

function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'whale-agent-'));
}

test('Cursor stub 标明未实现', async () => {
  const stub = createCursorStub();
  assert.equal(stub.id, 'cursor');
  await assert.rejects(() => stub.listSessions(), /未实现|二期|Cursor/i);
  await assert.rejects(() => stub.prompt({ sessionId: 'x', content: 'hi' }), /未实现|二期|Cursor/i);
});

test('绑定 get/set/clear 按 chatId 隔离并落盘', () => {
  const root = tmpRoot();
  try {
    const bridge = createAgentBridge({ root, backend: createCursorStub() });
    assert.equal(bridge.getBinding('chat-a'), null);
    bridge.bind('chat-a', { backend: 'harness', sessionId: 's1', sessionTitle: '工作区' });
    bridge.bind('chat-b', { backend: 'harness', sessionId: 's2', sessionTitle: '另一' });
    assert.equal(bridge.getBinding('chat-a').sessionId, 's1');
    assert.equal(bridge.getBinding('chat-b').sessionId, 's2');
    bridge.unbind('chat-a');
    assert.equal(bridge.getBinding('chat-a'), null);
    assert.equal(bridge.getBinding('chat-b').sessionId, 's2');

    const again = createAgentBridge({ root, backend: createCursorStub() });
    assert.equal(again.getBinding('chat-b').sessionId, 's2');
  } finally {
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('extractCommand 识别 /dsh 子命令', () => {
  assert.deepEqual(extractCommand('/dsh').type, 'dsh');
  assert.equal(extractCommand('/dsh').arg, '');
  assert.equal(extractCommand('/dsh status').arg, 'status');
  assert.equal(extractCommand('/dsh list').arg, 'list');
  assert.equal(extractCommand('/dsh use s1').arg, 'use s1');
  assert.equal(extractCommand('/dsh off').arg, 'off');
  assert.equal(extractCommand('/dsh cancel').arg, 'cancel');
  assert.equal(extractCommand('／dsh list').type, 'dsh');
});

function makeBotWithBridge({ agentBridge, ownerWxid = 'wxid_owner' } = {}) {
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.persona.master = { names: ['主人'], wxids: [ownerWxid] };
  const dir = tmpRoot();
  config.paths = { ...(config.paths || {}), storeFile: path.join(dir, 'store.json'), dataDir: dir };
  const store = new Store({ file: config.paths.storeFile, limits: config.memory });
  let completeCalls = 0;
  const llm = {
    isMock: false,
    model: 'test-model',
    providerLabel: 'test',
    reload() {},
    async complete() {
      completeCalls += 1;
      return '普通人设回复';
    },
  };
  const bot = new Bot({
    config,
    store,
    llm,
    logger: null,
    mockChunkDelayMs: 0,
    rng: () => 0.9,
    agentBridge,
  });
  return {
    bot,
    dir,
    completeCalls: () => completeCalls,
    cleanup() {
      store.close();
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
    },
  };
}

test('非主人 /dsh use 不能绑定', async () => {
  const root = tmpRoot();
  const prompts = [];
  const backend = {
    id: 'harness',
    async listSessions() {
      return [{ id: 's1', title: '会话一', running: false }];
    },
    async prompt(args) {
      prompts.push(args);
      return { text: 'agent说', pendingApproval: false };
    },
    async cancel() {},
    async ping() { return { ok: true, baseUrl: 'http://127.0.0.1:9' }; },
  };
  const agentBridge = createAgentBridge({ root, backend });
  const { bot, cleanup } = makeBotWithBridge({ agentBridge });
  try {
    const out = await bot.handle({
      platform: 'wechat',
      chatId: 'p-stranger',
      chatType: 'private',
      senderId: 'wxid_other',
      senderName: '路人',
      text: '/dsh use s1',
    });
    assert.equal(agentBridge.getBinding('wechat:u:p-stranger'), null);
    const any = Object.keys(agentBridge.listBindings()).length;
    assert.equal(any, 0);
    assert.match(String(out && (out.reply || out.text) || ''), /主人|只有主人|不能/);
  } finally {
    cleanup();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('主人绑定后消息走 backend.prompt，不调 llm.complete', async () => {
  const root = tmpRoot();
  const prompts = [];
  const backend = {
    id: 'harness',
    async listSessions() {
      return [{ id: 's1', title: '会话一', running: false }];
    },
    async prompt(args) {
      prompts.push(args);
      return { text: '来自Harness', pendingApproval: false };
    },
    async cancel() {},
    async ping() { return { ok: true, baseUrl: 'http://127.0.0.1:9' }; },
  };
  const agentBridge = createAgentBridge({ root, backend });
  const { bot, completeCalls, cleanup } = makeBotWithBridge({ agentBridge });
  try {
    const bind = await bot.handle({
      platform: 'wechat',
      chatId: 'p-owner',
      chatType: 'private',
      senderId: 'wxid_owner',
      senderName: '主人',
      text: '/dsh use s1',
    });
    assert.match(String(bind && (bind.reply || bind.text) || ''), /绑定|已|s1|会话/);
    const key = 'wechat:u:p-owner';
    assert.ok(agentBridge.getBinding(key), '应写入绑定');

    // 只统计「绑定之后」的模型调用；绑定命令本身不应触发 LLM
    const before = completeCalls();
    prompts.length = 0;
    const reply = await bot.handle({
      platform: 'wechat',
      chatId: 'p-owner',
      chatType: 'private',
      senderId: 'wxid_owner',
      senderName: '主人',
      text: '帮我看看这段代码',
    });
    assert.equal(completeCalls() - before, 0);
    assert.equal(prompts.length, 1);
    assert.equal(prompts[0].sessionId, 's1');
    assert.match(String(reply && (reply.reply || reply.text) || ''), /来自Harness/);
  } finally {
    cleanup();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('绑定后非主人消息不进 Harness', async () => {
  const root = tmpRoot();
  const prompts = [];
  const backend = {
    id: 'harness',
    async listSessions() {
      return [{ id: 's1', title: '会话一', running: false }];
    },
    async prompt(args) {
      prompts.push(args);
      return { text: '不该到这', pendingApproval: false };
    },
    async cancel() {},
    async ping() { return { ok: true }; },
  };
  const agentBridge = createAgentBridge({ root, backend });
  agentBridge.bind('wechat:g:g1', { backend: 'harness', sessionId: 's1', sessionTitle: '会话一' });
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.persona.master = { names: ['主人'], wxids: ['wxid_owner'] };
  config.group.requireAt = true;
  const dir = tmpRoot();
  const store = new Store({ file: path.join(dir, 'store.json'), limits: config.memory });
  let completeCalls = 0;
  const llm = {
    isMock: false,
    model: 'm',
    providerLabel: 't',
    reload() {},
    async complete({ system }) {
      if (/检索路由器/.test(system)) return '{"need":false}';
      completeCalls += 1;
      return '群里普通人设';
    },
  };
  const bot = new Bot({
    config, store, llm, logger: null, mockChunkDelayMs: 0, rng: () => 0.9, agentBridge,
  });
  try {
    // 先用主人口令绑定到真实 key（handle 会规范化 chat key）
    await bot.handle({
      platform: 'wechat', chatId: 'g1', chatType: 'group',
      senderId: 'wxid_owner', senderName: '主人', text: '/dsh use s1', atMe: true, chatTitle: '群',
    });
    prompts.length = 0;
    completeCalls = 0;
    const out = await bot.handle({
      platform: 'wechat', chatId: 'g1', chatType: 'group',
      senderId: 'wxid_other', senderName: '路人', text: '你好', atMe: true, chatTitle: '群',
    });
    assert.equal(prompts.length, 0);
    assert.ok(completeCalls >= 1);
    assert.match(String(out && (out.reply || out.text) || ''), /普通人设/);
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('Harness 适配器：401 变成友好错误', async () => {
  const { createHarnessBackend } = require('../src/adapters/harness');
  const server = http.createServer((req, res) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end('{"error":"unauthorized"}');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const backend = createHarnessBackend({
      baseUrl: `http://127.0.0.1:${port}`,
      authSecret: 'dGVzdA', // base64url "test"
    });
    await assert.rejects(() => backend.listSessions(), /未登录|凭证|401|Harness/i);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('/dsh new 省略路径时提示用法，不调后端', async () => {
  const root = tmpRoot();
  let createCalls = 0;
  const backend = {
    id: 'harness',
    async listSessions() { return []; },
    async prompt() { return { text: '' }; },
    async cancel() {},
    async ping() { return { ok: true }; },
    async createWorkspaceSession() {
      createCalls += 1;
      return { sessionId: 's-new', workspaceId: 'w1', path: 'x', permission: 'workspace-write', title: '' };
    },
  };
  const agentBridge = createAgentBridge({ root, backend });
  const { bot, cleanup } = makeBotWithBridge({ agentBridge });
  try {
    const out = await bot.handle({
      platform: 'wechat', chatId: 'p-owner', chatType: 'private',
      senderId: 'wxid_owner', senderName: '主人', text: '/dsh new',
    });
    assert.equal(createCalls, 0);
    assert.match(String(out && (out.reply || out.text) || ''), /用法|路径/);
  } finally {
    cleanup();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('/dsh new 创建工作区会话并绑定，权限为 workspace-write', async () => {
  const root = tmpRoot();
  const wsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-ws-'));
  const creates = [];
  const backend = {
    id: 'harness',
    async listSessions() { return []; },
    async prompt() { return { text: '' }; },
    async cancel() {},
    async ping() { return { ok: true }; },
    async createWorkspaceSession(args) {
      creates.push(args);
      return {
        sessionId: 'sess-new-1',
        workspaceId: 'ws-1',
        path: args.workspacePath,
        permission: args.permission || 'workspace-write',
        title: '新建会话',
      };
    },
  };
  const agentBridge = createAgentBridge({ root, backend });
  const { bot, cleanup } = makeBotWithBridge({ agentBridge });
  try {
    const out = await bot.handle({
      platform: 'wechat', chatId: 'p-owner', chatType: 'private',
      senderId: 'wxid_owner', senderName: '主人',
      text: '/dsh new ' + wsDir,
    });
    assert.equal(creates.length, 1);
    assert.equal(creates[0].permission, 'workspace-write');
    assert.ok(String(creates[0].workspacePath).includes(path.basename(wsDir)) || creates[0].workspacePath === wsDir);
    assert.ok(agentBridge.getBinding('wechat:u:p-owner'));
    assert.equal(agentBridge.getBinding('wechat:u:p-owner').sessionId, 'sess-new-1');
    assert.match(String(out && (out.reply || out.text) || ''), /绑定|workspace-write|sess-new-1|读写/);
  } finally {
    cleanup();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
    fs.rmSync(wsDir, { recursive: true, force: true, maxRetries: 6, retryDelay: 60 });
  }
});

test('createWorkspaceSession：路径不存在时报错', async () => {
  const { createHarnessBackend } = require('../src/adapters/harness');
  const backend = createHarnessBackend({
    baseUrl: 'http://127.0.0.1:9',
    authSecret: 'dGVzdA',
  });
  await assert.rejects(
    () => backend.createWorkspaceSession({ workspacePath: path.join(os.tmpdir(), 'no-such-whale-ws-' + Date.now()) }),
    /不存在|不是目录/
  );
});
