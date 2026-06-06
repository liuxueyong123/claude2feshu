# claude2feishu

Claude Code CLI ↔ 飞书双向通信。在飞书群里 **@机器人** 发送指令，Claude Code 执行并将结果回传。

## 工作原理

```
用户手机飞书 @机器人 "运行测试"
       │
       ▼
飞书服务器 ←──(API 轮询 3s)── feishu_bot (守护进程)
       │                              │
       │                         写入 JSONL
       │                              ▼
       │                    ~/.claude/feishu_inbox.jsonl
       │                              │
       │                    Claude Code 消费指令
       │                              │
       │                         执行完成
       │                              │
       ◄── 飞书卡片通知 ←── notify.ts ─┘
```

- **出站**（Claude → 飞书）：webhook 推送卡片，覆盖 SessionStart / Stop / 权限请求等 10 个 hook
- **入站**（飞书 → Claude）：轮询飞书 API，只拉取 **@机器人** 的消息

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

编辑 `.env` 填入飞书应用凭证：

```env
FEISHU_APP_ID=cli_aXXXXXXXXXXXX
FEISHU_APP_SECRET=XXXXXXXXXXXXXXXXXXXXXXXX
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxxx
```

获取方式：[飞书开发者后台](https://open.feishu.cn/app) → 应用 → 凭证与基础信息。

**必需权限：** `im:chat:readonly` / `im:message:read` / `im:message:send`。应用需发布并添加机器人到目标群聊。

### 3. 启动

```bash
pnpm start
```

守护进程每 3 秒轮询一次，只处理 **@机器人** 的消息。

### 4. 验证

在飞书群里 @机器人 发一条消息，会收到确认卡片。

```bash
pnpm run status   # 查看状态
pnpm run inbox    # 查看待处理指令
```

## 命令参考

| 命令 | 说明 |
|------|------|
| `pnpm start` | 后台守护进程 |
| `pnpm stop` | 停止守护进程 |
| `pnpm run restart` | 重启 |
| `pnpm run status` | 状态 + inbox 统计 |
| `pnpm run once` | 单次拉取（测试） |
| `pnpm run inbox` | 待处理指令列表 |
| `pnpm run pop` | 弹出下一条指令 |
| `pnpm run done <id>` | 标记完成 |
| `pnpm run reply <id> <text>` | 回复并标记完成 |
| `pnpm run clear` | 清理已完成记录 |
| `pnpm run test-webhook` | 测试 webhook |
| `pnpm run test-api` | 测试 API |

## Hook 事件

| 事件 | 通知 |
|------|------|
| SessionStart | 🚀 已启动（含项目/分支/模型） |
| Stop | ✅ 任务完成 |
| StopFailure | ❌ 异常终止 |
| SessionEnd | 🏁 会话结束 |
| PermissionRequest | 🔔 等待确认 |
| PermissionDenied | 🚫 权限被拒绝 |
| Elicitation | ❓ 等待输入 |
| PostToolUseFailure | 💻/🌐/📝 操作失败 |

SessionStart 时会自动检查 inbox，有待处理指令则在飞书提醒。

## 在 Claude Code 中消费指令

```
!pnpm run pop                           # 弹出指令
!pnpm run reply om_xxxxx "已完成"        # 回传结果
```

## 项目结构

```
src/
├── config.ts          # 配置加载
├── logger.ts          # 日志工具
├── feishu_api.ts      # 飞书 API 客户端（token/消息/@过滤/回复）
├── feishu_bot.ts      # 轮询守护进程
├── inbox.ts           # 指令队列（JSONL）
├── notify.ts          # Hook 通知 + inbox 检查
└── cli.ts             # 统一 CLI
```

## 技术栈

TypeScript + Node.js 22 + tsx + 飞书 Open API

## License

MIT
