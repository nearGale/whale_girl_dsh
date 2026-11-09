# Harness Agent Bridge 设计

日期：2026-11-07  
状态：已批准（用户确认方案 1，并要求写完规格后直接实现）

## 目标

主人在微信私聊 / 群聊里，用指令把当前会话绑定到本机 **DeepSeek Harness** 的某个 session；之后该会话里主人的消息进入 Harness Agent，Agent 最终文字回复回到微信。未绑定时仍走现有人设 + `DeepSeekClient`。

Cursor 作为并列后端：**一期只留接口 stub**，二期再实现。

## 非目标（一期）

- 不改 `DeepSeekClient` 的 HTTP 传输层（不是「IPC 换传输」）
- 不实现 Cursor 实装
- 不把 Harness 工具审批搬到微信
- ~~不自动创建 Harness session~~ → 已补充 `/dsh new <路径>`（workspace-write，路径必填）
- 不对流式工具输出刷屏到微信

## 架构

```text
微信 → 桥接 → Node Bot
                 │
                 ├─ /dsh* 主人指令 → 绑定 / 列表 / 取消
                 ├─ chat 已绑定 + 主人消息 → AgentBackend.prompt → finalize → 微信
                 └─ 其它 → 人设流水线 → DeepSeekClient
```

| 模块 | 职责 |
|------|------|
| `src/adapters/agentBackend.js` | 后端接口；`createCursorStub()` |
| `src/adapters/harness.js` | 本机 HTTP `/api` RPC + 鉴权 + 轮询完成 |
| `src/services/agentBridge.js` | 按 chatId 绑定；编排 prompt→完成→文本 |
| `src/core/commands.js` + `pipeline/chat.js` | `/dsh` 指令；绑定开启时短路 LLM |
| 配置 | `harness.baseUrl` 可选；否则发现本机端口；凭证读 `~/.dsh/.credentials.yaml` |

## 指令与绑定

- **权限**：仅主人。非主人 `/dsh` 忽略或短拒。
- **指令**：
  - `/dsh` / `/dsh status`：绑定状态与在线情况
  - `/dsh list`：列 session
  - `/dsh use <id|序号|标题关键字>`：绑定
  - `/dsh off`：解绑
  - `/dsh cancel`：取消当前 turn（若支持）
- **绑定主键**：`chatId`；存 `data/agent-bindings.json`
- **字段**：`backend`（`harness`）、`sessionId`、`sessionTitle`、`boundAt`
- 群内 slash 主人命令：沿用现有「主人 slash 可不 @」逻辑
- 绑定后：**仅主人**消息进 Harness；非主人仍走普通人设/触发规则
- `/dsh*` 永不送进 session

## Harness 客户端

- 传输：loopback HTTP（非 Electron IPC）
- 鉴权：`~/.dsh/.credentials.yaml` → `client-connection/browser-session` secret；可被 env / settings 覆盖
- 只连 `127.0.0.1` / `::1`
- 端口：`harness.baseUrl` 优先，否则发现 `DeepSeek Harness` 监听端口
- RPC：`session/list`、`session.prompt`、完成轮询、`session.cancel`（可选）
- 一期用 HTTP 轮询完成，避免强制 Node 22 WebSocket
- 单次 turn 默认最多等 10 分钟；检测到审批等待则立刻提示去 Harness 窗口批准
- 日志：只记 sessionId / 耗时 / 状态，不打正文；凭证脱敏

## 流水线

1. 命令阶段处理 `/dsh*`
2. 触发通过后、`llm.complete` 前：若绑定 harness 且主人 → `agentBridge.prompt` → `finalize`
3. 记忆：用户消息仍落盘；Harness 模式下一期跳过 episode 模型抽取
4. 过长回复：按现有气泡/字数上限截断并注明

## 测试

- 非主人不能绑定
- 主人绑定后消息走 mock backend，不调 `DeepSeekClient`
- 绑定后非主人不进 Harness
- `/dsh off` 恢复
- 401 / 超时友好短句
- Cursor stub 返回未实现

## 风险

- Desktop 与 `dsh web` RPC 差异 → 适配器集中兼容
- 审批卡住 → 检测后提示
- 凭证泄露 → 只读用户目录、脱敏、不进 git
