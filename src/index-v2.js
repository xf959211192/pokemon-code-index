import oldWorker, {
  communityCandidate,
  fetchTopic,
  inAutoWindow,
  periodOf
} from "./index.js";

const LINUXDO_BASE = "https://linux.do";
const JINA_READER_BASE = "https://r.jina.ai/http://";
const KNOWN_TOPIC_GRACE_DAY = 14;
const MAX_DISCOVERY_PAGES = 24;
const DISCOVERY_BATCH_SIZE = 4;
const FETCH_TIMEOUT_MS = 15000;

const CN_MONTHS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

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

async function body(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

function stripHtml(text = "") {
  return String(text)
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function safeUrl(value) {
  if (!value) return null;
  const url = new URL(String(value).trim());
  if (url.protocol !== "https:") throw new Error("来源地址必须使用 HTTPS");
  return url.toString();
}

function normalizeTopic(value) {
  const url = new URL(String(value ?? "").trim());
  if (url.protocol !== "https:" || url.hostname !== "linux.do") throw new Error("仅支持 https://linux.do 帖子地址");
  const match = url.pathname.match(/^\/t\/(?:[^/]+\/)?topic\/(\d+)/) || url.pathname.match(/^\/t\/topic\/(\d+)/);
  if (!match) throw new Error("不是有效的 LINUX DO 话题地址");
  return `${LINUXDO_BASE}/t/topic/${match[1]}`;
}

function normalizeManualTopicUrl(topicUrl) {
  const value = String(topicUrl ?? "").trim();
  return value ? normalizeTopic(value) : null;
}

function plausibleCode(value) {
  const code = String(value ?? "").trim();
  return Boolean(
    code &&
    /^([\u4e00-\u9fa5]{2,8}|[A-Za-z0-9_-]{3,64}|[A-Fa-f0-9]{8}(?:-[A-Fa-f0-9]{4}){3}-[A-Fa-f0-9]{12})$/.test(code) &&
    !/(感谢|谢谢|支持|大佬|佬友|前排|优惠|兑换|白嫖|礼品|套餐|使用|输入|官网|备用|机场|免费|成功|失败|快乐|答案|正确|这个|那个|来了)/.test(code)
  );
}

function hashText(value = "") {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
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

async function fetchText(url, accept = "text/plain,*/*", timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        Accept: accept,
        "User-Agent": "pokemon-code-index/1.0"
      },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function readerUrlForLinuxDo(value) {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.hostname !== "linux.do") throw new Error("Reader 只允许读取 linux.do 公开页面");
  return `${JINA_READER_BASE}${url.hostname}${url.pathname}${url.search}`;
}

function monthSearchTerms(month) {
  const cn = CN_MONTHS[month];
  return [
    `${month}月`,
    `${String(month).padStart(2, "0")}月`,
    cn ? `${cn}月` : "",
    cn ? `${cn}月份` : ""
  ].filter(Boolean);
}

function scoreTopicTitle(title, now = new Date()) {
  const { month } = chinaParts(now);
  const text = stripHtml(title);
  if (!text.includes("宝可梦")) return 0;
  if (!monthSearchTerms(month).some((term) => text.includes(term))) return 0;
  let score = 8;
  if (/兑换码|优惠码|白嫖码|免费码|免费兑换码/.test(text)) score += 4;
  if (/猜猜我是谁|答案|谜题/.test(text)) score += 3;
  if (/宝可梦机场|宝可梦星云|宝可梦云|pokemon/i.test(text)) score += 2;
  if (/每月|月度|本月/.test(text)) score += 1;
  return score;
}

function parseTopicLinks(markdown = "") {
  const topics = [];
  const seen = new Set();
  const text = String(markdown ?? "");
  const patterns = [
    /\[([^\]\n]+)]\(https?:\/\/linux\.do\/t\/(?:[^/)]+\/)?topic\/(\d+)[^)]*\)/g,
    /\[([^\]\n]+)]\(\/t\/(?:[^/)]+\/)?topic\/(\d+)[^)]*\)/g,
    /href=["']https?:\/\/linux\.do\/t\/(?:[^"']+\/)?topic\/(\d+)[^"']*["'][^>]*>([^<]+)</g,
    /https?:\/\/linux\.do\/t\/(?:[^\s)]+\/)?topic\/(\d+)/g
  ];

  for (const pattern of patterns.slice(0, 3)) {
    for (const match of text.matchAll(pattern)) {
      const title = stripHtml(pattern === patterns[2] ? match[2] : match[1]);
      const id = Number(pattern === patterns[2] ? match[1] : match[2]);
      if (!title || !id || seen.has(id)) continue;
      seen.add(id);
      topics.push({ id, title, url: `${LINUXDO_BASE}/t/topic/${id}` });
    }
  }

  for (const match of text.matchAll(patterns[3])) {
    const id = Number(match[1]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    topics.push({ id, title: `linux.do topic ${id}`, url: `${LINUXDO_BASE}/t/topic/${id}` });
  }

  return topics;
}

function addDiscoveryCandidate(map, item, now, kind, query) {
  const score = scoreTopicTitle(item.title, now);
  if (!score) return null;
  const current = map.get(item.id);
  const next = { ...item, score, kind, query };
  if (!current || score > current.score) map.set(item.id, next);
  return next;
}

async function recordDiscovery(env, item) {
  try {
    await env.DB.prepare(`
      INSERT INTO source_discoveries(provider_key, period, discovery_kind, query, title, source_url, score, updated_at)
      VALUES ('pokemon_nebula', ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(provider_key, period, discovery_kind, source_url, query) DO UPDATE SET
        title = excluded.title,
        score = MAX(source_discoveries.score, excluded.score),
        updated_at = CURRENT_TIMESTAMP
    `).bind(item.period, item.kind, item.query, item.title, item.sourceUrl, item.score).run();
  } catch (error) {
    console.warn("record_discovery_failed", error instanceof Error ? error.message : String(error));
  }
}

async function discoverFromLinuxDoSearch(env, now) {
  const { year, month } = chinaParts(now);
  const period = periodOf(now);
  const cn = CN_MONTHS[month];
  const queries = [
    `宝可梦 ${year} ${month}月 免费兑换码`,
    `宝可梦机场 ${cn}月 免费兑换码 猜猜我是谁`,
    `宝可梦机场 ${month}月 优惠码`,
    `宝可梦星云 ${cn}月 兑换码`,
    `pokemon521 ${month}月 兑换码`
  ].filter(Boolean);
  const candidates = new Map();

  for (const query of queries) {
    try {
      const text = await fetchText(`${LINUXDO_BASE}/search.json?q=${encodeURIComponent(query)}`, "application/json,*/*", 12000);
      const data = JSON.parse(text);
      for (const topic of data.topics ?? []) {
        const item = {
          id: Number(topic.id),
          title: String(topic.title ?? ""),
          url: `${LINUXDO_BASE}/t/topic/${topic.id}`
        };
        const found = addDiscoveryCandidate(candidates, item, now, "linuxdo_search", query);
        if (found) await recordDiscovery(env, { period, kind: found.kind, query: found.query, title: found.title, sourceUrl: found.url, score: found.score });
      }
    } catch (error) {
      await log(env, period, "discover_search", "search_error", `${query}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return [...candidates.values()].sort((a, b) => b.score - a.score);
}

async function discoverFromLinuxDoCategory(env, now) {
  const period = periodOf(now);
  const candidates = new Map();
  const seedTopics = new Map();

  for (let page = 1; page <= MAX_DISCOVERY_PAGES; page += DISCOVERY_BATCH_SIZE) {
    const batch = Array.from(
      { length: Math.min(DISCOVERY_BATCH_SIZE, MAX_DISCOVERY_PAGES - page + 1) },
      (_, index) => page + index
    );
    const settled = await Promise.allSettled(batch.map((pageNumber) => {
      const pageUrl = `${LINUXDO_BASE}/c/welfare/36?page=${pageNumber}`;
      return fetchText(readerUrlForLinuxDo(pageUrl), "text/plain,*/*", 15000).then((content) => ({ pageNumber, content }));
    }));

    for (const result of settled) {
      if (result.status !== "fulfilled") continue;
      for (const topic of parseTopicLinks(result.value.content)) {
        if (topic.title.includes("宝可梦")) seedTopics.set(topic.id, topic);
        const found = addDiscoveryCandidate(candidates, topic, now, "linuxdo_category", `linux.do/c/welfare/36?page=${result.value.pageNumber}`);
        if (found) await recordDiscovery(env, { period, kind: found.kind, query: found.query, title: found.title, sourceUrl: found.url, score: found.score });
      }
    }

    const ranked = [...candidates.values()].sort((a, b) => b.score - a.score);
    if (ranked[0]?.score >= 10) return ranked;
  }

  const related = await discoverFromRelatedSeeds(env, now, [...seedTopics.values()].slice(0, 12));
  for (const item of related) {
    const current = candidates.get(item.id);
    if (!current || item.score > current.score) candidates.set(item.id, item);
  }

  return [...candidates.values()].sort((a, b) => b.score - a.score);
}

async function discoverFromRelatedSeeds(env, now, seeds) {
  const period = periodOf(now);
  const candidates = new Map();
  const settled = await Promise.allSettled(seeds.map((seed) => fetchText(readerUrlForLinuxDo(seed.url), "text/plain,*/*", 15000).then((content) => ({ seed, content }))));

  for (const result of settled) {
    if (result.status !== "fulfilled") continue;
    for (const topic of parseTopicLinks(result.value.content)) {
      const found = addDiscoveryCandidate(candidates, topic, now, "linuxdo_related_topic", result.value.seed.url);
      if (found) await recordDiscovery(env, { period, kind: found.kind, query: found.query, title: found.title, sourceUrl: found.url, score: found.score });
    }
  }

  return [...candidates.values()].sort((a, b) => b.score - a.score);
}

async function discoverMonthlyTopic(env, now = new Date()) {
  const period = periodOf(now);
  const found = [];

  found.push(...await discoverFromLinuxDoSearch(env, now));
  found.push(...await discoverFromLinuxDoCategory(env, now));

  const known = KNOWN_LINUXDO_TOPICS[period];
  if (known) {
    found.push({
      id: Number(known.url.match(/topic\/(\d+)/)?.[1] ?? 0),
      url: known.url,
      title: known.title,
      score: 9,
      kind: "known_topic_url",
      query: "KNOWN_LINUXDO_TOPICS"
    });
  }

  const deduped = new Map();
  for (const item of found) {
    const url = normalizeTopic(item.url);
    const current = deduped.get(url);
    if (!current || Number(item.score) > Number(current.score)) deduped.set(url, { ...item, url });
  }

  const ranked = [...deduped.values()].sort((a, b) => Number(b.score) - Number(a.score));
  if (!ranked[0] || Number(ranked[0].score) < 6) throw new Error("没有发现本月 LINUX DO 公开月度帖");
  await log(env, period, "discover_monthly_topic", "discovered", `发现候选帖子：${ranked[0].title}`, ranked[0].url);
  return ranked[0];
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
    console.warn("record_evidence_failed", error instanceof Error ? error.message : String(error));
  }
}

function evidenceFor(period, item, sourceKey = "manual_admin") {
  const sourceUrl = item.sourceUrl ? safeUrl(item.sourceUrl) : "https://pokemon-code-index.xf959211192.workers.dev/admin.html";
  const evidenceExcerpt = item.evidence || "后台写入或公开帖识别";
  return {
    providerKey: "pokemon_nebula",
    period,
    code: item.code,
    sourceKey,
    sourceType: item.sourceType ?? (sourceKey === "linuxdo_monthly_topic" ? "linuxdo_topic" : "manual"),
    sourceUrl,
    referenceUrl: item.referenceUrl ?? item.sourceUrl ?? null,
    isOfficial: 0,
    status: item.status ?? (sourceKey === "linuxdo_monthly_topic" ? "corroborated" : "checkout_verified"),
    confidenceScore: item.confidenceScore ?? (sourceKey === "linuxdo_monthly_topic" ? 65 : 90),
    evidenceExcerpt,
    evidenceHash: hashText(["pokemon_nebula", period, item.code, sourceKey, sourceUrl, evidenceExcerpt].join("|")),
    extractionMethod: item.extractionMethod ?? (sourceKey === "linuxdo_monthly_topic" ? "linuxdo_public_topic" : "manual_entry"),
    verificationMethod: item.verificationMethod ?? (sourceKey === "linuxdo_monthly_topic" ? "community_consensus" : "open_admin_write"),
    reviewer: item.reviewer ?? "open_admin"
  };
}

async function saveCandidate(env, period, item, sourceKey = item.sourceKey ?? "manual_admin") {
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
    sourceKey,
    item.sourceName,
    item.sourceType ?? (sourceKey === "linuxdo_monthly_topic" ? "linuxdo_topic" : "manual"),
    item.sourceUrl,
    item.confidence,
    item.evidenceCount,
    item.evidence
  ).run();

  await tryRecordEvidence(env, evidenceFor(period, item, sourceKey));
}

async function upsertVerifiedCode(env, period, item, status = "verified") {
  await env.DB.prepare(`
    INSERT INTO codes(period, code, status, confidence, evidence_count, source_url, source_title, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
    status,
    item.confidence,
    item.evidenceCount,
    item.sourceUrl,
    item.sourceTitle ?? "后台手动确认"
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
    sourceTitle: "LINUX DO 月度帖社区共识",
    sourceKey: "linuxdo_monthly_topic",
    sourceName: "LINUX DO 月度帖社区共识",
    sourceType: "linuxdo_topic",
    evidence: item.evidence ?? "LINUX DO 评论区社区共识"
  };
}

async function manual(env, data) {
  const period = /^\d{4}-\d{2}$/.test(data.period ?? "") ? data.period : periodOf();
  const code = String(data.code ?? "").trim();
  if (!plausibleCode(code)) throw new Error("兑换码格式不正确");
  const sourceUrl = data.sourceUrl ? safeUrl(data.sourceUrl) : null;
  const item = {
    code,
    sourceKey: "manual_admin",
    sourceName: "开放后台手动补录",
    sourceType: "manual",
    sourceUrl: sourceUrl ?? "https://pokemon-code-index.xf959211192.workers.dev/admin.html",
    confidence: 1,
    evidenceCount: 1,
    evidence: "开放后台手动补录并确认",
    sourceTitle: "开放后台手动确认"
  };
  await saveCandidate(env, period, item, "manual_admin");
  await upsertVerifiedCode(env, period, item);
  await log(env, period, "manual_write_open_admin", "updated", `开放后台写入 ${period} 兑换码：${code}`, sourceUrl);
  return { ok: true, period, code };
}

async function testTopic(data) {
  const topicUrl = String(data.topicUrl ?? "").trim();
  if (!topicUrl) throw new Error("请先填写 LINUX DO 帖子地址");
  const topic = await fetchTopic(topicUrl);
  const candidate = communityCandidate(topic);
  return {
    ok: true,
    url: topic.url,
    title: topic.title,
    postCount: topic.posts.length,
    candidate,
    message: candidate
      ? `读取评论 ${topic.posts.length} 条；社区候选：${candidate.code}；证据分数：${candidate.evidenceCount}`
      : `读取评论 ${topic.posts.length} 条；没有提取出高可信社区答案`
  };
}

async function refreshKnownTopic(env, { force = false, triggerType = "manual_refresh", topicUrl = null, now = new Date() } = {}) {
  const period = periodOf(now);

  if (!force && !inAutoWindow(now) && !inKnownTopicGraceWindow(now)) {
    const message = `当前不在自动检查窗口，自动发现仅运行到每月 ${KNOWN_TOPIC_GRACE_DAY} 日`;
    await log(env, period, triggerType, "skipped", message);
    return { ok: true, skipped: true, period, message };
  }

  if (!force && await hasVerifiedCode(env, period)) {
    const message = "本月已有已确认兑换码，停止自动抓取";
    await log(env, period, triggerType, "skipped", message);
    return { ok: true, skipped: true, period, message };
  }

  let topicRef;
  try {
    const manualTopicUrl = normalizeManualTopicUrl(topicUrl);
    topicRef = manualTopicUrl
      ? { url: manualTopicUrl, title: "指定 LINUX DO 帖子", kind: "manual_topic_url" }
      : await discoverMonthlyTopic(env, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await log(env, period, triggerType, "topic_not_found", message);
    return { ok: false, period, message };
  }

  try {
    const topic = await fetchTopic(topicRef.url);
    const item = communityCandidate(topic);

    if (item) await saveCandidate(env, period, item, "linuxdo_monthly_topic");
    await sourceCheck(
      env,
      period,
      item ? "candidate_found" : "no_candidate",
      item
        ? `发现帖子：${topicRef.title || topic.title}；读取评论 ${topic.posts.length} 条；社区候选：${item.code}；证据分数：${item.evidenceCount}`
        : `发现帖子：${topicRef.title || topic.title}；读取评论 ${topic.posts.length} 条；没有提取出高可信社区答案`,
      item ? 1 : 0,
      topic.url
    );

    const verified = verifiedFromCommunity(item);
    if (!verified) {
      const message = item ? "已保存候选，但尚未达到自动确认条件" : "没有提取到候选兑换码";
      await log(env, period, triggerType, "candidate_not_verified", message, topic.url);
      return { ok: false, period, message, topic: { url: topic.url, title: topic.title || topicRef.title }, candidate: item ?? null };
    }

    await upsertVerifiedCode(env, period, verified);
    const message = `已通过 LINUX DO 月度帖更新 ${period} 兑换码：${verified.code}`;
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
      topic: { url: topic.url, title: topic.title || topicRef.title }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await sourceCheck(env, period, "error", `帖子读取或识别失败：${message}`, 0, topicRef.url);
    await log(env, period, triggerType, "error", message, topicRef.url);
    return { ok: false, period, message, topic: topicRef };
  }
}

async function listCandidates(env, period) {
  const { results } = await env.DB.prepare(`
    SELECT period, code, source_key, source_name, source_type, source_url, confidence, evidence_count, evidence, updated_at
    FROM code_candidates
    WHERE period = ?
    ORDER BY confidence DESC, evidence_count DESC, updated_at DESC
  `).bind(period).all();
  return results;
}

async function listOffers(env, period) {
  const { results } = await env.DB.prepare(`
    SELECT period, code, offer_type, discount_value, plan_name, status, confidence_score, source_count, first_seen_at, last_seen_at, last_verified_at, updated_at
    FROM offers
    WHERE period = ?
    ORDER BY confidence_score DESC, source_count DESC, updated_at DESC
  `).bind(period).all();
  return results;
}

async function listEvidence(env, period) {
  const { results } = await env.DB.prepare(`
    SELECT period, code, source_key, source_type, source_url, reference_url, is_official, status, confidence_score, evidence_excerpt, extraction_method, verification_method, reviewer, created_at
    FROM offer_evidence
    WHERE period = ?
    ORDER BY id DESC
    LIMIT 80
  `).bind(period).all();
  return results;
}

async function listDiscovery(env, period) {
  const planned = [
    { kind: "linuxdo_search", query: "宝可梦 + 当月 + 兑换码/优惠码", purpose: "优先搜索 Linux.do 站内话题" },
    { kind: "linuxdo_category", query: "linux.do/c/welfare/36", purpose: "搜索失败时扫描福利羊毛分类" },
    { kind: "linuxdo_related_topic", query: "已发现的宝可梦历史帖", purpose: "从历史帖关联链接继续找当月帖" }
  ];
  const { results } = await env.DB.prepare(`
    SELECT period, discovery_kind, query, title, source_url, score, updated_at
    FROM source_discoveries
    WHERE period = ?
    ORDER BY score DESC, updated_at DESC
    LIMIT 80
  `).bind(period).all();
  return { planned, discovered: results };
}

async function listSources(env) {
  const { results } = await env.DB.prepare(`
    SELECT s.*, c.result AS last_result, c.message AS last_message, c.source_url AS last_source_url, c.created_at AS last_checked_at
    FROM sources s
    LEFT JOIN source_checks c ON c.id = (SELECT id FROM source_checks WHERE source_key = s.source_key ORDER BY id DESC LIMIT 1)
    ORDER BY s.priority, s.id
  `).all();
  return results;
}

async function runOldScheduled(controller, env) {
  if (!oldWorker.scheduled) return;
  await oldWorker.scheduled(controller, env, { waitUntil: (promise) => promise });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const currentPeriod = periodOf();

    if (url.pathname === "/api/latest" && request.method === "GET") {
      return oldWorker.fetch(request, env, ctx);
    }

    if (url.pathname === "/api/history" && request.method === "GET") {
      return oldWorker.fetch(request, env, ctx);
    }

    if (url.pathname === "/api/admin/refresh" && request.method === "POST") {
      const data = await body(request);
      const result = await refreshKnownTopic(env, {
        force: true,
        triggerType: "manual_refresh_open_admin",
        topicUrl: data.topicUrl || null
      });
      return json(result, result.ok ? 200 : 422);
    }

    if (url.pathname === "/api/admin/test-topic" && request.method === "POST") {
      try { return json(await testTopic(await body(request))); }
      catch (error) { return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 422); }
    }

    if (url.pathname === "/api/admin/manual" && request.method === "POST") {
      try { return json(await manual(env, await body(request))); }
      catch (error) { return json({ ok: false, message: error instanceof Error ? error.message : String(error) }, 422); }
    }

    if (url.pathname === "/api/admin/logs" && request.method === "GET") {
      return json({ items: (await env.DB.prepare(`SELECT period, trigger_type, result, message, source_url, created_at FROM refresh_logs ORDER BY id DESC LIMIT 40`).all()).results });
    }

    if (url.pathname === "/api/admin/candidates" && request.method === "GET") return json({ period: currentPeriod, items: await listCandidates(env, currentPeriod) });
    if (url.pathname === "/api/admin/offers" && request.method === "GET") return json({ period: currentPeriod, items: await listOffers(env, currentPeriod) });
    if (url.pathname === "/api/admin/evidence" && request.method === "GET") return json({ period: currentPeriod, items: await listEvidence(env, currentPeriod) });
    if (url.pathname === "/api/admin/discovery" && request.method === "GET") return json({ period: currentPeriod, ...(await listDiscovery(env, currentPeriod)) });

    if (url.pathname === "/api/admin/discover" && request.method === "POST") {
      try {
        const bestTopic = await discoverMonthlyTopic(env);
        return json({ ok: true, period: currentPeriod, bestTopic, ...(await listDiscovery(env, currentPeriod)) });
      } catch (error) {
        return json({ ok: false, period: currentPeriod, message: error instanceof Error ? error.message : String(error), ...(await listDiscovery(env, currentPeriod)) }, 422);
      }
    }

    if (url.pathname === "/api/admin/backfill-recent" && request.method === "POST") {
      return json({ ok: false, message: "已移除固定码回填。请使用 /api/admin/manual 手动补录，或 /api/admin/refresh 指定公开帖识别。" }, 410);
    }

    if (url.pathname === "/api/admin/sources" && request.method === "GET") return json({ items: await listSources(env) });

    if (url.pathname === "/api/admin/sources/toggle" && request.method === "POST") {
      const data = await body(request);
      const result = await env.DB.prepare(`UPDATE sources SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE source_key = ?`)
        .bind(data.enabled ? 1 : 0, String(data.sourceKey ?? ""))
        .run();
      return json({ ok: Boolean(result.meta?.changes), sourceKey: data.sourceKey, enabled: Boolean(data.enabled) });
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
  discoverMonthlyTopic,
  manual,
  refreshKnownTopic
};
