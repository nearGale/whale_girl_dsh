'use strict';

// 启动器未运行内核时也能写配置：复用与 HTTP 路由相同的 patch/save，不启聊天、不监听端口。
const { loadConfig } = require('../infra/config');
const { DeepSeekClient } = require('../llm/client');
const { applyPersonaPatch } = require('./persona');
const { applySettings } = require('./settings');
const { applyConfigPatch, publicConfig } = require('../infra/configPatch');
const { statusPayload } = require('./status');
const personaStore = require('../persona/store');
const presets = require('../persona/presets');
const features = require('../infra/features');
const { checkPersonaTokens, PERSONA_MAX_TOKENS } = require('../persona/tokenCheck');

function silentLogger() {
  return { info() {}, warn() {}, error() {}, debug() {} };
}

function makeRuntime(root, env = process.env) {
  const config = loadConfig({ root, env });
  personaStore.apply(config, personaStore.load(config));
  const logger = silentLogger();
  config.__logger = logger;
  return {
    config,
    llm: new DeepSeekClient({ config }),
    logger,
    version: 'offline',
    startedAt: Date.now(),
    store: {
      summary: () => ({ sessions: 0, messages: 0, notes: 0, totalMessages: 0, totalReplies: 0 }),
    },
    gateways: new Map(),
    bot: null,
  };
}

async function writeOp(runtime, path, body) {
  const payload = body && typeof body === 'object' ? body : {};
  if (path === '/api/persona') return applyPersonaPatch(runtime, payload);
  if (path === '/api/settings') {
    return applySettings(runtime, payload);
  }
  if (path === '/api/config') {
    const out = applyConfigPatch(runtime, payload.patch);
    const pub = publicConfig(runtime.config);
    return {
      ok: true,
      changed: out.changed,
      clearedSettings: out.cleared,
      config: pub.config,
      secrets: pub.secrets,
      status: statusPayload(runtime),
    };
  }
  if (path === '/api/features') {
    const key = String(payload.key || '').trim();
    const entry = features.REGISTRY.find((f) => f.key === key);
    if (!entry) return { ok: false, error: '没有这个开关：' + key };
    const on = features.toBool(payload.value, false);
    applyConfigPatch(runtime, { [entry.path]: on });
    return { ok: true, key, value: on, features: features.list(runtime.config) };
  }
  if (path === '/api/persona/preset') {
    const preset = presets.load(runtime.config, payload.id);
    if (!preset) return { ok: false, error: '没有这个人设预设' };
    const patch = presets.toPatch(preset);
    if (!patch) return { ok: false, error: '这个人设预设是空的' };
    patch.sourcePreset = preset.id;
    const tokenCheck = await checkPersonaTokens(runtime, patch);
    if (tokenCheck.overLimit) {
      return {
        ok: false,
        error: `这个人设预设太长：约 ${tokenCheck.tokens} token，超过上限 ${PERSONA_MAX_TOKENS}。`,
        tokenCheck,
      };
    }
    personaStore.save(runtime.config, patch);
    return {
      ok: true,
      applied: { id: preset.id, version: preset.version || '', name: preset.name || '' },
      persona: personaStore.summary(runtime.config),
      tokenCheck,
    };
  }
  return { ok: false, error: '此功能需要启动内核。' };
}

async function writeOps(root, ops, env = process.env) {
  const list = Array.isArray(ops) ? ops : [];
  if (!list.length) return { ok: false, error: '没有要写入的操作' };
  const runtime = makeRuntime(root, env);
  const results = [];
  for (const op of list) {
    const path = String((op && op.path) || '');
    const result = await writeOp(runtime, path, op && op.body);
    results.push({ path, result });
    if (!result || result.ok === false) {
      return { ok: false, results, error: (result && result.error) || '写入失败' };
    }
  }
  return { ok: true, results };
}

async function main() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf8').trim();
  let input;
  try { input = raw ? JSON.parse(raw) : {}; }
  catch {
    process.stderr.write('写入请求不是合法 JSON。');
    process.exitCode = 1;
    return;
  }
  const ops = Array.isArray(input.ops)
    ? input.ops
    : (input.path ? [{ path: input.path, body: input.body }] : []);
  try {
    const out = await writeOps(process.cwd(), ops);
    process.stdout.write(JSON.stringify(out));
    if (!out.ok) process.exitCode = 1;
  } catch (err) {
    process.stderr.write(String((err && err.message) || err || '写入本地配置失败'));
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { writeOps, writeOp, makeRuntime };
