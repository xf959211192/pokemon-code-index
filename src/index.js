const LINUXDO_BASE = "https://linux.do";
const OFFICIAL_CHANNEL_URL = "https://t.me/s/pokemon521";
const OFFICIAL_GROUP_URL = "https://t.me/pokemon_love";
const POKEMON_PROVIDER_KEY = "pokemon_nebula";
const MAX_TOPIC_POSTS = 240;
const TOPIC_POST_BATCH_SIZE = 40;
const CN_MONTHS = [
  "",
  "一",
  "二",
  "三",
  "四",
  "五",
  "六",
  "七",
  "八",
  "九",
  "十",
  "十一",
  "十二"
];

const STOP_WORDS = new Set([
  "感谢", "谢谢", "支持", "兑换", "成功", "宝可梦", "火烈鸟", "兑换码", "优惠码",
  "白嫖码", "礼品卡", "猜猜我是谁", "管理员手动确认", "来了", "大佬", "本月"
]);

function json(data, status = 200, headers = {}) {
  return Response.json(data, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

function chinaParts(date = new Date()) {
  const d = new Date(date.getTime() + 8 * 3600_000);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function periodOf(date = new Date()) {
  const { year, month } = chinaParts(date);
  return `${year}-${String(month).padStart(2, "0")}`;
}

function inAutoWindow(date = new Date()) {
  const { day } = chinaParts(date);
  return day >= 1 && day <= 7;
}

async function buildHealth(env, now = new Date()) {
  const period = periodOf(now);
  try {
    const row = await env.DB.prepare(`
      SELECT EXISTS(
        SELECT 1 FROM codes WHERE period = ? AND status = 'verified' LIMIT 1
      ) AS has_verified
    `).bind(period).first();
    return {
      ok: true,
      period,
      database: "reachable",
      autoWindow: inAutoWindow(now),
      hasVerifiedCodeThisMonth: Boolean(row?.has_verified)
    };
  } catch {
    return {
      ok: false,
      period,
      database: "unreachable",
      autoWindow: inAutoWindow(now),
      hasVerifiedCodeThisMonth: false
    };
  }
}

function decodeHtml(text = "") {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function stripHtml(text = "") {
  return decodeHtml(text)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function snippet(text = "", limit = 220) {
  const value = stripHtml(text);
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function plausibleCode(value) {
  const code = String(value ?? "").trim();
  return Boolean(
    code &&
    /^([\u4e00-\u9fa5]{2,8}|[A-Za-z0-9_-]{3,32})$/.test(code) &&
    !STOP_WORDS.has(code)
  );
}

function safeUrl(value, linuxDoOnly = false) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== "https:") throw new Error("来源地址必须使用 HTTPS");
  if (linuxDoOnly && url.hostname !== "linux.do") throw new Error("指定帖子仅允许使用 linux.do 地址");
  return url.toString();
}

function normalizeTopic(value) {
  const url = new URL(safeUrl(value, true));
  const match = url.pathname.match(/^\/t\/(?:[^/]+\/)?(\d+)/);
  if (!match) throw new Error("LINUX DO 帖子地址格式不正确");
  return `${LINUXDO_BASE}/t/topic/${match[1]}`;
}

async function fetchText(url, accept = "text/html,application/json;q=0.9,*/*;q=0.8") {
  const response = await fetch(url, {
    headers: { "User-Agent": "pokemon-code-index/2.1 (+public-code-aggregator)", Accept: accept }
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return await response.text();
}

function candidate(code, source, confidence, evidenceCount = 1, evidence = "") {
  const value = String(code ?? "").trim();
  if (!plausibleCode(value)) return null;
  return {
    code: value,
    sourceKey: source.source_key,
    sourceName: source.name,
    sourceType: source.source_type,
    sourceUrl: source.url,
    confidence,
    evidenceCount,
    evidence: snippet(evidence)
  };
}

function explicitCandidates(text, source, confidence) {
  const plain = stripHtml(text);
  const patterns = [
    /(?:本月|当月|\d+\s*月份?)?\s*(?:免费)?(?:兑换码|优惠码|白嫖码|礼品卡)\s*(?:是|为|[:：=])\s*([\u4e00-\u9fa5]{2,8}|[A-Za-z0-9_-]{3,32})/gi,
    /(?:使用|输入)\s*(?:兑换码|优惠码|白嫖码|礼品卡)?\s*[:：=]\s*([\u4e00-\u9fa5]{2,8}|[A-Za-z0-9_-]{3,32})/gi
  ];
  const map = new Map();
  for (const pattern of patterns) {
    for (const match of plain.matchAll(pattern)) {
      const item = candidate(match[1], source, confidence, 1, plain.slice(Math.max(0, match.index - 50), match.index + 120));
      if (item) map.set(`${item.code}|${item.sourceUrl}`, item);
    }
  }
  return [...map.values()];
}

function normalizeTelegramAssetUrl(value) {
  if (!value) return null;
  if (value.startsWith("//")) return `https:${value}`;
  if (value.startsWith("https://")) return value;
  return null;
}

function extractTelegramPuzzleImage(html = "") {
  const text = String(html);
  const blocks = text.match(/<div class="tgme_widget_message_wrap[\s\S]*?(?=<div class="tgme_widget_message_wrap|<\/section>)/g) ?? [text];
  for (const block of blocks) {
    const plain = stripHtml(block);
    if (!plain.includes("猜猜我是谁")) continue;
    const anchor = block.match(/<a[^>]+class="[^"]*tgme_widget_message_photo_wrap[^"]*"[^>]*>/i)?.[0] ?? "";
    const postUrl = anchor.match(/href="([^"]+)"/i)?.[1] ?? "";
    const imageUrl = normalizeTelegramAssetUrl(anchor.match(/background-image:url\(['"]?([^'")]+)['"]?\)/i)?.[1] ?? "");
    if (!imageUrl) continue;
    return {
      imageUrl,
      postUrl
    };
  }
  return null;
}

function monthSearchTerms(month) {
  const padded = String(month).padStart(2, "0");
  const cn = CN_MONTHS[month];
  return [
    `${month}月`,
    `${month}月份`,
    `${padded}月`,
    `${cn}月`,
    `${cn}月份`,
    `${month} 月`
  ];
}

function topicSearchQueries(year, month) {
  const terms = monthSearchTerms(month);
  return [
    `宝可梦机场 ${year}年 ${terms[0]} 免费兑换码 猜猜我是谁`,
    `宝可梦机场 ${year}年 ${terms[3]} 免费兑换码`,
    `宝可梦星云 ${year}年 ${terms[0]} 免费兑换码`,
    `宝可梦 ${year} ${terms[1]} 兑换码`,
    `pokemon 宝可梦 ${year} ${terms[0]} 兑换码`
  ];
}

function scoreTopicTitle(title, monthTerms) {
  let score = 0;
  if (monthTerms.some((term) => title.includes(term))) score += 6;
  if (/兑换码|优惠码|白嫖码|免费码/.test(title)) score += 4;
  if (/猜猜我是谁|答案|谜题/.test(title)) score += 3;
  if (/宝可梦机场|宝可梦星云/.test(title)) score += 2;
  return score;
}

async function discoverTopic(now = new Date()) {
  const { year, month } = chinaParts(now);
  const monthTerms = monthSearchTerms(month);
  const seen = new Map();
  for (const query of topicSearchQueries(year, month)) {
    const q = encodeURIComponent(query);
    const body = JSON.parse(await fetchText(`${LINUXDO_BASE}/search.json?q=${q}`, "application/json"));
    for (const item of body.topics ?? []) {
      const title = String(item.title ?? "");
      if (!title.includes("宝可梦")) continue;
      const score = scoreTopicTitle(title, monthTerms);
      const current = seen.get(item.id);
      if (!current || score > current.score) seen.set(item.id, { id: item.id, title, score });
    }
  }
  const ranked = [...seen.values()].sort((a, b) => b.score - a.score);
  if (!ranked[0] || ranked[0].score < 6) throw new Error("没有发现本月公开帖子");
  return { url: `${LINUXDO_BASE}/t/topic/${ranked[0].id}`, title: ranked[0].title };
}

async function fetchTopicPosts(normalized, initialBody) {
  const initialPosts = initialBody.post_stream?.posts ?? [];
  const allIds = (initialBody.post_stream?.stream ?? []).slice(0, MAX_TOPIC_POSTS);
  const posts = [...initialPosts];
  const loadedIds = new Set(initialPosts.map((post) => post.id));
  const missingIds = allIds.filter((id) => !loadedIds.has(id));

  for (let index = 0; index < missingIds.length; index += TOPIC_POST_BATCH_SIZE) {
    const batch = missingIds.slice(index, index + TOPIC_POST_BATCH_SIZE);
    const query = batch.map((id) => `post_ids[]=${encodeURIComponent(id)}`).join("&");
    const body = JSON.parse(await fetchText(`${normalized}.json?${query}`, "application/json"));
    for (const post of body.post_stream?.posts ?? []) {
      if (!loadedIds.has(post.id)) {
        posts.push(post);
        loadedIds.add(post.id);
      }
    }
  }

  return posts.slice(0, MAX_TOPIC_POSTS);
}

async function fetchTopic(url) {
  const normalized = normalizeTopic(url);
  const body = JSON.parse(await fetchText(`${normalized}.json`, "application/json"));
  const posts = await fetchTopicPosts(normalized, body);
  return { url: normalized, title: String(body.title ?? ""), posts };
}

function communityCandidate(topic) {
  const scores = new Map();
  const evidence = new Map();
  const add = (code, points, text) => {
    const value = String(code ?? "").trim();
    if (!plausibleCode(value)) return;
    scores.set(value, (scores.get(value) ?? 0) + points);
    const list = evidence.get(value) ?? [];
    if (list.length < 4) list.push(snippet(text, 90));
    evidence.set(value, list);
  };
  for (const post of topic.posts.slice(1, 160)) {
    const text = stripHtml(post.cooked ?? post.raw ?? "");
    if (!text) continue;
    for (const match of text.matchAll(/(?:兑换码|优惠码|答案|应该是|我猜|就是)\s*[：:\-=]?\s*([\u4e00-\u9fa5]{2,8}|[A-Za-z0-9_-]{3,32})/gi)) add(match[1], 3, text);
    for (const match of text.matchAll(/([\u4e00-\u9fa5]{2,8}|[A-Za-z0-9_-]{3,32})\s*(?:已)?(?:兑换|续费)成功/gi)) add(match[1], 3, text);
    const first = text.match(/^#*\s*([\u4e00-\u9fa5]{2,8}|[A-Za-z0-9_-]{3,32})(?=[，,。！!；;：:\s]|$)/);
    if (first) add(first[1], 1, text);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked[0] || ranked[0][1] < 4) return null;
  if (ranked[1] && ranked[0][1] < ranked[1][1] * 1.35) return null;
  const [code, score] = ranked[0];
  return {
    code,
    sourceKey: "linuxdo_monthly_topic",
    sourceName: topic.title || "LINUX DO 月度讨论帖",
    sourceType: "linuxdo_topic",
    sourceUrl: topic.url,
    confidence: Math.min(0.98, 0.55 + score * 0.055),
    evidenceCount: score,
    evidence: (evidence.get(code) ?? []).join(" | ")
  };
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
  `).bind(period, item.code, item.sourceKey, item.sourceName, item.sourceType, item.sourceUrl, item.confidence, item.evidenceCount, item.evidence).run();
  await tryRecordEvidence(env, evidenceFromCandidate(period, item));
}

async function sourceCheck(env, source, period, result, message, candidateCount = 0, sourceUrl = source.url) {
  await env.DB.prepare(`INSERT INTO source_checks(source_key, period, result, message, source_url, candidate_count) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(source.source_key, period, result, message, sourceUrl, candidateCount).run();
}

async function log(env, period, triggerType, result, message, sourceUrl = null) {
  await env.DB.prepare(`INSERT INTO refresh_logs(period, trigger_type, result, message, source_url) VALUES (?, ?, ?, ?, ?)`)
    .bind(period, triggerType, result, message, sourceUrl).run();
}

async function enabledSources(env) {
  const { results } = await env.DB.prepare(`SELECT source_key, name, url, source_type, priority, enabled, description FROM sources WHERE enabled = 1 ORDER BY priority, id`).all();
  return results;
}

async function listCandidates(env, period) {
  const { results } = await env.DB.prepare(`SELECT period, code, source_key, source_name, source_type, source_url, confidence, evidence_count, evidence, updated_at FROM code_candidates WHERE period = ? ORDER BY confidence DESC, evidence_count DESC, updated_at DESC`).bind(period).all();
  return results;
}

async function listOffers(env, period) {
  const { results } = await env.DB.prepare(`
    SELECT period, code, offer_type, discount_value, plan_name, status, confidence_score, source_count, first_seen_at, last_seen_at, last_verified_at, updated_at
    FROM offers
    WHERE period = ?
    ORDER BY confidence_score DESC, source_count DESC, updated_at DESC
  `).bind(period).all();
  return results.map((item) => ({ ...item, trust_label: trustLabelForStatus(item.status) }));
}

async function listEvidence(env, period) {
  const { results } = await env.DB.prepare(`
    SELECT period, code, source_key, source_type, source_url, reference_url, is_official, status, confidence_score, evidence_excerpt, extraction_method, verification_method, reviewer, created_at
    FROM offer_evidence
    WHERE period = ?
    ORDER BY id DESC
    LIMIT 80
  `).bind(period).all();
  return results.map((item) => ({ ...item, trust_label: trustLabelForStatus(item.status) }));
}

function verifiedFrom(items) {
  const grouped = new Map();
  for (const item of items) grouped.set(item.code, [...(grouped.get(item.code) ?? []), item]);
  for (const [code, list] of grouped) {
    const official = list.find((x) => x.source_key === "official_telegram" && x.confidence >= 0.95);
    if (official) return { code, confidence: official.confidence, evidenceCount: official.evidence_count, sourceUrl: official.source_url, sourceTitle: "官方 Telegram 明确发布" };
  }
  for (const [code, list] of grouped) {
    if (new Set(list.map((x) => x.source_key)).size >= 2 && list.some((x) => ["official_telegram", "linuxdo_monthly_topic"].includes(x.source_key))) {
      return { code, confidence: Math.min(0.99, Math.max(...list.map((x) => Number(x.confidence))) + 0.08), evidenceCount: list.reduce((sum, x) => sum + Number(x.evidence_count || 0), 0), sourceUrl: list[0].source_url, sourceTitle: "多来源交叉验证" };
    }
  }
  for (const [code, list] of grouped) {
    const community = list.find((x) => x.source_key === "linuxdo_monthly_topic");
    if (community && community.confidence >= 0.75 && community.evidence_count >= 4) return { code, confidence: community.confidence, evidenceCount: community.evidence_count, sourceUrl: community.source_url, sourceTitle: "LINUX DO 评论区社区共识" };
  }
  return null;
}

async function upsertCode(env, period, item) {
  await env.DB.prepare(`
    INSERT INTO codes(period, code, status, confidence, evidence_count, source_url, source_title, updated_at)
    VALUES (?, ?, 'verified', ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(period) DO UPDATE SET code = excluded.code, status = 'verified', confidence = excluded.confidence,
      evidence_count = excluded.evidence_count, source_url = excluded.source_url, source_title = excluded.source_title, updated_at = CURRENT_TIMESTAMP
  `).bind(period, item.code, item.confidence, item.evidenceCount, item.sourceUrl, item.sourceTitle).run();
}

async function collectSource(env, source, period, now, topicUrl = null) {
  try {
    if (source.source_type === "linuxdo_search") {
      const found = topicUrl ? { url: normalizeTopic(topicUrl) } : await discoverTopic(now);
      const topic = await fetchTopic(found.url);
      const item = communityCandidate(topic);
      if (item) await saveCandidate(env, period, item);
      await sourceCheck(
        env,
        source,
        period,
        item ? "candidate_found" : "no_candidate",
        item
          ? `读取评论 ${topic.posts.length} 条；社区候选：${item.code}；证据分数：${item.evidenceCount}`
          : `读取评论 ${topic.posts.length} 条；没有提取出高可信社区答案`,
        item ? 1 : 0,
        topic.url
      );
      return;
    }
    const text = await fetchText(source.url);
    if (source.source_type === "reference") {
      await sourceCheck(env, source, period, "reachable", "公开入口可访问；不抓取群聊内容");
      return;
    }
    const scoped = source.source_type.startsWith("third_party") ? stripHtml(text).slice(0, 5000) : text;
    const items = explicitCandidates(scoped, source, source.source_type === "official_telegram" ? 1 : 0.52);
    for (const item of items) await saveCandidate(env, period, item);
    const puzzleImage = source.source_type === "official_telegram" ? extractTelegramPuzzleImage(text) : null;
    if (puzzleImage) await tryRecordEvidence(env, evidenceFromPuzzle(period, source, puzzleImage));
    const puzzle = source.source_type === "official_telegram" && stripHtml(text).includes("猜猜我是谁");
    await sourceCheck(
      env,
      source,
      period,
      items.length ? "candidate_found" : (puzzle ? "puzzle_found" : "checked"),
      items.length
        ? `发现 ${items.length} 个明确文本候选`
        : (puzzleImage ? "发现官方谜题公告，已记录谜题图片，需要社区答案或人工确认" : (puzzle ? "发现官方谜题公告，需要社区答案或人工确认" : "未发现明确文本兑换码")),
      items.length,
      puzzleImage?.imageUrl ?? source.url
    );
  } catch (error) {
    await sourceCheck(env, source, period, "error", error instanceof Error ? error.message : String(error));
  }
}

async function refresh(env, { force = false, triggerType = "manual", topicUrl = null } = {}) {
  const now = new Date();
  const period = periodOf(now);
  if (!force && !inAutoWindow(now)) {
    const message = "当前不在每月 1 日至 7 日的自动检查窗口";
    await log(env, period, triggerType, "skipped", message);
    return { ok: true, skipped: true, message };
  }
  if (!force && await env.DB.prepare(`SELECT 1 FROM codes WHERE period = ? AND status = 'verified' LIMIT 1`).bind(period).first()) {
    const message = "本月已有已确认兑换码，停止自动抓取";
    await log(env, period, triggerType, "skipped", message);
    return { ok: true, skipped: true, message };
  }
  for (const source of await enabledSources(env)) await collectSource(env, source, period, now, topicUrl);
  const candidates = await listCandidates(env, period);
  const verified = verifiedFrom(candidates);
  if (!verified) {
    const message = candidates.length ? "已保存候选，但尚未达到自动确认条件" : "没有提取到候选兑换码";
    await log(env, period, triggerType, "candidate_not_verified", message);
    return { ok: false, message, period, candidates };
  }
  await upsertCode(env, period, verified);
  const message = `已更新 ${period} 兑换码：${verified.code}（${verified.sourceTitle}）`;
  await log(env, period, triggerType, "updated", message, verified.sourceUrl);
  return { ok: true, message, period, ...verified, candidates };
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(request, env) {
  const expected = env.ADMIN_TOKEN ? `Bearer ${env.ADMIN_TOKEN}` : "";
  const actual = request.headers.get("Authorization") ?? "";
  if (!expected || actual.length !== expected.length) return false;
  return constantTimeEqual(actual, expected);
}

async function body(request) {
  try { return await request.json(); } catch { return {}; }
}

async function latest(env) {
  const period = periodOf();
  const current = await env.DB.prepare(`SELECT period, code, status, confidence, evidence_count, source_url, source_title, updated_at FROM codes WHERE period = ? LIMIT 1`).bind(period).first();
  if (current) return { found: true, isCurrentMonth: true, item: await enrichCodeWithOffer(env, current) };
  const item = await env.DB.prepare(`SELECT period, code, status, confidence, evidence_count, source_url, source_title, updated_at FROM codes WHERE status = 'verified' ORDER BY period DESC LIMIT 1`).first();
  return item ? { found: true, isCurrentMonth: false, item: await enrichCodeWithOffer(env, item) } : { found: false, isCurrentMonth: false, item: null };
}

async function enrichCodeWithOffer(env, item) {
  try {
    const offer = await env.DB.prepare(`
      SELECT status AS offer_status, confidence_score, source_count, last_seen_at, last_verified_at
      FROM offers
      WHERE provider_key = ? AND period = ? AND code = ?
      LIMIT 1
    `).bind(POKEMON_PROVIDER_KEY, item.period, item.code).first();
    if (!offer) return item;
    return {
      ...item,
      offer_status: offer.offer_status,
      trust_label: trustLabelForStatus(offer.offer_status),
      confidence_score: offer.confidence_score,
      source_count: offer.source_count,
      last_seen_at: offer.last_seen_at,
      last_verified_at: offer.last_verified_at
    };
  } catch {
    return item;
  }
}

async function manual(env, data) {
  const period = /^\d{4}-\d{2}$/.test(data.period ?? "") ? data.period : periodOf();
  const code = String(data.code ?? "").trim();
  if (!plausibleCode(code)) throw new Error("兑换码格式不正确");
  const sourceUrl = data.sourceUrl ? safeUrl(data.sourceUrl) : null;
  await upsertCode(env, period, { code, confidence: 1, evidenceCount: 1, sourceUrl, sourceTitle: "管理员手动确认" });
  await tryRecordEvidence(env, {
    providerKey: POKEMON_PROVIDER_KEY,
    period,
    code,
    sourceKey: "manual_admin",
    sourceType: "manual",
    sourceUrl: sourceUrl ?? "https://pokemon-code-index.xf959211192.workers.dev/admin.html",
    referenceUrl: sourceUrl,
    isOfficial: 0,
    status: "checkout_verified",
    confidenceScore: 90,
    evidenceExcerpt: "管理员手动补录并确认",
    evidenceHash: hashText([POKEMON_PROVIDER_KEY, period, code, sourceUrl ?? "manual_admin"].join("|")),
    extractionMethod: "manual_entry",
    verificationMethod: "manual_admin",
    reviewer: "admin"
  });
  await log(env, period, "manual_write", "updated", `管理员手动写入 ${period} 兑换码：${code}`, sourceUrl);
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
    maxPostCount: MAX_TOPIC_POSTS,
    candidate,
    message: candidate
      ? `读取评论 ${topic.posts.length} 条；社区候选：${candidate.code}；证据分数：${candidate.evidenceCount}`
      : `读取评论 ${topic.posts.length} 条；没有提取出高可信社区答案`
  };
}

function hashText(value = "") {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function trustLabelForStatus(status = "") {
  const labels = {
    checkout_verified: "已验证",
    official_notice: "官方或关联公告出现",
    corroborated: "多来源或社区共识",
    reported: "第三方报告，建议结算前确认",
    candidate: "候选线索，等待复核",
    expired: "已失效",
    unknown: "暂未确认"
  };
  return labels[status] ?? "暂未确认";
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

function candidateEvidenceStatus(item) {
  if (item.sourceKey === "official_telegram" && Number(item.confidence) >= 0.95) return "official_notice";
  if (item.sourceKey === "linuxdo_monthly_topic" && Number(item.evidenceCount) >= 4) return "corroborated";
  if (String(item.sourceType ?? "").startsWith("third_party")) return "reported";
  return "candidate";
}

function confidenceScoreForEvidence(status, item = {}) {
  const base = {
    checkout_verified: 90,
    official_notice: 70,
    corroborated: 55,
    reported: 18,
    candidate: 8,
    unknown: 5,
    expired: 0
  }[status] ?? 8;
  if (status === "corroborated") return Math.min(69, base + Math.max(0, Number(item.evidenceCount ?? 0) - 6) * 2);
  if (status === "reported") return Math.min(39, base + Math.max(0, Number(item.evidenceCount ?? 0) - 1) * 2);
  return base;
}

function evidenceFromCandidate(period, item) {
  const status = candidateEvidenceStatus(item);
  const sourceUrl = safeUrl(item.sourceUrl);
  const evidenceExcerpt = snippet(item.evidence || item.sourceName || item.code, 260);
  const hashBase = [
    POKEMON_PROVIDER_KEY,
    period,
    item.code,
    item.sourceKey,
    sourceUrl,
    evidenceExcerpt
  ].join("|");
  return {
    providerKey: POKEMON_PROVIDER_KEY,
    period,
    code: item.code,
    sourceKey: item.sourceKey,
    sourceType: item.sourceType,
    sourceUrl,
    referenceUrl: null,
    isOfficial: item.sourceKey === "official_telegram" ? 1 : 0,
    status,
    confidenceScore: confidenceScoreForEvidence(status, item),
    evidenceExcerpt,
    evidenceHash: hashText(hashBase),
    extractionMethod: item.sourceKey === "linuxdo_monthly_topic" ? "linuxdo_public_topic" : "public_page_text",
    verificationMethod: status === "official_notice" ? "official_notice" : "source_tracking",
    reviewer: null
  };
}

function evidenceFromPuzzle(period, source, puzzleImage) {
  const sourceUrl = safeUrl(puzzleImage.imageUrl);
  const referenceUrl = puzzleImage.postUrl ? safeUrl(puzzleImage.postUrl) : source.url;
  const evidenceExcerpt = "官方频道发布猜图兑换活动图片；图片仅作为谜题证据，兑换码需社区答案或人工确认";
  return {
    providerKey: POKEMON_PROVIDER_KEY,
    period,
    code: null,
    sourceKey: source.source_key,
    sourceType: source.source_type,
    sourceUrl,
    referenceUrl,
    isOfficial: 1,
    status: "official_notice",
    confidenceScore: 30,
    evidenceExcerpt,
    evidenceHash: hashText([POKEMON_PROVIDER_KEY, period, source.source_key, sourceUrl, referenceUrl].join("|")),
    extractionMethod: "telegram_public_preview_image",
    verificationMethod: "manual_required",
    reviewer: null
  };
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

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === "/api/health" && request.method === "GET") {
        const health = await buildHealth(env);
        return json(health, health.ok ? 200 : 500, { "Cache-Control": "no-store" });
      }
      if (url.pathname === "/api/latest" && request.method === "GET") return json(await latest(env), 200, { "Cache-Control": "public, max-age=300" });
      if (url.pathname === "/api/history" && request.method === "GET") return json({ items: (await env.DB.prepare(`SELECT * FROM codes ORDER BY period DESC LIMIT 24`).all()).results });
      if (url.pathname === "/api/public-links" && request.method === "GET") return json({ officialChannel: OFFICIAL_CHANNEL_URL, officialGroup: OFFICIAL_GROUP_URL }, 200, { "Cache-Control": "public, max-age=3600" });
      if (url.pathname.startsWith("/api/admin/") && !(await authorized(request, env))) return json({ ok: false, message: "管理员令牌错误" }, 401);
      if (url.pathname === "/api/admin/refresh" && request.method === "POST") {
        const data = await body(request);
        const result = await refresh(env, { force: true, triggerType: "manual_refresh", topicUrl: data.topicUrl || null });
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
      if (url.pathname === "/api/admin/logs" && request.method === "GET") return json({ items: (await env.DB.prepare(`SELECT period, trigger_type, result, message, source_url, created_at FROM refresh_logs ORDER BY id DESC LIMIT 40`).all()).results });
      if (url.pathname === "/api/admin/candidates" && request.method === "GET") return json({ period: periodOf(), items: await listCandidates(env, periodOf()) });
      if (url.pathname === "/api/admin/offers" && request.method === "GET") return json({ period: periodOf(), items: await listOffers(env, periodOf()) });
      if (url.pathname === "/api/admin/evidence" && request.method === "GET") return json({ period: periodOf(), items: await listEvidence(env, periodOf()) });
      if (url.pathname === "/api/admin/sources" && request.method === "GET") return json({ items: (await env.DB.prepare(`SELECT s.*, c.result AS last_result, c.message AS last_message, c.source_url AS last_source_url, c.created_at AS last_checked_at FROM sources s LEFT JOIN source_checks c ON c.id = (SELECT id FROM source_checks WHERE source_key = s.source_key ORDER BY id DESC LIMIT 1) ORDER BY s.priority, s.id`).all()).results });
      if (url.pathname === "/api/admin/sources/toggle" && request.method === "POST") {
        const data = await body(request);
        const result = await env.DB.prepare(`UPDATE sources SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE source_key = ?`).bind(data.enabled ? 1 : 0, String(data.sourceKey ?? "")).run();
        return json({ ok: Boolean(result.meta?.changes), sourceKey: data.sourceKey, enabled: Boolean(data.enabled) });
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("request_failed", error instanceof Error ? error.message : String(error));
      return json({ ok: false, message: "服务暂时异常，请稍后再试" }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(refresh(env, { force: false, triggerType: `cron:${controller.cron}` }));
  }
};

export {
  buildHealth,
  discoverTopic,
  evidenceFromCandidate,
  evidenceFromPuzzle,
  extractTelegramPuzzleImage,
  fetchTopic,
  fetchTopicPosts,
  inAutoWindow,
  periodOf,
  testTopic,
  topicSearchQueries,
  trustLabelForStatus,
  verifiedFrom
};
