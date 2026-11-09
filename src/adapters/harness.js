'use strict';

/**
 * DeepSeek Harness 本机 Host 适配器：loopback HTTP /api RPC + browser-auth cookie。
 * 完成态优先走 /api/remote.mux（有 WebSocket 时）；否则轮询 session/list 后尽力取文。
 */
const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { URL } = require('node:url');
const net = require('node:net');

function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(s) {
  const padded = String(s).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded + '='.repeat((4 - (padded.length % 4)) % 4), 'base64');
}

function sha256B64Url(text) {
  return b64url(crypto.createHash('sha256').update(String(text), 'utf8').digest());
}

function hmacB64Url(secretBytes, message) {
  return b64url(crypto.createHmac('sha256', secretBytes).update(String(message), 'utf8').digest());
}

function readAuthSecret({ authSecret, credentialsFile } = {}) {
  if (authSecret) return b64urlDecode(String(authSecret).trim());
  if (process.env.DSH_AUTH_SECRET) return b64urlDecode(String(process.env.DSH_AUTH_SECRET).trim());
  const file = credentialsFile || path.join(os.homedir(), '.dsh', '.credentials.yaml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch {
    const err = new Error('找不到 Harness 凭证（~/.dsh/.credentials.yaml），请先打开一次 DeepSeek Harness');
    err.code = 'HARNESS_NO_CREDENTIAL';
    throw err;
  }
  const lines = text.split(/\r?\n/);
  const keyLine = lines.findIndex((l) => l.trimEnd() === '  client-connection/browser-session:');
  if (keyLine < 0) {
    const err = new Error('凭证文件里没有 browser-session，请先打开一次 DeepSeek Harness');
    err.code = 'HARNESS_NO_CREDENTIAL';
    throw err;
  }
  for (let i = keyLine + 1; i < Math.min(lines.length, keyLine + 20); i++) {
    const m = /^\s+secret:\s*(\S+)\s*$/.exec(lines[i]);
    if (m) return b64urlDecode(m[1]);
  }
  const err = new Error('凭证文件缺少 secret 字段');
  err.code = 'HARNESS_NO_CREDENTIAL';
  throw err;
}

function mintCookie(authority, secretBytes) {
  const issuedAt = Date.now() - 1000;
  const expiresAt = issuedAt + 60 * 60 * 1000;
  const body = b64url(Buffer.from(JSON.stringify({
    version: 1, authority, issuedAt, expiresAt,
  }), 'utf8'));
  const sig = hmacB64Url(secretBytes, body);
  const name = `dsh-auth-${sha256B64Url(authority)}`;
  return `${name}=v1.${body}.${sig}`;
}

function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
}

function httpRequest(urlString, { method = 'GET', headers = {}, body = null, timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlString);
    if (!isLoopbackHost(u.hostname)) {
      reject(Object.assign(new Error('Harness 只允许连接本机 loopback'), { code: 'HARNESS_NOT_LOOPBACK' }));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          headers: res.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(Object.assign(new Error('Harness 请求超时'), { code: 'HARNESS_TIMEOUT' }));
    });
    if (body != null) req.write(body);
    req.end();
  });
}

function friendlyAuthError(status) {
  const err = new Error(
    status === 401 || status === 403
      ? 'Harness 未登录或凭证过期（' + status + '），打开 DeepSeek Harness 再试'
      : 'Harness 返回 HTTP ' + status
  );
  err.code = 'HARNESS_AUTH';
  err.status = status;
  return err;
}

function encodeWsTextFrame(obj) {
  const payload = Buffer.from(JSON.stringify(obj), 'utf8');
  const maskKey = crypto.randomBytes(4);
  const len = payload.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, 0x80 | len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 0x80 | 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 0x80 | 127;
    header.writeUInt32BE(Math.floor(len / 2 ** 32), 2);
    header.writeUInt32BE(len >>> 0, 6);
  }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ maskKey[i % 4];
  return Buffer.concat([header, maskKey, masked]);
}

/** 极简 RFC6455 客户端（仅文本帧），给 remote.mux 用 */
function wsConnect(wsUrl, { cookie, timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(wsUrl);
    if (!isLoopbackHost(u.hostname)) {
      reject(Object.assign(new Error('Harness mux 只允许本机'), { code: 'HARNESS_NOT_LOOPBACK' }));
      return;
    }
    const key = crypto.randomBytes(16).toString('base64');
    const port = Number(u.port) || 80;
    const socket = net.connect({ host: u.hostname, port });
    let settled = false;
    let buf = Buffer.alloc(0);
    let opened = false;
    const handlers = { message: null };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* */ }
      reject(err);
    };
    const timer = setTimeout(
      () => fail(Object.assign(new Error('mux 连接超时'), { code: 'HARNESS_TIMEOUT' })),
      timeoutMs
    );
    socket.once('error', fail);
    socket.once('connect', () => {
      const pathAndQuery = u.pathname + (u.search || '');
      const lines = [
        `GET ${pathAndQuery} HTTP/1.1`,
        `Host: ${u.hostname}:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
      ];
      if (cookie) lines.push(`Cookie: ${cookie}`);
      lines.push('', '');
      socket.write(lines.join('\r\n'));
    });
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!opened) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.slice(0, idx).toString('utf8');
        buf = buf.slice(idx + 4);
        if (!/^HTTP\/1\.\d 101/i.test(head)) {
          fail(Object.assign(new Error('mux 握手失败'), { code: 'HARNESS_MUX', detail: head.slice(0, 120) }));
          return;
        }
        opened = true;
        clearTimeout(timer);
        settled = true;
        resolve({
          send(obj) { socket.write(encodeWsTextFrame(obj)); },
          onMessage(fn) { handlers.message = fn; },
          close() { try { socket.end(); } catch { /* */ } },
        });
      }
      while (opened && buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        const b1 = buf[1];
        const masked = (b1 & 0x80) !== 0;
        let len = b1 & 0x7f;
        let offset = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          offset = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readUInt32BE(2)) * 2 ** 32 + buf.readUInt32BE(6);
          offset = 10;
        }
        const maskLen = masked ? 4 : 0;
        if (buf.length < offset + maskLen + len) return;
        let payload = buf.slice(offset + maskLen, offset + maskLen + len);
        if (masked) {
          const maskKey = buf.slice(offset, offset + 4);
          const out = Buffer.alloc(len);
          for (let i = 0; i < len; i++) out[i] = payload[i] ^ maskKey[i % 4];
          payload = out;
        }
        buf = buf.slice(offset + maskLen + len);
        if (opcode === 0x8) {
          try { socket.end(); } catch { /* */ }
          return;
        }
        if (opcode === 0x1 && handlers.message) {
          try { handlers.message(payload.toString('utf8')); } catch { /* */ }
        }
      }
    });
  });
}

function textOfMessage(message) {
  const parts = [];
  for (const block of (message && message.content) || []) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  if (!parts.length && typeof (message && message.text) === 'string') parts.push(message.text);
  return parts.join('\n').trim();
}

function finalAssistantText(history) {
  const events = (history && history.events) || [];
  for (let i = events.length - 1; i >= 0; i--) {
    const entry = events[i];
    const ev = entry && entry.event ? entry.event : entry;
    const type = ev && ev.type;
    if (type === 'assistant/message') {
      const msg = (ev.data && ev.data.message) || ev.data || ev.message;
      const t = textOfMessage(msg);
      if (t) return t;
    }
  }
  return '';
}

function pendingApproval(history) {
  const events = (history && history.events) || [];
  for (let i = events.length - 1; i >= 0; i--) {
    const entry = events[i];
    const ev = entry && entry.event ? entry.event : entry;
    if (ev && ev.type === 'approval/asked') return ev.data || {};
  }
  return null;
}

function createHarnessBackend(opts = {}) {
  const rpcTimeoutMs = Number(opts.rpcTimeoutMs) || 30000;
  const pollMs = Number(opts.pollMs) || 1000;
  const turnTimeoutMs = Number(opts.turnTimeoutMs) || 10 * 60 * 1000;
  let baseUrl = String(opts.baseUrl || process.env.DSH_URL || '').replace(/\/+$/, '');
  let secretBytes = null;

  function authorityOf(url) {
    const u = new URL(url);
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `${u.hostname}:${port}`;
  }

  function ensureSecret() {
    if (!secretBytes) secretBytes = readAuthSecret(opts);
    return secretBytes;
  }

  async function rpc(endpoint, args) {
    if (!baseUrl) {
      const err = new Error('未配置 Harness 地址，请在设置里填 harness.baseUrl 或先启动 DeepSeek Harness');
      err.code = 'HARNESS_NO_URL';
      throw err;
    }
    const rpcId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    const cookie = mintCookie(authorityOf(baseUrl), ensureSecret());
    const res = await httpRequest(`${baseUrl}/api/${endpoint}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie,
        'content-length': Buffer.byteLength(
          JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: args || {} } }),
          'utf8'
        ),
      },
      body: JSON.stringify({ type: 'client-request', rpcId, method: endpoint, payload: { args: args || {} } }),
      timeoutMs: rpcTimeoutMs,
    });
    if (res.status === 401 || res.status === 403) throw friendlyAuthError(res.status);
    if (res.status === 404) {
      const err = new Error(`Harness 无此接口：${endpoint}`);
      err.code = 'HARNESS_NO_METHOD';
      err.status = 404;
      throw err;
    }
    if (res.status < 200 || res.status >= 300) {
      const err = new Error(`Harness HTTP ${res.status}`);
      err.code = 'HARNESS_HTTP';
      err.status = res.status;
      throw err;
    }
    let full;
    try { full = JSON.parse(res.body); } catch {
      const err = new Error('Harness 返回了无法解析的 JSON');
      err.code = 'HARNESS_BAD_JSON';
      throw err;
    }
    if (!full || full.type !== 'server-response' || full.rpcId !== rpcId || !full.result) {
      const err = new Error('Harness RPC 响应格式不对');
      err.code = 'HARNESS_BAD_RPC';
      throw err;
    }
    if (!full.result.ok) {
      const e = full.result.error || {};
      const err = new Error(`${endpoint} 失败：${e.code || 'unknown'}${e.message ? ' ' + e.message : ''}`);
      err.code = e.code || 'HARNESS_RPC';
      throw err;
    }
    return full.result.value;
  }

  async function muxOpen(endpoint, args) {
    const cookie = mintCookie(authorityOf(baseUrl), ensureSecret());
    const wsUrl = baseUrl.replace(/^http/i, 'ws') + '/api/remote.mux';
    const ws = await wsConnect(wsUrl, { cookie, timeoutMs: rpcTimeoutMs });
    const streamId = 'whale-' + crypto.randomBytes(6).toString('hex');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        ws.close();
        reject(Object.assign(new Error(`${endpoint} 流超时`), { code: 'HARNESS_TIMEOUT' }));
      }, rpcTimeoutMs);
      ws.onMessage((raw) => {
        let m;
        try { m = JSON.parse(raw); } catch { return; }
        if (!m || m.streamId !== streamId) return;
        if (m.type === 'item') {
          clearTimeout(timer);
          try { ws.send({ type: 'cancel', streamId }); } catch { /* */ }
          ws.close();
          resolve(m.value);
        } else if (m.type === 'error') {
          clearTimeout(timer);
          ws.close();
          const err = m.error || {};
          reject(Object.assign(new Error(`${endpoint}：${err.code || 'error'}`), { code: err.code || 'HARNESS_MUX' }));
        } else if (m.type === 'end') {
          clearTimeout(timer);
          ws.close();
          reject(Object.assign(new Error(`${endpoint} 流提前结束`), { code: 'HARNESS_MUX' }));
        }
      });
      ws.send({ type: 'open', streamId, endpoint, payload: { args: args || {} } });
    });
  }

  async function followSession(sessionId) {
    try {
      const snap = await muxOpen('session/follow', { request: { sessionId } });
      return snap || {};
    } catch (err) {
      if (err && err.code === 'HARNESS_MUX') return null;
      throw err;
    }
  }

  async function listSessions() {
    const value = await rpc('session/list', { _request: {} });
    const items = (value && (value.items || value.sessions || value)) || [];
    const list = Array.isArray(items) ? items : [];
    return list.map((s) => ({
      id: String(s.id || s.sessionId || ''),
      title: String(s.title || s.name || ''),
      running: Boolean(s.running),
    })).filter((s) => s.id);
  }

  async function cancel({ sessionId }) {
    await rpc('session/cancel', { request: { sessionId } });
  }

  /**
   * 在本机路径上确保工作区 + 新建 session，并固定权限为 workspace-write（读写本工作区）。
   * 不替用户 mkdir：路径必须已是存在的目录。
   */
  async function createWorkspaceSession({ workspacePath, permission = 'workspace-write' } = {}) {
    const raw = String(workspacePath || '').trim().replace(/^["']|["']$/g, '');
    if (!raw) {
      throw Object.assign(new Error('缺少工作区路径'), { code: 'HARNESS_BAD_PATH' });
    }
    const abs = path.resolve(raw);
    let st;
    try { st = fs.statSync(abs); } catch {
      throw Object.assign(new Error(`路径不存在或不是目录：${abs}`), { code: 'HARNESS_BAD_PATH' });
    }
    if (!st.isDirectory()) {
      throw Object.assign(new Error(`路径不存在或不是目录：${abs}`), { code: 'HARNESS_BAD_PATH' });
    }

    const createdWs = await rpc('workspace/create', { request: { path: abs } });
    const workspace = (createdWs && createdWs.workspace) || createdWs || {};
    const workspaceId = String(workspace.workspaceId || workspace.id || '').trim();
    if (!workspaceId) {
      throw Object.assign(new Error('Harness 创建工作区后没有返回 workspaceId'), { code: 'HARNESS_NO_WORKSPACE' });
    }

    const createdSess = await rpc('session/create', { request: { workspaceId } });
    const sessionId = String(
      (createdSess && (createdSess.sessionId || (createdSess.session && (createdSess.session.id || createdSess.session.sessionId))))
      || ''
    ).trim();
    if (!sessionId) {
      throw Object.assign(new Error('Harness 创建会话后没有返回 sessionId'), { code: 'HARNESS_NO_SESSION' });
    }

    const perm = String(permission || 'workspace-write').trim() || 'workspace-write';
    // 设权限失败不回滚 session：会话已在，用户仍可在 Harness 里改；这里把原因抛给上层提示
    const exec = await rpc('commands/execute', {
      agentId: sessionId,
      line: `/permission ${perm}`,
      submittedAttachments: [],
    });
    if (exec && exec.result && exec.result.kind && exec.result.kind !== 'success') {
      const detail = exec.result.text ? String(exec.result.text).slice(0, 80) : exec.result.kind;
      throw Object.assign(
        new Error(`无法把权限设成 ${perm}${detail ? '：' + detail : ''}`),
        { code: 'HARNESS_PERMISSION', sessionId, workspaceId }
      );
    }

    return {
      workspaceId,
      sessionId,
      path: abs,
      permission: perm,
      title: String(workspace.title || path.basename(abs) || ''),
    };
  }

  async function ping() {
    if (!baseUrl) return { ok: false, error: 'no_url' };
    try {
      ensureSecret();
      await rpc('session/list', { _request: {} });
      return { ok: true, baseUrl };
    } catch (err) {
      if (err && (err.status === 401 || err.code === 'HARNESS_AUTH')) {
        return { ok: false, error: 'auth', baseUrl };
      }
      return { ok: false, error: String(err && err.message || err), baseUrl };
    }
  }

  async function prompt({ sessionId, content, signal } = {}) {
    const sid = String(sessionId || '').trim();
    if (!sid) throw Object.assign(new Error('缺少 sessionId'), { code: 'HARNESS_NO_SESSION' });
    const requestId = crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex');
    await rpc('session/prompt', {
      request: {
        sessionId: sid,
        requestId,
        content: String(content || ''),
      },
    });
    const started = Date.now();
    while (Date.now() - started < turnTimeoutMs) {
      if (signal && signal.aborted) {
        try { await cancel({ sessionId: sid }); } catch { /* */ }
        throw Object.assign(new Error('已取消'), { code: 'aborted' });
      }
      let history = null;
      try { history = await followSession(sid); } catch { history = null; }
      if (history) {
        const approval = pendingApproval(history);
        if (approval) return { text: '', pendingApproval: true, approval };
      }
      const list = await listSessions();
      const row = list.find((s) => s.id === sid);
      const running = row ? row.running : false;
      if (!running) {
        if (!history) {
          try { history = await followSession(sid); } catch { history = null; }
        }
        const text = history ? finalAssistantText(history) : '';
        if (history && pendingApproval(history)) {
          return { text: '', pendingApproval: true };
        }
        return {
          text: text || 'Harness 回合已结束（未能读取正文，可在 Harness 窗口查看）',
          pendingApproval: false,
        };
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    try { await cancel({ sessionId: sid }); } catch { /* */ }
    throw Object.assign(new Error('Harness 这轮等待超时，已尝试取消'), { code: 'HARNESS_TURN_TIMEOUT' });
  }

  return {
    id: 'harness',
    setBaseUrl(url) { baseUrl = String(url || '').replace(/\/+$/, ''); },
    getBaseUrl() { return baseUrl; },
    listSessions,
    prompt,
    cancel,
    createWorkspaceSession,
    ping,
    rpc,
  };
}

module.exports = {
  createHarnessBackend,
  readAuthSecret,
  mintCookie,
  isLoopbackHost,
};
