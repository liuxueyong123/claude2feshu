import Router from "@koa/router";
import { sendChatCard, listReceivedMessages } from "./api.js";

const router = new Router();

router.post("/test/webhook", async (ctx) => {
  ctx.body = { ok: !!(await sendChatCard("🧪 测试", "webhook 正常 ✅")) };
});

router.post("/test/api", async (ctx) => {
  const msgs = await listReceivedMessages(5, false);
  ctx.body = msgs.map((m) => ({
    type: m.msg_type, sender: m.sender?.id, content: m.body?.content?.slice(0, 100),
  }));
});

export { router };
