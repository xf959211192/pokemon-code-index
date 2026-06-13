import assert from "node:assert/strict";
import test from "node:test";

import { buildHealth, discoverTopic, fetchTopic, periodOf, verifiedFrom } from "../src/index.js";

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
