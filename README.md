# pokemon-code-index

使用 Cloudflare Workers、D1 和 Cron Trigger 的公开兑换码聚合站模板。

## 自动更新规则

- 每天 UTC 01:00（北京时间 09:00）触发一次定时任务。
- 原自动搜索仍保留：北京时间每月 1 日至 7 日执行公开来源抓取。
- 新增 v2 已知 LINUX DO 月度帖兜底：当本月配置了已知帖子时，可在每月 1 日至 14 日内定时读取该帖并从评论区提取社区共识。
- 新增 v2 已知确认码自动写入：当 `KNOWN_VERIFIED_CODES` 配置了当月公开确认码，且 D1 还没有当月已确认记录时，Cron、管理员刷新和 `/api/latest` 公开读取都会自动写入。
- 当数据库存在当月已确认兑换码后，本月后续任务直接跳过。
- 管理页的“立即刷新全部来源”无视上述时间限制；如果填写了指定 LINUX DO 帖子地址，会直接抓取该公开帖子。
- 每月 14 日后仍未找到时，自动任务停止实际兜底抓取，等待管理员手动刷新或补录。
- 进入下个月后自动开始新一轮检查。

## v2 入口说明

当前 `wrangler.jsonc` 使用 `src/index-v2.js` 作为 Worker 入口。v2 不删除旧功能，而是：

1. 拦截 `/api/admin/refresh` 和 Cron 定时任务；
2. 拦截 `/api/latest`，在公开首页读取时自动补写当月已知确认码；
3. 优先使用 `KNOWN_VERIFIED_CODES` 内置公开确认码写入 D1；
4. 若没有内置确认码，再使用已知 LINUX DO 月度帖兜底；
5. 如果没有配置本月已知帖子，则回退旧版自动搜索；
6. 其他页面、历史接口、管理员手动补录、候选查看、日志查看等仍委托给旧版 `src/index.js`。

因此管理员上传/手动补录功能仍然保留。

## 当前已知确认码

| 月份 | 兑换码 | 来源 |
|---|---|---|
| 2026-07 | 小火马 | https://linux.do/t/topic/2504318 |

如果下个月自动搜索仍失败，可以在 `src/index-v2.js` 的 `KNOWN_VERIFIED_CODES` 里追加新月份。

## 已接入来源

| 来源 | 行为 |
|---|---|
| 官方 Telegram 通知频道 `https://t.me/s/pokemon521` | 抓取公开频道网页。若官方明确发布文本兑换码，直接确认；若为图片谜题，记录公告后等待社区答案。 |
| 官方 Telegram 群组入口 `https://t.me/pokemon_love` | 只检查公开入口是否可访问，不抓取群聊内容。 |
| LINUX DO 月度讨论帖 | 自动搜索当月公开帖子，从评论区重复答案中提取社区共识。 |
| 已知 LINUX DO 月度帖兜底 | 当搜索失败但已知帖子 URL 已配置时，直接读取该公开帖并提取社区共识。 |
| 已知确认码自动写入 | 当管理员已人工确认公开来源，可作为代码兜底写入 D1。 |
| 趣分享备用介绍页 | 作为第三方辅助线索，单独命中不会自动发布。 |
| 趣分享 Telegram 频道 | 只分析宝可梦相关上下文，单独命中不会自动发布。 |
| 管理员手动补录 | 自动识别失败时兜底。 |

## 自动确认规则

1. 官方 Telegram 明确发布文本兑换码：直接确认。
2. 至少两个不同来源得到相同答案，且至少一个来源为官方频道或 LINUX DO：自动确认。
3. LINUX DO 评论区出现明显社区共识，可信度不低于 75%，证据分数不低于 4：自动确认。
4. 只有第三方页面出现答案：仅保存为候选，不自动发布。
5. `KNOWN_VERIFIED_CODES` 只用于已经由管理员确认过的公开证据兜底，不用于未知月份猜测。

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