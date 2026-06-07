# claude2feishu

Claude Code 和飞书群的双向通信服务。当前版本以 Koa 启动一个本地 HTTP 服务，统一承接飞书轮询、Claude Code hooks、队列投递和诊断接口。

## 能做什么

- 飞书群里 @机器人发送指令，服务轮询飞书 Open API 后投递到本机 Claude Code 终端。
- Claude Code hooks 通过 `POST /hook` 回传会话启动、完成、失败、权限请求和工具失败通知。
- Claude 忙碌或终端不可写时，消息进入统一队列，后续由 `SessionStart`、`Stop`、`SessionEnd` 等 hook 触发单条自动投递。
- 飞书卡片消息会记录 card message id 到 session id 的映射，用户引用卡片回复时可路由回对应 Claude session。

## 前置要求

- Node.js 22+ 和 pnpm。
- macOS + iTerm2 或 Terminal.app。终端投递依赖 AppleScript 按 TTY 精确定位 tab/session。
- 本机已安装 Claude Code，并允许配置 `~/.claude/settings.json` hooks。
- 飞书自建应用已启用机器人能力，并加入目标群。
- 飞书权限至少包含 `im:chat:readonly`、`im:message:read`、`im:message:send`。

## 快速开始

```bash
pnpm install
cp .env.example .env
```

编辑 `.env`：

```env
FEISHU_APP_ID=cli_xxxxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxx

# 可选
FEISHU_CHAT_ID=oc_xxxxxxxxxxxxxx
FEISHU_NOTIFYD_HOST=127.0.0.1
FEISHU_NOTIFYD_PORT=9876
FEISHU_POLL_INTERVAL=3
FEISHU_LOG_LEVEL=INFO
FEISHU_DATA_DIR=./data
```

配置 Claude Code hooks：

```bash
pnpm setup-hooks
```

启动服务：

```bash
pnpm start
pnpm status
```

`pnpm setup-hooks` 会把 hooks 合并到 `~/.claude/settings.json`，hook 命令通过 curl 向本地服务 `POST /hook`。执行 `pnpm setup-hooks --dry-run` 可以预览，`pnpm setup-hooks --force` 会覆盖已有 claude2feishu hook。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `pnpm start` | 后台启动 Koa 服务并自动开始飞书轮询 |
| `pnpm stop` | 按 pid 文件停止服务 |
| `pnpm restart` | 重启服务 |
| `pnpm status` | 查看 `/health` |
| `pnpm logs` | 跟随服务日志 |
| `pnpm once` | 触发一次飞书消息拉取 |
| `pnpm inbox` | 查看通用 inbox |
| `pnpm pop` | 取出下一条通用 inbox 指令文本 |
| `pnpm clear` | 清理已 delivered 的队列项 |
| `pnpm session-list` | 查看活跃 session 和待处理 session 队列 |
| `pnpm test-webhook` | 通过真实飞书 API 发送测试卡片 |
| `pnpm test-api` | 通过真实飞书 API 拉取最近消息 |
| `pnpm test` | 运行测试 |
| `pnpm typecheck` | TypeScript 静态检查 |
| `pnpm build` | 编译到 `dist/` |

带参数的调试接口可以直接调用 HTTP：

```bash
PORT=${FEISHU_NOTIFYD_PORT:-9876}

curl -s "http://127.0.0.1:$PORT/sessions/<session-id>" | python3 -m json.tool
curl -s "http://127.0.0.1:$PORT/sessions/<session-id>/queue" | python3 -m json.tool
curl -s -X POST "http://127.0.0.1:$PORT/sessions/<session-id>/send" \
  -H "Content-Type: application/json" \
  -d '{"message":"继续"}'

curl -s -X POST "http://127.0.0.1:$PORT/inbox/done/<message-id>"
curl -s -X POST "http://127.0.0.1:$PORT/inbox/reply" \
  -H "Content-Type: application/json" \
  -d '{"msgId":"om_xxx","text":"执行完成"}'
```

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/health` | 服务健康状态、pid、端口、轮询状态、pending 数量 |
| `POST` | `/daemon/start` | 启动飞书轮询 |
| `POST` | `/daemon/stop` | 停止飞书轮询 |
| `GET` | `/daemon/status` | 查看轮询状态 |
| `POST` | `/daemon/once` | 手动拉取一次飞书消息 |
| `POST` | `/hook` | Claude Code hook 入口 |
| `GET` | `/inbox` | 通用 inbox 文本视图 |
| `POST` | `/inbox/pop` | 取出下一条通用 inbox 指令 |
| `POST` | `/inbox/done/:id` | 标记队列消息 delivered |
| `POST` | `/inbox/reply` | 回复飞书消息并标记 delivered |
| `POST` | `/inbox/clear` | 清理 delivered 消息 |
| `GET` | `/sessions` | 活跃 session 与待处理 session 队列 |
| `GET` | `/sessions/:id` | session 详情和 Claude 状态 |
| `GET` | `/sessions/:id/queue` | 指定 session 待投递消息 |
| `POST` | `/sessions/:id/send` | 手动向 session 终端发送消息 |
| `POST` | `/test/webhook` | 真实飞书卡片发送测试 |
| `POST` | `/test/api` | 真实飞书消息拉取测试 |

## 当前代码结构

```text
src/
  app.ts              Koa app 组装：错误处理、bodyparser、routes、health
  server.ts           服务生命周期：load/persist、pid、listen、signal、polling
  index.ts            进程入口，只调用 startService()
  utils/
    config.ts         环境变量、端口、数据目录、飞书 API 常量
    logger.ts         统一日志
    storage.ts        运行时内存状态和 JSON 持久化
    terminal.ts       Claude 状态检测、进程发现、AppleScript 终端投递
  scripts/
    service.ts        本地服务管理脚本：start/stop/status/logs
    setup-hooks.ts    写入 Claude Code hooks
  bot/
    index.ts          飞书消息轮询、入站路由、fallback inbox
    routes.ts         daemon HTTP 接口
  feishu/
    api.ts            飞书 Open API、卡片构建、消息解析、card-session 映射
    routes.ts         飞书 API 测试接口
  notify/
    index.ts          hook 事件处理、通知卡片、队列触发投递
    routes.ts         hook 和 inbox HTTP 接口
  session/
    state.ts          session 注册、心跳、活跃进程过滤
    queue.ts          统一待投递队列
    delivery.ts       最近投递追踪和单条投递编排
    routes.ts         session HTTP 接口
tests/
  *.test.ts           Node test 测试套件
```

## 数据文件

默认数据目录是 `./data`，可用 `FEISHU_DATA_DIR` 覆盖。

| 文件 | 用途 |
| --- | --- |
| `service.pid` | 后台服务 pid |
| `service.log` | `pnpm start` 重定向日志 |
| `sessions.json` | session 到 PID/TTY/transcript 的映射 |
| `messages.json` | 统一消息队列，`session_id` 为空表示通用 inbox |
| `delivery.json` | session 最近一次投递的飞书消息 id，用于 Stop 引用回复 |
| `card_map.json` | 飞书卡片 message id 到 session id 的映射 |
| `checkpoint.json` | 飞书轮询的最后处理消息 |

## 消息流

飞书到 Claude：

1. `bot/index.ts` 定时调用飞书 API 拉取群消息。
2. `mentionsBot()` 过滤 @机器人消息，`extractText()` 提取纯文本。
3. 有引用消息时先通过 `lookupCardSession()` 精确路由到 session。
4. 无引用或映射未命中时，选择最近活跃 session。
5. 没有可用 session 时进入通用 inbox。
6. 目标 session 空闲则通过 `sendToTerminal()` 写入终端；忙碌、退出或投递失败则进入队列。

Claude 到飞书：

1. Claude Code hook 通过 curl 调用 `POST /hook?title=...&type=...`。
2. `notify/index.ts` 根据 hook event 构建上下文卡片并发送飞书。
3. `SessionStart` 注册当前 Claude 进程和 TTY，并尝试投递一条 pending 消息。
4. `Stop` / `StopFailure` / `SessionEnd` 标记 session idle，并再次尝试投递一条 pending 消息。
5. 如果该 session 最近接收过飞书指令，Stop 通知会优先引用回复原始飞书消息。

## 开发与验证

常规验证：

```bash
pnpm typecheck
pnpm test
pnpm build
```

涉及真实飞书 API 的命令需要 `.env` 凭证，并会访问真实群聊：

```bash
pnpm test-webhook
pnpm test-api
pnpm once
```

新增运行时状态时优先放在 `storage.ts`，并通过 `FEISHU_DATA_DIR` 支持测试隔离。更新 session、queue、delivery 等共享状态时使用替换式写入，避免原地修改既有对象。

## 排障

服务没起来：

```bash
pnpm status
pnpm logs
cat ${FEISHU_DATA_DIR:-./data}/service.pid
```

`pnpm start` 会先检查 `/health`。如果服务已经运行，它只打印当前状态，不会截断 `service.log`；新启动时日志以追加方式写入。

飞书收不到消息：

- 检查 `.env` 的 `FEISHU_APP_ID` / `FEISHU_APP_SECRET` / `FEISHU_CHAT_ID`。
- 确认应用已发布、机器人已入群、权限已开通。
- 运行 `pnpm test-webhook` 看真实发送接口返回。

飞书消息没有投到终端：

- 运行 `pnpm session-list` 查看是否有活跃 session。
- 检查 `sessions.json` 中的 `pid`、`tty`、`transcript_path`。
- 确认 iTerm2 或 Terminal.app 已授予自动化 / AppleScript 权限。
- 查看 `messages.json` 是否已经进入队列。

引用卡片没有路由到原 session：

- 检查 `card_map.json` 是否存在对应飞书卡片 message id。
- 检查飞书回复消息是否带有 `reply_to`、`parent_id` 或 `root_id`。

Hook 没触发：

- 运行 `pnpm setup-hooks --dry-run` 查看将写入的 curl 命令。
- 检查 `~/.claude/settings.json` 是否包含指向 `http://127.0.0.1:9876/hook` 的 hook。
- 确认本地服务端口和 `FEISHU_NOTIFYD_PORT` 一致。
