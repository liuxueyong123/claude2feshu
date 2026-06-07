#!/bin/bash
# Claude Code → 飞书通知入口（TypeScript）
cd "$(dirname "$0")" && exec npx tsx src/notify.ts "$@"
