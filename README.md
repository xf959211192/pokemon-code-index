# pokemon-code-index

使用 Cloudflare Workers、D1 和 Cron Trigger 的公开兑换码记录与管理页。

## 当前状态

- Worker 入口：`src/index-v2.js`。
- 数据库：Cloudflare D1，结构在 `schema.sql`。
- 首页：`public/index.html`。
- 管理页：`public/admin.html`。
- 后台 Token 鉴权：已按确认要求取消。
- 代码中不再固定任何兑换码。

## 自动更新规则

- 每天 UTC 01:00（北京时间 09:00）触发一次定时任务。
- 如果当前月份配置了已知 LINUX DO 月度帖，Worker 会尝试读取公开帖子评论区并提取社区共识。
- 自动检查窗口：北京时间每月 1 日至 14 日。
- 如果当月数据库已经有已确认兑换码，自动任务会跳过。
- 如果没有配置当月帖子，或帖子识别失败，需要在管理页手动补录。

## 主要接口

### 公开读取

| 接口 | 用途 |
|---|---|
| `GET /api/latest` | 首页读取最新兑换码。 |
| `GET /api/history` | 读取历史兑换码。 |
| `GET /api/health` | 服务状态检查。 |
| `GET /api/public-links` | 读取公开频道链接。 |

### 后台管理

当前后台接口不需要 Token。

| 接口 | 用途 |
|---|---|
| `POST /api/admin/manual` | 手动写入指定月份兑换码。 |
| `POST /api/admin/refresh` | 按已知帖子或指定帖子自动识别。 |
| `POST /api/admin/test-topic` | 只测试某个 LINUX DO 帖子，不写入。 |
| `GET /api/admin/logs` | 查看刷新日志。 |
| `GET /api/admin/candidates` | 查看本月候选码。 |
| `GET /api/admin/offers` | 查看本月优惠记录。 |
| `GET /api/admin/evidence` | 查看本月证据记录。 |
| `GET /api/admin/discovery` | 查看已知月度帖。 |
| `POST /api/admin/discover` | 返回当前内置已知帖信息。 |
| `GET /api/admin/sources` | 查看数据源。 |
| `POST /api/admin/sources/toggle` | 启用或停用数据源。 |

## 下个月怎么用

### 已经知道兑换码

打开管理页：

```text
https://你的地址.workers.dev/admin.html
```

在“手动补录”里填写：

```text
月份：2026-08
兑换码：实际兑换码
公开来源地址：Linux.do 或其他公开来源
```

或者直接调用：

```bash
curl -X POST "https://你的地址.workers.dev/api/admin/manual" \
  -H "Content-Type: application/json" \
  -d '{"period":"2026-08","code":"实际兑换码","sourceUrl":"https://linux.do/t/topic/xxxxxxx"}'
```

### 只知道 Linux.do 帖子

调用：

```bash
curl -X POST "https://你的地址.workers.dev/api/admin/refresh" \
  -H "Content-Type: application/json" \
  -d '{"topicUrl":"https://linux.do/t/topic/xxxxxxx"}'
```

或者在管理页“按帖子识别”里填写帖子地址后点击“立即刷新”。

## 已知帖子配置

`src/index-v2.js` 里只保留已知 LINUX DO 帖子地址，不保留兑换码。

示例：

```js
const KNOWN_LINUXDO_TOPICS = {
  "2026-07": {
    url: "https://linux.do/t/topic/2504318",
    title: "宝可梦机场之七月免费兑换码猜猜我是谁"
  }
};
```

下个月如果想让定时任务自动尝试识别，可只追加当月帖子地址，不要写死兑换码。

## 部署

```bash
npm install
npx wrangler deploy
```

首次初始化或结构更新 D1：

```bash
npx wrangler d1 execute pokemon-code-index --remote --file=./schema.sql
```

## 本地调试

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

- 当前后台接口已公开，任何知道后台地址的人都可能写入数据或修改数据源状态。
- 只抓取无需登录即可访问的公开网页。
- 不绕过验证码、登录限制或访问权限。
- Telegram 群聊记录不纳入自动抓取。
- 如果 LINUX DO 页面返回 `403`、`429` 或结构变化，使用管理页手动补录。