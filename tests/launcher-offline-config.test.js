'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { readSnapshot } = require('../src/services/launcherSnapshot');
const { writeOps } = require('../src/services/launcherOfflineWrite');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'whale-offline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  fs.mkdirSync(path.join(root, 'data'));
  return root;
}

function write(root, file, value) { fs.writeFileSync(path.join(root, file), JSON.stringify(value)); }

test('未启动内核也能读取保存的人设、模型、高级选项及提醒，且不会改写或迁移数据', (t) => {
  const root = fixture(t);
  write(root, 'config.json', { persona: { name: '本地名字', ownerName: '本地称呼' },
    deepseek: { temperature: 1.15, apiKey: 'test-offline-key' },
    wechat: { quoteReply: true }, group: { requireAt: false } });
  write(root, 'data/settings.json', { provider: 'custom', model: 'test-model', baseUrl: 'http://127.0.0.1:19191/v1', temperature: 1.25 });
  write(root, 'data/persona.json', { personality: '保存的性格', privateMaxChars: 188 });
  const files = ['config.json', 'data/settings.json', 'data/persona.json'];
  const before = files.map((f) => fs.readFileSync(path.join(root, f), 'utf8'));
  const snapshot = readSnapshot(root, {});
  assert.equal(snapshot['/api/persona'].persona.name, '本地名字');
  assert.equal(snapshot['/api/persona'].persona.personality, '保存的性格');
  assert.equal(snapshot['/api/persona'].persona.privateMaxChars, 188);
  assert.equal(snapshot['/api/settings'].model, 'test-model');
  assert.equal(snapshot['/api/settings'].userName, '本地称呼');
  assert.equal(snapshot['/api/config'].config.wechat.quoteReply, true);
  assert.equal(snapshot['/api/config'].config.group.requireAt, false);
  assert.ok(snapshot['/api/features'].features.length > 0);
  assert.equal(snapshot['/api/reminders'].ok, true);
  assert.ok(!JSON.stringify(snapshot).includes('test-offline-key'));
  assert.deepEqual(files.map((f) => fs.readFileSync(path.join(root, f), 'utf8')), before);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data')).sort(), ['persona.json', 'settings.json']);
});

test('首次打开无配置文件时回填出厂默认值而不生成运行时数据', (t) => {
  const root = fixture(t);
  const snapshot = readSnapshot(root, {});
  assert.ok(snapshot['/api/persona'].persona.name.length > 0);
  assert.ok(snapshot['/api/settings'].providers.deepseek);
  assert.equal(snapshot['/api/settings'].mock, true, '未配 Key 的演示兜底保留');
  assert.deepEqual(fs.readdirSync(root).sort(), ['data']);
  assert.deepEqual(fs.readdirSync(path.join(root, 'data')), []);
});

test('短进程只输出有效配置 JSON，不启动聊天服务；配置变化后重读可见', (t) => {
  const root = fixture(t);
  const script = path.resolve(__dirname, '../src/services/launcherSnapshot.js');
  const read = () => JSON.parse(execFileSync(process.execPath, [script], { cwd: root, encoding: 'utf8', timeout: 5000 }));
  write(root, 'config.json', { persona: { name: '第一次打开' } });
  assert.equal(read()['/api/persona'].persona.name, '第一次打开');
  write(root, 'config.json', { persona: { name: '重新打开' } });
  assert.equal(read()['/api/persona'].persona.name, '重新打开');
  assert.equal(fs.existsSync(path.join(root, 'data/server-port.txt')), false);
});

test('未启动内核也能写入人设、称呼与 config 补丁，重读可见且不启服务', async (t) => {
  const root = fixture(t);
  write(root, 'config.json', { persona: { name: '旧名字', ownerName: '旧称呼' } });
  const out = await writeOps(root, [
    { path: '/api/persona', body: { name: '离线鲸鲸', personality: '离线性格', privateMaxChars: 160 } },
    { path: '/api/settings', body: { userName: '离线主人' } },
    { path: '/api/config', body: { patch: { 'persona.masterRoast': true, 'chat.emojiChance': 0.4 } } },
  ], {});
  assert.equal(out.ok, true);
  const snapshot = readSnapshot(root, {});
  assert.equal(snapshot['/api/persona'].persona.name, '离线鲸鲸');
  assert.equal(snapshot['/api/persona'].persona.personality, '离线性格');
  assert.equal(snapshot['/api/persona'].persona.privateMaxChars, 160);
  assert.equal(snapshot['/api/settings'].userName, '离线主人');
  assert.equal(snapshot['/api/config'].config.persona.masterRoast, true);
  assert.equal(snapshot['/api/config'].config.chat.emojiChance, 0.4);
  assert.equal(fs.existsSync(path.join(root, 'data/server-port.txt')), false);

  const script = path.resolve(__dirname, '../src/services/launcherOfflineWrite.js');
  const cli = JSON.parse(execFileSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    timeout: 15000,
    input: JSON.stringify({ path: '/api/persona', body: { job: '离线职业' } }),
  }));
  assert.equal(cli.ok, true);
  assert.equal(readSnapshot(root, {})['/api/persona'].persona.job, '离线职业');
});
