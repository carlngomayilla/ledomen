CREATE TABLE IF NOT EXISTS leads (
  id BIGSERIAL PRIMARY KEY,
  prenom VARCHAR(80) NOT NULL,
  nom VARCHAR(80) NOT NULL,
  contact_raw VARCHAR(180) NOT NULL,
  contact_normalized VARCHAR(180) NOT NULL UNIQUE,
  contact_type VARCHAR(16) NOT NULL CHECK (contact_type IN ('email','whatsapp')),
  ville VARCHAR(80) NOT NULL,
  role VARCHAR(32) NOT NULL CHECK (role IN ('organisateur','entreprise','prestataire')),
  consent BOOLEAN NOT NULL DEFAULT FALSE,
  consent_at TIMESTAMPTZ,
  source VARCHAR(80) NOT NULL DEFAULT 'landing-page',
  user_agent TEXT,
  unsubscribed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE leads ADD COLUMN IF NOT EXISTS unsubscribed_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_leads_created_at ON leads(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_leads_role ON leads(role);
CREATE INDEX IF NOT EXISTS idx_leads_ville ON leads(ville);
CREATE INDEX IF NOT EXISTS idx_leads_email_eligible ON leads(contact_type, consent, unsubscribed_at);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL DEFAULT '',
  updated_by VARCHAR(180),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS email_campaigns (
  id BIGSERIAL PRIMARY KEY,
  kind VARCHAR(32) NOT NULL DEFAULT 'launch' CHECK (kind IN ('launch')),
  name VARCHAR(140) NOT NULL,
  subject VARCHAR(180) NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  target_role VARCHAR(32),
  target_ville VARCHAR(80),
  only_not_notified BOOLEAN NOT NULL DEFAULT TRUE,
  platform_url TEXT NOT NULL,
  promo_code VARCHAR(80),
  sender_name VARCHAR(100),
  status VARCHAR(24) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('draft','scheduled','queued','sending','completed','cancelled')),
  scheduled_at TIMESTAMPTZ,
  total_recipients INTEGER NOT NULL DEFAULT 0,
  sent_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  skipped_count INTEGER NOT NULL DEFAULT 0,
  created_by VARCHAR(180),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ
);

ALTER TABLE email_campaigns ADD COLUMN IF NOT EXISTS sender_name VARCHAR(100);

CREATE INDEX IF NOT EXISTS idx_campaigns_created_at ON email_campaigns(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_campaigns_status ON email_campaigns(status, scheduled_at);

CREATE TABLE IF NOT EXISTS email_deliveries (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
  lead_id BIGINT NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  email VARCHAR(180) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','sending','sent','failed','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_error TEXT,
  provider_message_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  UNIQUE (campaign_id, lead_id)
);

CREATE INDEX IF NOT EXISTS idx_deliveries_queue ON email_deliveries(status, next_attempt_at, id);
CREATE INDEX IF NOT EXISTS idx_deliveries_campaign ON email_deliveries(campaign_id, status);
CREATE INDEX IF NOT EXISTS idx_deliveries_lead ON email_deliveries(lead_id, status);

CREATE TABLE IF NOT EXISTS admin_sessions (
  id BIGSERIAL PRIMARY KEY,
  token_hash CHAR(64) NOT NULL UNIQUE,
  csrf_hash CHAR(64) NOT NULL,
  admin_user VARCHAR(180) NOT NULL,
  user_agent_hash CHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_admin_sessions_active
  ON admin_sessions(token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS security_rate_limits (
  key TEXT PRIMARY KEY,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  count INTEGER NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGSERIAL PRIMARY KEY,
  admin_user VARCHAR(180),
  action VARCHAR(100) NOT NULL,
  target VARCHAR(180),
  success BOOLEAN NOT NULL DEFAULT TRUE,
  ip_hash CHAR(64),
  user_agent VARCHAR(500),
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at
  ON audit_logs(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_admin_user
  ON audit_logs(admin_user, created_at DESC);

