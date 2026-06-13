CREATE TABLE IF NOT EXISTS codes (
  period TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'verified'
    CHECK (status IN ('candidate', 'verified', 'expired', 'rejected')),
  confidence REAL NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 0,
  source_url TEXT,
  source_title TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS refresh_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  result TEXT NOT NULL,
  message TEXT,
  source_url TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_refresh_logs_created_at
ON refresh_logs(created_at DESC);

CREATE TABLE IF NOT EXISTS sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  url TEXT NOT NULL,
  source_type TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  description TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS code_candidates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period TEXT NOT NULL,
  code TEXT NOT NULL,
  source_key TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_url TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0,
  evidence_count INTEGER NOT NULL DEFAULT 1,
  evidence TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(period, code, source_url)
);

CREATE INDEX IF NOT EXISTS idx_code_candidates_period
ON code_candidates(period, confidence DESC, evidence_count DESC);

CREATE TABLE IF NOT EXISTS source_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_key TEXT NOT NULL,
  period TEXT NOT NULL,
  result TEXT NOT NULL,
  message TEXT,
  source_url TEXT NOT NULL,
  candidate_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_source_checks_source_key
ON source_checks(source_key, id DESC);

CREATE TABLE IF NOT EXISTS providers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_key TEXT NOT NULL UNIQUE,
  canonical_name TEXT NOT NULL,
  aliases TEXT NOT NULL DEFAULT '[]',
  official_domains TEXT NOT NULL DEFAULT '[]',
  public_channels TEXT NOT NULL DEFAULT '[]',
  plan_keywords TEXT NOT NULL DEFAULT '[]',
  risk_notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS offers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_key TEXT NOT NULL,
  period TEXT NOT NULL,
  code TEXT NOT NULL,
  offer_type TEXT NOT NULL DEFAULT 'unknown',
  discount_value TEXT,
  plan_name TEXT,
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'reported', 'corroborated', 'official_notice', 'checkout_verified', 'expired', 'unknown')),
  confidence_score INTEGER NOT NULL DEFAULT 0,
  source_count INTEGER NOT NULL DEFAULT 0,
  first_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_verified_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider_key, period, code)
);

CREATE INDEX IF NOT EXISTS idx_offers_period
ON offers(period, confidence_score DESC, source_count DESC);

CREATE TABLE IF NOT EXISTS offer_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_key TEXT NOT NULL,
  period TEXT NOT NULL,
  code TEXT,
  source_key TEXT,
  source_type TEXT NOT NULL,
  source_url TEXT NOT NULL,
  reference_url TEXT,
  is_official INTEGER NOT NULL DEFAULT 0 CHECK (is_official IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'candidate'
    CHECK (status IN ('candidate', 'reported', 'corroborated', 'official_notice', 'checkout_verified', 'expired', 'unknown')),
  confidence_score INTEGER NOT NULL DEFAULT 0,
  evidence_excerpt TEXT,
  evidence_hash TEXT NOT NULL,
  extraction_method TEXT,
  verification_method TEXT,
  reviewer TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(evidence_hash)
);

CREATE INDEX IF NOT EXISTS idx_offer_evidence_period
ON offer_evidence(period, created_at DESC);

CREATE TABLE IF NOT EXISTS source_discoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  provider_key TEXT NOT NULL,
  period TEXT NOT NULL,
  discovery_kind TEXT NOT NULL,
  query TEXT NOT NULL,
  title TEXT,
  source_url TEXT NOT NULL,
  score INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(provider_key, period, discovery_kind, source_url, query)
);

CREATE INDEX IF NOT EXISTS idx_source_discoveries_period
ON source_discoveries(period, score DESC, updated_at DESC);

INSERT OR IGNORE INTO sources (
  source_key, name, url, source_type, priority, enabled, description
) VALUES
(
  'official_telegram',
  '官方 Telegram 通知频道',
  'https://t.me/s/pokemon521',
  'official_telegram',
  10,
  1,
  '抓取公开频道网页。若官方直接发布文本兑换码，可自动确认；若为图片谜题，则等待社区答案。'
),
(
  'official_group',
  '官方 Telegram 群组入口',
  'https://t.me/pokemon_love',
  'reference',
  20,
  1,
  '仅检查公开入口是否可访问，不抓取群聊记录。'
),
(
  'linuxdo_monthly_topic',
  'LINUX DO 月度讨论帖',
  'https://linux.do',
  'linuxdo_search',
  30,
  1,
  '自动搜索当月公开帖子，并根据评论区重复答案提取社区共识。'
);

INSERT OR IGNORE INTO providers (
  provider_key,
  canonical_name,
  aliases,
  official_domains,
  public_channels,
  plan_keywords,
  risk_notes
) VALUES (
  'pokemon_nebula',
  '宝可梦星云',
  '["宝可梦VPN","宝可梦加速器","宝可梦机场","宝可梦云","宝可梦星云","52pokemon","pokemon521"]',
  '[]',
  '["pokemon521"]',
  '["入门精灵球","高级精灵球","免费套餐","白嫖码"]',
  '公开信息聚合；涉及网络代理服务时需结合实际运营地和用户所在地做合规评估。'
);
