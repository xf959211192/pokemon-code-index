const LINUXDO_BASE = "https://linux.do";
const JINA_READER_BASE = "https://r.jina.ai/http://";
const OFFICIAL_CHANNEL_URL = "https://t.me/s/pokemon521";
const OFFICIAL_GROUP_URL = "https://t.me/pokemon_love";

const POKEMON_PROVIDER_KEY = "pokemon_nebula";
const AUTO_WINDOW_END_DAY = 14;
const MAX_TOPIC_POSTS = 240;
const TOPIC_POST_BATCH_SIZE = 40;
const MAX_READER_TOPIC_PAGES = 3;
const MAX_DIRECT_TOPIC_PAGES = 3;
const MAX_DISCOVERY_PAGES = 24;
const DISCOVERY_BATCH_SIZE = 4;
const FETCH_TIMEOUT_MS = 15000;
const FETCH_RETRY_ATTEMPTS = 3;
const RETRY_DELAY_MS = 800;

const CN_MONTHS = ["", "一", "二", "三", "四", "五", "六", "七", "八", "九", "十", "十一", "十二"];

const KNOWN_LINUXDO_TOPICS = {
  "2026-02": { url: "https://linux.do/t/topic/1550007", title: "宝可梦机场之二月优惠码猜猜我是谁！" },
  "2026-04": { url: "https://linux.do/t/topic/1876094", title: "砥砺前行 宝可梦机场之四月免费兑换码猜猜我是谁" },
  "2026-05": { url: "https://linux.do/t/topic/2092025", title: "五一优惠大放送和 宝可梦机场之五月免费兑换码猜猜我是谁" },
  "2026-06": { url: "https://linux.do/t/topic/2289939", title: "宝可梦机场之六月免费兑换码猜猜我是谁" },
  "2026-07": { url: "https://linux.do/t/topic/2504318", title: "宝可梦机场之七月免费兑换码猜猜我是谁" }
};

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
  return day >= 1 && day <= AUTO_WINDOW_END_DAY;
}

async function body(request) {
  try { return await request.json(); } catch { return {}; }
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

function snippet(text = "", limit = 220) {
  const value = stripHtml(text);
  return value.length > limit ? `${value.slice(0, limit)}…` : value;
}

function safeUrl(value) {
  if (!value) return null;
  const url = new URL(String(value).trim());
  if (url.protocol !== "https:") throw new Error("来源地址必须使用 HTTPS");
  return url.toString();
}

function topicIdFromUrl(value) {
  const url = new URL(String(value ?? "").trim(), LINUXDO_BASE);
  if (url.hostname !== "linux.do") throw new Error("仅支持 linux.do 帖子地址");
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[0] !== "t") throw new Error("不是有效的 LINUX DO 话题地址");
  if (parts[1] === "topic" && /^\d+$/.test(parts[2] ?? "")) return parts[2];
  const last = parts[parts.length - 1];
  if (/^\d+$/.test(last ?? "")) return last;
  throw new Error("不是有效的 LINUX DO 话题地址");
}

function normalizeTopic(value) {
  return `${LINUXDO_BASE}/t/topic/${topicIdFromUrl(value)}`;
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function isRetryableError(error) {
  const message = errorMessage(error);
  return /^HTTP (403|408|409|425|429|500|502|503|504)$/.test(message) || /timeout|aborted|network|Unexpected token/i.test(message);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rankStatus(status = "") {
  const ranks = { candidate: 1, unknown: 1, reported: 2, corroborated: 3, official_notice: 4, checkout_verified: 5, expired: 0 };
  return ranks[status] ?? 1;
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

async function fetchText(url, accept = "text/plain,*/*", timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: accept, "User-Agent": "pokemon-code-index/1.0" },
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchTextWithRetry(url, accept = "text/plain,*/*", timeoutMs = FETCH_TIMEOUT_MS, attempts = FETCH_RETRY_ATTEMPTS) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fetchText(url, accept, timeoutMs);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts || !isRetryableError(error)) break;
      await sleep(RETRY_DELAY_MS * attempt);
    }
  }
  throw lastError;
}

function readerUrlForLinuxDo(value) {
  const url = new URL(value, LINUXDO_BASE);
  if (url.hostname !== "linux.do") throw new Error("Reader 只允许读取 linux.do 公开页面");
  return `${JINA_READER_BASE}${url.hostname}${url.pathname}${url.search}`;
}

function monthSearchTerms(month) {
  const cn = CN_MONTHS[month];
  return [`${month}月`, `${String(month).padStart(2, "0")}月`, cn ? `${cn}月` : "", cn ? `${cn}月份` : ""].filter(Boolean);
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
  for (const match of text.matchAll(/\[([^\]\n]+)]\(([^)]+)\)/g)) {
    const title = stripHtml(match[1]);
    const href = String(match[2] ?? "").trim();
    if (!/^(https?:\/\/linux\.do\/t\/|\/t\/)/.test(href)) continue;
    try {
      const id = Number(topicIdFromUrl(href));
      if (!title || !id || seen.has(id)) continue;
      seen.add(id);
      topics.push({ id, title, url: `${LINUXDO_BASE}/t/topic/${id}` });
    } catch {}
  }
  for (const match of text.matchAll(/href=["']([^"']*\/t\/[^"']+)["'][^>]*>([^<]+)</g)) {
    try {
      const id = Number(topicIdFromUrl(match[1]));
      const title = stripHtml(match[2]);
      if (!title || !id || seen.has(id)) continue;
      seen.add(id);
      topics.push({ id, title, url: `${LINUXDO_BASE}/t/topic/${id}` });
    } catch {}
  }
  return topics;
}

async function recordDiscovery(env, item) {
  try {
    await env.DB.prepare(`
      INSERT INTO source_discoveries(provider_key, period, discovery_kind, query, title, source_url, score, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(provider_key, period, discovery_kind, source_url, query) DO UPDATE SET
        title = excluded.title,
        score = MAX(source_discoveries.score, excluded.score),
        updated_at = CURRENT_TIMESTAMP
    `).bind(POKEMON_PROVIDER_KEY, item.period, item.kind, item.query, item.title, item.sourceUrl, item.score).run();
  } catch (error) {
    console.warn("record_discovery_failed", errorMessage(error));
  }
}

function addDiscoveryCandidate(map, item, now, kind, query) {
  const score = scoreTopicTitle(item.title, now);
  if (!score) return null;
  const current = map.get(item.id);
  const next = { ...item, score, kind, query };
  if (!current || score > current.score) map.set(item.id, next);
  return next;
}

async function discoverFromSearch(env, now) {
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
      const text = await fetchTextWithRetry(`${LINUXDO_BASE}/search.json?q=${encodeURIComponent(query)}`, "application/json,*/*", 12000, 2);
      const data = JSON.parse(text);
      for (const topic of data.topics ?? []) {
        const item = { id: Number(topic.id), title: String(topic.title ?? ""), url: `${LINUXDO_BASE}/t/topic/${topic.id}` };
        const found = addDiscoveryCandidate(candidates, item, now, "linuxdo_search", query);
        if (found) await recordDiscovery(env, { period, kind: found.kind, query: found.query, title: found.title, sourceUrl: found.url, score: found.score });
      }
    } catch (error) {
      await log(env, period, "discover_search", "search_error", `${query}: ${errorMessage(error)}`);
    }
  }
  return [...candidates.values()].sort((a, b) => b.score - a.score);
}

async function discoverFromCategory(env, now) {
  const period = periodOf(now);
  const candidates = new Map();
  const seedTopics = new Map();
  for (let page = 1; page <= MAX_DISCOVERY_PAGES; page += DISCOVERY_BATCH_SIZE) {
    const batch = Array.from({ length: Math.min(DISCOVERY_BATCH_SIZE, MAX_DISCOVERY_PAGES - page + 1) }, (_, index) => page + index);
    const settled = await Promise.allSettled(batch.map((pageNumber) => {
      const pageUrl = `${LINUXDO_BASE}/c/welfare/36?page=${pageNumber}`;
      return fetchTextWithRetry(readerUrlForLinuxDo(pageUrl), "text/plain,*/*", 15000, 2).then((content) => ({ pageNumber, content }));
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
  const settled = await Promise.allSettled(seeds.map((seed) =>
    fetchTextWithRetry(readerUrlForLinuxDo(seed.url), "text/plain,*/*", 15000, 2).then((content) => ({ seed, content }))
  ));
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
  const found = [
    ...(await discoverFromSearch(env, now)),
    ...(await discoverFromCategory(env, now))
  ];
  const known = KNOWN_LINUXDO_TOPICS[period];
  if (known) found.push({ id: Number(topicIdFromUrl(known.url)), url: normalizeTopic(known.url), title: known.title, score: 9, kind: "known_topic_url", query: "KNOWN_LINUXDO_TOPICS" });
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

function dedupePosts(posts) {
  const seen = new Set();
  const out = [];
  for (const post of posts) {
    const key = post.id ?? snippet(post.cooked ?? post.raw ?? "", 120);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(post);
  }
  return out.slice(0, MAX_TOPIC_POSTS);
}

async function fetchTopicPosts(normalized, initialBody) {
  const posts = [...(initialBody.post_stream?.posts ?? [])];
  const loaded = new Set(posts.map((post) => post.id));
  const stream = (initialBody.post_stream?.stream ?? []).slice(0, MAX_TOPIC_POSTS);
  const missing = stream.filter((id) => !loaded.has(id)).slice(0, TOPIC_POST_BATCH_SIZE);
  if (!missing.length) return dedupePosts(posts);
  const query = missing.map((id) => `post_ids[]=${encodeURIComponent(id)}`).join("&");
  const text = await fetchTextWithRetry(`${normalized}.json?${query}`, "application/json,*/*", FETCH_TIMEOUT_MS, 2);
  const body = JSON.parse(text);
  return dedupePosts([...posts, ...(body.post_stream?.posts ?? [])]);
}

function parseReaderTopic(markdown, normalized, fallbackTitle = "") {
  const text = String(markdown ?? "");
  const title = text.match(/^Title:\s*(.+)$/m)?.[1]?.trim() || text.match(/^#\s+(.+)$/m)?.[1]?.trim() || fallbackTitle;
  const content = text.includes("Markdown Content:") ? text.slice(text.indexOf("Markdown Content:") + "Markdown Content:".length) : text;
  const chunks = content.split(/\n## post by [^\n]+\n/);
  const posts = chunks.map((chunk, index) => ({ id: index + 1, cooked: chunk.trim() })).filter((post) => post.cooked);
  return { url: normalized, title, posts };
}

async function fetchTopicViaReader(normalized) {
  const posts = [];
  let title = "";
  let lastError = null;
  for (let page = 1; page <= MAX_READER_TOPIC_PAGES; page += 1) {
    const pageUrl = page === 1 ? normalized : `${normalized}?page=${page}`;
    try {
      const text = await fetchTextWithRetry(readerUrlForLinuxDo(pageUrl), "text/plain,*/*", 15000, 2);
      const topic = parseReaderTopic(text, normalized);
      if (topic.title && !title) title = topic.title;
      posts.push(...topic.posts.map((post) => ({ id: posts.length + 1, cooked: post.cooked })));
      if (posts.length >= MAX_TOPIC_POSTS) break;
    } catch (error) {
      lastError = error;
      if (page === 1) await sleep(RETRY_DELAY_MS);
    }
  }
  if (!posts.length) throw new Error(`Reader 回退未读取到公开帖子内容${lastError ? `：${errorMessage(lastError)}` : ""}`);
  return { url: normalized, title, posts: dedupePosts(posts) };
}

async function fetchTopicDirect(normalized) {
  let title = "";
  let firstBody = null;
  let lastError = null;
  const posts = [];
  for (let page = 1; page <= MAX_DIRECT_TOPIC_PAGES; page += 1) {
    const url = page === 1 ? `${normalized}.json` : `${normalized}.json?page=${page}`;
    try {
      const text = await fetchTextWithRetry(url, "application/json,*/*", FETCH_TIMEOUT_MS, page === 1 ? FETCH_RETRY_ATTEMPTS : 1);
      const body = JSON.parse(text);
      if (!firstBody) firstBody = body;
      if (!title) title = String(body.title ?? "");
      posts.push(...(body.post_stream?.posts ?? []));
    } catch (error) {
      lastError = error;
      if (page === 1) throw error;
    }
  }
  if (firstBody) {
    try {
      const expanded = await fetchTopicPosts(normalized, { ...firstBody, post_stream: { ...firstBody.post_stream, posts: dedupePosts(posts) } });
      return { url: normalized, title, posts: expanded };
    } catch {
      return { url: normalized, title, posts: dedupePosts(posts) };
    }
  }
  throw lastError ?? new Error("直连未读取到帖子内容");
}

async function fetchTopic(url) {
  const normalized = normalizeTopic(url);
  let directError = null;
  try { return await fetchTopicDirect(normalized); }
  catch (error) { directError = error; }
  try { return await fetchTopicViaReader(normalized); }
  catch (readerError) { throw new Error(`直连读取失败：${errorMessage(directError)}；Reader 回退失败：${errorMessage(readerError)}`); }
}

function cleanCommunityText(value = "") {
  return stripHtml(value)
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)]\([^)]+\)/g, " $1 ")
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/Image\s+\d+(?::\s*[\w:+-]+)?/gi, " ")
    .replace(/[`"'“”‘’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function addCommunityMatch(add, text, pattern, points) {
  for (const match of text.matchAll(pattern)) add(match[1], points, text);
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
    const text = cleanCommunityText(post.cooked ?? post.raw ?? "");
    if (!text) continue;
    addCommunityMatch(add, text, /(?:兑换码|优惠码|白嫖码|礼品码|礼品卡|答案)\s*(?:是|为|那里输入|输入|填入|填写|[:：=\-])?\s*([\u4e00-\u9fa5]{2,8}|[A-Za-z0-9_-]{3,32})/gi, 4);
    addCommunityMatch(add, text, /(?:是的|应该是|我猜|猜(?:出来)?是|就是|正确答案|ps[:：]?)\s*([\u4e00-\u9fa5]{2,8}|[A-Za-z0-9_-]{3,32})/gi, 3);
    addCommunityMatch(add, text, /([\u4e00-\u9fa5]{2,8}|[A-Za-z0-9_-]{3,32})\s*(?:是正确的答案|正确|没错|已?(?:兑换|续费)成功|可用|0\s*元|免费)/gi, 3);
    addCommunityMatch(add, text, /(?:输入|填入|填写)\s*([\u4e00-\u9fa5]{2,8}|[A-Za-z0-9_-]{3,32})(?:，|,|。|后|再|就|会)/gi, 3);
    for (const rawLine of String(post.cooked ?? post.raw ?? "").split(/\n+/)) {
      const plainLine = cleanCommunityText(rawLine);
      const standalone = plainLine.match(/^#*\s*([\u4e00-\u9fa5]{2,8}|[A-Za-z0-9_-]{3,32})(?:[，,。！!；;：:\s].*)?$/);
      if (standalone) add(standalone[1], 2, plainLine);
    }
    const first = text.match(/^#*\s*([\u4e00-\u9fa5]{2,8}|[A-Za-z0-9_-]{3,32})(?=[，,。！!；;：:\s]|$)/);
    if (first) add(first[1], 2, text);
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked[0] || ranked[0][1] < 4) return null;
  if (ranked[1] && ranked[0][1] < ranked[1][1] * 1.35) return null;
  const [code, score] = ranked[0];
  return { code, sourceKey: "linuxdo_monthly_topic", sourceName: topic.title || "LINUX DO 月度讨论帖", sourceType: "linuxdo_topic", sourceUrl: topic.url, confidence: Math.min(0.98, 0.55 + score * 0.055), evidenceCount: score, evidence: (evidence.get(code) ?? []).join(" | ") };
}

async function hasVerifiedCode(env, period) {
  return Boolean(await env.DB.prepare(`SELECT 1 FROM codes WHERE period = ? AND status = 'verified' LIMIT 1`).bind(period).first());
}

async function log(env, period, triggerType, result, message, sourceUrl = null) {
  await env.DB.prepare(`INSERT INTO refresh_logs(period, trigger_type, result, message, source_url) VALUES (?, ?, ?, ?, ?)`).bind(period, triggerType, result, message, sourceUrl).run();
}

async function sourceCheck(env, period, result, message, candidateCount = 0, sourceUrl = "https://linux.do") {
  await env.DB.prepare(`INSERT INTO source_checks(source_key, period, result, message, source_url, candidate_count) VALUES (?, ?, ?, ?, ?, ?)`).bind("linuxdo_monthly_topic", period, result, message, sourceUrl, candidateCount).run();
}

async function recordEvidence(env, evidence) {
  await env.DB.prepare(`
    INSERT OR IGNORE INTO offer_evidence(provider_key, period, code, source_key, source_type, source_url, reference_url, is_official, status, confidence_score, evidence_excerpt, evidence_hash, extraction_method, verification_method, reviewer)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(evidence.providerKey, evidence.period, evidence.code, evidence.sourceKey, evidence.sourceType, evidence.sourceUrl, evidence.referenceUrl, evidence.isOfficial, evidence.status, evidence.confidenceScore, evidence.evidenceExcerpt, evidence.evidenceHash, evidence.extractionMethod, evidence.verificationMethod, evidence.reviewer).run();
  if (!evidence.code) return;
  const current = await env.DB.prepare(`SELECT status, confidence_score FROM offers WHERE provider_key = ? AND period = ? AND code = ? LIMIT 1`).bind(evidence.providerKey, evidence.period, evidence.code).first();
  const nextStatus = !current || rankStatus(evidence.status) >= rankStatus(current.status) ? evidence.status : current.status;
  const nextScore = Math.max(Number(current?.confidence_score ?? 0), evidence.confidenceScore);
  const sourceCount = await env.DB.prepare(`SELECT COUNT(DISTINCT COALESCE(source_key, source_url)) AS count FROM offer_evidence WHERE provider_key = ? AND period = ? AND code = ?`).bind(evidence.providerKey, evidence.period, evidence.code).first();
  await env.DB.prepare(`
    INSERT INTO offers(provider_key, period, code, status, confidence_score, source_count, last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT(provider_key, period, code) DO UPDATE SET status = excluded.status, confidence_score = excluded.confidence_score, source_count = excluded.source_count, last_seen_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
  `).bind(evidence.providerKey, evidence.period, evidence.code, nextStatus, nextScore, Number(sourceCount?.count ?? 1)).run();
}

async function tryRecordEvidence(env, evidence) {
  try { await recordEvidence(env, evidence); } catch (error) { console.warn("record_evidence_failed", errorMessage(error)); }
}

function evidenceFor(period, item, sourceKey = "manual_admin") {
  const sourceUrl = item.sourceUrl ? safeUrl(item.sourceUrl) : "https://pokemon-code-index.xf959211192.workers.dev/admin.html";
  const evidenceExcerpt = item.evidence || "后台写入或公开帖识别";
  return { providerKey: POKEMON_PROVIDER_KEY, period, code: item.code, sourceKey, sourceType: item.sourceType ?? (sourceKey === "linuxdo_monthly_topic" ? "linuxdo_topic" : "manual"), sourceUrl, referenceUrl: item.referenceUrl ?? item.sourceUrl ?? null, isOfficial: 0, status: item.status ?? (sourceKey === "linuxdo_monthly_topic" ? "corroborated" : "checkout_verified"), confidenceScore: item.confidenceScore ?? (sourceKey === "linuxdo_monthly_topic" ? 65 : 90), evidenceExcerpt, evidenceHash: hashText([POKEMON_PROVIDER_KEY, period, item.code, sourceKey, sourceUrl, evidenceExcerpt].join("|")), extractionMethod: item.extractionMethod ?? (sourceKey === "linuxdo_monthly_topic" ? "linuxdo_public_topic" : "manual_entry"), verificationMethod: item.verificationMethod ?? (sourceKey === "linuxdo_monthly_topic" ? "community_consensus" : "open_admin_write"), reviewer: item.reviewer ?? "open_admin" };
}

async function saveCandidate(env, period, item, sourceKey = item.sourceKey ?? "manual_admin") {
  await env.DB.prepare(`
    INSERT INTO code_candidates(period, code, source_key, source_name, source_type, source_url, confidence, evidence_count, evidence, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(period, code, source_url) DO UPDATE SET confidence = MAX(code_candidates.confidence, excluded.confidence), evidence_count = MAX(code_candidates.evidence_count, excluded.evidence_count), evidence = excluded.evidence, updated_at = CURRENT_TIMESTAMP
  `).bind(period, item.code, sourceKey, item.sourceName, item.sourceType ?? (sourceKey === "linuxdo_monthly_topic" ? "linuxdo_topic" : "manual"), item.sourceUrl, item.confidence, item.evidenceCount, item.evidence).run();
  await tryRecordEvidence(env, evidenceFor(period, item, sourceKey));
}

async function upsertVerifiedCode(env, period, item, status = "verified") {
  await env.DB.prepare(`
    INSERT INTO codes(period, code, status, confidence, evidence_count, source_url, source_title, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(period) DO UPDATE SET code = excluded.code, status = excluded.status, confidence = excluded.confidence, evidence_count = excluded.evidence_count, source_url = excluded.source_url, source_title = excluded.source_title, updated_at = CURRENT_TIMESTAMP
  `).bind(period, item.code, status, item.confidence, item.evidenceCount, item.sourceUrl, item.sourceTitle ?? "后台手动确认").run();
}

function verifiedFromCommunity(item) {
  if (!item) return null;
  if (Number(item.confidence) < 0.75 || Number(item.evidenceCount) < 4) return null;
  return { code: item.code, confidence: Number(item.confidence), evidenceCount: Number(item.evidenceCount), sourceUrl: item.sourceUrl, sourceTitle: "LINUX DO 月度帖社区共识", sourceKey: "linuxdo_monthly_topic", sourceName: "LINUX DO 月度帖社区共识", sourceType: "linuxdo_topic", evidence: item.evidence ?? "LINUX DO 评论区社区共识" };
}

async function manual(env, data) {
  const period = /^\d{4}-\d{2}$/.test(data.period ?? "") ? data.period : periodOf();
  const code = String(data.code ?? "").trim();
  if (!plausibleCode(code)) throw new Error("兑换码格式不正确");
  const sourceUrl = data.sourceUrl ? safeUrl(data.sourceUrl) : null;
  const item = { code, sourceKey: "manual_admin", sourceName: "开放后台手动补录", sourceType: "manual", sourceUrl: sourceUrl ?? "https://pokemon-code-index.xf959211192.workers.dev/admin.html", confidence: 1, evidenceCount: 1, evidence: "开放后台手动补录并确认", sourceTitle: "开放后台手动确认" };
  await saveCandidate(env, period, item, "manual_admin");
  await upsertVerifiedCode(env, period, item);
  await log(env, period, "manual_write_open_admin", "updated", `开放后台写入 ${period} 兑换码：${code}`, sourceUrl);
  return { ok: true, period, code };
}

async function refresh(env, { force = false, triggerType = "manual_refresh", topicUrl = null, now = new Date() } = {}) {
  const period = periodOf(now);
  if (!force && !inAutoWindow(now)) {
    const message = `当前不在自动检查窗口，自动发现仅运行到每月 ${AUTO_WINDOW_END_DAY} 日`;
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
    const known = KNOWN_LINUXDO_TOPICS[period];
    topicRef = topicUrl
      ? { url: normalizeTopic(topicUrl), title: "指定 LINUX DO 帖子", kind: "manual_topic_url" }
      : known
        ? { url: normalizeTopic(known.url), title: known.title, kind: "known_topic_url" }
        : await discoverMonthlyTopic(env, now);
  } catch (error) {
    const message = errorMessage(error);
    await log(env, period, triggerType, "topic_not_found", message);
    return { ok: false, period, message };
  }

  try {
    const topic = await fetchTopic(topicRef.url);
    const item = communityCandidate(topic);
    if (item) await saveCandidate(env, period, item, "linuxdo_monthly_topic");
    await sourceCheck(env, period, item ? "candidate_found" : "no_candidate", item ? `发现帖子：${topicRef.title || topic.title}；读取评论 ${topic.posts.length} 条；社区候选：${item.code}；证据分数：${item.evidenceCount}` : `发现帖子：${topicRef.title || topic.title}；读取评论 ${topic.posts.length} 条；没有提取出高可信社区答案`, item ? 1 : 0, topic.url);
    const verified = verifiedFromCommunity(item);
    if (!verified) {
      const message = item ? "已保存候选，但尚未达到自动确认条件" : "没有提取到候选兑换码";
      await log(env, period, triggerType, "candidate_not_verified", message, topic.url);
      return { ok: false, period, message, topic: { url: topic.url, title: topic.title || topicRef.title, kind: topicRef.kind }, postCount: topic.posts.length, candidate: item ?? null };
    }
    await upsertVerifiedCode(env, period, verified);
    const message = `已通过 LINUX DO 月度帖更新 ${period} 兑换码：${verified.code}`;
    await log(env, period, triggerType, "updated", message, verified.sourceUrl);
    return { ok: true, period, message, ...verified, topic: { url: topic.url, title: topic.title || topicRef.title, kind: topicRef.kind } };
  } catch (error) {
    const message = errorMessage(error);
    await sourceCheck(env, period, "error", `帖子读取或识别失败：${message}`, 0, topicRef.url);
    await log(env, period, triggerType, "error", message, topicRef.url);
    return { ok: false, period, message, topic: topicRef };
  }
}

async function testTopic(data) {
  const topicUrl = String(data.topicUrl ?? "").trim();
  if (!topicUrl) throw new Error("请先填写 LINUX DO 帖子地址");
  const topic = await fetchTopic(topicUrl);
  const candidate = communityCandidate(topic);
  return { ok: true, url: topic.url, title: topic.title, postCount: topic.posts.length, candidate, message: candidate ? `读取评论 ${topic.posts.length} 条；社区候选：${candidate.code}；证据分数：${candidate.evidenceCount}` : `读取评论 ${topic.posts.length} 条；没有提取出高可信社区答案` };
}

async function latest(env) {
  const period = periodOf();
  const current = await env.DB.prepare(`SELECT period, code, status, confidence, evidence_count, source_url, source_title, updated_at FROM codes WHERE period = ? LIMIT 1`).bind(period).first();
  if (current) return { found: true, isCurrentMonth: true, item: current };
  const item = await env.DB.prepare(`SELECT period, code, status, confidence, evidence_count, source_url, source_title, updated_at FROM codes WHERE status = 'verified' ORDER BY period DESC LIMIT 1`).first();
  return item ? { found: true, isCurrentMonth: false, item } : { found: false, isCurrentMonth: false, item: null };
}

async function history(env) {
  return { items: (await env.DB.prepare(`SELECT * FROM codes ORDER BY period DESC LIMIT 24`).all()).results };
}

async function health(env, now = new Date()) {
  const period = periodOf(now);
  try {
    const row = await env.DB.prepare(`SELECT 1 AS ok FROM codes LIMIT 1`).first();
    return { ok: true, period, database: row ? "reachable" : "reachable_empty", autoWindow: inAutoWindow(now), hasVerifiedCodeThisMonth: await hasVerifiedCode(env, period) };
  } catch {
    return { ok: false, period, database: "unreachable", autoWindow: inAutoWindow(now), hasVerifiedCodeThisMonth: false };
  }
}

async function listCandidates(env, period) {
  return (await env.DB.prepare(`SELECT period, code, source_key, source_name, source_type, source_url, confidence, evidence_count, evidence, updated_at FROM code_candidates WHERE period = ? ORDER BY confidence DESC, evidence_count DESC, updated_at DESC`).bind(period).all()).results;
}

async function listOffers(env, period) {
  return (await env.DB.prepare(`SELECT period, code, offer_type, discount_value, plan_name, status, confidence_score, source_count, first_seen_at, last_seen_at, last_verified_at, updated_at FROM offers WHERE period = ? ORDER BY confidence_score DESC, source_count DESC, updated_at DESC`).bind(period).all()).results.map((item) => ({ ...item, trust_label: trustLabelForStatus(item.status) }));
}

async function listEvidence(env, period) {
  return (await env.DB.prepare(`SELECT period, code, source_key, source_type, source_url, reference_url, is_official, status, confidence_score, evidence_excerpt, extraction_method, verification_method, reviewer, created_at FROM offer_evidence WHERE period = ? ORDER BY id DESC LIMIT 80`).bind(period).all()).results;
}

async function listDiscovery(env, period) {
  const planned = [
    { kind: "known_topic_url", query: "KNOWN_LINUXDO_TOPICS", purpose: "当月已知公开帖优先，避免 refresh 触发过多子请求" },
    { kind: "linuxdo_search", query: "宝可梦 + 当月 + 兑换码/优惠码", purpose: "未知帖子时搜索 Linux.do 站内话题" },
    { kind: "linuxdo_category", query: "linux.do/c/welfare/36", purpose: "搜索失败时扫描福利羊毛分类" },
    { kind: "linuxdo_related_topic", query: "已发现的宝可梦历史帖", purpose: "从历史帖关联链接继续找当月帖" }
  ];
  const discovered = (await env.DB.prepare(`SELECT period, discovery_kind, query, title, source_url, score, updated_at FROM source_discoveries WHERE period = ? ORDER BY score DESC, updated_at DESC LIMIT 80`).bind(period).all()).results;
  return { planned, discovered };
}

async function listSources(env) {
  return (await env.DB.prepare(`SELECT s.*, c.result AS last_result, c.message AS last_message, c.source_url AS last_source_url, c.created_at AS last_checked_at FROM sources s LEFT JOIN source_checks c ON c.id = (SELECT id FROM source_checks WHERE source_key = s.source_key ORDER BY id DESC LIMIT 1) ORDER BY s.priority, s.id`).all()).results;
}

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      const currentPeriod = periodOf();
      if (url.pathname === "/api/health" && request.method === "GET") return json(await health(env));
      if (url.pathname === "/api/latest" && request.method === "GET") return json(await latest(env), 200, { "Cache-Control": "public, max-age=300" });
      if (url.pathname === "/api/history" && request.method === "GET") return json(await history(env));
      if (url.pathname === "/api/public-links" && request.method === "GET") return json({ officialChannel: OFFICIAL_CHANNEL_URL, officialGroup: OFFICIAL_GROUP_URL }, 200, { "Cache-Control": "public, max-age=3600" });
      if (url.pathname === "/api/admin/manual" && request.method === "POST") {
        try { return json(await manual(env, await body(request))); } catch (error) { return json({ ok: false, message: errorMessage(error) }, 422); }
      }
      if (url.pathname === "/api/admin/refresh" && request.method === "POST") {
        const data = await body(request);
        const result = await refresh(env, { force: true, triggerType: "manual_refresh_open_admin", topicUrl: data.topicUrl || null });
        return json(result, result.ok ? 200 : 422);
      }
      if (url.pathname === "/api/admin/test-topic" && request.method === "POST") {
        try { return json(await testTopic(await body(request))); } catch (error) { return json({ ok: false, message: errorMessage(error) }, 422); }
      }
      if (url.pathname === "/api/admin/discover" && request.method === "POST") {
        try {
          const bestTopic = await discoverMonthlyTopic(env);
          return json({ ok: true, period: currentPeriod, bestTopic, ...(await listDiscovery(env, currentPeriod)) });
        } catch (error) {
          return json({ ok: false, period: currentPeriod, message: errorMessage(error), ...(await listDiscovery(env, currentPeriod)) }, 422);
        }
      }
      if (url.pathname === "/api/admin/backfill-recent" && request.method === "POST") return json({ ok: false, message: "已移除固定码回填。请使用 /api/admin/manual 手动补录，或 /api/admin/refresh 自动发现/指定公开帖识别。" }, 410);
      if (url.pathname === "/api/admin/logs" && request.method === "GET") return json({ items: (await env.DB.prepare(`SELECT period, trigger_type, result, message, source_url, created_at FROM refresh_logs ORDER BY id DESC LIMIT 40`).all()).results });
      if (url.pathname === "/api/admin/candidates" && request.method === "GET") return json({ period: currentPeriod, items: await listCandidates(env, currentPeriod) });
      if (url.pathname === "/api/admin/offers" && request.method === "GET") return json({ period: currentPeriod, items: await listOffers(env, currentPeriod) });
      if (url.pathname === "/api/admin/evidence" && request.method === "GET") return json({ period: currentPeriod, items: await listEvidence(env, currentPeriod) });
      if (url.pathname === "/api/admin/discovery" && request.method === "GET") return json({ period: currentPeriod, ...(await listDiscovery(env, currentPeriod)) });
      if (url.pathname === "/api/admin/sources" && request.method === "GET") return json({ items: await listSources(env) });
      if (url.pathname === "/api/admin/sources/toggle" && request.method === "POST") {
        const data = await body(request);
        const result = await env.DB.prepare(`UPDATE sources SET enabled = ?, updated_at = CURRENT_TIMESTAMP WHERE source_key = ?`).bind(data.enabled ? 1 : 0, String(data.sourceKey ?? "")).run();
        return json({ ok: Boolean(result.meta?.changes), sourceKey: data.sourceKey, enabled: Boolean(data.enabled) });
      }
      return env.ASSETS.fetch(request);
    } catch (error) {
      console.error("request_failed", errorMessage(error));
      return json({ ok: false, message: "服务暂时异常，请稍后再试" }, 500);
    }
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(refresh(env, { force: false, triggerType: `cron:${controller.cron}` }));
  }
};

export { communityCandidate, discoverMonthlyTopic, fetchTopic, inAutoWindow, manual, periodOf, refresh, testTopic };
