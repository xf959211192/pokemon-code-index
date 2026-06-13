import assert from "node:assert/strict";
import test from "node:test";

import worker, {
  buildHealth,
  discoverTopic,
  evidenceFromCandidate,
  evidenceFromPuzzle,
  extractTelegramPuzzleImage,
  fetchTopic,
  periodOf,
  providerSearchQueries,
  trustLabelForStatus,
  verifiedFrom
} from "../src/index.js";

function createDb({ hasVerified = false, fail = false } = {}) {
  return {
    prepare(sql) {
      return {
        bind() {
          return this;
        },
        async first() {
          if (fail) throw new Error("D1 unavailable");
          if (sql.includes("SELECT 1 FROM codes")) return { has_verified: hasVerified ? 1 : 0 };
          return { ok: 1 };
        }
      };
    }
  };
}

test("periodOf 使用北京时间计算月份", () => {
  assert.equal(periodOf(new Date("2026-05-31T16:30:00.000Z")), "2026-06");
});

test("buildHealth 只做轻量数据库检查并返回当前状态", async () => {
  const health = await buildHealth(
    { DB: createDb({ hasVerified: false }) },
    new Date("2026-06-12T00:00:00.000Z")
  );

  assert.deepEqual(health, {
    ok: true,
    period: "2026-06",
    database: "reachable",
    autoWindow: false,
    hasVerifiedCodeThisMonth: false
  });
});

test("buildHealth 在自动窗口内能识别本月已有确认码", async () => {
  const health = await buildHealth(
    { DB: createDb({ hasVerified: true }) },
    new Date("2026-06-01T01:00:00.000Z")
  );

  assert.equal(health.autoWindow, true);
  assert.equal(health.hasVerifiedCodeThisMonth, true);
});

test("buildHealth 数据库不可达时返回明确诊断", async () => {
  const health = await buildHealth(
    { DB: createDb({ fail: true }) },
    new Date("2026-06-12T00:00:00.000Z")
  );

  assert.equal(health.ok, false);
  assert.equal(health.database, "unreachable");
  assert.equal(health.hasVerifiedCodeThisMonth, false);
});

test("第三方来源单独候选不会触发自动确认", () => {
  const result = verifiedFrom([
    {
      code: "皮卡丘",
      source_key: "go4sharing_article",
      confidence: 0.95,
      evidence_count: 5,
      source_url: "https://example.com"
    }
  ]);

  assert.equal(result, null);
});

test("证据状态会按来源可信度分级", () => {
  const official = evidenceFromCandidate("2026-06", {
    code: "火焰鸟",
    sourceKey: "official_telegram",
    sourceName: "官方 Telegram 通知频道",
    sourceType: "official_telegram",
    sourceUrl: "https://t.me/s/pokemon521",
    confidence: 1,
    evidenceCount: 1,
    evidence: "官方明确文本"
  });
  const community = evidenceFromCandidate("2026-06", {
    code: "火焰鸟",
    sourceKey: "linuxdo_monthly_topic",
    sourceName: "LINUX DO 月度讨论帖",
    sourceType: "linuxdo_topic",
    sourceUrl: "https://linux.do/t/topic/2289939",
    confidence: 0.88,
    evidenceCount: 6,
    evidence: "多人兑换成功"
  });
  const thirdParty = evidenceFromCandidate("2026-06", {
    code: "火焰鸟",
    sourceKey: "third_party_page",
    sourceName: "第三方页面",
    sourceType: "third_party_html",
    sourceUrl: "https://example.com/code",
    confidence: 0.52,
    evidenceCount: 1,
    evidence: "第三方报告"
  });

  assert.equal(official.status, "official_notice");
  assert.equal(official.confidenceScore, 70);
  assert.equal(community.status, "corroborated");
  assert.equal(community.confidenceScore, 55);
  assert.equal(thirdParty.status, "reported");
  assert.equal(thirdParty.confidenceScore, 18);
});

test("官方谜题图片会保存为无兑换码的官方公告证据", () => {
  const evidence = evidenceFromPuzzle("2026-06", {
    source_key: "official_telegram",
    source_type: "official_telegram"
  }, {
    imageUrl: "https://cdn4.telesco.pe/file/puzzle.jpg",
    postUrl: "https://t.me/pokemon521/365"
  });

  assert.equal(evidence.code, null);
  assert.equal(evidence.status, "official_notice");
  assert.equal(evidence.sourceUrl, "https://cdn4.telesco.pe/file/puzzle.jpg");
  assert.equal(evidence.referenceUrl, "https://t.me/pokemon521/365");
});

test("可信度标签面向普通用户表达验证阶段", () => {
  assert.equal(trustLabelForStatus("checkout_verified"), "已验证");
  assert.equal(trustLabelForStatus("reported"), "第三方报告，建议结算前确认");
  assert.equal(trustLabelForStatus("candidate"), "候选线索，等待复核");
});

test("搜索流程会基于商家别名、套餐和月份生成发现入口", () => {
  const queries = providerSearchQueries({
    aliases: ["宝可梦星云", "pokemon521"],
    planKeywords: ["入门精灵球"],
    publicChannels: ["pokemon521"]
  }, 2026, 6);
  const text = queries.map((item) => item.query).join("\n");

  assert.ok(text.includes('"宝可梦星云" "优惠码"'));
  assert.ok(text.includes('"pokemon521" "入门精灵球"'));
  assert.ok(text.includes('site:t.me/s/pokemon521 "六月"'));
  assert.ok(text.includes('site:github.com "宝可梦星云" 优惠码'));
  assert.ok(queries.some((item) => item.kind === "linuxdo_topic"));
});

test("fetchTopic 会按 post_stream.stream 加载后续评论", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).endsWith("/t/topic/2289939.json")) {
      return Response.json({
        title: "六月兑换码",
        post_stream: {
          stream: [1, 2, 3],
          posts: [{ id: 1, cooked: "主帖" }]
        }
      });
    }
    return Response.json({
      post_stream: {
        posts: [
          { id: 2, cooked: "兑换码：火焰鸟" },
          { id: 3, cooked: "火焰鸟兑换成功" }
        ]
      }
    });
  };

  try {
    const topic = await fetchTopic("https://linux.do/t/topic/2289939");
    assert.deepEqual(topic.posts.map((post) => post.id), [1, 2, 3]);
    assert.equal(requested[1], "https://linux.do/t/topic/2289939.json?post_ids[]=2&post_ids[]=3");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("fetchTopic 在 LINUX DO JSON 被拒绝时会使用公开 Reader 回退", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (String(url).endsWith("/t/topic/2289939.json")) return new Response("Forbidden", { status: 403 });
    return new Response(`
Title: 宝可梦机场之六月免费兑换码猜猜我是谁 - 福利羊毛 - LINUX DO

Markdown Content:
# 宝可梦机场之六月免费兑换码猜猜我是谁

使用教程：猜出来名字，购买入门精灵球优惠码那里输入。

## post by qppq54 on Jun 2

火焰鸟

## post by KonBAI on Jun 2

火焰鸟,一直在用，感谢佬提供的机场服务！

## post by MFC on Jun 2

火焰鸟 感谢各位宝可梦大佬给出正确答案
`, {
      status: 200,
      headers: { "Content-Type": "text/plain" }
    });
  };

  try {
    const topic = await fetchTopic("https://linux.do/t/topic/2289939");
    assert.equal(topic.title, "宝可梦机场之六月免费兑换码猜猜我是谁 - 福利羊毛 - LINUX DO");
    assert.equal(topic.posts.length, 4);
    assert.ok(requested.some((url) => url.startsWith("https://r.jina.ai/http://linux.do/t/topic/2289939")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discoverTopic 兼容中文月份标题", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({
    topics: [
      { id: 11, title: "宝可梦机场六月免费兑换码，猜猜我是谁" },
      { id: 12, title: "宝可梦机场五月免费兑换码，猜猜我是谁" }
    ]
  });

  try {
    const topic = await discoverTopic(new Date("2026-06-02T01:00:00.000Z"));
    assert.deepEqual(topic, {
      url: "https://linux.do/t/topic/11",
      title: "宝可梦机场六月免费兑换码，猜猜我是谁"
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discoverTopic 会记录每次站内搜索发现的候选帖子", async () => {
  const originalFetch = globalThis.fetch;
  const discoveries = [];
  globalThis.fetch = async () => Response.json({
    topics: [
      { id: 11, title: "宝可梦机场六月免费兑换码，猜猜我是谁" }
    ]
  });

  try {
    const topic = await discoverTopic(new Date("2026-06-02T01:00:00.000Z"), {
      onDiscovery(item) {
        discoveries.push(item);
      }
    });
    assert.equal(topic.url, "https://linux.do/t/topic/11");
    assert.ok(discoveries.length > 0);
    assert.equal(discoveries[0].kind, "linuxdo_topic");
    assert.equal(discoveries[0].sourceUrl, "https://linux.do/t/topic/11");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("discoverTopic 会使用多组公开搜索词扩大命中范围", async () => {
  const originalFetch = globalThis.fetch;
  const requested = [];
  globalThis.fetch = async (url) => {
    requested.push(String(url));
    if (requested.length === 1) return Response.json({ topics: [] });
    return Response.json({
      topics: [
        { id: 99, title: "宝可梦星云 2026 年 6 月免费兑换码，猜猜我是谁" }
      ]
    });
  };

  try {
    const topic = await discoverTopic(new Date("2026-06-02T01:00:00.000Z"));
    assert.equal(topic.url, "https://linux.do/t/topic/99");
    assert.ok(requested.length >= 2);
    assert.ok(requested.some((url) => decodeURIComponent(url).includes("宝可梦星云")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("管理员测试帖子接口只分析不写数据库", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/t/topic/2289939.json")) {
      return Response.json({
        title: "宝可梦机场六月免费兑换码",
        post_stream: {
          stream: [1, 2, 3],
          posts: [{ id: 1, cooked: "主帖" }]
        }
      });
    }
    return Response.json({
      post_stream: {
        posts: [
          { id: 2, cooked: "兑换码：火焰鸟" },
          { id: 3, cooked: "火焰鸟兑换成功" }
        ]
      }
    });
  };

  const env = {
    ADMIN_TOKEN: "local-test-token",
    DB: {
      prepare() {
        throw new Error("测试帖子接口不应访问数据库");
      }
    },
    ASSETS: {
      fetch() {
        throw new Error("测试帖子接口不应访问静态资源");
      }
    }
  };

  try {
    const response = await worker.fetch(new Request("https://example.test/api/admin/test-topic", {
      method: "POST",
      headers: {
        Authorization: "Bearer local-test-token",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ topicUrl: "https://linux.do/t/topic/2289939" })
    }), env);
    const data = await response.json();

    assert.equal(response.status, 200);
    assert.equal(data.ok, true);
    assert.equal(data.url, "https://linux.do/t/topic/2289939");
    assert.equal(data.postCount, 3);
    assert.equal(data.candidate.code, "火焰鸟");
    assert.equal(data.candidate.evidenceCount, 6);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("extractTelegramPuzzleImage 能从官方谜题公告中提取图片", () => {
  const html = `
    <div class="tgme_widget_message_wrap js-widget_message_wrap">
      <div class="tgme_widget_message" data-post="pokemon521/365">
        <a class="tgme_widget_message_photo_wrap" href="https://t.me/pokemon521/365"
          style="width:800px;background-image:url('https://cdn4.telesco.pe/file/puzzle.jpg')">
          <div class="tgme_widget_message_photo"></div>
        </a>
        <div class="tgme_widget_message_text js-message_text" dir="auto">
          六月份免费优惠码 之猜猜我是谁<br/>使用教程：猜出来名字
        </div>
      </div>
    </div>
  `;

  assert.deepEqual(extractTelegramPuzzleImage(html), {
    imageUrl: "https://cdn4.telesco.pe/file/puzzle.jpg",
    postUrl: "https://t.me/pokemon521/365"
  });
});
