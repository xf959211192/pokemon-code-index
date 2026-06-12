# pokemon-code-index

使用 Cloudflare Workers、D1 和 Cron Trigger 的公开兑换码聚合站模板。

## 自动更新规则

- 每天 UTC 01:00（北京时间 09:00）触发一次定时任务。
- 仅在北京时间每月 1 日至 7 日执行自动抓取。
- 当数据库存在当月已确认兑换码后，本月后续任务直接跳过。
- 管理页的“立即刷新全部来源”无视上述限制。
- 每月 8 日后仍未找到时，自动任务停止实际抓取，等待管理员手动刷新或补录。
- 进入下个月后自动开始新一轮检查。

## 已接入来源

| 来源 | 行为 |
|---|---|
| 官方 Telegram 通知频道 `https://t.me/s/pokemon521` | 抓取公开频道网页。若官方明确发布文本兑换码，直接确认；若为图片谜题，记录公告后等待社区答案。 |
| 官方 Telegram 群组入口 `https://t.me/pokemon_love` | 只检查公开入口是否可访问，不抓取群聊内容。 |
| LINUX DO 月度讨论帖 | 自动搜索当月公开帖子，从评论区重复答案中提取社区共识。 |
| 趣分享备用介绍页 | 作为第三方辅助线索，单独命中不会自动发布。 |
| 趣分享 Telegram 频道 | 只分析宝可梦相关上下文，单独命中不会自动发布。 |
| 管理员手动补录 | 自动识别失败时兜底。 |

## 自动确认规则

1. 官方 Telegram 明确发布文本兑换码：直接确认。
2. 至少两个不同来源得到相同答案，且至少一个来源为官方频道或 LINUX DO：自动确认。
3. LINUX DO 评论区出现明显社区共识，可信度不低于 75%，证据分数不低于 4：自动确认。
4. 只有第三方页面出现答案：仅保存为候选，不自动发布。

## 全新部署

```bash
npm install
npx wrangler login
npx wrangler d1 create pokemon-code-index --binding DB --update-config
npx wrangler d1 execute pokemon-code-index --remote --file=./schema.sql
npx wrangler secret put ADMIN_TOKEN
npx wrangler deploy
```

访问：

- 首页：`https://你的地址.workers.dev/`
- 管理页：`https://你的地址.workers.dev/admin.html`

## 从单来源旧版升级

新版数据库结构兼容旧版。进入旧项目目录后，用新版文件覆盖，再执行：

```bash
npm install
npx wrangler d1 execute pokemon-code-index --remote --file=./schema.sql
npx wrangler deploy
```

`schema.sql` 使用 `CREATE TABLE IF NOT EXISTS` 和 `INSERT OR IGNORE`，不会删除原有兑换码历史。

## 本地调试

复制 `.dev.vars.example` 为 `.dev.vars`，填写本地令牌：

```bash
npm install
npm run db:local
npm run dev
```

访问：

- 首页：`http://localhost:8787/`
- 管理页：`http://localhost:8787/admin.html`
- 模拟 Cron：`http://localhost:8787/cdn-cgi/handler/scheduled?cron=0+1+*+*+*`

## 注意

- 只抓取无需登录即可访问的公开网页。
- 不绕过验证码、登录限制或访问权限。
- Telegram 群聊记录不纳入自动抓取。
- 官方频道若只发布图片谜题，当前模板不会识别图片内容；此时依赖 LINUX DO 评论区共识或管理员手动补录。
- 若外部页面返回 `403`、`429` 或结构发生变化，可在管理页查看来源状态并手动处理。
