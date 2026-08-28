PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending', -- pending | active | disabled
  email_verified_at TEXT,
  is_main_admin INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL, -- member | advisor | admin
  granted_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, role)
);

-- Per-user fine-grained overrides on top of role defaults.
CREATE TABLE IF NOT EXISTS user_permissions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  permission TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'grant', -- grant | revoke
  granted_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, permission)
);

CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY,
  token_hash TEXT NOT NULL UNIQUE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  ip TEXT,
  user_agent TEXT
);

CREATE TABLE IF NOT EXISTS email_tokens (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL, -- verify | reset
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Dev mailbox: outbound email captured locally instead of being sent.
CREATE TABLE IF NOT EXISTS outbound_emails (
  id INTEGER PRIMARY KEY,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cases (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES users(id),
  title TEXT NOT NULL,
  case_type TEXT NOT NULL DEFAULT 'other',
  status TEXT NOT NULL DEFAULT 'gathering', -- gathering | waiting_for_kelly | kelly_reviewing | need_member_info | action_plan_ready | ongoing | closed
  urgency TEXT NOT NULL DEFAULT 'normal', -- critical | high | normal | self_service
  urgency_reason TEXT,
  what_happened TEXT NOT NULL,
  employer TEXT NOT NULL DEFAULT '',
  staff_group TEXT NOT NULL DEFAULT '',
  formal_stage TEXT NOT NULL DEFAULT '',
  desired_outcome TEXT NOT NULL DEFAULT '',
  meeting_or_deadline TEXT NOT NULL DEFAULT '',
  next_important_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_cases_member ON cases(member_id);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);

CREATE TABLE IF NOT EXISTS case_messages (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  author_user_id INTEGER REFERENCES users(id), -- NULL = system/AI
  visibility TEXT NOT NULL DEFAULT 'member', -- member | advisor_private | system
  kind TEXT NOT NULL DEFAULT 'message', -- message | question | ai_explanation | action_plan | note
  content TEXT NOT NULL,
  approved_by INTEGER REFERENCES users(id), -- who approved AI-assisted member-visible content
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_msgs_case ON case_messages(case_id);

CREATE TABLE IF NOT EXISTS case_timeline (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  event_date TEXT,
  description TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'member', -- member | document:<id> | ai | advisor
  confidence TEXT NOT NULL DEFAULT 'stated',
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_timeline_case ON case_timeline(case_id);

CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  storage_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'stored', -- stored | extracted | extraction_failed
  extracted_text TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_docs_case ON documents(case_id);

CREATE TABLE IF NOT EXISTS knowledge_sources (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  publisher TEXT NOT NULL DEFAULT '',
  source_type TEXT NOT NULL DEFAULT 'guidance', -- legislation | acas | nhs_national | regulator | trust_policy | guidance
  jurisdiction TEXT NOT NULL DEFAULT 'UK',
  canonical_url TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_versions (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES knowledge_sources(id) ON DELETE CASCADE,
  version_label TEXT NOT NULL DEFAULT 'v1',
  effective_from TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
  checksum TEXT NOT NULL,
  review_status TEXT NOT NULL DEFAULT 'approved', -- draft | approved | superseded
  supersedes_id INTEGER REFERENCES knowledge_versions(id),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS knowledge_chunks (
  id INTEGER PRIMARY KEY,
  version_id INTEGER NOT NULL REFERENCES knowledge_versions(id) ON DELETE CASCADE,
  seq INTEGER NOT NULL,
  content TEXT NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS knowledge_fts USING fts5(
  content,
  content='knowledge_chunks',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ai AFTER INSERT ON knowledge_chunks BEGIN
  INSERT INTO knowledge_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS knowledge_chunks_ad AFTER DELETE ON knowledge_chunks BEGIN
  INSERT INTO knowledge_fts(knowledge_fts, rowid, content) VALUES ('delete', old.id, old.content);
END;

CREATE TABLE IF NOT EXISTS ai_outputs (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  task TEXT NOT NULL, -- intake | reanalyse
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok', -- ok | failed | invalid
  output_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ai_case ON ai_outputs(case_id);

CREATE TABLE IF NOT EXISTS citations (
  id INTEGER PRIMARY KEY,
  ai_output_id INTEGER NOT NULL REFERENCES ai_outputs(id) ON DELETE CASCADE,
  chunk_id INTEGER NOT NULL REFERENCES knowledge_chunks(id),
  claim TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS escalations (
  id INTEGER PRIMARY KEY,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'high', -- critical | high
  detected_by TEXT NOT NULL DEFAULT 'rules', -- rules | ai | advisor
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id)
);
CREATE INDEX IF NOT EXISTS idx_escalations_case ON escalations(case_id);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY,
  actor_user_id INTEGER REFERENCES users(id),
  action TEXT NOT NULL,
  object_type TEXT NOT NULL DEFAULT '',
  object_id TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_events(created_at);

CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  case_id INTEGER REFERENCES cases(id) ON DELETE CASCADE,
  read_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Admin assistant chatbot: multiple parallel conversations (tabs) per user.
CREATE TABLE IF NOT EXISTS assistant_threads (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'New chat',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assistant_threads_user ON assistant_threads(user_id, updated_at);

CREATE TABLE IF NOT EXISTS assistant_messages (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL, -- user | assistant | tool
  content TEXT NOT NULL DEFAULT '',
  tool_calls TEXT,    -- JSON, assistant rows only
  tool_call_id TEXT,  -- tool rows only
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_assistant_msgs_user ON assistant_messages(user_id, id);

-- Proposed write actions awaiting human approval. Args live only here —
-- the client ever sees just the row id, so args cannot be tampered with.
CREATE TABLE IF NOT EXISTS assistant_actions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | executed | declined | expired
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_assistant_actions_user ON assistant_actions(user_id, status);

-- ═══════════════════════════════════════════════════════════════════════════
-- Job evaluation & banding (standalone section; scheme-agnostic reference
-- data). Reference numerics (factors, level points, band boundaries,
-- profiles) are DATA — loaded, versioned, checksummed and approved. No AfC
-- constant may appear in application code.
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS je_rulesets (
  id INTEGER PRIMARY KEY,
  label TEXT NOT NULL,
  scheme TEXT NOT NULL DEFAULT 'afc',
  status TEXT NOT NULL DEFAULT 'draft', -- draft | approved | superseded
  origin TEXT NOT NULL DEFAULT 'import', -- seed | import
  effective_from TEXT,
  checksum TEXT NOT NULL,                -- sha256 of the canonical bundle
  match_rules_json TEXT NOT NULL DEFAULT '{}',
  limitation_rules_json TEXT NOT NULL DEFAULT '[]', -- statutory/procedural time-limit parameters (data, never code)
  source_note TEXT NOT NULL DEFAULT '',  -- publisher / edition / URL provenance
  knowledge_version_id INTEGER REFERENCES knowledge_versions(id),
  supersedes_id INTEGER REFERENCES je_rulesets(id),
  created_by INTEGER REFERENCES users(id),
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  verified_by INTEGER REFERENCES users(id), -- human checked against the published handbook
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_je_ruleset_checksum ON je_rulesets(checksum);
-- At most one approved ruleset per scheme at any time.
CREATE UNIQUE INDEX IF NOT EXISTS idx_je_ruleset_active ON je_rulesets(scheme) WHERE status = 'approved';

CREATE TABLE IF NOT EXISTS je_factors (
  id INTEGER PRIMARY KEY,
  ruleset_id INTEGER NOT NULL REFERENCES je_rulesets(id) ON DELETE CASCADE,
  code TEXT NOT NULL,      -- stable slug, e.g. 'communication'
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  guidance TEXT NOT NULL DEFAULT '',
  UNIQUE (ruleset_id, code)
);

CREATE TABLE IF NOT EXISTS je_factor_levels (
  id INTEGER PRIMARY KEY,
  ruleset_id INTEGER NOT NULL REFERENCES je_rulesets(id) ON DELETE CASCADE,
  factor_code TEXT NOT NULL,
  level_seq INTEGER NOT NULL,
  level_label TEXT NOT NULL,
  points INTEGER NOT NULL,
  descriptor TEXT NOT NULL, -- short paraphrase; verbatim prose lives in knowledge
  UNIQUE (ruleset_id, factor_code, level_label)
);

CREATE TABLE IF NOT EXISTS je_band_boundaries (
  id INTEGER PRIMARY KEY,
  ruleset_id INTEGER NOT NULL REFERENCES je_rulesets(id) ON DELETE CASCADE,
  band_label TEXT NOT NULL, -- '5', '8a'
  seq INTEGER NOT NULL,
  min_points INTEGER NOT NULL, -- inclusive
  max_points INTEGER NOT NULL, -- inclusive
  UNIQUE (ruleset_id, band_label)
);

CREATE TABLE IF NOT EXISTS je_profiles (
  id INTEGER PRIMARY KEY,
  ruleset_id INTEGER NOT NULL REFERENCES je_rulesets(id) ON DELETE CASCADE,
  profile_code TEXT NOT NULL,
  title TEXT NOT NULL,
  job_family TEXT NOT NULL DEFAULT '',
  band_label TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'current', -- current | withdrawn
  notes TEXT NOT NULL DEFAULT '',
  UNIQUE (ruleset_id, profile_code)
);
CREATE INDEX IF NOT EXISTS idx_je_profiles_family ON je_profiles(ruleset_id, job_family);

-- Profiles express a level OR a permitted range per factor.
CREATE TABLE IF NOT EXISTS je_profile_levels (
  id INTEGER PRIMARY KEY,
  profile_id INTEGER NOT NULL REFERENCES je_profiles(id) ON DELETE CASCADE,
  factor_code TEXT NOT NULL,
  level_min TEXT NOT NULL,
  level_max TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  UNIQUE (profile_id, factor_code)
);

-- Deterministic profile shortlisting (mirrors knowledge_fts).
CREATE VIRTUAL TABLE IF NOT EXISTS je_profiles_fts USING fts5(
  title, job_family, notes, content='je_profiles', content_rowid='id'
);
CREATE TRIGGER IF NOT EXISTS je_profiles_ai AFTER INSERT ON je_profiles BEGIN
  INSERT INTO je_profiles_fts(rowid, title, job_family, notes)
  VALUES (new.id, new.title, new.job_family, new.notes);
END;
CREATE TRIGGER IF NOT EXISTS je_profiles_ad AFTER DELETE ON je_profiles BEGIN
  INSERT INTO je_profiles_fts(je_profiles_fts, rowid, title, job_family, notes)
  VALUES ('delete', old.id, old.title, old.job_family, old.notes);
END;

-- ── The review itself ──────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS je_reviews (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL DEFAULT 'band_review',
  -- band_review | job_match | new_post | appeal | equal_pay
  stage TEXT NOT NULL DEFAULT 'draft',
  -- draft | member_submitted | analysing | advisor_review | report_ready
  -- | submitted_to_employer | employer_review | outcome_received
  -- | appeal_lodged | appeal_outcome | closed
  job_title TEXT NOT NULL DEFAULT '',
  employer TEXT NOT NULL DEFAULT '',
  staff_group_code TEXT NOT NULL DEFAULT '',
  current_band TEXT NOT NULL DEFAULT '',
  claimed_band TEXT NOT NULL DEFAULT '',
  in_post_since TEXT,
  duties_changed_since TEXT,
  ruleset_id INTEGER REFERENCES je_rulesets(id), -- FROZEN at first compute
  question_set_version TEXT NOT NULL DEFAULT '',
  member_editable INTEGER NOT NULL DEFAULT 1,
  answers_version INTEGER NOT NULL DEFAULT 0,    -- optimistic lock
  assigned_advisor_id INTEGER REFERENCES users(id),
  risk_acknowledged_at TEXT,
  consent_version TEXT NOT NULL DEFAULT '',
  urgency TEXT NOT NULL DEFAULT 'normal', -- critical | high | normal
  urgency_reason TEXT,
  next_important_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_je_reviews_member ON je_reviews(member_id);
CREATE INDEX IF NOT EXISTS idx_je_reviews_stage ON je_reviews(stage);

CREATE TABLE IF NOT EXISTS je_answers (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES je_reviews(id) ON DELETE CASCADE,
  question_code TEXT NOT NULL,
  answer TEXT NOT NULL DEFAULT '',
  answered_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (review_id, question_code)
);

-- The review's own conversation thread (standalone: mirrors case_messages).
CREATE TABLE IF NOT EXISTS je_messages (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES je_reviews(id) ON DELETE CASCADE,
  author_user_id INTEGER REFERENCES users(id), -- NULL = system/AI
  visibility TEXT NOT NULL DEFAULT 'member', -- member | advisor_private | system
  kind TEXT NOT NULL DEFAULT 'message', -- message | question | report | note
  content TEXT NOT NULL,
  approved_by INTEGER REFERENCES users(id),
  meta TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_je_msgs_review ON je_messages(review_id);

-- Standalone document store for reviews; shares the upload/extraction
-- pipeline with case documents via services/documentIntake.js.
CREATE TABLE IF NOT EXISTS je_documents (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES je_reviews(id) ON DELETE CASCADE,
  owner_user_id INTEGER NOT NULL REFERENCES users(id),
  doc_role TEXT NOT NULL DEFAULT 'other',
  -- jd | person_spec | org_chart | appraisal | rota | payslip
  -- | comparator_jd | outcome_letter | other
  storage_key TEXT NOT NULL,
  original_filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  sha256 TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'stored', -- stored | extracted | extraction_failed
  extracted_text TEXT,
  is_current INTEGER NOT NULL DEFAULT 1,
  document_dated TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_je_docs_review ON je_documents(review_id);

-- One row per factor per review. Member, AI and advisor each own their own
-- column group, so concurrent writes can never clobber each other.
CREATE TABLE IF NOT EXISTS je_factor_assessments (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES je_reviews(id) ON DELETE CASCADE,
  factor_code TEXT NOT NULL,
  claimed_level TEXT,                      -- member-only
  claimed_note TEXT NOT NULL DEFAULT '',
  ai_level TEXT,                           -- pipeline-only; proposal, never authority
  ai_confidence TEXT,                      -- high | medium | low | insufficient
  ai_alternative_level TEXT,
  ai_rationale TEXT NOT NULL DEFAULT '',
  ai_output_id INTEGER,
  gap_note TEXT NOT NULL DEFAULT '',
  confirmed_level TEXT,                    -- advisor-only
  confirmed_decision TEXT,                 -- agree | amend | insufficient | not_applicable
  confirmed_reason_code TEXT,              -- required when decision = amend
  confirmed_by INTEGER REFERENCES users(id),
  confirmed_at TEXT,
  confirm_note TEXT NOT NULL DEFAULT '',
  adjustment_flag INTEGER NOT NULL DEFAULT 0,
  outlier_flag INTEGER NOT NULL DEFAULT 0,
  blind INTEGER NOT NULL DEFAULT 0,        -- AI proposal hidden until advisor recorded theirs
  status TEXT NOT NULL DEFAULT 'open',
  -- open | evidenced | insufficient_evidence | confirmed | disputed
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (review_id, factor_code)
);

-- Every level proposal must point at evidence that provably exists.
CREATE TABLE IF NOT EXISTS je_evidence (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES je_reviews(id) ON DELETE CASCADE,
  factor_code TEXT NOT NULL DEFAULT '',    -- '' = general
  source_kind TEXT NOT NULL,               -- document | wizard | message | advisor
  document_id INTEGER REFERENCES je_documents(id) ON DELETE SET NULL,
  answer_id INTEGER REFERENCES je_answers(id) ON DELETE SET NULL,
  quote TEXT NOT NULL DEFAULT '',          -- verbatim, verified against source
  quote_offset INTEGER,
  summary TEXT NOT NULL DEFAULT '',
  strength TEXT NOT NULL DEFAULT 'candidate', -- candidate | confirmed | rejected
  created_by TEXT NOT NULL DEFAULT 'ai',   -- ai | member | advisor
  ai_output_id INTEGER,
  confirmed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_je_evidence_review ON je_evidence(review_id, factor_code);

CREATE TABLE IF NOT EXISTS je_profile_matches (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES je_reviews(id) ON DELETE CASCADE,
  profile_id INTEGER NOT NULL REFERENCES je_profiles(id),
  rank INTEGER NOT NULL DEFAULT 0,
  fit TEXT NOT NULL DEFAULT 'partial',     -- match | partial | no_match (DETERMINISTIC)
  factors_outside_json TEXT NOT NULL DEFAULT '[]',
  ai_rationale TEXT NOT NULL DEFAULT '',
  ai_output_id INTEGER,
  selected_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_je_matches_review ON je_profile_matches(review_id);

-- Comparator / fair-pay evidence. Stores a member-chosen reference label,
-- never a colleague's name, unless consent is explicitly recorded.
CREATE TABLE IF NOT EXISTS je_comparators (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES je_reviews(id) ON DELETE CASCADE,
  comparator_ref TEXT NOT NULL,            -- 'Colleague A', 'Band 6 post on ward X'
  kind TEXT NOT NULL DEFAULT 'colleague',
  -- colleague | same_employer_other_post | other_employer | national_profile | advert
  same_employer INTEGER NOT NULL DEFAULT 1,
  band_label TEXT NOT NULL DEFAULT '',
  basis TEXT NOT NULL DEFAULT 'like_work',
  -- like_work | work_rated_as_equivalent | equal_value
  is_actual_person INTEGER NOT NULL DEFAULT 1,
  named_consent INTEGER NOT NULL DEFAULT 0, -- they know and agreed to be named
  similarity_note TEXT NOT NULL DEFAULT '',
  difference_note TEXT NOT NULL DEFAULT '',
  evidence_document_id INTEGER REFERENCES je_documents(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'claimed',  -- claimed | evidenced | verified | rejected
  verified_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_je_comparators_review ON je_comparators(review_id);

-- Deterministic check results / escalation flags for a review (standalone
-- sibling of `escalations`).
CREATE TABLE IF NOT EXISTS je_flags (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES je_reviews(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL DEFAULT 'high', -- critical | high | notice
  reason TEXT NOT NULL,
  factor_code TEXT NOT NULL DEFAULT '',
  detected_by TEXT NOT NULL DEFAULT 'rules', -- rules | ai | advisor
  acknowledged_by INTEGER REFERENCES users(id),
  acknowledged_at TEXT,
  resolved_at TEXT,
  resolved_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_je_flags_review ON je_flags(review_id);

-- ── Outcomes, decisions, reports, runs ─────────────────────────────────────

-- Append-only. A recompute NEVER mutates an existing outcome.
CREATE TABLE IF NOT EXISTS je_outcomes (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES je_reviews(id) ON DELETE CASCADE,
  ruleset_id INTEGER NOT NULL REFERENCES je_rulesets(id),
  ruleset_checksum TEXT NOT NULL,
  basis TEXT NOT NULL,              -- claimed | ai_proposed | confirmed
  total_points INTEGER NOT NULL,
  band_label TEXT NOT NULL DEFAULT '', -- '' when not asserted (incomplete/range)
  points_low INTEGER NOT NULL,
  points_high INTEGER NOT NULL,
  band_low TEXT NOT NULL DEFAULT '',
  band_high TEXT NOT NULL DEFAULT '',
  confidence TEXT NOT NULL DEFAULT 'low', -- high | medium | low
  factors_missing INTEGER NOT NULL DEFAULT 0,
  computation_json TEXT NOT NULL,   -- frozen inputs + per-factor arithmetic
  checks_json TEXT NOT NULL DEFAULT '[]',
  supersedes_id INTEGER REFERENCES je_outcomes(id),
  computed_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_je_outcomes_review ON je_outcomes(review_id);

-- Real-world formal events in the employer's process. The ONLY entry point
-- for an actual band: a human recording an employer outcome.
CREATE TABLE IF NOT EXISTS je_decisions (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES je_reviews(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  -- request_submitted | panel_matched | panel_evaluated | outcome_issued
  -- | appeal_lodged | appeal_heard | appeal_outcome | back_pay_agreed | withdrawn
  decision_date TEXT,
  decided_by TEXT NOT NULL DEFAULT 'employer',
  -- employer | matching_panel | appeal_panel | member | advisor
  band_awarded TEXT NOT NULL DEFAULT '',
  effective_from TEXT,
  back_pay_from TEXT,
  back_pay_to TEXT,
  detail TEXT NOT NULL DEFAULT '',
  document_id INTEGER REFERENCES je_documents(id) ON DELETE SET NULL,
  source TEXT NOT NULL DEFAULT 'member_reported', -- member_reported | document | advisor
  date_confirmed INTEGER NOT NULL DEFAULT 0,      -- deadline safety: verify flag
  recorded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_je_decisions_review ON je_decisions(review_id);

CREATE TABLE IF NOT EXISTS je_reports (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES je_reviews(id) ON DELETE CASCADE,
  outcome_id INTEGER REFERENCES je_outcomes(id),
  audience TEXT NOT NULL DEFAULT 'member', -- member | advisor | employer_submission
  report_version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'draft',    -- draft | approved | issued | withdrawn
  includes_band_range INTEGER NOT NULL DEFAULT 1,
  include_range_reason TEXT NOT NULL DEFAULT '',
  body_json TEXT NOT NULL,
  ai_output_id INTEGER,
  generated_by TEXT NOT NULL DEFAULT 'template', -- template | ai
  approved_by INTEGER REFERENCES users(id),
  approved_at TEXT,
  issued_at TEXT,
  je_message_id INTEGER REFERENCES je_messages(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (review_id, audience, report_version)
);

CREATE TABLE IF NOT EXISTS je_runs (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES je_reviews(id) ON DELETE CASCADE,
  trigger_kind TEXT NOT NULL DEFAULT 'advisor', -- member_submit | advisor | recompute
  status TEXT NOT NULL DEFAULT 'running',       -- running | complete | failed | aborted
  requested_by INTEGER REFERENCES users(id),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  error_code TEXT
);
-- One in-flight run per review, enforced by the database.
CREATE UNIQUE INDEX IF NOT EXISTS idx_je_runs_active ON je_runs(review_id) WHERE status = 'running';

CREATE TABLE IF NOT EXISTS je_run_stages (
  id INTEGER PRIMARY KEY,
  run_id INTEGER NOT NULL REFERENCES je_runs(id) ON DELETE CASCADE,
  stage TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | ok | invalid | failed | skipped
  ai_output_id INTEGER,
  prompt_version TEXT NOT NULL DEFAULT '',
  dropped_count INTEGER NOT NULL DEFAULT 0, -- validator rejections, for oversight
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT
);
CREATE INDEX IF NOT EXISTS idx_je_run_stages_run ON je_run_stages(run_id);

-- Sign-off record: the advisor's completed fairness checklist per review.
CREATE TABLE IF NOT EXISTS je_signoffs (
  id INTEGER PRIMARY KEY,
  review_id INTEGER NOT NULL REFERENCES je_reviews(id) ON DELETE CASCADE,
  reviewer_user_id INTEGER NOT NULL REFERENCES users(id),
  review_role TEXT NOT NULL DEFAULT 'primary', -- primary | second_opinion
  checklist_version TEXT NOT NULL,
  checklist_json TEXT NOT NULL,       -- {itemCode: true} — codes only, no narrative
  recommendation TEXT NOT NULL,       -- supports | supports_in_part | not_supported | more_information
  disagreement_count INTEGER NOT NULL DEFAULT 0,
  band_low TEXT NOT NULL DEFAULT '',
  band_high TEXT NOT NULL DEFAULT '',
  second_opinion_required INTEGER NOT NULL DEFAULT 0,
  second_opinion_waived_reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_je_signoffs_review ON je_signoffs(review_id);
