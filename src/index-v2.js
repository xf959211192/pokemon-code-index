import oldWorker, {
  communityCandidate,
  evidenceFromCandidate,
  fetchTopic,
  inAutoWindow,
  periodOf
} from "./index.js";

const POKEMON_PROVIDER_KEY = "pokemon_nebula";
const KNOWN_TOPIC_GRACE_DAY = 14;

const KNOWN_LINUXDO_TOPICS = {
  "2026-02": {
    url: "https://linux.do/t/topic/1550007",
    title: "宝可梦机场之二月优惠码猜猜我是谁！"
  },
  "2026-04": {
    url: "https://linux.do/t/topic/1876094",
    title: "砥砺前行 宝可梦机场之四月免费兑换码猜猜我是谁"
  },
  "2026-05": {
    url: "https://linux.do/t/topic/2092025",
    title: "五一优惠大放送和 宝可梦机场之五月免费兑换码猜猜我是谁"
  },
  "2026-06": {
    url: "https://linux.do/t/topic/2289939",
    title: "宝可梦机场之六月免费兑换码猜猜我是谁"
  },
  "2026-07": {
    url: "https://linux.do/t/topic/2504318",
    title: "宝可梦机场之七月免费兑换码猜猜我是谁"
  }
};

const KNOWN_VERIFIED_CODES = {
  "2026-07": {
    code: "小火马",
    sourceUrl: "https://linux.do/t/topic/2504318",
    sourceTitle: "LINUX DO 七月月度帖社区共识",
    confidence: 0.98,
    evidenceCount: 12,
    evidence: "LINUX DO 七月月度帖评论区多次出现“小火马”，并有续期成功/成功续费等反馈。"
  }
};

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function chinaParts(date = new Date()) {
  const d = new Date(date.getTime() + 8 * 3600_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function inKnownTopicGraceWindow(date = new Date()) {
  const { day } = chinaParts(date);
  return day >= 1 && day <= KNOWN_TOPIC_GRACE_DAY;
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let index = 0; index < a.length; index += 1) diff |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return diff === 0;
}

function authorized(request, env) {
  const expected = env.ADMIN_TOKEN ? `Bearer ${env.ADMIN_TOKEN}` : "";
  const actual = request.headers.get("Authorization") ?? "";
  if (!expected || actual.length !== expected.length) return false;
  return constantTimeEqual(actual, expected);
}

async function body(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function hasVerifiedCode(env, period) {
  return Boolean(await env.DB.prepare(
    `SELECT 1 FROM codes WHERE period = ? AND status = 'verified' LIMIT 1`
  ).bind(period).first());
}

async function log(env, period, triggerType, result, message, sourceUrl = null) {
  await env.DB.prepare(
    `INSERT INTO refresh_logs(period, trigger_type, result, message, source_url) VALUES (?, ?, ?, ?, ?)`
  ).bind(period, triggerType, result, message, sourceUrl).run();
}

async function sourceCheck(env, period, result, message, candidateCount = 0, sourceUrl = "https://linux.do") {
  await env.DB.prepare(
    `INSERT INTO source_checks(source_key, period, result, message, source_url, candidate_count) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind("linuxdo_monthly_topic", period, result, message, sourceUrl, candidateCount).run();
}

function rankStatus(status = "") {
  const ranks = {
    candidate: 1,
    unknown: 1,
    reported: 2,
    corroborated: 3,
    official_notice: 4,
    checkout_verified: 5,
    expired: 0
  };
  return ranks[status] ?? 1;
}

async function recordEvidence(env, evidence) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO offer_evidence(
      provider_key, period, code, source_key, source_type, source_url, reference_url, is_official,
      status, confidence_score, evidence_excerpt, evidence_hash, extraction_method, verification_method, reviewer
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    evidence.providerKey,
    evidence.period,
    evidence.code,
    evidence.sourceKey,
    evidence.sourceType,
    evidence.sourceUrl,
    evidence.referenceUrl,
    evidence.isOfficial,
    evidence.status,
    evidence.confidenceScore,
    evidence.evidenceExcerpt,
    evidence.evidenceHash,
    evidence.extractionMethod,
    evidence.verificationMethod,
    evidence.reviewer
  ).run();

  if (!evidence.code) return;

  const current = await env.DB.prepare(`
    SELECT status, confidence_score FROM offers
    WHERE provider_key = ? AND period = ? AND code = ?
    LIMIT 1
  `).bind(evidence.providerKey, evidence.period, evidence.code).first();

  const nextStatus = !current || rankStatus(evidence.status) >= rankStatus(current.status)
    ? evidence.status
    : current.status;
  const nextScore = Math.max(Number(current?.confidence_score ?? 0), evidence.confidenceScore);
  const sourceCount = await env.DB.prepare(`
    SELECT COUNT(DISTINCT COALESCE(source_key, source_url)) AS count
    FROM offer_evidence
    WHERE provider_key = ? AND period = ? AND code = ?
  `).bind(evidence.providerKey, evidence.period, evidence.code).first();

  await env.DB.prepare(`
    INSERT INTO offers(provider_key, period, code, status, confidence_score, source_count, last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(provider_key, period, code) DO UPDATE SET
      status = excluded.status,
      confidence_score = excluded.confidence_score,
      source_count = excluded.source_count,
      last_seen_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    evidence.providerKey,
    evidence.period,
    evidence.code,
    nextStatus,
    nextScore,
    Number(sourceCount?.count ?? 1)
  ).run();
}

async function tryRecordEvidence(env, evidence) {
  try {
    await recordEvidence(env, evidence);
  } catch (error) {
    console.warn("v2_record_evidence_failed", error instanceof Error ? error.message : String(error));
  }
}

async function saveCandidate(env, period, item) {
  await env.DB.prepare(`
    INSERT INTO code_candidates(period, code, source_key, source_name, source_type, source_url, confidence, evidence_count, evidence, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(period, code, source_url) DO UPDATE SET
      confidence = MAX(code_candidates.confidence, excluded.confidence),
      evidence_count = MAX(code_candidates.evidence_count, excluded.evidence_count),
      evidence = excluded.evidence,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    period,
    item.code,
    item.sourceKey,
    item.sourceName,
    item.sourceType,
    item.sourceUrl,
    item.confidence,
    item.evidenceCount,
    item.evidence
  ).run();

  await tryRecordEvidence(env, evidenceFromCandidate(period, item));
}

async function upsertVerifiedCode(env, period, item) {
  await env.DB.prepare(`
    INSERT INTO codes(period, code, status, confidence, evidence_count, source_url, source_title, updated_at)
    VALUES (?, ?, 'verified', ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(period) DO UPDATE SET
      code = excluded.code,
      status = excluded.status,
      confidence = excluded.confidence,
      evidence_count = excluded.evidence_count,
      source_url = excluded.source_url,
      source_title = excluded.source_title,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    period,
    item.code,
    item.confidence,
    item.evidenceCount,
    item.sourceUrl,
    item.sourceTitle ?? "LINUX DO 已知月度帖社区共识"
  ).run();
}

function verifiedFromCommunity(item) {
  if (!item) return null;
  if (Number(item.confidence) < 0.75 || Number(item.evidenceCount) < 4) return null;
  return {
    code: item.code,
    confidence: Number(item.confidence),
    evidenceCount: Number(item.evidenceCount),
    sourceUrl: item.sourceUrl,
    sourceTitle: "LINUX DO 已知月度帖社区共识"
  };
}

function knownCodeCandidate(period) {
  const seed = KNOWN_VERIFIED_CODES[period];
  if (!seed) return null;
  return {
    code: seed.code,
    sourceKey: "linuxdo_monthly_topic",
    sourceName: seed.sourceTitle,
    sourceType: "linuxdo_topic",
    sourceUrl: seed.sourceUrl,
    confidence: seed.confidence,
    evidenceCount: seed.evidenceCount,
    evidence: seed.evidence
  };
}

async function seedKnownVerifiedCode(env, period, triggerType = "known_code_seed") {
  const seed = KNOWN_VERIFIED_CODES[period];
  if (!seed) return { ok: false, seeded: false, reason: "no_known_code" };
  if (await hasVerifiedCode(env, period)) return { ok: true, seeded: false, skipped: true, reason: "already_verified", period };

  const item = knownCodeCandidate(period);
  await saveCandidate(env, period, item);
  await upsertVerifiedCode(env, period, {
    code: seed.code,
    confidence: seed.confidence,
    evidenceCount: seed.evidenceCount,
    sourceUrl: seed.sourceUrl,
    sourceTitle: seed.sourceTitle
  });
  await sourceCheck(
    env,
    period,
    "known_code_seeded",
    `v2 已按内置公开证据自动写入：${seed.code}`,
    1,
    seed.sourceUrl
  );
  await log(env, period, triggerType, "updated", `v2 已按内置公开证据自动写入 ${period}：${seed.code}`, seed.sourceUrl);

  return {
    ok: true,
    seeded: true,
    period,
    code: seed.code,
    confidence: seed.confidence,
    evidenceCount: seed.evidenceCount,
    sourceUrl: seed.sourceUrl,
    sourceTitle: seed.sourceTitle,
    message: `已自动写入 ${period} 兑换码：${seed.code}`
  };
}

async function seedCurrentKnownCodeIfNeeded(env, triggerType) {
  try {
    return await seedKnownVerifiedCode(env, periodOf(), triggerType);
  } catch (error) {
    console.warn("v2_seed_current_failed", error instanceof Error ? error.message : String(error));
    return { ok: false, seeded: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function normalizeManualTopicUrl(topicUrl) {
  const value = String(topicUrl ?? "").trim();
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "linux.do") throw new Error("指定帖子仅支持 https://linux.do 地址");
  return value;
}

function knownTopicFor(period) {
  return KNOWN_LINUXDO_TOPICS[period] ?? null;
}

async function refreshKnownTopic(env, { force = false, triggerType = "manual_refresh", topicUrl = null, now = new Date() } = {}) {
  const period = periodOf(now);
  const seeded = await seedKnownVerifiedCode(env, period, `${triggerType}:known_code_seed`);
  if (seeded.seeded || seeded.skipped) return seeded;

  const manualTopicUrl = normalizeManualTopicUrl(topicUrl);
  const knownTopic = manualTopicUrl ? { url: manualTopicUrl, title: "管理员指定 LINUX DO 帖子" } : knownTopicFor(period);

  if (!knownTopic) {
    return { ok: false, fallbackToOld: true, period, message: "没有配置本月已知 LINUX DO 帖子，回退旧自动搜索" };
  }

  if (!force && !inAutoWindow(now) && !inKnownTopicGraceWindow(now)) {
    const message = `当前不在自动检查窗口，且已知帖子兜底仅运行到每月 ${KNOWN_TOPIC_GRACE_DAY} 日`;
    await log(env, period, triggerType, "skipped", message, knownTopic.url);
    return { ok: true, skipped: true, period, message };
  }

  if (!force && await hasVerifiedCode(env, period)) {
    const message = "本月已有已确认兑换码，停止自动抓取";
    await log(env, period, triggerType, "skipped", message, knownTopic.url);
    return { ok: true, skipped: true, period, message };
  }

  try {
    const topic = await fetchTopic(knownTopic.url);
    const item = communityCandidate(topic);

    if (item) await saveCandidate(env, period, item);
    await sourceCheck(
      env,
      period,
      item ? "candidate_found" : "no_candidate",
      item
        ? `v2 已知帖兜底：读取评论 ${topic.posts.length} 条；社区候选：${item.code}；证据分数：${item.evidenceCount}`
        : `v2 已知帖兜底：读取评论 ${topic.posts.length} 条；没有提取出高可信社区答案`,
      item ? 1 : 0,
      topic.url
    );

    const verified = verifiedFromCommunity(item);
    if (!verified) {
      const message = item ? "已保存候选，但尚未达到自动确认条件" : "没有提取到候选兑换码";
      await log(env, period, triggerType, "candidate_not_verified", message, topic.url);
      return { ok: false, period, message, topic: { url: topic.url, title: topic.title }, candidate: item ?? null };
    }

    await upsertVerifiedCode(env, period, verified);
    const message = `v2 已通过已知 LINUX DO 月度帖更新 ${period} 兑换码：${verified.code}`;
    await log(env, period, triggerType, "updated", message, verified.sourceUrl);
    return {
      ok: true,
      period,
      message,
      code: verified.code,
      confidence: verified.confidence,
      evidenceCount: verified.evidenceCount,
      sourceUrl: verified.sourceUrl,
      sourceTitle: verified.sourceTitle,
      topic: { url: topic.url, title: topic.title }
    };
  } catch (error) {
    const seedAfterError = await seedKnownVerifiedCode(env, period, `${triggerType}:known_code_after_error`);
    if (seedAfterError.seeded || seedAfterError.skipped) return seedAfterError;

    const message = error instanceof Error ? error.message : String(error);
    await sourceCheck(env, period, "error", `v2 已知帖兜底失败：${message}`, 0, knownTopic.url);
    await log(env, period, triggerType, "error", message, knownTopic.url);
    return { ok: false, period, message, topic: knownTopic };
  }
}

async function runOldScheduled(controller, env) {
  if (!oldWorker.scheduled) return;
  await oldWorker.scheduled(controller, env, { waitUntil: (promise) => promise });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/latest" && request.method === "GET") {
      await seedCurrentKnownCodeIfNeeded(env, "public_latest_known_code_seed");
      return oldWorker.fetch(request, env, ctx);
    }

    if (url.pathname === "/api/admin/refresh" && request.method === "POST") {
      if (!authorized(request, env)) return json({ ok: false, message: "管理员令牌错误" }, 401);
      const data = await body(request);
      try {
        const result = await refreshKnownTopic(env, {
          force: true,
          triggerType: "manual_refresh_v2",
          topicUrl: data.topicUrl || null
        });
        if (result.fallbackToOld) return oldWorker.fetch(request, env, ctx);
        return json(result, result.ok ? 200 : 422);
      } catch (error) {
        return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 422);
      }
    }

    return oldWorker.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil((async () => {
      const result = await refreshKnownTopic(env, {
        force: false,
        triggerType: `cron_v2:${controller.cron}`
      });
      if (result.fallbackToOld) await runOldScheduled(controller, env);
    })());
  }
};

export {
  KNOWN_LINUXDO_TOPICS,
  KNOWN_VERIFIED_CODES,
  refreshKnownTopic,
  seedKnownVerifiedCode
};
