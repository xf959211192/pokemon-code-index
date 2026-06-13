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
