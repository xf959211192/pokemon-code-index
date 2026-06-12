import assert from "node:assert/strict";
import test from "node:test";

import { buildHealth, periodOf, verifiedFrom } from "../src/index.js";

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
