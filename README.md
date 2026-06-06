# claude2feishu

Claude Code ↔ 飞书双向通信。在飞书群里 **@机器人** 发送指令，Claude Code 执行并将结果回传。

## 工作原理

```
用户手机飞书 @机器人 "运行测试"
       │
       ▼
飞书服务器 ←──(API 轮询 3s)── feishu_bot (守护进程)
       │                              │
       │                         检测 @提及
       │                              │
       │                    ┌─────────┴──────────┐
       │                    │ 引用消息带 session?  │
       │                    │  否 → 查活跃 session │
       │                    └─────────┬──────────┘
       │                              │
       │                    detectState() 判断 Claude 状态
       │                              │
       │              ┌───────────────┼───────────────┐
       │              │               │               │
       │           waiting          busy           gone
       │         立即发送到      入队等待          入队等待
       │         iTerm2 终端   任务结束后发送    下次启动通知
       │              │               │               │
       │              └───────────────┴───────────────┘
       │                              │
       ◄── 飞书卡片回复 ───────────────┘
```

- **出站** (Claude → 飞书): hook 推送卡片，覆盖 SessionStart / Stop / PermissionRequest 等事件
- **入站** (飞书 → Claude): 轮询飞书 API，检测 @机器人 消息，自动发送到运行 Claude Code 的 iTerm2 终端

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

编辑 `.env` 填入飞书应用凭证:

```env
FEISHU_APP_ID=cli_aXXXXXXXXXXXX
FEISHU_APP_SECRET=XXXXXXXXXXXXXXXXXXXXXXXX
```

获取方式: [飞书开发者后台](https://open.feishu.cn/app) → 应用 → 凭证与基础信息。

**必需权限:** `im:chat:readonly` / `im:message:read` / `im:message:send`。应用需发布并添加机器人到目标群聊。

### 3. 启动

```bash
pnpm start
```

守护进程每 3 秒轮询一次，处理 **@机器人** 的消息。

### 4. 验证

在飞书群里 @机器人 发一条消息，会收到确认卡片。如果本地有 Claude Code 在 iTerm2 中运行，消息会自动发送到终端。

```bash
pnpm run status         # 查看状态
pnpm run session-list   # 查看活跃 session
```

## 命令参考

### 守护进程

| 命令 | 说明 |
|------|------|
| `pnpm start` | 后台守护进程 |
| `pnpm stop` | 停止守护进程 |
| `pnpm restart` | 重启 |
| `pnpm status` | 状态 + inbox 统计 |
| `pnpm once` | 单次拉取 (测试) |

### Inbox 管理

| 命令 | 说明 |
|------|------|
| `pnpm inbox` | 待处理指令列表 |
| `pnpm pop` | 弹出下一条指令 |
| `pnpm done <id>` | 标记完成 |
| `pnpm reply <id> <text>` | 回复并标记完成 |
| `pnpm clear` | 清理已完成记录 |

### Session 管理

| 命令 | 说明 |
|------|------|
| `pnpm session-list` | 查看活跃 session + 待处理消息 |
| `pnpm session-state <sid>` | 查看 session 详情 + Claude 状态 (waiting/busy/gone) |
| `pnpm session-queue <sid>` | 查看 session 待投递消息 |
| `pnpm session-send <sid> <msg>` | 手动发送消息到终端 (调试) |

### 测试

| 命令 | 说明 |
|------|------|
| `pnpm test-webhook` | 测试 API 发送卡片 |
| `pnpm test-api` | 测试 API 拉取消息 (不过滤 @) |

## Session 路由

当用户 @机器人 发送消息时，系统自动:

1. **引用消息路由**: 引用机器人的通知卡片 (包含 session ID) → 精确路由到该 session
2. **自动路由**: 无引用时，自动选择当前活跃 session
3. **状态感知**:
   - Claude **等待输入** (end_turn) → AppleScript 立即发送到 iTerm2 终端
   - Claude **处理中** (tool_use) → 入队，任务结束后自动发送
   - Claude **已退出** → 入队，下次 SessionStart 通知用户

## Hook 事件

| 事件 | 通知 | Session 操作 |
|------|------|-------------|
| SessionStart | 启动 (含项目/分支/模型/主机) | 注册 session，检查队列 |
| Stop | 任务完成 | 标记空闲，检查队列 |
| StopFailure | 异常终止 | 标记空闲，检查队列 |
| SessionEnd | 会话结束 | 标记空闲 |
| PermissionRequest | 等待确认 | — |
| PermissionDenied | 权限被拒绝 | — |
| Elicitation | 等待输入 | — |
| PostToolUseFailure | 操作失败 | — |

## 项目结构

```
src/
├── config.ts          # 配置加载 (.env + 环境变量)
├── logger.ts          # 日志工具 (stderr → LOG_FILE)
├── feishu_api.ts      # 飞书 API 客户端
│                        - Token / 消息拉取 / @过滤
│                        - 引用消息解析 / Session ID 提取
│                        - 卡片构建 / 回复 / 发送
├── feishu_bot.ts      # 轮询守护进程
│                        - @消息检测 → Session 路由分发
│                        - 通用 inbox 回退
├── inbox.ts           # 通用指令队列 (JSONL)
├── session_state.ts   # Session → 进程映射
│                        - PID / TTY / transcript_path
│                        - 心跳 / 自动去重 / 空闲标记
├── session_queue.ts   # Session 专用延迟队列
│                        - 按 session 维度管理待投递消息
├── terminal.ts        # 终端交互
│                        - detectState() 读 transcript 判断状态
│                        - sendViaITerm() AppleScript 发送
│                        - startWaitAndSend() 轮询等待后发送
├── notify.ts          # Hook 通知 + Session 生命周期
│                        - SessionStart 注册 / Stop 清理
│                        - 队列检查 / 飞书卡片通知
└── cli.ts             # 统一 CLI
```

数据文件 (均在 `~/.claude/feishu/` 下):

| 文件 | 用途 |
|------|------|
| `session_states.json` | Session 状态与进程映射 |
| `feishu_session_queue.jsonl` | Session 专用延迟消息队列 |
| `feishu_inbox.jsonl` | 通用指令队列 |
| `feishu_checkpoint.json` | 轮询 checkpoint (最后处理的消息 ID) |
| `feishu_bot.pid` | 守护进程 PID |
| `feishu_bot.log` | 守护进程日志 |

## 日志

守护进程日志位置: `~/.claude/feishu/feishu_bot.log`

```bash
# 实时查看
tail -f ~/.claude/feishu/feishu_bot.log

# 最近 50 行
tail -50 ~/.claude/feishu/feishu_bot.log
```

Hook 诊断数据: `~/.claude/feishu/hook_dump.jsonl`

## Claude Code Hook 配置

在 `~/.claude/settings.json` 中配置 hooks:

```json
{
  "hooks": {
    "SessionStart": [{ "command": "cd /path/to/claude2feishu && ./notify.sh --title ' 已启动' --type info" }],
    "Stop": [{ "command": "cd /path/to/claude2feishu && ./notify.sh --title ' 任务完成' --type success" }],
    "StopFailure": [{ "command": "cd /path/to/claude2feishu && ./notify.sh --title ' 异常终止' --type error" }],
    "PermissionRequest": [{ "command": "cd /path/to/claude2feishu && ./notify.sh --title ' 等待确认' --type warning" }],
    "PermissionDenied": [{ "command": "cd /path/to/claude2feishu && ./notify.sh --title ' 权限拒绝' --type error" }],
    "Elicitation": [{ "command": "cd /path/to/claude2feishu && ./notify.sh --title ' 等待输入' --type warning" }],
    "PostToolUseFailure": [{ "command": "cd /path/to/claude2feishu && ./notify.sh --title ' 操作失败' --type error" }]
  }
}
```

## 技术栈

TypeScript + Node.js 22 + tsx + 飞书 Open API + AppleScript (iTerm2)

## License

MIT
