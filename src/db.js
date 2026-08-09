import pg from 'pg';

const { Pool } = pg;

const ssl = String(process.env.DATABASE_SSL || 'false').toLowerCase() === 'true'
  ? { rejectUnauthorized: false }
  : false;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl,
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

export async function ensureSchema() {
  await pool.query(`
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
    CREATE INDEX IF NOT EXISTS idx_leads_email_eligible
      ON leads(contact_type, consent, unsubscribed_at);

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

    CREATE INDEX IF NOT EXISTS idx_deliveries_queue
      ON email_deliveries(status, next_attempt_at, id);
    CREATE INDEX IF NOT EXISTS idx_deliveries_campaign
      ON email_deliveries(campaign_id, status);
    CREATE INDEX IF NOT EXISTS idx_deliveries_lead
      ON email_deliveries(lead_id, status);

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
  `);
}

export async function createLead(lead) {
  const query = `
    INSERT INTO leads (
      prenom, nom, contact_raw, contact_normalized, contact_type,
      ville, role, consent, consent_at, source, user_agent
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING id, prenom, nom, contact_type, ville, role, created_at
  `;
  const values = [
    lead.prenom,
    lead.nom,
    lead.contactRaw,
    lead.contactNormalized,
    lead.contactType,
    lead.ville,
    lead.role,
    true,
    new Date(),
    lead.source || 'landing-page',
    lead.userAgent || null,
  ];
  const result = await pool.query(query, values);
  return result.rows[0];
}

export async function getLeadCount() {
  const result = await pool.query('SELECT COUNT(*)::int AS count FROM leads');
  return result.rows[0].count;
}

export async function getLeadSummary() {
  const result = await pool.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE role = 'organisateur')::int AS organisateurs,
      COUNT(*) FILTER (WHERE role = 'entreprise')::int AS entreprises,
      COUNT(*) FILTER (WHERE role = 'prestataire')::int AS prestataires,
      COUNT(*) FILTER (
        WHERE contact_type = 'email' AND consent = TRUE AND unsubscribed_at IS NULL
      )::int AS emails_eligibles,
      COUNT(*) FILTER (WHERE unsubscribed_at IS NOT NULL)::int AS desinscrits
    FROM leads
  `);
  return result.rows[0];
}

export async function listLeads({ limit = 100, offset = 0, role = '', ville = '' } = {}) {
  const where = [];
  const values = [];
  if (role) {
    values.push(role);
    where.push(`l.role = $${values.length}`);
  }
  if (ville) {
    values.push(ville);
    where.push(`l.ville = $${values.length}`);
  }
  values.push(limit);
  const limitParam = `$${values.length}`;
  values.push(offset);
  const offsetParam = `$${values.length}`;

  const sql = `
    SELECT
      l.id, l.prenom, l.nom, l.contact_raw, l.contact_type, l.ville, l.role,
      l.consent_at, l.unsubscribed_at, l.created_at,
      EXISTS (
        SELECT 1
        FROM email_deliveries d
        JOIN email_campaigns c ON c.id = d.campaign_id
        WHERE d.lead_id = l.id AND d.status = 'sent' AND c.kind = 'launch'
      ) AS launch_notified
    FROM leads l
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY l.created_at DESC
    LIMIT ${limitParam} OFFSET ${offsetParam}
  `;
  const result = await pool.query(sql, values);
  return result.rows;
}

export async function exportAllLeads() {
  const result = await pool.query(`
    SELECT
      l.id, l.prenom, l.nom, l.contact_raw, l.contact_type, l.ville, l.role,
      l.consent_at, l.unsubscribed_at, l.created_at,
      EXISTS (
        SELECT 1
        FROM email_deliveries d
        JOIN email_campaigns c ON c.id = d.campaign_id
        WHERE d.lead_id = l.id AND d.status = 'sent' AND c.kind = 'launch'
      ) AS launch_notified
    FROM leads l
    ORDER BY l.created_at DESC
  `);
  return result.rows;
}

export async function getAppSettings() {
  const result = await pool.query('SELECT key, value FROM app_settings');
  return Object.fromEntries(result.rows.map((row) => [row.key, row.value]));
}

export async function upsertAppSettings(settings, updatedBy) {
  const entries = Object.entries(settings);
  if (!entries.length) return getAppSettings();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const [key, value] of entries) {
      await client.query(`
        INSERT INTO app_settings (key, value, updated_by, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (key) DO UPDATE
        SET value = EXCLUDED.value,
            updated_by = EXCLUDED.updated_by,
            updated_at = NOW()
      `, [key, String(value ?? ''), updatedBy || null]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return getAppSettings();
}

export async function createAdminSession({
  tokenHash,
  csrfHash,
  adminUser,
  userAgentHash = null,
  expiresAt,
}) {
  const result = await pool.query(`
    INSERT INTO admin_sessions (
      token_hash, csrf_hash, admin_user, user_agent_hash, expires_at
    )
    VALUES ($1, $2, $3, $4, $5)
    RETURNING id, admin_user, created_at, last_seen_at, expires_at
  `, [tokenHash, csrfHash, adminUser, userAgentHash, expiresAt]);
  return result.rows[0];
}

export async function getAdminSessionByTokenHash(tokenHash) {
  const result = await pool.query(`
    SELECT
      id, token_hash, csrf_hash, admin_user, user_agent_hash,
      created_at, last_seen_at, expires_at
    FROM admin_sessions
    WHERE token_hash = $1
      AND revoked_at IS NULL
      AND expires_at > NOW()
    LIMIT 1
  `, [tokenHash]);
  return result.rows[0] || null;
}

export async function touchAdminSession(sessionId) {
  await pool.query(`
    UPDATE admin_sessions
    SET last_seen_at = NOW()
    WHERE id = $1
      AND revoked_at IS NULL
      AND expires_at > NOW()
  `, [sessionId]);
}


export async function revokeAdminSessionByTokenHash(tokenHash) {
  const result = await pool.query(`
    UPDATE admin_sessions
    SET revoked_at = COALESCE(revoked_at, NOW())
    WHERE token_hash = $1
      AND revoked_at IS NULL
    RETURNING id
  `, [tokenHash]);
  return Boolean(result.rows.length);
}

export async function cleanupExpiredAdminSessions() {
  const result = await pool.query(`
    DELETE FROM admin_sessions
    WHERE expires_at <= NOW()
       OR revoked_at < NOW() - INTERVAL '7 days'
  `);
  return result.rowCount || 0;
}

export async function consumeSecurityRateLimit({
  key,
  windowSeconds,
  max,
}) {
  const result = await pool.query(`
    INSERT INTO security_rate_limits (
      key, window_started_at, count, updated_at
    )
    VALUES ($1, NOW(), 1, NOW())
    ON CONFLICT (key) DO UPDATE
    SET
      count = CASE
        WHEN security_rate_limits.window_started_at <=
             NOW() - ($2::int * INTERVAL '1 second')
          THEN 1
        ELSE security_rate_limits.count + 1
      END,
      window_started_at = CASE
        WHEN security_rate_limits.window_started_at <=
             NOW() - ($2::int * INTERVAL '1 second')
          THEN NOW()
        ELSE security_rate_limits.window_started_at
      END,
      updated_at = NOW()
    RETURNING count, window_started_at
  `, [key, windowSeconds]);

  const row = result.rows[0];
  const count = Number(row.count || 0);
  const startedAt = new Date(row.window_started_at);
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((startedAt.getTime() + (windowSeconds * 1000) - Date.now()) / 1000)
  );

  return {
    allowed: count <= max,
    count,
    retryAfterSeconds,
  };
}

export async function clearSecurityRateLimit(key) {
  await pool.query('DELETE FROM security_rate_limits WHERE key = $1', [key]);
}

export async function cleanupSecurityRateLimits() {
  const result = await pool.query(`
    DELETE FROM security_rate_limits
    WHERE updated_at < NOW() - INTERVAL '2 days'
  `);
  return result.rowCount || 0;
}

export async function writeAuditLog({
  adminUser = null,
  action,
  target = null,
  success = true,
  ipHash = null,
  userAgent = '',
  details = {},
}) {
  await pool.query(`
    INSERT INTO audit_logs (
      admin_user, action, target, success, ip_hash, user_agent, details
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
  `, [
    adminUser,
    action,
    target,
    Boolean(success),
    ipHash,
    String(userAgent || '').slice(0, 500),
    JSON.stringify(details || {}),
  ]);
}

export async function listAuditLogs(limit = 100) {
  const result = await pool.query(`
    SELECT
      id, admin_user, action, target, success, details, created_at
    FROM audit_logs
    ORDER BY created_at DESC
    LIMIT $1
  `, [Math.min(500, Math.max(1, Number(limit || 100)))]);
  return result.rows;
}


export async function countEligibleEmailLeads({ targetRole = '', targetVille = '', onlyNotNotified = true } = {}) {
  const filters = [
    `l.contact_type = 'email'`,
    `l.consent = TRUE`,
    `l.unsubscribed_at IS NULL`,
  ];
  const values = [];
  if (targetRole) {
    values.push(targetRole);
    filters.push(`l.role = $${values.length}`);
  }
  if (targetVille) {
    values.push(targetVille);
    filters.push(`l.ville = $${values.length}`);
  }
  if (onlyNotNotified) {
    filters.push(`NOT EXISTS (
      SELECT 1
      FROM email_deliveries previous_delivery
      JOIN email_campaigns previous_campaign
        ON previous_campaign.id = previous_delivery.campaign_id
      WHERE previous_delivery.lead_id = l.id
        AND previous_delivery.status = 'sent'
        AND previous_campaign.kind = 'launch'
    )`);
  }
  const result = await pool.query(`
    SELECT COUNT(*)::int AS count
    FROM leads l
    WHERE ${filters.join(' AND ')}
  `, values);
  return result.rows[0].count;
}

export async function createEmailCampaign({
  name,
  subject,
  message,
  targetRole = '',
  targetVille = '',
  onlyNotNotified = true,
  scheduledAt = null,
  platformUrl,
  promoCode = '',
  senderName = 'LeDomen.com',
  createdBy,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const futureSchedule = scheduledAt && new Date(scheduledAt).getTime() > Date.now() + 30_000;
    const status = futureSchedule ? 'scheduled' : 'queued';
    const campaignResult = await client.query(`
      INSERT INTO email_campaigns (
        kind, name, subject, message, target_role, target_ville,
        only_not_notified, platform_url, promo_code, sender_name, status,
        scheduled_at, created_by
      )
      VALUES ('launch',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      RETURNING *
    `, [
      name,
      subject,
      message,
      targetRole || null,
      targetVille || null,
      Boolean(onlyNotNotified),
      platformUrl,
      promoCode || null,
      senderName || 'LeDomen.com',
      status,
      futureSchedule ? new Date(scheduledAt) : null,
      createdBy || null,
    ]);

    const campaign = campaignResult.rows[0];
    const filters = [
      `l.contact_type = 'email'`,
      `l.consent = TRUE`,
      `l.unsubscribed_at IS NULL`,
    ];
    const values = [campaign.id];

    if (targetRole) {
      values.push(targetRole);
      filters.push(`l.role = $${values.length}`);
    }
    if (targetVille) {
      values.push(targetVille);
      filters.push(`l.ville = $${values.length}`);
    }
    if (onlyNotNotified) {
      filters.push(`NOT EXISTS (
        SELECT 1
        FROM email_deliveries previous_delivery
        JOIN email_campaigns previous_campaign
          ON previous_campaign.id = previous_delivery.campaign_id
        WHERE previous_delivery.lead_id = l.id
          AND previous_delivery.status = 'sent'
          AND previous_campaign.kind = 'launch'
      )`);
    }

    await client.query(`
      INSERT INTO email_deliveries (campaign_id, lead_id, email)
      SELECT $1, l.id, l.contact_normalized
      FROM leads l
      WHERE ${filters.join(' AND ')}
      ON CONFLICT (campaign_id, lead_id) DO NOTHING
    `, values);

    const countResult = await client.query(`
      SELECT COUNT(*)::int AS total
      FROM email_deliveries
      WHERE campaign_id = $1
    `, [campaign.id]);
    const total = countResult.rows[0].total;

    const updated = await client.query(`
      UPDATE email_campaigns
      SET total_recipients = $2,
          status = CASE WHEN $2 = 0 THEN 'completed' ELSE status END,
          completed_at = CASE WHEN $2 = 0 THEN NOW() ELSE completed_at END
      WHERE id = $1
      RETURNING *
    `, [campaign.id, total]);

    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function listEmailCampaigns(limit = 50) {
  const result = await pool.query(`
    SELECT
      id, kind, name, subject, target_role, target_ville, only_not_notified,
      platform_url, promo_code, sender_name, status, scheduled_at, total_recipients,
      sent_count, failed_count, skipped_count, created_by, created_at,
      started_at, completed_at
    FROM email_campaigns
    ORDER BY created_at DESC
    LIMIT $1
  `, [limit]);
  return result.rows;
}

export async function activateScheduledCampaigns() {
  const result = await pool.query(`
    UPDATE email_campaigns
    SET status = 'queued'
    WHERE status = 'scheduled' AND scheduled_at <= NOW()
    RETURNING id
  `);
  return result.rows.map((row) => row.id);
}

export async function recoverStaleDeliveries() {
  const result = await pool.query(`
    UPDATE email_deliveries d
    SET status = 'queued',
        next_attempt_at = NOW(),
        last_error = COALESCE(last_error, 'Envoi récupéré après interruption du worker.')
    FROM email_campaigns c
    WHERE c.id = d.campaign_id
      AND d.status = 'sending'
      AND d.next_attempt_at <= NOW()
      AND c.status IN ('queued','sending')
    RETURNING d.id
  `);
  return result.rows.length;
}

export async function claimQueuedDeliveries(limit = 10) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const picked = await client.query(`
      WITH picked AS (
        SELECT d.id
        FROM email_deliveries d
        JOIN email_campaigns c ON c.id = d.campaign_id
        WHERE d.status = 'queued'
          AND d.next_attempt_at <= NOW()
          AND c.status IN ('queued','sending')
        ORDER BY d.id
        FOR UPDATE OF d SKIP LOCKED
        LIMIT $1
      )
      UPDATE email_deliveries d
      SET status = 'sending', attempts = d.attempts + 1,
          next_attempt_at = NOW() + INTERVAL '10 minutes'
      FROM picked
      WHERE d.id = picked.id
      RETURNING d.id, d.campaign_id
    `, [limit]);

    if (!picked.rows.length) {
      await client.query('COMMIT');
      return [];
    }

    const ids = picked.rows.map((row) => row.id);
    const campaignIds = [...new Set(picked.rows.map((row) => row.campaign_id))];
    await client.query(`
      UPDATE email_campaigns
      SET status = 'sending', started_at = COALESCE(started_at, NOW())
      WHERE id = ANY($1::bigint[]) AND status = 'queued'
    `, [campaignIds]);

    const details = await client.query(`
      SELECT
        d.id AS delivery_id, d.attempts, d.email,
        l.id AS lead_id, l.prenom, l.nom,
        c.id AS campaign_id, c.name AS campaign_name, c.subject,
        c.message, c.platform_url, c.promo_code, c.sender_name
      FROM email_deliveries d
      JOIN leads l ON l.id = d.lead_id
      JOIN email_campaigns c ON c.id = d.campaign_id
      WHERE d.id = ANY($1::bigint[])
      ORDER BY d.id
    `, [ids]);

    await client.query('COMMIT');
    return details.rows;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function refreshCampaignStatsWithClient(client, campaignId) {
  const counts = await client.query(`
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE status = 'sent')::int AS sent,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed,
      COUNT(*) FILTER (WHERE status = 'skipped')::int AS skipped,
      COUNT(*) FILTER (WHERE status IN ('queued','sending'))::int AS pending
    FROM email_deliveries
    WHERE campaign_id = $1
  `, [campaignId]);
  const stats = counts.rows[0];
  await client.query(`
    UPDATE email_campaigns
    SET total_recipients = $2,
        sent_count = $3,
        failed_count = $4,
        skipped_count = $5,
        status = CASE
          WHEN status = 'cancelled' THEN status
          WHEN $6 = 0 THEN 'completed'
          ELSE status
        END,
        completed_at = CASE
          WHEN status <> 'cancelled' AND $6 = 0 THEN COALESCE(completed_at, NOW())
          ELSE completed_at
        END
    WHERE id = $1
  `, [campaignId, stats.total, stats.sent, stats.failed, stats.skipped, stats.pending]);
  return stats;
}

export async function finishDelivery({
  deliveryId,
  sent,
  providerMessageId = null,
  errorMessage = '',
  maxAttempts = 3,
  retryDelayMinutes = 2,
}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query(`
      SELECT id, campaign_id, attempts
      FROM email_deliveries
      WHERE id = $1
      FOR UPDATE
    `, [deliveryId]);
    if (!current.rows.length) {
      await client.query('ROLLBACK');
      return null;
    }
    const delivery = current.rows[0];
    if (sent) {
      await client.query(`
        UPDATE email_deliveries
        SET status = 'sent', sent_at = NOW(), last_error = NULL,
            provider_message_id = $2
        WHERE id = $1
      `, [deliveryId, providerMessageId]);
    } else if (delivery.attempts >= maxAttempts) {
      await client.query(`
        UPDATE email_deliveries
        SET status = 'failed', last_error = $2
        WHERE id = $1
      `, [deliveryId, errorMessage.slice(0, 2000)]);
    } else {
      await client.query(`
        UPDATE email_deliveries
        SET status = 'queued', last_error = $2,
            next_attempt_at = NOW() + ($3::text || ' minutes')::interval
        WHERE id = $1
      `, [deliveryId, errorMessage.slice(0, 2000), retryDelayMinutes]);
    }
    await refreshCampaignStatsWithClient(client, delivery.campaign_id);
    await client.query('COMMIT');
    return delivery.campaign_id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function cancelEmailCampaign(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const campaign = await client.query(`
      UPDATE email_campaigns
      SET status = 'cancelled', completed_at = NOW()
      WHERE id = $1 AND status IN ('scheduled','queued')
      RETURNING *
    `, [id]);
    if (!campaign.rows.length) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query(`
      UPDATE email_deliveries
      SET status = 'skipped', last_error = 'Campagne annulée par un administrateur.'
      WHERE campaign_id = $1 AND status = 'queued'
    `, [id]);
    await refreshCampaignStatsWithClient(client, id);
    await client.query('COMMIT');
    return campaign.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function retryFailedDeliveries(id) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const campaign = await client.query(`
      SELECT id, status FROM email_campaigns WHERE id = $1 FOR UPDATE
    `, [id]);
    if (!campaign.rows.length || campaign.rows[0].status === 'cancelled') {
      await client.query('ROLLBACK');
      return null;
    }
    const retried = await client.query(`
      UPDATE email_deliveries
      SET status = 'queued', attempts = 0, next_attempt_at = NOW(), last_error = NULL
      WHERE campaign_id = $1 AND status = 'failed'
      RETURNING id
    `, [id]);
    if (retried.rows.length) {
      await client.query(`
        UPDATE email_campaigns
        SET status = 'queued', completed_at = NULL, failed_count = 0
        WHERE id = $1
      `, [id]);
    }
    await refreshCampaignStatsWithClient(client, id);
    await client.query('COMMIT');
    return { retried: retried.rows.length };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function unsubscribeLead({ leadId, email }) {
  const result = await pool.query(`
    UPDATE leads
    SET unsubscribed_at = COALESCE(unsubscribed_at, NOW())
    WHERE id = $1 AND contact_type = 'email' AND contact_normalized = $2
    RETURNING id, prenom, contact_normalized, unsubscribed_at
  `, [leadId, email]);
  return result.rows[0] || null;
}
