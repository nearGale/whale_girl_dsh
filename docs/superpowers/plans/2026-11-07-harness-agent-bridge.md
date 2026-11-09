# Harness Agent Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 主人可用 `/dsh` 将微信会话绑定到本机 DeepSeek Harness session，消息进 Agent，最终文字回微信；Cursor 仅 stub。

**Architecture:** `AgentBackend` 接口 + `HarnessBackend`（本机 HTTP RPC）+ `agentBridge` 绑定编排；`pipeline/chat.js` 在 LLM 前短路；`DeepSeekClient` 不动。

**Tech Stack:** Node ≥18 CommonJS，零 npm 依赖；本机 HTTP；`data/agent-bindings.json`。

**Spec:** `docs/superpowers/specs/2026-11-07-harness-agent-bridge-design.md`

## Global Constraints

- 零 npm 运行时依赖；不改 DeepSeekClient 传输
- 日志不打聊天/Agent 正文；凭证脱敏
- 每个行为改动配可复现测试；中文注释讲为什么

---

## File map

| File | Responsibility |
|------|----------------|
| `src/adapters/agentBackend.js` | 接口约定 + Cursor stub |
| `src/adapters/harness.js` | 发现端口、鉴权、list/prompt/cancel |
| `src/services/agentBridge.js` | 绑定持久化 + prompt 编排 |
| `src/core/commands.js` | 解析 `/dsh*` |
| `src/pipeline/chat.js` | 命令执行 + 绑定短路 |
| `src/app.js` | 注入 agentBridge |
| `tests/agent-bridge.test.js` | 绑定/权限/短路/stub |
| `tests/harness-adapter.test.js` | mock HTTP RPC / 鉴权失败 |

---

### Task 1: AgentBackend + 绑定存储

- [x] RED: `tests/agent-bridge.test.js` — Cursor stub 未实现；绑定 get/set/clear
- [x] GREEN: `agentBackend.js` + `agentBridge.js` 绑定部分
- [x] 跑通测试

### Task 2: `/dsh` 命令解析与主人权限

- [x] RED: 解析 `/dsh list|use|off|status|cancel`；非主人拒绝绑定
- [x] GREEN: `commands.js` + `runCommand` 分支（mock bridge）
- [x] 跑通测试

### Task 3: 流水线短路

- [x] RED: 绑定后主人消息调用 backend.prompt，不调 llm.complete
- [x] GREEN: `chat.js` 接入
- [x] 跑通测试

### Task 4: Harness 适配器（mock 服务器）

- [x] RED: list/prompt/401/超时友好错误
- [x] GREEN: `harness.js` + 发现/凭证读取
- [x] 跑通测试

### Task 5: 装配与文档

- [x] `app.js` 注入；`CHANGELOG.md` 补一段
- [x] `node scripts/check-layers.js`；相关测试全绿
