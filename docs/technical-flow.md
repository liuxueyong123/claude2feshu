# claude2feishu 技术流程文档

> 版本: 2.0.0 | 最后更新: 2026-06-07

---

## 目录

1. [项目概述](#1-项目概述)
2. [系统架构](#2-系统架构)
3. [核心流程](#3-核心流程)
   - [3.1 飞书 → Claude 消息投递](#31-飞书--claude-消息投递)
   - [3.2 Claude → 飞书 通知推送](#32-claude--飞书-通知推送)
   - [3.3 Session 生命周期管理](#33-session-生命周期管理)
   - [3.4 消息队列与投递编排](#34-消息队列与投递编排)
   - [3.5 完整交互时序](#35-完整交互时序)
4. [模块详解](#4-模块详解)
   - [4.1 配置模块](#41-配置模块-srcutilsconfigts)
   - [4.2 存储模块](#42-存储模块-srcutilsstoragets)
   - [4.3 日志模块](#43-日志模块-srcutilsloggerts--request-loggerts)
   - [4.4 终端交互模块](#44-终端交互模块-srcutilsterminalts)
   - [4.5 飞书 API 模块](#45-飞书-api-模块-srcfeishuapits)
   - [4.6 轮询 Bot 模块](#46-轮询-bot-模块-srcbotindexts)
   - [4.7 通知模块](#47-通知模块-srcnotifyindexts)
   - [4.8 Session 管理模块](#48-session-管理模块-srcsession)
   - [4.9 HTTP 路由层](#49-http-路由层-srcroutests)
   - [4.10 服务管理模块](#410-服务管理模块-srcscriptsservicets)
   - [4.11 Hook 配置工具](#411-hook-配置工具-srcscriptssetup-hooksts)
5. [数据持久化](#5-数据持久化)
6. [Claude Code Hook 系统](#6-claude-code-hook-系统)
7. [HTTP API 参考](#7-http-api-参考)
8. [消息路由策略](#8-消息路由策略)
9. [终端注入原理](#9-终端注入原理)
10. [安全设计](#10-安全设计)
11. [部署与运维](#11-部署与运维)
12. [故障排查指南](#12-故障排查指南)

---

## 1. 项目概述

### 1.1 定位

claude2feishu 是一个 **Node.js 中间件服务**，实现 Claude Code（终端中的 AI 编程助手）与飞书群聊之间的**双向实时通信**。

核心场景：用户在飞书群里 @机器人 发送指令 → 服务自动将指令注入到本机 Claude Code 终端 → Claude 处理过程中，Hook 事件（启动、完成、失败、权限请求等）通过飞书卡片消息实时通知到群里。

### 1.2 核心能力

| 能力 | 说明 |
| --- | --- |
| 飞书 → Claude | 轮询飞书 API 获取 @消息，自动路由到目标 Claude 会话并注入终端键盘输入 |
| Claude → 飞书 | 通过 Claude Code Hook 机制回传 7 类事件，构建富文本卡片推送到飞书群 |
| 消息队列 | Claude 忙碌/离线时消息自动入队，Hook 触发时自动逐条投递 |
| 多 Session 管理 | 支持多个 Claude Code 实例同时运行，消息精确路由到对应 Session |
| Card → Session 映射 | 飞书卡片消息 ID 与 Claude Session ID 双向映射，支持引用回复精确路由 |
| 通用收件箱 | 无活跃 Session 时的消息降级存储，支持手动取出指令 |

### 1.3 技术栈

| 层级 | 技术 |
| --- | --- |
| 运行时 | Node.js 22+ |
| 语言 | TypeScript 6.0 (ES2022, ESM) |
| HTTP 框架 | Koa 3.x + @koa/router |
| 进程管理 | 后台守护进程 (spawn + pid 文件) |
| 终端注入 | AppleScript (iTerm2 / Terminal.app) |
| 外部 API | 飞书 Open API (tenant_access_token 认证) |
| 数据持久化 | JSON 文件存储 (内存为主，退出时落盘) |
| 包管理 | pnpm |

### 1.4 项目目录结构

```text
claude2feishu/
├── src/
│   ├── index.ts              # 进程入口，仅调用 startService()
│   ├── app.ts                # Koa 应用组装（中间件、路由、健康检查）
│   ├── server.ts             # 服务生命周期（加载/持久化、pid、监听、信号、轮询）
│   ├── utils/
│   │   ├── config.ts         # dotenv 统一配置入口
│   │   ├── logger.ts         # 统一日志（stderr，北京时间戳）
│   │   ├── request-logger.ts # HTTP 请求日志中间件
│   │   ├── storage.ts        # 运行时内存状态 + JSON 持久化
│   │   └── terminal.ts       # Claude 状态检测、进程发现、AppleScript 终端注入
│   ├── scripts/
│   │   ├── service.ts        # 本地服务管理（start/stop/status/logs）
│   │   └── setup-hooks.ts    # Claude Code hooks 自动配置工具
│   ├── bot/
│   │   ├── index.ts          # 飞书消息轮询主逻辑、Session 路由、入站处理
│   │   └── routes.ts         # Daemon 控制接口（/daemon/*）
│   ├── feishu/
│   │   ├── api.ts            # 飞书 Open API 客户端（认证/消息/卡片/映射）
│   │   └── routes.ts         # 飞书 API 测试接口（/test/*）
│   ├── notify/
│   │   ├── index.ts          # Hook 事件处理、通知构建、Session 生命周期管理
│   │   └── routes.ts         # Hook 和 Inbox HTTP 接口
│   └── session/
│       ├── state.ts          # Session 注册、心跳、活跃进程过滤
│       ├── queue.ts          # 统一消息队列（入队/查询/标记完成/清理）
│       ├── delivery.ts       # 投递追踪 + 单条投递编排
│       └── routes.ts         # Session 查询和手动投递接口
├── tests/                    # Node test 测试套件（12 个测试文件）
├── data/                     # 运行时数据目录（JSON 持久化文件）
├── docs/                     # 文档
├── package.json
└── tsconfig.json
```

---

## 2. 系统架构

### 2.1 架构总览

```text
┌──────────────────────────────────────────────────────────────────┐
│                        飞书云端                                   │
│  ┌──────────┐    ┌──────────────┐    ┌─────────────────────────┐ │
│  │ 飞书群聊  │───▶│ 飞书 Open API │◀───│ 消息接收 / 卡片发送      │ │
│  │ @机器人   │    │ (im/v1)      │    │ (tenant_access_token)   │ │
│  └──────────┘    └──────────────┘    └─────────────────────────┘ │
└──────────────────────────────────────────────────────────────────┘
                          │                         ▲
                  HTTP轮询 │                         │ HTTP POST
                  (每3秒)  │                         │ (卡片消息)
                          ▼                         │
┌──────────────────────────────────────────────────────────────────┐
│                   claude2feishu 本地服务                          │
│                   (Koa HTTP Server :9876)                         │
│                                                                  │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐   │
│  │ Bot 轮询  │  │ 消息队列  │  │ Session  │  │ 通知/Hook     │   │
│  │ 处理器    │─▶│ (Queue)  │  │ 管理器    │  │ 事件处理器     │   │
│  └──────────┘  └──────────┘  └──────────┘  └───────────────┘   │
│       │              │              │               ▲            │
│       ▼              ▼              ▼               │            │
│  ┌──────────────────────────────────────────────────────────┐    │
│  │              统一存储层 (Storage)                         │    │
│  │   sessions[] | messages[] | delivery{} | cardMap | ckpt  │    │
│  └──────────────────────────────────────────────────────────┘    │
│       │              │              │               │            │
│       ▼              ▼              ▼               ▼            │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌───────────────┐   │
│  │ JSON 文件 │  │ JSON 文件 │  │ JSON 文件 │  │ JSON 文件     │   │
│  │sessions. │  │messages. │  │delivery. │  │card_map.json  │   │
│  │json      │  │json      │  │json      │  │checkpoint.json│   │
│  └──────────┘  └──────────┘  └──────────┘  └───────────────┘   │
└──────────────────────────────────────────────────────────────────┘
                          │                         ▲
            AppleScript   │                         │ curl POST
            键盘注入      │                         │ (Hook 回调)
                          ▼                         │
┌──────────────────────────────────────────────────────────────────┐
│                    本机终端模拟器                                  │
│  ┌──────────────────────────────────────────────────────┐        │
│  │  iTerm2 / Terminal.app                               │        │
│  │  ┌────────────────────────────────────────────────┐  │        │
│  │  │  Claude Code 进程 (ttys001)                     │  │        │
│  │  │  - 接收键盘输入 (write text / do script)         │──┼────────│──▶ ~/.claude/settings.json
│  │  │  - 处理完成后触发 Hook (curl → POST /hook)       │  │        │   (Hook 配置)
│  │  └────────────────────────────────────────────────┘  │        │
│  └──────────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────┘
```

### 2.2 数据流方向

```text
飞书 → Claude (入站):
  飞书群 @消息 → 飞书 Open API → Bot 轮询拉取 → @过滤 → 文本提取
  → Session 路由 → 状态检测 → [等待中: AppleScript 注入] / [忙碌/离线: 入队]
  → Claude Code 终端接收输入 → AI 处理

Claude → 飞书 (出站):
  Claude Code Hook 触发 → curl POST /hook → 事件处理
  → 上下文构建 (项目/分支/主机/模型/事件详情) → 飞书卡片消息
  → POST /im/v1/messages (回复/群发) → 飞书群聊展示
```

### 2.3 核心设计原则

1. **不可变数据 (Immutability)**: 所有状态更新使用扩展运算符创建新对象/数组，绝不原地修改。参见 `src/session/state.ts` 和 `src/session/queue.ts` 中的 `storage.sessions = storage.sessions.map(...)` 模式。

2. **内存为主，退出落盘**: 运行时所有状态保存在 `Storage` 类的内存属性中。仅在收到 SIGTERM/SIGINT 信号或调用 `persist()` 时写入 JSON 文件。持久化时自动清理超过 24 小时无心跳的 Session。

3. **单条投递 (One-at-a-time)**: 队列每次只投递一条消息。投递完成后，下一条由后续 Hook 事件触发。这种设计避免了在 Claude 处理中连续注入多条指令。

4. **Fire-and-Forget 通知**: Hook 事件处理中的后台投递（`deliverNextInBackground`）以 `void` 启动，不阻塞 Hook HTTP 响应。Claude Code 的 Hook 机制要求快速返回 (< 10s)，因此通知和投递采用异步分离。

5. **回退降级 (Graceful Degradation)**: 终端注入失败 → 入队；Session 不存在 → 入队；进程退出 → 入队并通知用户。系统中每个失败路径都有对应的降级策略。

---

## 3. 核心流程

### 3.1 飞书 → Claude 消息投递

这是系统最主要的入站流程，从飞书群聊消息到 Claude Code 终端输入。

#### 3.1.1 轮询机制

```text
┌──────────────────────────────────────────────────────────────┐
│                    Poll Loop 主循环                            │
│                                                              │
│  startPolling()                                               │
│       │                                                      │
│       ▼                                                      │
│  ┌──────────┐    每 N 秒 (默认 3s)    ┌──────────────────┐   │
│  │  running  │──────────────────────▶│ processNewMessages│   │
│  │  = true   │◀─────────────────────│     ()            │   │
│  └──────────┘                       └──────┬───────────┘   │
│       │                                    │               │
│       │ 异常 > 10 次连续                    ▼               │
│       │ → 暂停 30s              ┌──────────────────────┐    │
│       │                         │ 1. listReceivedMsgs  │    │
│       │                         │    (飞书 API 拉取)    │    │
│       │                         │ 2. 与 checkpint 比对  │    │
│       │                         │    找到新消息         │    │
│       │                         │ 3. 按时间正序处理      │    │
│       │                         │ 4. 每条消息 →         │    │
│       │                         │    handleSessionMsg() │    │
│       │                         │ 5. 更新 checkpint     │    │
│       │                         └──────────────────────┘    │
│       │                                                    │
│       ▼                                                    │
│  stopPolling() → running = false → 循环退出                  │
└──────────────────────────────────────────────────────────────┘
```

#### 3.1.2 消息处理详细决策树

```
每条新消息的处理决策树:

消息到达
  │
  ├─ mentionsBot() 检查是否 @机器人?
  │   └─ NO  → 跳过
  │   └─ YES → extractText() 提取纯文本，去除 @前缀
  │
  ├─ 消息为空?
  │   └─ YES → 跳过
  │
  ├─ 有引用消息 (reply_to / parent_id / root_id)?
  │   ├─ YES → lookupCardSession(quotedMsgId)
  │   │         └─ 命中 → handleSessionMessage(sid) [精确路由]
  │   │         └─ 未命中 → 继续下一步
  │   └─ NO  → 继续下一步
  │
  ├─ listActive() 有活跃 Session?
  │   ├─ YES → 取最近启动的 Session
  │   │         → handleSessionMessage(sid) [自动路由]
  │   └─ NO  → 入队到通用 Inbox (session_id = undefined)
  │             → replyCard("📨 已收到，等待投递")
  │
  └─ handleSessionMessage(sid) 内部分支:
       │
       ├─ getSession(sid) / findByPrefix(sid) 未找到?
       │   └─ 入队 (session_id = sid) → replyCard("已入队")
       │
       ├─ Session 无 transcript_path?
       │   └─ 入队 (session_id = sid) → replyCard("已入队")
       │
       ├─ detectState(transcript_path) 检测 Claude 状态:
       │   ├─ "waiting" → sendToTerminal(tty, text)
       │   │   ├─ 成功 → replyCard("已投递") → recordDelivery()
       │   │   └─ 失败 → 入队 → replyCard("投递失败")
       │   ├─ "busy"  → 入队 → replyCard("已排队")
       │   └─ "gone"  → 入队 → replyCard("已入队")
       │       └─ 例外: 若 isProcessAlive(pid) → 降级为 "waiting"
       │
       └─ 入队消息特性:
            - 有 session_id → 绑定到特定 Session 队列
            - 无 session_id → 通用 Inbox (后续任意 Session 可消费)
```

#### 3.1.3 飞书 API 拉取细节

```text
listReceivedMessages(pageSize=20, onlyMentions=true)
  │
  ├─ 获取机器人 open_id (缓存)
  │
  ├─ listChats() 获取所有群聊
  │   └─ GET /im/v1/chats?page_size=50
  │
  ├─ 对每个群聊:
  │   └─ listChatMessages(chatId, pageSize)
  │       └─ GET /im/v1/messages
  │            ?container_id_type=chat
  │            &container_id={chatId}
  │            &page_size=20
  │            &sort_type=ByCreateTimeDesc
  │
  ├─ mentionsBot() 过滤 @机器人消息
  │
  └─ 按 create_time 降序排列，取前 pageSize 条
```

### 3.2 Claude → 飞书 通知推送

#### 3.2.1 Hook 触发机制

Claude Code 在关键事件发生时，通过 `~/.claude/settings.json` 中配置的 Hook 自动执行 curl 命令：

```bash
curl -s -X POST "http://127.0.0.1:9876/hook?title=Claude%20已启动&type=info" \
  --data-binary @- \
  -H 'Content-Type: application/json'
```

Claude Code 通过 stdin 管道传入 JSON 事件数据。

#### 3.2.2 事件处理流程

```text
POST /hook?title=...&type=...
  │
  ▼
processHookEvent(event, title, message, type)        [src/notify/index.ts]
  │
  ├─ 通知过滤:
  │   └─ PostToolUseFailure + Bash? → 静默丢弃 (探索性错误)
  │
  ├─ buildContext(event)  构建上下文信息:
  │   ├─ 📁 项目名 + 🌿 Git 分支/commit
  │   ├─ 💻 主机名 (macOS友好名称)
  │   ├─ 🧠 模型名称 (从 transcript 提取)
  │   ├─ 🔗 Session ID
  │   └─ 事件特定详情:
  │       ├─ Stop         → 💬 模型最终输出
  │       ├─ StopFailure  → 💥 错误原因
  │       ├─ PermissionRequest → 🛠 工具 + 参数摘要 + 模型输出
  │       ├─ PermissionDenied → 🚫 被拒绝的工具
  │       ├─ Elicitation   → ❓ Claude 的提问
  │       └─ PostToolUseFailure → 🔧 失败工具 + 错误信息
  │
  ├─ 消息截断: 飞书卡片 JSON 上限 30KB，内容截断到 24KB 安全区
  │
  ├─ 通知发送:
  │   ├─ Stop/StopFailure + 有原始飞书消息?
  │   │   └─ YES → replyCard() 引用回复 (形成对话线程)
  │   │   └─ NO  → sendChatCard() 群发新卡片
  │   └─ 其他事件 → sendChatCard()
  │
  ├─ Session 生命周期:
  │   ├─ SessionStart → findMyClaudeProcess() 发现进程
  │   │   ├─ registerSession() 注册
  │   │   ├─ 展示 Inbox 待处理数量
  │   │   └─ deliverNextInBackground() 后台投递一条
  │   ├─ Stop/StopFailure/SessionEnd → markIdle()
  │   │   ├─ deliverNextInBackground() 尝试投递
  │   │   └─ 展示 Session 待处理消息数量
  │   └─ 其他事件 → 仅通知，不改变状态
  │
  └─ 返回 { ok: true }  (10秒内必须返回)
```

#### 3.2.3 支持的 Hook 事件

| Hook 事件 | 含义 | 飞书卡片颜色 | 特殊处理 |
| --- | --- | --- | --- |
| `SessionStart` | Claude 会话启动 | 蓝色 (info) | 注册 Session，触发队列投递 |
| `Stop` | 任务正常完成 | 绿色 (success) | 引用回复，展示模型输出，markIdle |
| `StopFailure` | 异常终止 | 红色 (error) | 引用回复，展示错误原因，markIdle |
| `PermissionRequest` | 等待用户确认操作 | 黄色 (warning) | 展示工具名、参数摘要、模型意图 |
| `PermissionDenied` | 操作被拒绝 | 红色 (error) | 展示被拒绝的工具 |
| `Elicitation` | Claude 等待用户输入 | 黄色 (warning) | 展示 Claude 的提问 |
| `PostToolUseFailure` | 工具执行失败 | 红色 (error) | **Bash 错误默认过滤**，其余展示工具名+错误 |

#### 3.2.4 Bash 错误过滤逻辑

```
PostToolUseFailure 事件的特殊处理:
  原因: Claude 的 Bash 操作经常是探索性的（如 ls 不存在路径、git 无变更），
        它会自行消化错误并重试，无需推送通知打断用户。

  规则: event.tool_name === "Bash" 且未携带 include-bash-errors 参数
         → 静默丢弃，仅 DEBUG 日志记录
```

### 3.3 Session 生命周期管理

#### 3.3.1 Session 状态模型

```typescript
interface SessionState {
  session_id: string;      // Claude Code UUID
  pid: number;             // 进程 ID
  tty: string;             // 终端 TTY 设备名 (如 ttys001)
  transcript_path: string; // transcript JSONL 文件路径
  status: "active" | "idle";
  started_at: string;      // ISO 时间戳
  last_heartbeat: string;  // ISO 时间戳
}
```

#### 3.3.2 Session 状态机

```text
                    SessionStart Hook
                         │
                         ▼
                   ┌──────────┐
                   │  active  │ ◄── findMyClaudeProcess() 发现进程
                   └────┬─────┘     registerSession()
                        │
          Stop / StopFailure / SessionEnd Hook
                        │
                        ▼
                   ┌──────────┐
                   │   idle   │ ◄── markIdle()
                   └────┬─────┘
                        │
              下次 SessionStart
          (同一 pid 的旧 Session 会被标记为 idle)
                        │
                        ▼
                   ┌──────────┐
                   │  active  │ (新 Session，旧 Session 仍保留)
                   └──────────┘

持久化时:
  - 超过 24 小时无心跳的 Session → 自动清理
  - 通过 isProcessAlive(pid) 过滤已退出进程
```

#### 3.3.3 Claude 状态检测

通过读取 transcript JSONL 文件的最后几行，判断 Claude Code 当前状态：

```text
detectState(transcriptPath) → "waiting" | "busy" | "gone"

检测逻辑（从后往前扫描 JSONL）:

1. 最后一条 assistant 消息:
   ├─ stop_reason = "end_turn"    → "waiting" (空闲，可接收新指令)
   ├─ stop_reason = "tool_use"    → "busy"   (正在执行工具)
   ├─ stop_reason = "max_tokens"  → "busy"
   └─ 其他 / 无 stop_reason      → "busy"

2. 最后一条 user 消息:
   ├─ 时间戳 < 5分钟             → "busy"   (等待 assistant 响应)
   └─ 时间戳 > 5分钟             → "gone"   (进程可能已退出)

3. 文件不存在 / 无有效 message   → "gone"
```

**特殊回退**: 当 `detectState` 返回 `"gone"` 但 `isProcessAlive(pid)` 返回 `true` 时，降级为 `"waiting"`。这处理了刚启动尚无交互消息的 Claude 实例。

### 3.4 消息队列与投递编排

#### 3.4.1 队列模型

```typescript
interface QueuedMessage {
  id: string;           // 飞书消息 ID (om_xxx)
  chat_id: string;      // 群聊 ID
  sender: string;       // 发送者 open_id
  content: string;      // 指令文本
  session_id?: string;  // 目标 Session (undefined = 通用 Inbox)
  received_at: string;  // 接收时间
  status: "pending" | "delivered";
  delivered_at?: string;
}
```

#### 3.4.2 队列消费优先级

当投递触发时（Hook 事件），消息按以下优先级消费：

```text
deliverNextPending() 消费优先级:

1. 当前 Session 绑定的 pending 消息 (session_id === 当前 sid)
2. 通用 Inbox 消息 (session_id === undefined)
3. 已死亡 Session 的遗留消息 (其 Session 进程已退出)

每条 Hook 事件仅投递 1 条消息。
```

#### 3.4.3 投递编排流程

```text
deliverNextPending(deps)
  │
  ├─ collectMessages(sessionId) 按优先级收集待投递消息
  │   ├─ 无消息? → { sent: 0, reason: "done" }
  │   └─ 有消息? → 继续
  │
  ├─ normalizeState() 检测 Claude 状态
  │   ├─ "gone" + 进程存活 → 降级为 "waiting"
  │   ├─ "busy" → { sent: 0, reason: "busy", remaining: N }
  │   └─ "waiting" → 继续
  │
  ├─ sendToTerminal(tty, content) 终端注入
  │   ├─ 失败 → replyCard("投递失败") → { sent: 0, reason: "send_failed" }
  │   └─ 成功 → 继续
  │
  ├─ markDelivered(msgId)    标记消息为已投递
  ├─ recordDelivery(sid, msgId)  记录投递追踪 (用于 Stop 引用回复)
  └─ replyCard("已投递")     发送确认卡片
```

#### 3.4.4 投递追踪 (Delivery Tracking)

```text
recordDelivery(sessionId, msgId):
  记录 session 最近一次投递的飞书消息 ID。

用途：当 Claude 任务完成 (Stop Hook) 时:
  - getLastDelivery(sessionId) 获取最近的 msgId
  - replyCard(msgId, ...) 引用回复该消息
  - clearDelivery(sessionId) 清除记录

这样 Stop 通知就出现在原始飞书指令的正下方，形成对话线程。
```

### 3.5 完整交互时序

以下是一次典型交互的完整时序：

```text
飞书群              飞书API         claude2feishu        终端              Claude Code
  │                   │                  │                  │                   │
  │  用户 @机器人      │                  │                  │                   │
  │  "帮我重构代码"    │                  │                  │                   │
  │                   │                  │                  │                   │
  │                   │  ◄─── 轮询拉取 ──│ (每3秒)          │                   │
  │                   │  ─── 返回消息 ──▶│                  │                   │
  │                   │                  │                  │                   │
  │                   │                  │─ mentionsBot()   │                   │
  │                   │                  │─ extractText()   │                   │
  │                   │                  │─ listActive()    │                   │
  │                   │                  │─ detectState() ──│── 读 transcript ─▶│
  │                   │                  │  ◀── "waiting" ──│                   │
  │                   │                  │                  │                   │
  │                   │                  │─ sendToTerminal()──▶ AppleScript      │
  │                   │                  │                  │   write text      │
  │                   │                  │                  │                   │
  │ ◄─── 卡片 ──────────────────────────│  replyCard()     │  ── "帮我重构代码"▶│
  │    "✅ 已投递"     │                  │  "✅ 已投递"     │  (键盘注入)        │
  │                   │                  │                  │                   │
  │                   │                  │                  │       │           │
  │                   │                  │                  │       │ AI 处理   │
  │                   │                  │                  │       │           │
  │                   │                  │                  │  ◄── Hook 触发 ──│
  │                   │                  │  ◄── POST /hook ──│     SessionStart │
  │                   │                  │                  │                   │
  │                   │                  │  processHookEvent │                   │
  │                   │                  │  buildContext()   │                   │
  │                   │                  │  sendChatCard()   │                   │
  │                   │                  │                  │                   │
  │ ◄─── 卡片 ───────────────────────────────────────────────│                   │
  │  "Claude 已启动"  │                  │                  │                   │
  │  📁 项目: myapp  │                  │                  │                   │
  │  🌿 分支: main   │                  │                  │                   │
  │  💻 主机: MacBook│                  │                  │                   │
  │  🧠 模型: opus   │                  │                  │                   │
  │                   │                  │                  │                   │
  │       .           │                  │                  │       .           │
  │       .           │                  │                  │       .           │
  │       .           │                  │                  │       .           │
  │                   │                  │                  │                   │
  │                   │                  │                  │  ◄── Hook 触发 ──│
  │                   │                  │  ◄── POST /hook ──│       Stop      │
  │                   │                  │                  │                   │
  │ ◄─── 引用回复 ──────────────────────────────────────────│                   │
  │  "任务完成"       │                  │                  │                   │
  │  💬 模型输出:     │                  │                  │                   │
  │  ```已重构...```  │                  │                  │                   │
```

---

## 4. 模块详解

### 4.1 配置模块 (`src/utils/config.ts`)

**职责**: 统一加载 `.env` 环境变量，提供唯一配置访问点。

```text
dotenv/config → process.env → loadConfig()
                                │
                                ├─ FEISHU_APP_ID          → appId
                                ├─ FEISHU_APP_SECRET      → appSecret
                                ├─ FEISHU_CHAT_ID         → chatId
                                ├─ FEISHU_NOTIFYD_PORT    → port (默认 9876)
                                ├─ FEISHU_NOTIFYD_HOST    → host (默认 127.0.0.1)
                                ├─ FEISHU_POLL_INTERVAL   → pollInterval (默认 3s)
                                ├─ FEISHU_LOG_LEVEL       → logLevel (默认 INFO)
                                ├─ FEISHU_DATA_DIR        → dataDir (默认 ./data)
                                ├─ apiBase                 → "https://open.feishu.cn/open-apis"
                                ├─ tzOffset                → 8 (北京时间)
                                ├─ requestTimeoutMs        → 15000
                                ├─ pidFile                 → {dataDir}/service.pid
                                └─ logFile                 → {dataDir}/service.log
```

**设计要点**:
- 使用 `as const` 确保配置对象只读
- 整个项目不直接读取 `process.env`，全部通过 `config` 对象
- 无凭证时返回空字符串，服务仍可启动（仅打印警告）

### 4.2 存储模块 (`src/utils/storage.ts`)

**职责**: 统一管理所有运行时内存状态，提供 load/persist/reset 生命周期方法。

```text
Storage 类
  ├─ sessions: SessionState[]         ←→ data/sessions.json
  ├─ messages: QueuedMessage[]        ←→ data/messages.json
  ├─ delivery: Record<string, {msgId, timestamp}>
  │                                   ←→ data/delivery.json
  ├─ cardMap: Map<string, CardEntry>  ←→ data/card_map.json
  ├─ lastMsgId: string               ┐
  └─ lastMsgTime: string             ┘←→ data/checkpoint.json

生命周期:
  load()     → 从 JSON 文件恢复到内存 (启动时)
  persist()  → 从内存写入 JSON 文件 (退出时 / SIGTERM / SIGINT)
  reset()    → 清空所有内存状态 (测试用)
```

**不可变更新模式**: 所有对 storage 属性的修改都通过模块层的函数完成（如 `registerSession`、`enqueue`、`markDelivered`），这些函数使用 `map`/`filter`/扩展运算符创建新数组/对象后整体替换。

**持久化优化**:
- `persist()` 时自动清理 `last_heartbeat` 超过 24 小时的 Session
- `cardMap` 使用 `Map` 类型在内存中高效查找，序列化时转为 `[key, value][]` 数组
- 文件读写失败静默忽略（不阻塞服务）

### 4.3 日志模块 (`src/utils/logger.ts` + `request-logger.ts`)

**logger.ts**:
```
log(msg, level)
  │
  ├─ 时间戳: 北京时间 (UTC+8)，格式 YYYY-MM-DD HH:mm:ss
  ├─ 级别图标: DEBUG=空, INFO=📡, WARN=⚠️, ERROR=❌
  └─ 输出: process.stderr (不污染 stdout)
```

**request-logger.ts**: Koa 中间件，记录每个 HTTP 请求的方法、URL、状态码、耗时和响应长度。使用洋葱模型在请求/响应两侧计时。

### 4.4 终端交互模块 (`src/utils/terminal.ts`)

#### 4.4.1 核心函数

| 函数 | 用途 | 调用场景 |
| --- | --- | --- |
| `detectState(transcriptPath)` | 读取 transcript 判断 Claude 状态 | 轮询处理、投递编排 |
| `sendToTerminal(tty, message)` | 通过 AppleScript 向终端注入键盘输入 | 轮询处理、队列投递 |
| `findClaudeProcess()` | 全局搜索 Claude 进程 | 回退方案 |
| `findMyClaudeProcess()` | 沿进程树向上查找 Claude 进程 | SessionStart Hook 处理 |
| `detectTTY()` | 获取当前终端的 TTY 名称 | 调试 |

#### 4.4.2 终端注入原理

**为什么不能直接用 PTY?**

```
PTY (Pseudo Terminal) 数据方向:
  Keyboard → Master → Slave → 进程 stdin   (输入方向)
  进程 stdout → Slave → Master → 终端显示    (输出方向)

直接写 /dev/ttys001 (slave):
  write() → slave → master → 屏幕显示 ✓
  但无法注入进程 stdin ✗

正确做法: 通过终端模拟器的 AppleScript 接口，模拟键盘输入:
  iTerm2:    tell session "ttys001" to write text "hello"
  Terminal:  do script "hello" in tab "ttys001"
```

#### 4.4.3 AppleScript 注入策略

**策略 1: iTerm2 (优先)**

```applescript
if application "iTerm" is not running then return "not_running"
tell application "iTerm"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if (tty of s) ends with "ttys001" then
          tell s
            write text "用户指令"
          end tell
          return "ok"
        end if
      end repeat
    end repeat
  end repeat
  return "not_found"
end tell
```

优点: `write text` 不抢焦点，后台静默注入。

**策略 2: Terminal.app (回退)**

```applescript
if application "Terminal" is not running then return "not_running"
tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if (tty of t) ends with "ttys001" then
        do script "用户指令" in t
        return "ok"
      end if
    end repeat
  end repeat
  return "not_found"
end tell
```

#### 4.4.4 进程发现机制

**方法 1: 进程树向上查找 (`findMyClaudeProcess`)**

在 Hook 执行上下文中使用，从当前进程沿 PPID 链向上查找：

```
进程树:
  Claude Code (ttys002, pid=12345)        ← 目标
    └─ sh -c "hook_command..."            ← Hook 子进程
         └─ curl ...                      ← Hook 命令

算法: process.pid → ps -p {pid} -o ppid= → 逐级向上
      直到找到包含 "claude" 且不是 claude2feishu/hook/plugin 的进程
      最多向上查找 10 级
      回退: 全局 findClaudeProcess()
```

**方法 2: 全局搜索 (`findClaudeProcess`)**

```bash
ps -eo pid,tty,command | grep -E "claude( |$)" | grep -v grep | grep -v "claude2feishu" | grep -v "hook" | grep -v "plugin"
```

取第一个匹配结果。适用于非 Hook 上下文（如轮询处理中的 Session 路由）。

#### 4.4.5 字符串转义

```
escapeAppleScript(s):
  1. \ → \\  (反斜杠)
  2. " → \"  (双引号)
  3. \n → 空格 (write text 自带回车)
  4. \r → 空  (移除)
```

### 4.5 飞书 API 模块 (`src/feishu/api.ts`)

#### 4.5.1 认证流程

```
getToken()
  │
  ├─ 缓存有效 (expiresAt > now + 60s)?
  │   └─ YES → 直接返回缓存 token
  │
  └─ NO → POST /auth/v3/tenant_access_token/internal
            { app_id, app_secret }
            │
            ├─ code=0 → 缓存 token + expiresAt
            └─ code≠0 → 返回空字符串，调用方降级
```

#### 4.5.2 API 请求封装

```typescript
async function req(method, path, body?, params?, auth=true):
  1. 构建 URL: config.apiBase + path + query params
  2. 获取 token (如果 auth=true)
  3. fetch() 请求，15 秒超时 (AbortController)
  4. 返回 [code, data] 元组
  5. 异常时返回 [-1, { error: String(e) }]
```

#### 4.5.3 @提及检测流程

```
mentionsBot(msg, botId)
  │
  ├─ 优先: 检查 msg.mentions[] 数组 (飞书结构化字段)
  │   └─ 遍历 mentions，提取 open_id 与 botId 比对
  │
  └─ 回退: 检查 body.content JSON 文本
      └─ 解析 content JSON
          ├─ text 字段包含 @ → 检查是否包含 botId
          └─ 递归遍历 content 对象 (处理富文本 post)
              └─ 查找 tag="at" 节点 → 比对 user_id / open_id
```

#### 4.5.4 引用消息解析

```
getQuotedMessageId(msg)
  │
  ├─ 1) 正文内显式引用 (优先级最高)
  │   └─ body.content JSON 中的 reply_to.message_id 或 quote.message_id
  │      或递归查找 tag="quote"/"reply" 的富文本节点
  │
  ├─ 2) 线程父消息 (parent_id) — 用户在话题中直接回复
  │
  └─ 3) 线程根消息 (root_id) — 话题起始消息
```

#### 4.5.5 卡片消息构建与截断

```
buildCard(title, content, color)
  │
  ├─ rawCard() 构建完整卡片 JSON (飞书卡片 JSON 2.0)
  │   schema: "2.0"
  │   header: { title (plain_text), template (color) }
  │   body: { elements: [markdown content, hr, timestamp footer] }
  │
  ├─ 检查字节长度 ≤ 30KB?
  │   └─ YES → 直接返回
  │
  └─ NO → 二分查找最大可容纳内容长度 → 截断内容 + "…"
```

#### 4.5.6 Card → Session 映射

```
registerCardSession(messageId, sessionId):
  将发送的飞书卡片消息 ID 与 Claude Session ID 关联
  存储: storage.cardMap (Map 类型，不可变替换)

lookupCardSession(quotedMessageId):
  根据引用的消息 ID 查找对应的 Session ID
  用途: 用户引用卡片回复时，精确路由回原 Session
```

### 4.6 轮询 Bot 模块 (`src/bot/index.ts`)

#### 4.6.1 轮询生命周期

```
startPolling()
  ├─ 检查 polling 标志 (防止重复启动)
  ├─ running = true, polling = true
  └─ pollLoop() → 异步循环

pollLoop():
  while (running) {
    try { processNewMessages(); errors = 0; }
    catch { errors++; if (errors > 10) { 暂停 30s; errors = 0; } }
    sleep(pollInterval * 1000)
  }

stopPolling(): running = false → 下次循环迭代退出
```

#### 4.6.2 新消息去重

```
processNewMessages():
  1. 拉取最近 20 条 @消息
  2. 从最新到最旧遍历
  3. 遇到 lastMsgId (上次处理的最后一条) → 停止
  4. 将新消息反转 (从旧到新) 按时间正序处理
  5. 更新 lastMsgId 和 lastMsgTime
```

### 4.7 通知模块 (`src/notify/index.ts`)

#### 4.7.1 上下文构建

`buildContext(event)` 是所有通知的上下文构建核心：

```
所有事件都包含 (如有数据):
  📁 项目名 (从 cwd 取 basename)
  🌿 Git 分支 + commit hash
  💻 主机名 (macOS: scutil --get ComputerName)
  🧠 模型名称 (从 transcript JSONL 提取)
  🔗 Session ID

事件特定内容:
  SessionStart         → 仅基础信息
  Stop                 → 💬 模型最终输出 (从 transcript 提取)
  StopFailure          → 💥 错误原因
  PermissionRequest    → 🛠 工具中文标签 + 参数摘要 + 💬 模型输出
  PermissionDenied     → 🚫 被拒绝的工具
  Elicitation          → ❓ Claude 的提问
  PostToolUseFailure   → 🔧 工具名 + 💥 错误信息
```

#### 4.7.2 工具名中文化

```
Bash → "执行 Shell 命令"
Write → "写入文件"
Edit → "编辑文件"
Read → "读取文件"
WebFetch → "访问网页"
WebSearch → "搜索网页"
Grep → "搜索代码"
Glob → "查找文件"
Task → "创建任务"
Agent → "启动子 Agent"
AskUserQuestion → "向用户提问"
```

#### 4.7.3 内容截断策略

飞书卡片 JSON 有 30KB 大小限制。为避免发送失败：

```
三级截断策略:
  1. rawCard() 构建完整卡片
  2. 若 > 30KB → 对 content 文本进行二分查找截断
  3. 上下文 (ctx) 优先级高于消息正文 (message)
     - ctx 不截断（项目/分支/主机等关键信息）
     - message 按剩余空间截断: 24000 - byteLength(ctx)
     - message 最低保证 4000 字节
```

#### 4.7.4 引用回复 vs 群发

```
Stop/StopFailure 通知:
  │
  ├─ getLastDelivery(sessionId) 有值?
  │   └─ YES → replyCard(msgId, ...) 引用回复
  │             clearDelivery(sessionId)
  │             效果: 通知卡片出现在原始指令下方，形成对话线程
  │
  └─ NO → sendChatCard() 群发新消息
           效果: 通知卡片为独立消息
```

### 4.8 Session 管理模块 (`src/session/`)

#### 4.8.1 state.ts — Session 状态管理

```
registerSession(s):
  ├─ 同一 session_id → 更新已有记录
  ├─ 同一 pid 的旧 Session → 标记为 idle (避免重复 active)
  └─ 新 Session → 追加

markIdle(sid): 将 Session 状态设为 "idle"，更新 heartbeat

listActive(): 返回 status = "active"|"idle" 且 isProcessAlive(pid) 的 Session

isProcessAlive(pid): process.kill(pid, 0) — 发送空信号，仅检查进程存在性
```

#### 4.8.2 queue.ts — 消息队列管理

```
enqueue(msg): 不可变追加: storage.messages = [...storage.messages, { ...msg }]

getPending(sessionId?): 筛选 status="pending" 的消息

getInboxPending(): session_id 为空的消息 (通用 Inbox)

markDelivered(msgId): 仅当 pending 时改为 delivered + 时间戳

clearDelivered(): 移除所有非 pending 消息
```

#### 4.8.3 delivery.ts — 投递编排

`deliverNextPending()` 是核心投递编排函数：

```
输入: OrchestratorDeps { sessionId, tty, transcriptPath, pid, ... }
输出: OrchestratorResult { sent, failed, remaining, reason, details }

处理流程:
  1. collectMessages(sid) → 按优先级收集候选消息
  2. normalizeState(deps) → 检测 Claude 状态 (含 gone→waiting 降级)
  3. state ≠ "waiting" → 不投递，返回原因
  4. sendToTerminal() 失败 → 回复失败卡片，标记 failed
  5. 成功 → markDelivered + recordDelivery + 回复确认卡片
```

### 4.9 HTTP 路由层 (`src/*/routes.ts`)

#### 4.9.1 路由汇总

| 路由模块 | 路径前缀 | 主要端点 |
| --- | --- | --- |
| bot/routes.ts | `/daemon` | start, stop, status, once |
| notify/routes.ts | `/hook`, `/inbox` | hook 接收, inbox CRUD |
| session/routes.ts | `/sessions` | 列表, 详情, 队列, 手动发送 |
| feishu/routes.ts | `/test` | webhook 测试, API 测试 |
| app.ts (内联) | `/health` | 服务健康状态 |

#### 4.9.2 中间件栈 (洋葱模型)

```
请求 → createRequestLogger (计时开始)
     → errorHandler (try/catch 包裹)
     → bodyParser (JSON 解析)
     → botRouter.routes()
     → notifyRouter.routes()
     → sessionRouter.routes()
     → feishuRouter.routes()
     → healthRoute (仅匹配 /health)
     ← 响应返回
     ← createRequestLogger (记录耗时)
```

### 4.10 服务管理模块 (`src/scripts/service.ts`)

#### 4.10.1 服务生命周期

```
pnpm start
  ├─ cleanupLegacyDataDir()  清理旧 src/data/ 目录
  ├─ fetchHealth()           检查是否已有运行中的服务
  │   └─ 已运行 → 打印状态，退出
  ├─ mkdirSync(dataDir)      创建数据目录
  ├─ openSync(logFile, "a")  打开日志文件 (追加模式)
  └─ spawn("npx", ["tsx", "src/index.ts"], {
       detached: true,
       stdio: ["ignore", logFd, logFd]
     })
       └─ child.unref()      分离子进程
       └─ sleep(2000)        等待启动
       └─ fetchHealth()      确认启动成功

pnpm stop
  ├─ readFileSync(pidFile)   读取 PID 文件
  ├─ fetchHealth()           优先使用 /health 返回的 pid
  └─ process.kill(pid, "SIGTERM")
       └─ 服务收到 SIGTERM:
            ├─ stopPolling()
            ├─ storage.persist()
            ├─ removePid()
            └─ server.close()
```

#### 4.10.2 子命令列表

| 命令 | 功能 | 对应 HTTP 端点 |
| --- | --- | --- |
| `start` | 后台启动服务 | - |
| `stop` | 停止服务 | - |
| `restart` | 重启服务 | - |
| `status` | 查看服务健康状态 | `GET /health` |
| `logs` | tail -f 跟随日志 | - |
| `once` | 手动触发一次消息拉取 | `POST /daemon/once` |
| `inbox` | 查看通用收件箱 | `GET /inbox` |
| `pop` | 取出下一条收件箱指令 | `POST /inbox/pop` |
| `clear` | 清理已投递消息 | `POST /inbox/clear` |
| `session-list` | 查看活跃 Session | `GET /sessions` |
| `test-webhook` | 测试卡片发送 | `POST /test/webhook` |
| `test-api` | 测试消息拉取 | `POST /test/api` |

### 4.11 Hook 配置工具 (`src/scripts/setup-hooks.ts`)

#### 4.11.1 配置流程

```
pnpm setup-hooks [--dry-run] [--force]
  │
  ├─ 读取 ~/.claude/settings.json
  ├─ 生成 7 个 Hook 事件配置
  ├─ isFeishuHook() 检测已有 feishu hook (检查 command 字符串)
  ├─ 智能合并到已有配置:
  │   ├─ 已有 feishu hook + --force   → 替换
  │   ├─ 已有 feishu hook + 无 --force → 跳过
  │   └─ 无 feishu hook               → 追加
  └─ 写回 settings.json
```

#### 4.11.2 生成的 Hook 命令格式

每个 Hook 生成如下 curl 命令：

```bash
curl -s -X POST "http://127.0.0.1:9876/hook?title=Claude%20已启动&type=info" \
  --data-binary @- \
  -H 'Content-Type: application/json'
```

#### 4.11.3 PostToolUseFailure 的正向匹配

```
PostToolUseFailure Hook:
  matcher: "Write|Edit|Read|WebFetch|WebSearch|Grep|Glob|Task|Agent|AskUserQuestion"

含义: 匹配这些工具名，排除 Bash

原因: Bash 错误通常是探索性的，Claude 自行消化并重试，
      无需推送通知打断用户
```

---

## 5. 数据持久化

### 5.1 数据文件一览

| 文件 | 内存类型 | 读写时机 |
| --- | --- | --- |
| `data/sessions.json` | `SessionState[]` | 启动 load(), 退出 persist(), Hook 触发时更新 |
| `data/messages.json` | `QueuedMessage[]` | 启动 load(), 退出 persist(), 消息入队/投递时更新 |
| `data/delivery.json` | `Record<sid, {msgId, ts}>` | 同上 |
| `data/card_map.json` | `Map<msgId, CardEntry>` | 同上 (序列化为数组) |
| `data/checkpoint.json` | `{last_msg_id, last_time}` | 同上，用于轮询去重 |
| `data/service.pid` | `number` | 服务启动时写入，停止时删除 |
| `data/service.log` | 文本 (追加写) | 服务 stdout/stderr 重定向 |

### 5.2 持久化时机

```
自动持久化:
  - 服务收到 SIGTERM (pnpm stop / kill)
  - 服务收到 SIGINT  (Ctrl+C)

风险:
  - SIGKILL (kill -9) → 数据丢失
  - 异常崩溃 → 数据丢失
  - 缓解: 消息已通过飞书卡片确认 (用户知道指令已被接收)
```

### 5.3 持久化时数据清理

```typescript
persist() {
  // 清理 24 小时无心跳的 Session
  const cutoff = Date.now() - 24 * 3600_000;
  const alive = this.sessions.filter(
    s => new Date(s.last_heartbeat).getTime() > cutoff
  );
  this.sessions = alive;
  // ... 写入各文件
}
```

---

## 6. Claude Code Hook 系统

### 6.1 Hook 配置结构

`~/.claude/settings.json` 中的配置结构：

```json
{
  "hooks": {
    "SessionStart": [{
      "matcher": "",
      "hooks": [{
        "type": "command",
        "command": "curl -s -X POST \"http://127.0.0.1:9876/hook?title=...&type=...\" --data-binary @- -H 'Content-Type: application/json'"
      }]
    }],
    "Stop": [ ... ],
    ...
  }
}
```

### 6.2 Hook 事件数据字段

Claude Code 通过 stdin 传入 JSON 事件数据：

| 事件 | 主要字段 |
| --- | --- |
| SessionStart | `hook_event_name`, `session_id`, `transcript_path`, `cwd` |
| Stop | 上述 + `output`, `message`, `response` |
| StopFailure | 上述 + `error` |
| PermissionRequest | 上述 + `tool_name`, `tool_input`, `model` |
| PermissionDenied | 上述 + `tool_name`, `tool_input` |
| Elicitation | 上述 + `question` |
| PostToolUseFailure | 上述 + `tool_name`, `tool_input`, `error` |

### 6.3 Hook 超时约束

Claude Code 要求 Hook 命令在 **10 秒内**完成并返回。为此：

- 后台投递使用 `void deliverNextInBackground()` 不 await
- 飞书 API 调用配置 15 秒超时（在 req() 函数内）
- Hook 处理函数立即返回 `{ ok: true }`

---

## 7. HTTP API 参考

### 7.1 健康检查

```text
GET /health

Response:
{
  "ok": true,
  "uptime": 3600,          // 运行秒数
  "pid": 12345,            // 进程 PID
  "port": 9876,            // 监听端口
  "bot": "polling",        // "polling" | "stopped"
  "pending": 3             // 待处理消息数
}
```

### 7.2 Daemon 控制

| 方法 | 路径 | 说明 | 返回值 |
| --- | --- | --- | --- |
| `POST` | `/daemon/start` | 启动轮询 | `{ ok: true }` |
| `POST` | `/daemon/stop` | 停止轮询 | `{ ok: true }` |
| `GET` | `/daemon/status` | 轮询状态 | `{ polling: bool, pending: number }` |
| `POST` | `/daemon/once` | 手动拉取一次 | `{ ok: true }` |

### 7.3 Hook 接收

```text
POST /hook?title=...&type=...&message=...&include-bash-errors

Query 参数:
  title              - 通知标题 (必填)
  type               - info | success | warning | error (必填)
  message            - 额外消息文本 (可选)
  include-bash-errors - 不屏蔽 Bash 错误通知 (可选)

Body: Claude Code Hook JSON 事件数据
Response: { ok: true }
```

### 7.4 Inbox 管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/inbox` | 查看收件箱 (text/plain) |
| `POST` | `/inbox/pop` | 取出下一条指令 (text/plain) |
| `POST` | `/inbox/done/:id` | 标记已投递 |
| `POST` | `/inbox/reply` | 回复飞书消息并标记已投递 |
| `POST` | `/inbox/clear` | 清理所有已投递消息 |

`/inbox/reply` 请求体: `{ "msgId": "om_xxx", "text": "回复内容" }`

### 7.5 Session 管理

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/sessions` | 活跃 Session 列表 + 待处理概览 |
| `GET` | `/sessions/:id` | Session 详情 (含 claudeState) |
| `GET` | `/sessions/:id/queue` | Session 待投递消息 |
| `POST` | `/sessions/:id/send` | 手动向终端发送消息 |

`/sessions/:id/send` 请求体: `{ "message": "指令内容" }`

### 7.6 测试接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `/test/webhook` | 通过真实飞书 API 发送测试卡片 |
| `POST` | `/test/api` | 拉取最近 5 条消息 (不过滤 @) |

---

## 8. 消息路由策略

### 8.1 三级路由决策

```
飞书消息到达
  │
  ├─ 优先级 1: 引用消息路由 (精确匹配)
  │   条件: 消息包含 reply_to / parent_id / root_id
  │   动作: lookupCardSession(quotedMsgId)
  │   结果: 命中 → 直接路由到指定 Session
  │         未命中 → 降级到优先级 2
  │
  ├─ 优先级 2: 活跃 Session 自动路由
  │   条件: listActive().length > 0
  │   动作: 选择 started_at 最大的 Session (最近启动)
  │
  └─ 优先级 3: 通用 Inbox 降级
      条件: 无活跃 Session
      动作: enqueue (session_id = undefined)
            replyCard("已收到，等待投递")
```

### 8.2 Card → Session 映射生命周期

```
发送卡片时:
  sendChatCard() / replyCard()
    └─ 飞书返回 message_id ("om_xxxxx")
        └─ registerCardSession("om_xxxxx", sessionId)
            存储: cardMap["om_xxxxx"] = { session_id, sent_at }

用户引用回复时:
  飞书消息包含 reply_to.message_id = "om_xxxxx"
    └─ lookupCardSession("om_xxxxx")
        返回: sessionId → 精确路由回原 Session
```

---

## 9. 终端注入原理

### 9.1 方案对比

| 方案 | 可行性 | 优缺点 |
| --- | --- | --- |
| PTY 直接写入 | ✗ 不可行 | 只能显示文本，不能注入 stdin |
| AppleScript (当前) | ✓ | 精准定位 TTY，iTerm2 不抢焦点 |
| 剪贴板 + 粘贴 | △ 不可靠 | 污染剪贴板，需窗口聚焦 |
| CGEvent (辅助功能) | △ 复杂 | 需额外权限，需窗口聚焦 |

### 9.2 TTY 定位

```
Session 注册:
  SessionStart Hook → findMyClaudeProcess()
    → 沿 PPID 链定位 Claude 进程
    → ps -p {ppid} -o tty= → 获取 TTY (如 "ttys001")

终端匹配:
  iTerm2:    (tty of s) ends with "ttys001"
  Terminal:  (tty of t) ends with "ttys001"
```

---

## 10. 安全设计

### 10.1 网络安全

| 措施 | 说明 |
| --- | --- |
| 绑定地址 | 默认 `127.0.0.1`，仅监听本地回环 |
| 无外网暴露 | 所有 HTTP 接口仅本机可访问 |
| 飞书 API | HTTPS + tenant_access_token 认证 |
| 端口可配 | `FEISHU_NOTIFYD_PORT` 环境变量 |

### 10.2 凭证管理

| 凭证 | 存储 | 说明 |
| --- | --- | --- |
| `FEISHU_APP_ID` | `.env` 文件 | 不入 Git |
| `FEISHU_APP_SECRET` | `.env` 文件 | 不入 Git |
| `tenant_access_token` | 内存 | 不持久化，自动刷新 |

### 10.3 输入安全

- 飞书消息文本通过 `extractText()` 提取纯文本
- AppleScript 字符串通过 `escapeAppleScript()` 转义，防止注入
- 终端注入内容由 Claude Code 解析执行（符合预期行为）

### 10.4 异常恢复

- 连续 10 次错误 → 暂停 30 秒后重试
- API 请求 15 秒超时 → 不阻塞轮询循环
- 终端注入 5 秒超时 → 降级为队列模式
- Hook 处理快速返回 (< 10s) → 不阻塞 Claude Code

---

## 11. 部署与运维

### 11.1 环境要求

```
必需:
  - Node.js 22+
  - pnpm
  - macOS (AppleScript 依赖)
  - iTerm2 或 Terminal.app
  - Claude Code 已安装
  - 飞书自建应用 (机器人已入群)

飞书应用权限:
  - im:chat:readonly     (读取群聊信息)
  - im:message:read      (读取消息)
  - im:message:send      (发送消息)
```

### 11.2 快速部署

```bash
pnpm install
cp .env.example .env
# 编辑 .env 填入 FEISHU_APP_ID / FEISHU_APP_SECRET
pnpm setup-hooks
pnpm start
pnpm status   # 验证
pnpm test-webhook  # 测试飞书卡片发送
```

### 11.3 日常运维

```bash
pnpm start          # 启动
pnpm stop           # 停止
pnpm restart        # 重启
pnpm status         # 健康状态
pnpm logs           # 实时日志
pnpm session-list   # 活跃 Session
pnpm inbox          # 收件箱
```

### 11.4 日志格式

```text
[2026-06-07 21:30:15] 📡 服务启动: http://127.0.0.1:9876 pid=12345
[2026-06-07 21:30:15] 🚀 监听启动 (间隔 3s)
[2026-06-07 21:30:18] 📨 [ou_xxxxx] 帮我重构 src/utils 模块
[2026-06-07 21:30:18] 🔗 Session 路由: abc12345...
[2026-06-07 21:30:18]   状态: waiting (pid=12346, tty=ttys002)
[2026-06-07 21:30:18]   ✅ 已发送
[2026-06-07 21:30:20] POST /hook 200 150ms 45b
```

---

## 12. 故障排查指南

### 12.1 服务未启动

```bash
pnpm status                  # 检查健康状态
cat data/service.pid         # 检查 PID 文件
lsof -i :9876               # 检查端口占用
npx tsx src/index.ts        # 手动前台启动排查
```

### 12.2 飞书消息未收到

```
排查顺序:
  1. pnpm status → bot 是否为 "polling"
  2. pnpm test-api → 飞书 API 是否可达
  3. pnpm test-webhook → 卡片发送是否正常
  4. 检查 .env 凭证
  5. 确认飞书应用已发布、机器人已入群
  6. 飞书开发者后台检查权限
```

### 12.3 消息未投递到终端

```
排查顺序:
  1. pnpm session-list → 确认有活跃 Session
  2. cat data/sessions.json → 检查 PID 和 TTY
  3. ps aux | grep claude → 确认 Claude Code 进程存在
  4. 系统偏好设置 → 隐私 → 自动化 → 确认终端有 AppleScript 权限
  5. cat data/messages.json → 消息是否在队列中
```

### 12.4 Hook 未触发

```
排查顺序:
  1. pnpm setup-hooks --dry-run → 预览 Hook 配置
  2. cat ~/.claude/settings.json → 确认 hooks 存在
  3. 手动测试: curl -s -X POST "http://127.0.0.1:9876/hook?title=test&type=info" \
       -H "Content-Type: application/json" -d '{"hook_event_name":"test"}'
  4. 确认 Claude Code 版本支持 Hooks
```

### 12.5 引用消息路由失败

```
排查:
  1. cat data/card_map.json → 检查映射
  2. pnpm session-list → 目标 Session 是否存活
  3. 飞书回复是否包含 reply_to / parent_id / root_id
```

### 12.6 卡片发送失败

```
可能原因: 卡片 > 30KB / API rate limit / Token 过期 / 群聊 ID 错误
调试: 查看服务日志中的 "API 发送失败" 错误
```

---

> **文档维护**: 本文档应随代码变更同步更新。如发现文档与代码不一致，以代码为准并请更新本文档。
