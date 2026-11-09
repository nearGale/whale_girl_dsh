'use strict';

/**
 * 微信 chat ↔ Agent session 绑定，以及 prompt 编排。
 * 落盘 data/agent-bindings.json；正文不进日志。
 */
const fs = require('node:fs');
const path = require('node:path');
const { describeError } = require('../infra/errors');

function bindingsPath(root) {
  return path.join(root, 'data', 'agent-bindings.json');
}

function loadMap(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' && raw.bindings && typeof raw.bindings === 'object'
      ? raw.bindings
      : {};
  } catch {
    return {};
  }
}

function saveMap(file, bindings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, bindings }, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function createAgentBridge({ root, backend, logger = null } = {}) {
  if (!root) throw new Error('agentBridge 需要 root');
  const file = bindingsPath(root);
  let bindings = loadMap(file);

  function persist() {
    saveMap(file, bindings);
  }

  function getBinding(chatKey) {
    const key = String(chatKey || '');
    const row = bindings[key];
    return row && row.sessionId ? { ...row } : null;
  }

  function listBindings() {
    return { ...bindings };
  }

  function bind(chatKey, { backend: backendId = 'harness', sessionId, sessionTitle = '' } = {}) {
    const key = String(chatKey || '');
    const sid = String(sessionId || '').trim();
    if (!key || !sid) throw new Error('bind 需要 chatKey 与 sessionId');
    bindings[key] = {
      backend: String(backendId || 'harness'),
      sessionId: sid,
      sessionTitle: String(sessionTitle || ''),
      boundAt: Date.now(),
    };
    persist();
    return getBinding(key);
  }

  function unbind(chatKey) {
    const key = String(chatKey || '');
    if (!bindings[key]) return false;
    delete bindings[key];
    persist();
    return true;
  }

  async function resolveSession(selector) {
    const q = String(selector || '').trim();
    if (!q) return null;
    const sessions = await backend.listSessions();
    const list = Array.isArray(sessions) ? sessions : [];
    const byId = list.find((s) => s && String(s.id) === q);
    if (byId) return byId;
    const asNum = Number(q);
    if (Number.isInteger(asNum) && asNum >= 1 && asNum <= list.length) return list[asNum - 1];
    const lower = q.toLowerCase();
    const byTitle = list.filter((s) => s && String(s.title || '').toLowerCase().includes(lower));
    if (byTitle.length === 1) return byTitle[0];
    if (byTitle.length > 1) {
      const err = new Error(`标题「${q}」匹配到 ${byTitle.length} 个会话，请用 id 或序号`);
      err.code = 'AMBIGUOUS_SESSION';
      err.matches = byTitle;
      throw err;
    }
    return null;
  }

  async function statusText(chatKey) {
    const bound = getBinding(chatKey);
    let ping = { ok: false };
    try {
      ping = await backend.ping();
    } catch (err) {
      ping = { ok: false, error: describeError(err) };
    }
    const online = ping && ping.ok ? `在线${ping.baseUrl ? '（' + ping.baseUrl + '）' : ''}` : '离线或未认证';
    if (!bound) {
      return `Harness：${online}；本会话未绑定。/dsh list 查看，/dsh use <id> 绑定，/dsh new <目录> 新建（读写本工作区）。`;
    }
    return `Harness：${online}；已绑定 ${bound.sessionTitle || bound.sessionId}（${bound.sessionId}）。/dsh off 解除。`;
  }

  async function listText() {
    const sessions = await backend.listSessions();
    const list = Array.isArray(sessions) ? sessions : [];
    if (!list.length) {
      return 'Harness 里暂时没有会话。可用 /dsh new <已存在的本地目录> 新建（读写本工作区），或先在 Harness 窗口开一个。';
    }
    const lines = list.slice(0, 20).map((s, i) => {
      const run = s.running ? ' · 运行中' : '';
      return `${i + 1}. ${s.title || '(无标题)'} — ${s.id}${run}`;
    });
    return [
      'Harness 会话：',
      ...lines,
      '绑定：/dsh use <序号或id或标题关键字>；新建：/dsh new <本地目录>',
    ].join('\n');
  }

  async function promptForChat(chatKey, content, { signal } = {}) {
    const bound = getBinding(chatKey);
    if (!bound) {
      const err = new Error('本会话未绑定 Harness');
      err.code = 'NOT_BOUND';
      throw err;
    }
    logger && logger.info(`[agent] prompt chat=${chatKey} session=${bound.sessionId} chars=${String(content || '').length}`);
    const result = await backend.prompt({
      sessionId: bound.sessionId,
      content: String(content || ''),
      signal,
    });
    if (result && result.pendingApproval) {
      return {
        text: 'Harness 在等你批准操作，去 DeepSeek Harness 窗口点一下，然后再说一声继续。',
        pendingApproval: true,
      };
    }
    const text = String((result && result.text) || '').trim();
    return { text: text || '（Harness 这轮没有文字回复）', pendingApproval: false };
  }

  /** 新建工作区会话并绑定当前 chat；权限默认 workspace-write */
  async function createAndBind(chatKey, workspacePath, { permission = 'workspace-write' } = {}) {
    if (typeof backend.createWorkspaceSession !== 'function') {
      const err = new Error('当前后端不支持创建工作区');
      err.code = 'CREATE_UNSUPPORTED';
      throw err;
    }
    const created = await backend.createWorkspaceSession({
      workspacePath,
      permission,
    });
    bind(chatKey, {
      backend: backend.id || 'harness',
      sessionId: created.sessionId,
      sessionTitle: created.title || '',
    });
    logger && logger.info(
      `[agent] new workspace chat=${chatKey} session=${created.sessionId} perm=${created.permission}`
    );
    return created;
  }

  return {
    backend,
    getBinding,
    listBindings,
    bind,
    unbind,
    resolveSession,
    statusText,
    listText,
    promptForChat,
    createAndBind,
  };
}

module.exports = { createAgentBridge, bindingsPath };
