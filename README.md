# claude2feishu

Claude Code ↔ 飞书双向通信。在飞书群里 **@机器人** 发送指令，Claude Code 执行并将结果回传。

这个项目由两条链路组成：

- **飞书 → Claude Code**: 守护进程轮询飞书群消息，按引用卡片或活跃 session 路由，再通过终端 AppleScript 精确写入 Claude Code 所在 TTY。
- **Claude Code → 飞书**: Claude Code Hooks 调用 `notify.sh`，把 session 生命周期、权限请求、失败信息和最终输出发送为飞书卡片。

阅读建议：

- 只想跑起来：看 [快速开始](#快速开始)、[命令参考](#命令参考)、[日志与诊断](#日志与诊断)。
- 想理解完整机制：从 [系统架构](#系统架构) 开始，再看 [入站流程](#入站流程-飞书--claude-code-终端)、[出站流程](#出站流程-claude-code--飞书群) 和 [完整场景时序](#完整场景时序)。
- 想排查路由问题：重点看 `card_session_map.jsonl`、`session_states.json`、`message_queue.jsonl` 和 `message_dump.jsonl`。

## 目录

- [前置要求](#前置要求)
- [快速开始](#快速开始)
- [命令参考](#命令参考)
- [日志与诊断](#日志与诊断)
- [系统架构](#系统架构)
- [入站流程 (飞书 → Claude Code 终端)](#入站流程-飞书--claude-code-终端)
- [出站流程 (Claude Code → 飞书群)](#出站流程-claude-code--飞书群)
- [Session 状态管理详解](#session-状态管理详解)
- [Message Queue (统一待投递队列)](#message-queue-统一待投递队列)
- [detectState() — Claude 状态检测详解](#detectstate--claude-状态检测详解)
- [findMyClaudeProcess() / findClaudeProcess() — 进程发现详解](#findmyclaudeprocess--findclaudeprocess--进程发现详解)
- [完整场景时序](#完整场景时序)
- [项目文件结构](#项目文件结构)

## 前置要求

- Node.js 22+ 和 pnpm。
- macOS + iTerm 或 Terminal.app。自动投递依赖 AppleScript 枚举终端 session/tab 并匹配 TTY。
- 本地 Claude Code，且能配置 `~/.claude/settings.json` hooks。
- 飞书自建应用：已添加机器人能力、发布应用、把机器人加入目标群。
- 飞书应用权限：`im:chat:readonly` / `im:message:read` / `im:message:send`。

## 快速开始

### 1. 安装

```bash
cd claude2feishu
pnpm install
```

### 2. 配置

```bash
cp .env.example .env
```

编辑 `.env`:

```env
FEISHU_APP_ID=cli_aXXXXXXXXXXXX
FEISHU_APP_SECRET=XXXXXXXXXXXXXXXXXXXXXXXX
# 可选:
FEISHU_CHAT_ID=oc_xxxxxxxxxxxxxx    # 指定群聊，不填则自动选第一个
FEISHU_POLL_INTERVAL=3              # 轮询间隔（秒）
FEISHU_LOG_LEVEL=INFO               # 日志级别配置项
```

获取方式: [飞书开发者后台](https://open.feishu.cn/app) → 应用 → 凭证与基础信息。

**必需权限:** `im:chat:readonly` / `im:message:read` / `im:message:send`。应用需发布并添加机器人到目标群聊。

注意：`.env` 包含飞书应用凭证，已被 `.gitignore` 忽略，不要提交到仓库。

### 3. 配置 Claude Code Hooks

```bash
pnpm setup-hooks
```

自动将通知 hooks 写入 `~/.claude/settings.json`，与已有配置合并。执行 `pnpm setup-hooks --dry-run` 可预览不写入。

### 4. 启动

```bash
pnpm start        # 后台守护进程
pnpm status       # 验证运行状态
```

在飞书群里 @机器人 发一条消息，会收到确认卡片。如果本地有 Claude Code 在 iTerm 或 Terminal.app 中运行，消息会自动发送到对应终端。

---

## 命令参考

### 守护进程

| 命令           | 说明              |
| -------------- | ----------------- |
| `pnpm start`   | 后台守护进程      |
| `pnpm stop`    | 停止守护进程      |
| `pnpm restart` | 重启              |
| `pnpm status`  | 状态 + inbox 统计 |
| `pnpm once`    | 单次拉取 (测试)   |

### Inbox 管理

| 命令                     | 说明           |
| ------------------------ | -------------- |
| `pnpm inbox`             | 待处理指令列表 |
| `pnpm pop`               | 弹出下一条指令 |
| `pnpm done <id>`         | 标记完成       |
| `pnpm reply <id> <text>` | 回复并标记完成 |
| `pnpm clear`             | 清理已完成记录 |

### Session 管理

| 命令                            | 说明                            |
| ------------------------------- | ------------------------------- |
| `pnpm session-list`             | 查看活跃 session + 待处理消息   |
| `pnpm session-state <sid>`      | 查看 session 详情 + Claude 状态 |
| `pnpm session-queue <sid>`      | 查看 session 待投递消息         |
| `pnpm session-send <sid> <msg>` | 手动发送消息到终端 (调试)       |

### 测试

| 命令                | 说明                         |
| ------------------- | ---------------------------- |
| `pnpm test`         | 运行 Node test 测试套件      |
| `pnpm typecheck`    | TypeScript 静态类型检查      |
| `pnpm build`        | 编译到 `dist/`               |
| `pnpm test-webhook` | 测试 API 发送卡片            |
| `pnpm test-api`     | 测试 API 拉取消息 (不过滤 @) |

---

## 日志与诊断

守护进程日志:

```bash
tail -f ~/.claude/feishu/feishu_bot.log
```

引用消息原始数据（有 parent_id/root_id 时记录）:

```bash
cat ~/.claude/feishu/message_dump.jsonl
```

Card → Session 映射:

```bash
tail -10 ~/.claude/feishu/card_session_map.jsonl
```

飞书 API 错误日志:

```bash
tail -20 ~/.claude/feishu/feishu_error.log
```

Session 状态:

```bash
cat ~/.claude/feishu/session_states.json | python3 -m json.tool
```

---

## 技术栈

TypeScript + Node.js 22 + tsx + 飞书 Open API + AppleScript (iTerm / Terminal.app)

## 系统架构

```
┌──────────────────────────────────────────────────────────────────────────────┐
│                              claude2feishu                                    │
│                                                                              │
│  ┌─────────────┐    ┌──────────────────┐    ┌──────────────────┐            │
│  │  feishu_bot  │───▶│  session_state   │    │  message_queue   │            │
│  │  (守护进程)   │    │  (PID/TTY 映射)   │    │  (统一待投递队列)   │            │
│  └──────┬───────┘    └──────────────────┘    └────────┬─────────┘            │
│         │              ▲           │                 ▲         │              │
│         │              │ 读写       │ 写入             │ 读写     │ 读写         │
│         ▼              │           ▼                 │         ▼              │
│  ┌──────────────┐    ┌─┴──────────────────┐    ┌─────┴──────────────┐       │
│  │  feishu_api  │    │     terminal       │    │ delivery_          │       │
│  │  (API 客户端) │    │  (状态检测+发送)    │    │ orchestrator       │       │
│  └──────────────┘    └────────────────────┘    │ (Hook 驱动串行投递) │       │
│          ▲                                     └────────┬──────────┘       │
│          │                                              │                  │
│  ┌───────┴───────┐    ┌──────────────────┐             │                  │
│  │delivery_tracker│   │     notify       │◀────────────┘                  │
│  │(投递追踪映射)   │◀──│  (Hook 入口)      │                               │
│  └───────────────┘    └──────────────────┘                               │
│        │                                                                 │
│        │ Stop 时查询 msgId → replyCard 引用回复原始消息                     │
│        │ 投递时写入 session→msgId                                        │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 数据文件 (全部在 `~/.claude/feishu/`)

| 文件                         | 格式         | 用途                                                   |
| ---------------------------- | ------------ | ------------------------------------------------------ |
| `session_states.json`        | JSON 数组    | Session → 进程映射 (PID/TTY/transcript_path/状态/心跳) |
| `card_session_map.jsonl`     | JSONL (追加) | 飞书卡片 message_id → session_id 映射                  |
| `message_queue.jsonl`        | JSONL (读写) | 统一待投递队列；`session_id` 为空表示通用 inbox         |
| `feishu_checkpoint.json`     | JSON         | 轮询 checkpoint (最后处理的消息 ID)                    |
| `feishu_bot.pid`             | 文本         | 守护进程 PID                                           |
| `feishu_bot.log`             | 文本 (追加)  | 守护进程日志                                           |
| `feishu_error.log`           | 文本 (追加)  | 飞书 API 发送失败等 hook 环境错误诊断                  |
| `message_dump.jsonl`         | JSONL (追加) | 引用消息原始数据诊断                                   |
| `delivery_tracker.json`      | JSON         | session_id → 飞书消息 ID 映射，Stop 时引用回复用         |

### 两大消息流向

```
出站 (Claude → 飞书):   Hook 事件 → notify.ts → feishu_api.ts → 飞书群卡片
                         Stop 时查询 delivery_tracker → replyCard 引用回复原始消息
                         SessionStart/Stop 额外触发 deliverNextPending() → 投递队列中的下一条消息

入站 (飞书 → Claude):   轮询 API → feishu_bot.ts → 路由分发 → terminal.ts sendToTerminal()
                         无法立即投递 → enqueue() → 等待 hook 触发 deliverNextPending()
                         投递成功 → recordDelivery(session, msgId) 写入映射
```

---

## 入站流程 (飞书 → Claude Code 终端)

### 步骤 1: 轮询拉取

`feishu_bot.ts` 作为守护进程运行 (`cli.ts daemon`)，每 `FEISHU_POLL_INTERVAL` 秒（默认 3s）执行一次 `processNewMessages()`:

```
1. loadCkpt() — 从 feishu_checkpoint.json 读取最后处理的消息 ID
2. listReceivedMessages(20, true) — 调用飞书 API:
   a. listChats() → GET /im/v1/chats 获取所有群聊列表
   b. 对每个群聊调用 listChatMessages() → GET /im/v1/messages?sort_type=ByCreateTimeDesc
   c. mentionsBot() 过滤 @机器人的消息:
      - bot open_id 为空时直接返回 false
      - 优先检查 mentions 数组（飞书结构化 @提及）
        mentions[i].id 可能是字符串(open_id)或对象{open_id: "..."}
        如果 mentions 存在但不包含 bot open_id，直接返回 false
      - 无 mentions 数组时回退正文匹配:
        text 消息要求 body.text 包含 bot open_id
        post 富文本要求 at 节点的 user_id/open_id/id 等于 bot open_id
   d. 跨群聚合所有 @消息，按 create_time 降序排列，取前 20 条
3. 从最新消息往前遍历，遇到 lastId（checkpoint）就停止 → 增量拉取
4. 对每条新消息（reverse 后按时间正序）执行处理
5. saveCkpt() — 更新 checkpoint 为最新消息 ID 和时间
```

### 步骤 2: 消息文本提取 — `extractText()`

入参 `FeishuMessage`:

```
{
  message_id: "om_xxxxxxxxxxxxx",
  msg_type: "text" | "post" | "interactive" | ...,
  chat_id: "oc_xxxxxxxxxxxxx",
  create_time: "1717603200000",
  sender: { id: "ou_xxxxxxxxxxxxx", id_type: "open_id" },
  body: { content: '{"text":"@机器人 运行测试"}' },
  mentions: [{ key: "...", id: "ou_...", name: "机器人" }]
}
```

提取逻辑:

```
msg_type === "text":
  1. JSON.parse(body.content) → 取 text 字段
  2. 去掉 @机器人 前缀: 循环去掉开头的 @xxx（到第一个空格为止）
  3. 返回纯文本 "运行测试"

msg_type === "post":
  1. JSON.parse(body.content) → 取 content 字段（富文本节点树）
  2. extractPostText() 递归遍历:
     - tag === "text" → 收集 text 字段
     - tag === "at"  → 收集 "@用户名"
     - 数组 → 递归每个元素
     - 对象 → 递归每个 value
  3. 拼接返回

msg_type === "interactive":
  → body.content 为卡片 JSON 结构，无用户输入文本 → 返回 ""
```

### 步骤 3: 引用消息 ID 提取 — `getQuotedMessageId()`

从消息中提取用户引用/回复的目标消息 ID。优先级从高到低：

```
1️⃣ body.content JSON 中的 reply_to.message_id
   → 用户点击飞书"引用"按钮时附带的目标消息 ID（显式操作，最可靠）

2️⃣ body.content JSON 中的 quote.message_id
   → 另一种引用格式（富文本中的引用块）

3️⃣ 富文本递归查找 findQuotedInRichText()
   → 遍历 body.content 的节点树，找 tag==="quote" 或 tag==="reply" 节点
   → 提取 node.message_id 字段

4️⃣ 消息顶层 parent_id
   → 用户在话题（thread）中直接回复的父消息 ID
   → 注意: 如果用户既在话题中回复、又显式引用了另一条消息，
     parent_id 可能指向话题中的某条消息，而非用户刻意引用的那条

5️⃣ 消息顶层 root_id
   → 话题的根消息 ID（优先级最低，仅在无其他引用信息时使用）
```

**为什么 body 引用优先于 parent_id？**

飞书中用户可以同时做两件事：(a) 在话题中回复 (b) 显式引用另一条消息。此时消息同时带有 `parent_id`（话题父消息）和 body 中的 `reply_to`（显式引用目标），两者可能是不同的消息 ID。body 中的 `reply_to` 是用户主动选择的目标，应优先使用。

### 步骤 4: Card → Session 映射查询 — `lookupCardSession()`

当提取到引用消息 ID 后，查询该 ID 对应的 session:

```
lookupCardSession(quotedMessageId):
  1. 读取 card_session_map.jsonl 文件
  2. 按行 split, 从后往前遍历 (取最近匹配)
  3. JSON.parse 每行 → {message_id, session_id, sent_at}
  4. message_id === quotedMessageId → 返回 session_id
  5. 无匹配 → 返回 ""
```

映射的建立见出站流程步骤 4。

### 步骤 5: Session 路由分发

对每条新消息，按以下优先级路由：

```
┌─────────────────────────────────────────────────────────────────┐
│ 方式 1: 引用消息精确路由                                          │
│                                                                 │
│  quoteId = getQuotedMessageId(msg)                              │
│  if quoteId:                                                    │
│    log("引用消息: " + quoteId)                                   │
│    log("quoteId=X parent_id=Y root_id=Z")  ← 诊断日志           │
│    sid = lookupCardSession(quoteId)                             │
│    if sid:                                                      │
│      log("查找到 session: " + sid)                               │
│      → handleSessionMessage(id, chatId, sender, text, sid)      │
│      → routed = true                                           │
│    else:                                                        │
│      log("未在映射中找到 session ID", DEBUG)                      │
│      → 继续往下走（不阻断）                                       │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│ 方式 2: 自动路由到活跃 session（无引用或引用未命中时）              │
│                                                                 │
│  if !routed:                                                    │
│    active = listActive()                                        │
│    // listActive() = session_states 中 status=active/idle       │
│    //               且 isProcessAlive(pid)=true                  │
│    if active.length >= 1:                                       │
│      target = active.reduce(max started_at)  // 取最近启动的     │
│      log("自动路由到活跃 session: " + target.session_id)          │
│      → handleSessionMessage(id, chatId, sender, text,           │
│                              target.session_id)                │
│      → routed = true                                           │
│    else:                                                        │
│      log("无活跃 session，走 inbox", DEBUG)                      │
│                                                                 │
├─────────────────────────────────────────────────────────────────┤
│ 方式 3: 通用 inbox 回退                                           │
│                                                                 │
│  if !routed:                                                    │
│    enqueue({ id, chat_id, sender, content, status:"pending" })  │
│    → 写入 message_queue.jsonl（无 session_id，即通用 inbox）      │
│    replyCard(id, "📨 已收到，等待投递",                             │
│      "当前没有运行中的 Claude Code，指令已存入收件箱。                │
│       下次启动后自动处理。")                                        │
└─────────────────────────────────────────────────────────────────┘
```

### 步骤 6: Session 消息处理 — `handleSessionMessage()`

对已确定目标 session 的消息：

```
1. 查找 session:
   session = getSession(sid)          // 精确匹配 session_id
          ?? findByPrefix(sid)        // 前缀匹配回退（卡片文本截断）
   → 都找不到: enqueue + replyCard("📨 已入队", "目标会话未运行，指令已保存。")

2. 检查 transcript_path:
   if !session.transcript_path:
     → enqueue + replyCard("📨 已入队", "会话状态未知，指令已保存。")

3. 状态检测 + 降级保护:
   state = detectState(session.transcript_path)
   //      读取 transcript JSONL 从后往前扫描:
   //        assistant + stop_reason="end_turn" → "waiting"
   //        assistant + 其他 stop_reason       → "busy"
   //        user + 最近 5 分钟内               → "busy"
   //        user + 超过 5 分钟                → "gone"
   //        无有效 message                   → "gone"

   if state === "gone" AND isProcessAlive(session.pid):
     log("detectState=gone 但进程存活，降级为 waiting")
     state = "waiting"
   //   ↑ 覆盖刚启动尚无交互、transcript 格式异常等场景

4. 按状态分发:

   ┌──────────┬────────────────────────────────────────────────────┐
   │ waiting  │ ok = sendToTerminal(session.tty, text)              │
   │          │                                                    │
   │          │ 成功 → replyCard("✅ 已投递",                        │
   │          │          "指令已发送到终端处理。")                    │
   │          │        recordDelivery(sid, msgId)                  │
   │          │                                                    │
   │          │ 失败 → enqueue(msg)                                │
   │          │        replyCard("⚠️ 投递失败",                     │
   │          │          "无法写入终端，指令已保存。")                │
   ├──────────┼────────────────────────────────────────────────────┤
   │ busy     │ enqueue(msg) → 写入 message_queue                  │
   │          │ replyCard("⏳ 处理中，已排队",                       │
   │          │   "当前任务执行中，指令已保存。")                      │
   │          │                                                    │
   │          │ 后续 Stop/SessionStart hook 触发 deliverNextPending │
   │          │ 每次最多投递一条，避免连续写入终端                  │
   ├──────────┼────────────────────────────────────────────────────┤
   │ gone     │ enqueue(msg) → 写入 message_queue                  │
   │(进程已死) │ replyCard("📨 已入队",                              │
   │          │   "会话已退出，指令已保存。")                         │
   │          │ → 下次 SessionStart 时自动投递到新终端               │
   └──────────┴────────────────────────────────────────────────────┘
```

### 步骤 7: 终端消息发送 — `sendToTerminal()`

```
1. 转义消息文本 (AppleScript 安全):
   \ → \\,  " → \",  换行 → 空格,  \r → 空

2. 按优先级构造 AppleScript:

   iTerm / iTerm2:
   - 检查 `/Applications/iTerm.app` 或 `/Applications/iTerm2.app`
   - 枚举 window → tab → session
   - 匹配 `(tty of s) ends with "{tty}"`
   - 命中后 `write text "${escaped_message}"`

   Terminal.app:
   - 使用 `/System/Applications/Utilities/Terminal.app`
   - 枚举 window → tab
   - 匹配 `(tty of t) ends with "{tty}"`
   - 命中后 `do script "${escaped_message}" in t`

3. execSync("osascript", { input: script, timeout: 5000 })
   → result === "ok" → true (成功)
   → 其他 / 异常 → false (失败)

注意: 不使用 System Events `keystroke` 作为通用回退。它只能对前台窗口打字，不能按 TTY 精确定位，可能误投递到错误终端。无法精确定位时返回 false，消息保留在队列中。
```

### 步骤 8: 单条延迟投递 — `deliverNextPending()`

```
当 Claude 处于 busy/gone 或终端写入失败时，消息进入 message_queue。
队列不启动长轮询后台投递器，而是由 SessionStart / Stop / SessionEnd hook 自然触发下一次投递。

选择优先级:
  1. session_id === 当前 session 的消息
  2. 无 session_id 的通用 inbox 消息
  3. 绑定到其他已退出 session 的消息

每次触发:
  messages = collectMessages(currentSessionId)
  if messages 为空:
    return done

  state = detectState(transcriptPath)
  if state === "gone" && isProcessAlive(pid):
    state = "waiting"

  if state !== "waiting":
    保持所有消息 pending，等待下一次 hook

  if state === "waiting":
    只取第一条消息
    ok = sendToTerminal(tty, message)
    ok  → markDelivered(msgId) + replyCard("✅ 已投递")
    失败 → 保持 pending + replyCard("⚠️ 投递失败")

这样不会在同一个空闲窗口连续写入多条消息。下一条消息等 Claude 处理完当前消息后，
由下一次 Stop/SessionEnd hook 再投递。
```

---

## 出站流程 (Claude Code → 飞书群)

### 步骤 1: Hook 触发

Claude Code 在 `~/.claude/settings.json` 中配置 hooks:

```json
{
  "hooks": {
    "SessionStart": [{ "command": ".../notify.sh --title ' 已启动' --type info" }],
    "Stop": [{ "command": ".../notify.sh --title ' 任务完成' --type success" }],
    "StopFailure": [{ "command": ".../notify.sh --title ' 异常终止' --type error" }],
    "PermissionRequest": [{ "command": ".../notify.sh --title ' 等待确认' --type warning" }],
    "PermissionDenied": [{ "command": ".../notify.sh --title ' 权限拒绝' --type error" }],
    "Elicitation": [{ "command": ".../notify.sh --title ' 等待输入' --type warning" }],
    "PostToolUseFailure": [{ "command": ".../notify.sh --title ' 操作失败' --type error" }]
  }
}
```

每个 hook 事件触发时，Claude Code 通过 stdin 传入 JSON:

```json
{
  "hook_event_name": "Stop",
  "session_id": "abc123-def456-...",
  "transcript_path": "/path/to/transcript-abc123.jsonl",
  "cwd": "/Users/xxx/project",
  "model": "claude-sonnet-4-6",
  "tool_name": "Bash",
  "tool_input": { "command": "npm test" },
  "error": "...",
  "question": "...",
  "output": "...",
  "message": "..."
}
```

### 步骤 2: notify.ts 处理

```
1. readHookStdin():
   - 从 process.stdin.fd 读取 JSON
   - 非 TTY stdin 时返回 {}（CLI 手动调用时不解析 stdin）

2. buildContext(event):
   返回拼接后的通知卡片内容，包含:

   通用信息 (所有事件):
     📁 项目名: basename(event.cwd)
     🌿 分支:   git rev-parse --abbrev-ref HEAD + git log -1 --format=%h
     💻 主机:   macOS → scutil --get ComputerName, 其他 → os.hostname()
     🧠 模型:   从 transcript 最新 assistant 消息提取 model 字段
     🔗 会话:   event.session_id (截断显示)

   事件特定信息:
     Stop:
       → getModelOutput(): 从 transcript 提取最后 assistant text
       → 拼接 "💬 模型输出: ..."

     StopFailure:
       → event.error → "💥 错误原因: ..."

     PermissionRequest:
       → toolLabel(tool_name): 中文工具名映射 (Bash→"执行 Shell 命令", ...)
       → describeToolInput(tool, input): 工具参数摘要
         - Bash: 截取 command 前 150 字符
         - Write/Edit: 取 basename(file_path)
         - WebFetch: 取 URL hostname
         - WebSearch: 取 query 前 100 字符
         - Read: 取 basename(file_path)
         - 其他: 列出 key=value (最多 3 个)
       → getModelOutput(): Claude 最后输出 (帮助理解为什么请求此操作)

     PermissionDenied:
       → toolLabel + tool_input 摘要

     Elicitation:
       → event.question → "❓ Claude 的提问: ..."

     PostToolUseFailure:
       → toolLabel + tool_input + event.error

3. 组合 fullMessage:
   - ctx = buildContext(event)
   - CARD_CONTENT_MAX_BYTES = 24000
   - message 按 UTF-8 字节截断，给 ctx 和卡片结构保留空间
   - fullMessage = clipBytes(message, msgMaxBytes) + ctx

4. sendNotification(title, fullMessage, type, sessionId):
   → sendChatCard(title, fullMessage, color, sessionId)
```

### 步骤 3: 卡片发送 — `sendChatCard()`

```
1. 确定目标群聊:
   config.chatId || getDefaultChatId()
   getDefaultChatId(): listChats() → 取第一个群聊

2. 构建卡片 (飞书卡片 JSON 2.0):
   buildCard(title, content, color)
   - 先构建完整卡片 JSON
   - 按最终 JSON 字节数检查是否超过 30000 bytes
   - 如果超限，对 markdown content 做二分截断，并追加省略号

   {
     schema: "2.0",
     config: { update_multi: true },
     header: {
       title: { tag: "plain_text", content: title },
       template: color  // blue/green/yellow/red
     },
     body: {
       elements: [
         { tag: "markdown", content: fullMessage },
         { tag: "hr" },
         { tag: "markdown", content: "*⏱ 2026-06-06 21:30:00  ·  Claude Code*", text_size: "notation" }
       ]
     }
   }

3. POST /im/v1/messages?receive_id_type=chat_id
   { receive_id: chatId, msg_type: "interactive", content: cardJSON }

4. 飞书返回: { code: 0, data: { message_id: "om_xxxxxxxxxxxxx" } }
```

### 步骤 4: 记录 Card → Session 映射 — `registerCardSession()`

```
发送卡片成功后:
  registerCardSession(messageId, sessionId)

  → 追加到 card_session_map.jsonl:
    {"message_id":"om_xxxxxxxxxxxxx","session_id":"abc123-...","sent_at":"2026-06-06T21:30:00.000Z"}

  后续入站流程的步骤 4 通过 lookupCardSession(quotedMessageId) 查询此映射。
```

### 步骤 5: 回复消息 — `replyCard()`

```
当需要回复特定消息时 (handleSessionMessage 中的确认卡片):

  POST /im/v1/messages/{msgId}/reply
  { content: cardJSON, msg_type: "interactive" }

  同样在成功后 registerCardSession(newMessageId, sessionId)
```

### 步骤 6: Session 生命周期管理

#### SessionStart

```
1. findMyClaudeProcess():
   从当前 notify.ts 进程开始，沿 PPID 链向上最多查找 10 层:
     node notify.ts
       ↑ sh -c "./notify.sh ..."
       ↑ Claude Code 主进程

   每一层执行:
     ps -p <pid> -o ppid=
     ps -p <ppid> -o command=

   匹配条件:
     - command 中包含独立单词 claude
     - 不包含 claude2feishu
     - 不包含 hook
     - 不包含 plugin

   命中后:
     ps -p <ppid> -o tty=
     → 返回 { pid: <Claude PID>, tty: <TTY> }

   若沿 PPID 链查找失败:
     → 回退到 findClaudeProcess()
     → 全局 ps 搜索第一个 Claude Code 进程

   这样多窗口同时运行 Claude Code 时，优先定位触发当前 hook 的那一个 session。

2. registerSession({
     session_id: sid,
     pid: proc.pid,
     tty: proc.tty,
     transcript_path: event.transcript_path,
     status: "active",
     started_at: new Date().toISOString()
   })
   → 同一 PID 的旧 session 自动标记为 idle
   → 写入 session_states.json

3. 检查通用 inbox (getInboxPending):
   有 pending:
     a. 发送提醒卡片（列出最近 3 条）
     b. 不含 session 专属消息，避免把 session queue 误显示为 inbox

4. 触发单条队列投递:
   deliverNextPending(currentSession)
   → 当前 session 消息优先
   → 其次投递通用 inbox
   → 再投递已退出 session 的遗留消息
   → 每次最多发送 1 条
   → 发送成功 markDelivered(msgId)，失败/未投递保持 pending
```

#### Stop / StopFailure / SessionEnd

```
1. 通知发送:
   Stop / StopFailure:
     a. getLastDelivery(sid): 从 delivery_tracker.json 查询最近投递的飞书消息 ID
     b. 有记录: replyCard(msgId, title, message) → 引用回复原始消息，形成对话线程
        clearDelivery(sid) → 清除记录
     c. 无记录: sendChatCard(title, message) → 回退为独立群聊消息
   SessionEnd / 其他:
     → sendChatCard(title, message) → 独立群聊消息

2. markIdle(sid):
   session.status = "idle"
   session.last_heartbeat = now
   → 写入 session_states.json

3. deliverNextPending(currentSession):
   → Claude 刚完成一轮处理后，只投递下一条可达消息
   → 如果仍有 pending，等待下一次 Stop/SessionEnd hook

4. getPending(sid):
   如果当前 session 仍有 pending，发送提醒卡片说明还有消息等待后续 hook 投递。
```

---

## Session 状态管理详解

### 数据结构

```
session_states.json → SessionState[]:
{
  session_id: "abc123-def456-789-...",  // Claude Code UUID
  pid: 12345,                            // 进程 PID
  tty: "ttys002",                        // 终端设备名
  transcript_path: "/path/to/transcript.jsonl",
  status: "active" | "idle",             // active=运行中, idle=已结束
  started_at: "2026-06-06T21:00:00.000Z",
  last_heartbeat: "2026-06-06T21:30:00.000Z"
}
```

### 状态转换

```
SessionStart hook 触发:
  → findMyClaudeProcess() 沿 PPID 链定位当前 Claude Code 进程
    → 如失败则回退 findClaudeProcess() 全局搜索
  → registerSession({status: "active"})
  → 如果同一 PID 有旧 session → 旧 session 标记为 idle

Stop / StopFailure / SessionEnd hook 触发:
  → markIdle(sid) → status = "idle"

save() 时自动清理:
  → last_heartbeat > 24h 的记录被移除
  → 防止 session_states.json 无限增长
```

### 活跃判定

```
listActive():
  = session_states 中所有满足:
    1. status ∈ {"active", "idle"}
    2. isProcessAlive(pid) === true
       → process.kill(pid, 0) 成功 (不实际发信号，仅检查进程存在)
```

### 查询方法

```
getSession(sid):      精确匹配 session_id
findByPrefix(prefix): 前缀匹配回退 (prefix 需 ≥ 8 字符)
                      先精确匹配 → 再 startsWith 匹配
updateHeartbeat(sid): 更新 last_heartbeat 为当前时间
markIdle(sid):        标记 status="idle" + 更新心跳
removeSession(sid):   删除记录
```

---

## Message Queue (统一待投递队列)

### 数据结构

```
message_queue.jsonl → 每行一条 QueuedMessage:
{
  id: "om_msg_xxx",                    // 飞书消息 ID
  chat_id: "oc_xxx",                   // 群聊 ID
  sender: "ou_xxx",                    // 发送者 ID
  content: "运行测试",                  // 消息文本
  session_id: "abc123-...",            // 可选；为空表示通用 inbox
  received_at: "2026-06-06T21:30:00.000Z",
  status: "pending" | "delivered",     // pending=待投递, delivered=已投递
  delivered_at: "2026-06-06T21:31:00.000Z"
}
```

### 操作

```
enqueue(msg):              追加写入 JSONL
getInboxPending():         只读查看无 session_id 的 inbox pending
getPending(sid):           只读查看某 session 的 pending
getPending():              只读查看所有 pending
markDelivered(msgId):      确认成功写入终端后，标记单条为 delivered
listPendingSessions():     统计各 session 的 pending 数量
pendingCount(sid?):        某 session 或全局 pending 数量

SessionStart 自动投递:
  → deliverNextPending() 选择一条可达消息发送到当前终端
  → 成功发送的消息 markDelivered(id)
  → 发送失败 / 未轮到投递的消息保持 pending

clearDelivered():
  → 删除所有 delivered 记录，保留 pending
```

---

## detectState() — Claude 状态检测详解

### 输入

`transcript_path`: Claude Code 的 transcript JSONL 文件路径，每行一条 JSON:

```jsonl
{"message": {"role": "system", "content": [{"type":"text","text":"..."}]}}
{"message": {"role": "assistant", "model": "claude-sonnet-4-6", "stop_reason": "end_turn", "content": [{"type":"text","text":"你好！有什么可以帮你的？"}]}}
{"message": {"role": "user", "content": [{"type":"text","text":"运行测试"}]}}
{"message": {"role": "assistant", "model": "claude-sonnet-4-6", "stop_reason": "tool_use", "content": [...]}}
```

### 算法

```
detectState(transcriptPath):

1. 文件不存在 / 路径为空 → return "gone"

2. 读取文件，按 \n split

3. 从最后一行往前遍历:
   for i = lastIndex; i >= 0; i--:
     try:
       obj = JSON.parse(lines[i])
       msg = obj.message
       if !msg.role: continue  // 跳过无 role 的行

       if msg.role === "assistant":
         if msg.stop_reason === "end_turn":
           return "waiting"    // Claude 空闲，等待用户输入
         else:
           return "busy"       // tool_use / max_tokens / stop_sequence 等

       if msg.role === "user":
         ts = obj.timestamp
         if ts && (now - ts) > 300000ms:
           return "gone"       // 用户 5 分钟前发了消息但无响应
         else:
           return "busy"       // 用户刚发消息，Claude 还在处理
     catch: continue

4. 遍历完毕无匹配 → return "gone"
```

### 降级保护 (在 handleSessionMessage 中)

```
处理完 detectState() 后:
  if state === "gone" && isProcessAlive(session.pid):
    state = "waiting"  // 进程还活着，尝试发送
```

这确保以下场景不会错误判定为 gone:

- Claude 刚启动，transcript 尚无 assistant/user 消息
- transcript 文件暂时不可读
- transcript 中存在格式异常的行

---

## findMyClaudeProcess() / findClaudeProcess() — 进程发现详解

```
findMyClaudeProcess():

  currentPid = process.pid

  for i in 0..9:
    ppid = ps -p currentPid -o ppid=
    cmd  = ps -p ppid -o command=

    if cmd 匹配:
       /\bclaude\b/
       且不包含 claude2feishu / hook / plugin
    then:
       tty = ps -p ppid -o tty=
       return { pid: ppid, tty: tty.replace("?", "") }

    currentPid = ppid

  return findClaudeProcess()

进程树示意:

  Claude Code (ttys002)          ← 目标
    └─ sh -c "notify.sh ..."     ← PPID 链经过这里
         └─ node notify.ts       ← 当前进程
```

`findMyClaudeProcess()` 是 SessionStart hook 的主路径。它利用 hook 子进程关系定位“触发当前 hook 的 Claude Code 进程”，避免多窗口时误选其他 Claude Code 终端。

`findClaudeProcess()` 是回退路径，全局搜索第一个匹配的 Claude Code 进程:

```
ps -eo pid,tty,command
  | grep -E "claude( |$)"     ← 匹配含 "claude" 的命令
  | grep -v grep               ← 排除 grep 自身
  | grep -v claude2feishu      ← 排除本工具进程
  | grep -v hook               ← 排除 hook 子进程
  | grep -v plugin             ← 排除 plugin 子进程

取第一行输出:
  12345 ttys002 /path/to/node /path/to/claude

解析:
  parts = line.trim().split(/\s+/)
  pid    = Number(parts[0])  // 12345
  tty    = parts[1]          // "ttys002" (去掉 "?" 前缀)

返回: { pid: 12345, tty: "ttys002" } 或 null
```

---

## 完整场景时序

### 场景 A: 正常入站（单个活跃 session，无引用）

```
T+0s   用户手机飞书 @机器人 "运行测试"
T+1s   feishu_bot 轮询到消息
       extractText() → "运行测试"
       getQuotedMessageId() → "" (无引用)
       listActive() → [session] (1 个活跃)
       detectState(transcript) → "waiting"
       sendToTerminal("ttys002", "运行测试")
         → AppleScript 找到 ttys002 所在 session/tab → 写入 "运行测试"
         → 返回 "ok"
       recordDelivery(sid, msgId)  ← 记录映射: session → 飞书消息 ID
       replyCard("✅ 已投递", ...)   ← 回复原始消息
T+1.5s 对应终端出现 "运行测试"，Claude Code 开始处理
T+N s  Claude Code 处理完毕 → Stop hook 触发
       notify.ts → getLastDelivery(sid) → 查到 msgId
       notify.ts → replyCard(msgId, "✅ Claude 已响应", ...)  ← 引用回复，形成线程
       clearDelivery(sid)  ← 清除映射
```

### 场景 B: 引用卡片精确路由到指定 session

```
前提: session-A (ttys002) 和 session-B (ttys003) 都在运行
     之前 session-A 发过卡片 om_card_A → card_session_map 有记录

T+0s   用户飞书引用 session-A 的卡片 → @机器人 "继续"
T+1s   feishu_bot 轮询到消息
       getQuotedMessageId(msg):
         body.reply_to.message_id = "om_card_A" → 返回 "om_card_A"
       lookupCardSession("om_card_A") → "session-A-uuid"
       handleSessionMessage(..., "session-A-uuid")
       session = getSession("session-A-uuid") → {tty: "ttys002"}
       detectState("ttys002" 的 transcript) → "waiting"
       sendToTerminal("ttys002", "继续") → ✅
T+1.5s "继续" 出现在 session-A (ttys002)，session-B 不受影响
```

### 场景 C: Claude 处理中收到消息（busy → 延迟投递）

```
T+0s   用户 @机器人 "运行测试"
       → sendToTerminal → Claude 开始处理
       → transcript: assistant + stop_reason="tool_use" → busy

T+3s   用户又 @机器人 "再检查一下"
       feishu_bot 轮询到第二条消息
       detectState() → "busy"
       enqueue(msg) → message_queue
       replyCard("⏳ 处理中，已排队", "当前任务执行中，指令已保存。...")

T+30s  Claude 处理完毕
       transcript: assistant + stop_reason="end_turn" → waiting
       Stop hook 触发 deliverNextPending()
       sendToTerminal("再检查一下") → ✅
       markDelivered(msgId)

T+31s  Claude 开始处理第二条消息
```

### 场景 D: Claude 刚启动，尚无交互对话

```
T+0s   用户在 iTerm 或 Terminal.app 启动 Claude Code
       SessionStart hook 触发
       notify.ts: findMyClaudeProcess() → {pid: 12345, tty: "ttys002"}
         (沿 PPID 链失败时回退 findClaudeProcess())
       notify.ts: registerSession({status: "active", pid: 12345, tty: "ttys002"})
       notify.ts: sendChatCard(" 已启动", ...) → card om_start
       registerCardSession("om_start", "session-uuid")
       transcript 文件中可能只有 system 消息，无 assistant/user 消息

T+2s   用户没有在 Claude 中输入任何内容
       用户从飞书 @机器人 "你好"

T+3s   feishu_bot 轮询到消息
       getQuotedMessageId() → "" (无引用)
       listActive() → [session-uuid] (进程存活)
       handleSessionMessage(..., "session-uuid")
       detectState(transcript) → 无有效 message → "gone"
       ⚡ isProcessAlive(12345) → true!
       ⚡ 降级: state = "waiting"
       sendToTerminal("ttys002", "你好") → ✅
       replyCard("✅ 已投递")
```

### 场景 E: 引用消息 ID 解析（body reply_to vs parent_id）

```
用户在话题中回复时，又显式引用了另一条消息:

飞书返回的消息结构:
{
  message_id: "om_new_msg",
  parent_id: "om_thread_parent",    // 话题中的父消息
  root_id: "om_thread_root",        // 话题根消息
  body: {
    content: '{"text":"继续","reply_to":{"message_id":"om_card_A"}}'
    // ↑ 用户显式引用的目标（可能是另一个 session 的卡片）
  }
}

getQuotedMessageId() 处理:
1. body.reply_to.message_id = "om_card_A" → 优先返回!
   ✅ 正确路由到 session-A

如果旧逻辑 (parent_id 优先):
1. parent_id = "om_thread_parent" → 先返回
   ❌ 可能路由到错误的 session
```

### 场景 F: 引用未命中 → 自动路由回退

```
T+0s   用户引用了一条普通消息（非卡片）发送 @机器人 "继续"
T+1s   feishu_bot 轮询到消息
       getQuotedMessageId(msg) → "om_normal_msg" (用户引用的普通消息)
       lookupCardSession("om_normal_msg") → "" (不是卡片，无映射)
       log "未在映射中找到 session ID"
       → 继续往下走（不阻断）

       listActive() → [session-A] (1 个活跃)
       → 自动路由到 session-A
       handleSessionMessage(..., "session-A-uuid")
       → sendToTerminal("继续")
```

### 场景 G: Claude 已退出

```
T+0s   用户关闭了 Claude Code

T+5s   用户飞书 @机器人 "运行测试"
       feishu_bot 轮询到消息
       listActive() → [] (进程已退出)
       → 通用 inbox: enqueue(...)
       → replyCard("📨 已收到，等待投递", "当前没有运行中的 Claude Code，指令已存入收件箱。")

T+60s  用户重新启动 Claude Code
       SessionStart hook 触发
       getInboxPending() → 有 1 条 pending
       sendNotification("📥 收件箱待处理", "1 条: 运行测试")
       deliverNextPending()
       sendToTerminal("运行测试") → ✅
       markDelivered(msgId)

       如果还有其他 pending 消息，等待下一次 Stop/SessionEnd hook 再投递
```

---

## 项目文件结构

```
src/
├── config.ts          # 配置加载
│                      #  - .env 文件解析 (简易 key=value parser)
│                      #  - 环境变量 + 文件变量合并
│                      #  - 常量定义 (API_BASE, DATA_DIR, 路径)
├── logger.ts          # 日志工具
│                      #  - 北京时间戳 (UTC+8)
│                      #  - 按级别图标 (DEBUG/INFO/WARN/ERROR)
│                      #  - 输出到 stderr (守护进程捕获到 LOG_FILE)
├── feishu_api.ts      # 飞书 Open API 客户端
│                      #  - Token 管理: tenant_access_token 自动刷新
│                      #  - listChats: GET /im/v1/chats
│                      #  - listChatMessages: GET /im/v1/messages
│                      #  - listReceivedMessages: 跨群聚合 @过滤
│                      #  - mentionsBot: mentions 数组检测 / 文本回退
│                      #  - extractText: text/post 消息文本提取
│                      #  - getQuotedMessageId: 引用消息 ID 解析
│                      #    (reply_to > quote > rich text > parent_id > root_id)
│                      #  - sendChatCard: 卡片 JSON 2.0 构建 + 发送
│                      #  - replyCard: 回复特定消息 + 发送卡片
│                      #  - registerCardSession / lookupCardSession:
│                      #    卡片→session 映射
├── feishu_bot.ts      # 轮询守护进程 (核心)
│                      #  - processNewMessages: 增量拉取 + 路由分发
│                      #  - handleSessionMessage: 状态感知发送
│                      #  - makeSessionMsg: 构造 QueuedMessage
│                      #  - pollLoop: 主循环 (每 N 秒)
│                      #  - writePid/removePid/isRunning: 进程管理
│                      #  - 诊断: message_dump.jsonl 写入
├── message_queue.ts   # 统一待投递队列
│                      #  - JSONL 读写 (message_queue.jsonl)
│                      #  - session_id 为空表示通用 inbox
│                      #  - getInboxPending / getPending / markDelivered
│                      #  - listPendingSessions / clearDelivered
├── delivery_orchestrator.ts
│                      #  - deliverNextPending: 每次最多投递一条可达消息
│                      #  - 优先级: 当前 session → inbox → 已退出 session
├── session_state.ts   # Session → 进程映射
│                      #  - JSON 读写 (session_states.json)
│                      #  - registerSession: 注册/更新 + 同 PID 去重
│                      #  - updateHeartbeat / markIdle / removeSession
│                      #  - getSession / findByPrefix: 查询
│                      #  - listActive: 活跃 session 列表 (含进程存活检测)
│                      #  - isProcessAlive: process.kill(pid, 0)
│                      #  - 自动清理 24h+ 无心跳记录
├── delivery_tracker.ts # 投递追踪
│                      #  - recordDelivery: 记录 session → 飞书消息 ID
│                      #  - getLastDelivery: 查询最近投递的飞书消息 ID
│                      #  - clearDelivery: 回复后清除记录
│                      #  - 存储: delivery_tracker.json
├── terminal.ts        # 终端交互 (macOS + iTerm / Terminal.app)
│                      #  - detectState: 读 transcript 判断 Claude 状态
│                      #  - sendToTerminal: AppleScript 发送文本到指定 TTY
│                      #  - findMyClaudeProcess: 沿 PPID 链定位当前 hook 所属 Claude 进程
│                      #  - findClaudeProcess: 全局 ps 查找 Claude Code 进程（回退）
│                      #  - detectTTY: tty 命令获取当前终端名
│                      #  - escapeAppleScript: AppleScript 字符串转义
├── notify.ts          # Hook 入口 + Session 生命周期管理
│                      #  - readHookStdin: 从 stdin 读取 hook JSON
│                      #  - buildContext: 构建通知卡片内容 (项目/分支/模型/主机)
│                      #  - getModel: 从 transcript 提取模型名
│                      #  - getModelOutput: 提取 Claude 最后输出
│                      #  - getGitContext: git branch + commit
│                      #  - getHostname: macOS 友好名称/通用 hostname
│                      #  - describeToolInput: 工具参数人类可读摘要
│                      #  - toolLabel: 工具名中文映射
│                      #  - SessionStart: 注册 session + 单条队列投递
│                      #  - Stop/StopFailure: 查 delivery_tracker → replyCard 引用
│                      #    回复原始飞书消息, 无记录则 sendChatCard 新消息
│                      #  - SessionEnd: 标记空闲 + 单条队列投递
└── cli.ts             # 统一 CLI 入口
                       #  - daemon 模式: spawn 子进程 + stdio 重定向
                       #  - 守护进程管理: start/stop/restart/status
                       #  - Inbox 管理: inbox/pop/done/reply/clear
                       #  - Session 管理: session-list/state/queue/send
                       #  - 测试: test / test-webhook / test-api
tests/
├── feishu_api.test.ts       # @过滤 + 卡片 payload 大小
├── feishu_bot.test.ts       # 收件箱降级回复文案
├── message_queue.test.ts    # inbox/session pending 语义
└── delivery_orchestrator.test.ts # 单条队列投递
```

## License

MIT
