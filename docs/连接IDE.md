# 连接 IDE（DeepSeek Harness / Cursor）

一句话：微信当入口，本机 **DeepSeek Harness（DSH）** 或以后的 **Cursor** 当 Agent；绑定开启后，主人的消息进 IDE 会话，最终文字回微信。未绑定仍走鲸鲸人设 + 云端/本地模型（`DeepSeekClient`）。

| 后端 | 状态 | 说明 |
| --- | --- | --- |
| DeepSeek Harness | **可用** | 本机 HTTP `/api` + 浏览器会话凭证 |
| Cursor | **预留** | 接口已留 stub，二期再实装；当前不能选 Cursor 当会话后端 |

设计规格见 `docs/superpowers/specs/2026-11-07-harness-agent-bridge-design.md`（一期曾写「不自动创建 session」；现已支持 `/dsh new` 创建工作区会话）。

---

## 1. 和「填 API Key」有什么不同

| | 普通模型 | 接 IDE（Harness） |
| --- | --- | --- |
| 谁在干活 | 鲸鲸人设 + `DeepSeekClient` | Harness 里已有的 Agent session（工具、工作区、审批都在那边） |
| 配置 | 启动器「设置」里的 Key / 模型 | `config.json` 的 `harness.baseUrl` + 本机凭证 |
| 切换方式 | 换服务商 / 模型 | 主人发 `/dsh …` 绑定某个 session |

**不是**给 `DeepSeekClient` 换一条 IPC 传输；普通人设链路不动。

---

## 2. 接 DeepSeek Harness（DSH）

### 2.1 前提

1. 本机已安装并打开 **DeepSeek Harness**（任务管理器里能看到 `DeepSeek Harness`）。
2. 至少登录过一次，生成凭证文件：  
   `%USERPROFILE%\.dsh\.credentials.yaml`  
   （记录 `client-connection/browser-session` 的 secret；也可用环境变量 `DSH_AUTH_SECRET`。）
3. 鲸鲸内核在跑（启动器「启动」）。
4. 你是配置里的**主人**（`persona.master.wxids` 已绑定真实 `wxid_`）。

### 2.2 填写地址

桌面版 Host 端口常常是**随机**的（只听 `127.0.0.1`）。在运行目录的 `config.json` 里加上（没有就从 `config.example.json` 拷一份再改）：

```json
"harness": {
  "baseUrl": "http://127.0.0.1:53721"
}
```

查端口（PowerShell）：

```powershell
Get-NetTCPConnection -State Listen -OwningProcess (
  (Get-Process 'DeepSeek Harness' -ErrorAction SilentlyContinue | Select-Object -First 1).Id
) | Select-Object LocalAddress, LocalPort
```

或：`netstat -ano` 里找 `DeepSeek Harness.exe` 对应 PID 的 `127.0.0.1:xxxxx LISTENING`。

也可用环境变量（优先级见下）：

```text
DSH_URL=http://127.0.0.1:53721
DSH_AUTH_SECRET=<与 credentials 里相同的 base64url secret，可选>
```

**生效优先级（地址）：**  
`data/settings.json` 的 `harnessBaseUrl`（若以后启动器有填）> `config.json` 的 `harness.baseUrl` > 环境变量 `DSH_URL`。

改完 `config.json` 一般会热加载；不放心就在启动器里停一下再启动。

只连本机 loopback（`127.0.0.1` / `localhost` / `::1`），不会去连局域网别人的 Harness。

### 2.3 微信里怎么用（仅主人）

| 指令 | 作用 |
| --- | --- |
| `/dsh` 或 `/dsh status` | 看 Harness 是否在线、本会话有没有绑定 |
| `/dsh list` | 列出 Harness 里的会话（最多约 20 条） |
| `/dsh use <序号\|id\|标题关键字>` | 把**当前**微信会话绑到该 session |
| `/dsh new <已存在的本地目录>` | 在 Harness 里为该路径确保工作区、新建 session，权限固定为**读写本工作区**（`workspace-write`），并自动绑定当前微信会话。路径必填，不存在则报错（不会替你 mkdir） |
| `/dsh off` | 解除绑定，恢复普通人设回复 |
| `/dsh cancel` | 取消该 session 当前正在跑的 turn（若接口支持） |

要点：

- **私聊和群聊**都可以绑定；绑定按微信 `chatId` 分开存（`data/agent-bindings.json`）。
- 绑定后：**只有主人**的消息进 Harness；群里别人 @ 她仍走普通人设。
- 群里主人发 `/dsh …` 这类 slash 命令，按现有规则可不 @。
- `/dsh*` 本身不会被送进 Harness session。
- 工具审批、写文件等仍在 **Harness 窗口**完成；若卡在审批，微信里会提示你去点批准。

### 2.4 推荐自检顺序

1. Harness 开着，`config.json` 里 `harness.baseUrl` 端口对。  
2. 主人私聊发 `/dsh status` → 应显示在线或明确的鉴权错误。  
3. `/dsh list` → 能看到会话；没有就先在 Harness 里开一个。  
4. `/dsh use 1`（或具体 id）→ 提示已绑定。  
5. 发一句任务 → 等 Harness 跑完 → 微信收到最终文字。  
6. `/dsh off` → 再聊应回到鲸鱼娘人设。

### 2.5 常见问题

| 现象 | 处理 |
| --- | --- |
| 「未配置 Harness 地址」 | 补 `harness.baseUrl` 或 `DSH_URL` |
| 401 / 未登录 / 凭证过期 | 打开一次 Harness；检查 `~\.dsh\.credentials.yaml`；必要时设 `DSH_AUTH_SECRET` |
| list 为空 | 在 Harness UI 里开一个，或用 `/dsh new D:\某目录` 新建 |
| `/dsh new` 无路径 | 必须带已存在的本地目录，例如 `/dsh new D:\CodeLib\my-app` |
| 一直不回或提示批准 | 到 Harness 窗口处理审批 / 看 Agent 是否还在跑 |
| 回复被截断 | 微信气泡有字数上限，过长会按现有规则截；完整内容在 Harness 历史里 |
| 重启后绑定还在吗 | 在：`data/agent-bindings.json`；Harness 没开则 prompt 会失败并回短错误 |

---

## 3. Cursor（预留）

一期只实现了 **Agent 后端接口** 和 Cursor **stub**（调用会明确返回「二期未实现」）。

规划中的用法与 Harness 对齐：

- 主人用指令选择后端 / session（具体命令名二期再定，可能是 `/cursor …` 或统一的 `/ide …`）。
- 微信 → 绑定的 Cursor Agent → 最终文字回微信。
- 同样：非主人不进 Agent；审批留在 Cursor 侧。

在 Cursor 实装合并前，**不要**指望微信能驱动 Cursor Agent。开发入口：

- 接口约定：`src/adapters/agentBackend.js`（`createCursorStub`）
- Harness 实装可对照：`src/adapters/harness.js`、`src/services/agentBridge.js`

---

## 4. 代码落点（给改代码的人）

```text
微信消息
  → pipeline/chat.js
       ├─ /dsh* → agentBridge 绑定 / 列表
       ├─ 已绑定 + 主人 → agentBridge.promptForChat → finalize → 微信
       └─ 否则 → 人设 + DeepSeekClient
```

| 模块 | 路径 |
| --- | --- |
| 命令解析 | `src/core/commands.js` |
| 绑定与编排 | `src/services/agentBridge.js` |
| Harness 客户端 | `src/adapters/harness.js` |
| Cursor stub | `src/adapters/agentBackend.js` |
| 装配 | `src/app.js` |
| 测试 | `tests/agent-bridge.test.js` |

配置字段模板：`config.example.json` → `harness`；字段说明另见 [设置说明.md](设置说明.md)。
