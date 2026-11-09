'use strict';

/**
 * Agent 后端接口约定（Harness / 未来 Cursor）。
 * 聊天模型仍走 DeepSeekClient；这里只服务「把微信绑到外部 Agent 会话」。
 */

function createCursorStub() {
  const notReady = async () => {
    const err = new Error('Cursor Agent 后端尚未实现（二期）');
    err.code = 'CURSOR_NOT_IMPLEMENTED';
    throw err;
  };
  return {
    id: 'cursor',
    listSessions: notReady,
    prompt: notReady,
    cancel: notReady,
    ping: notReady,
  };
}

module.exports = { createCursorStub };
