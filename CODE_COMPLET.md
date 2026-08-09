# LeDomen.com v1.5.0 — code complet
> Ne contient volontairement aucun fichier `.env` ni secret.

## `package.json`

```json
{
  "name": "ledomen-com",
  "version": "1.5.0",
  "private": true,
  "description": "LeDomen.com — landing page de pré-lancement, collecte de leads, administration et campagnes e-mail de lancement.",
  "type": "module",
  "scripts": {
    "start": "node src/server.js",
    "start:env": "node --env-file=.env src/server.js",
    "dev": "node --watch --env-file=.env src/server.js",
    "check": "node --check src/server.js && node --check src/db.js && node --check public/js/app.js && node --check public/js/admin.js && node scripts/smoke-static.mjs"
  },
  "engines": {
    "node": ">=20"
  },
  "dependencies": {
    "express": "5.2.1",
    "pg": "8.22.0",
    "nodemailer": "9.0.3"
  }
}
```

## `.env.example`

```dotenv
NODE_ENV=development
PORT=3000

# En développement: 0.0.0.0 permet l'accès local.
# En production derrière Nginx: utilisez 127.0.0.1.
BIND_HOST=0.0.0.0

# Origine canonique exacte utilisée pour les contrôles anti-CSRF/origine.
APP_ORIGIN=http://localhost:3000
# Facultatif: origines additionnelles séparées par des virgules.
EXTRA_ALLOWED_ORIGINS=

# Derrière un reverse proxy Nginx unique en production: 1.
# En développement direct: false.
TRUST_PROXY=false

# URL publique de la landing page. Utilisée dans les liens de désinscription des e-mails.
PUBLIC_BASE_URL=http://localhost:3000

# PostgreSQL
DATABASE_URL=postgres://ledomen:change-me@localhost:5432/ledomen
DATABASE_SSL=false

# Valeur initiale uniquement. Ensuite la date se modifie depuis l'interface admin.
LAUNCH_DATE=2026-09-15T00:00:00+01:00

# Administration
ADMIN_USER=admin@ledomen.com
# Production: mot de passe long et unique (14 caractères minimum imposés par le serveur).
ADMIN_PASSWORD=change-this-password
# Production: secret aléatoire d'au moins 32 caractères.
# Exemple PowerShell: [Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Maximum 256 }))
ADMIN_SESSION_SECRET=change-this-session-secret-with-a-long-random-value
# Secret séparé d'au moins 32 caractères pour signer les liens de désinscription.
UNSUBSCRIBE_SECRET=change-this-unsubscribe-secret-with-a-long-random-value
ADMIN_SESSION_HOURS=8

# Nombre maximum de premiers inscrits bénéficiant de l'offre de lancement.
EARLY_ACCESS_LIMIT=100

# E-mail / SMTP
# Tant que SMTP_HOST ou SMTP_FROM_EMAIL est vide, aucun e-mail réel ne partira.
SMTP_HOST=
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=
SMTP_PASS=
SMTP_FROM_EMAIL=
SMTP_FROM_NAME=LeDomen.com
SMTP_REPLY_TO=

# File d'envoi e-mail
EMAIL_BATCH_SIZE=10
EMAIL_MAX_ATTEMPTS=3
EMAIL_WORKER_INTERVAL_MS=15000
```

## `src/server.js`

```javascript
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import nodemailer from 'nodemailer';
import {
  activateScheduledCampaigns,
  cancelEmailCampaign,
  claimQueuedDeliveries,
  cleanupExpiredAdminSessions,
  cleanupSecurityRateLimits,
  clearSecurityRateLimit,
  consumeSecurityRateLimit,
  countEligibleEmailLeads,
  createAdminSession,
  createEmailCampaign,
  createLead,
  ensureSchema,
  exportAllLeads,
  finishDelivery,
  getAdminSessionByTokenHash,
  getAppSettings,
  getLeadCount,
  getLeadSummary,
  listAuditLogs,
  listEmailCampaigns,
  listLeads,
  pool,
  recoverStaleDeliveries,
  retryFailedDeliveries,
  revokeAdminSessionByTokenHash,
  touchAdminSession,
  unsubscribeLead,
  upsertAppSettings,
  writeAuditLog,
} from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../public');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === 'production';
const BIND_HOST = String(process.env.BIND_HOST || (isProduction ? '127.0.0.1' : '0.0.0.0')).trim();
const APP_ORIGIN = String(process.env.APP_ORIGIN || `http://localhost:${PORT}`).replace(/\/$/, '');
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || APP_ORIGIN).replace(/\/$/, '');
const EXTRA_ALLOWED_ORIGINS = String(process.env.EXTRA_ALLOWED_ORIGINS || '')
  .split(',')
  .map((value) => value.trim().replace(/\/$/, ''))
  .filter(Boolean);
const DEVELOPMENT_ORIGINS = isProduction
  ? []
  : [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`];
const ALLOWED_ORIGINS = new Set([
  APP_ORIGIN,
  ...DEVELOPMENT_ORIGINS,
  ...EXTRA_ALLOWED_ORIGINS,
]);
const TRUST_PROXY = String(process.env.TRUST_PROXY ?? (isProduction ? '1' : 'false')).trim();
const ADMIN_USER = process.env.ADMIN_USER || 'admin@ledomen.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_SESSION_SECRET = process.env.ADMIN_SESSION_SECRET || '';
const UNSUBSCRIBE_SECRET = process.env.UNSUBSCRIBE_SECRET || ADMIN_SESSION_SECRET;
const ADMIN_SESSION_HOURS = Math.max(1, Number(process.env.ADMIN_SESSION_HOURS || 8));
const EARLY_ACCESS_LIMIT = Math.max(1, Number(process.env.EARLY_ACCESS_LIMIT || 100));
const LAUNCH_DATE = process.env.LAUNCH_DATE || '2026-09-15T00:00:00+01:00';
const EMAIL_BATCH_SIZE = Math.min(50, Math.max(1, Number(process.env.EMAIL_BATCH_SIZE || 10)));
const EMAIL_MAX_ATTEMPTS = Math.min(10, Math.max(1, Number(process.env.EMAIL_MAX_ATTEMPTS || 3)));
const EMAIL_WORKER_INTERVAL_MS = Math.max(5_000, Number(process.env.EMAIL_WORKER_INTERVAL_MS || 15_000));
const SMTP_HOST = String(process.env.SMTP_HOST || '').trim();
const SMTP_PORT = Math.max(1, Number(process.env.SMTP_PORT || 587));
const SMTP_SECURE = String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || SMTP_PORT === 465;
const SMTP_USER = String(process.env.SMTP_USER || '').trim();
const SMTP_PASS = String(process.env.SMTP_PASS || '');
const SMTP_FROM_EMAIL = String(process.env.SMTP_FROM_EMAIL || '').trim();
const SMTP_FROM_NAME = String(process.env.SMTP_FROM_NAME || 'LeDomen.com').trim();
const mailConfigured = Boolean(SMTP_HOST && SMTP_FROM_EMAIL);
const mailTransporter = mailConfigured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      // Le contenu des campagnes ne doit jamais pouvoir charger
      // un fichier local ou une URL côté serveur via Nodemailer.
      disableFileAccess: true,
      disableUrlAccess: true,
    })
  : null;

const DEFAULT_SETTINGS = {
  site_status: 'prelaunch',
  platform_url: '',
  launch_date: LAUNCH_DATE,
  promo_code: '',
  sender_name: SMTP_FROM_NAME || 'LeDomen.com',
  email_subject: 'LeDomen.com est maintenant disponible',
  email_intro: 'Bonne nouvelle : la plateforme LeDomen.com est officiellement ouverte. Vous pouvez maintenant rechercher, comparer et réserver vos espaces et prestataires événementiels.',

  // Liens & contacts publics
  whatsapp_number: '',
  whatsapp_message: 'Bonjour, je souhaite des informations sur LeDomen.com.',
  show_whatsapp: 'true',
  facebook_url: '',
  show_facebook: 'true',
  instagram_url: '',
  show_instagram: 'true',
  linkedin_url: '',
  show_linkedin: 'true',
  contact_email: '',
  show_contact_email: 'true',
  contact_phone: '',
  show_contact_phone: 'true',
  contact_address: 'Libreville — Gabon',
  show_contact_address: 'true',

  // Libellés des boutons publics
  nav_prelaunch_text: 'Être informé',
  nav_prelaunch_action: 'signup',
  nav_prelaunch_value: '',
  nav_open_text: 'Accéder à la plateforme',
  nav_open_action: 'platform',
  nav_open_value: '',

  hero_prelaunch_text: 'Je veux être informé du lancement',
  hero_prelaunch_action: 'signup',
  hero_prelaunch_value: '',
  hero_open_text: 'Accéder à LeDomen',
  hero_open_action: 'platform',
  hero_open_value: '',

  concept_button_text: 'Découvrir le concept',
  concept_button_action: 'concept',
  concept_button_value: '',

  show_nav_cta: 'true',
  show_hero_primary: 'true',
  show_hero_secondary: 'true',
};

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL est obligatoire. Copiez .env.example vers .env et configurez PostgreSQL.');
  process.exit(1);
}
if (!ADMIN_PASSWORD || !ADMIN_SESSION_SECRET) {
  console.error('ADMIN_PASSWORD et ADMIN_SESSION_SECRET sont obligatoires.');
  process.exit(1);
}
if (
  isProduction &&
  (
    !ADMIN_PASSWORD ||
    ADMIN_PASSWORD.startsWith('change-') ||
    ADMIN_PASSWORD.length < 14 ||
    !ADMIN_SESSION_SECRET ||
    ADMIN_SESSION_SECRET.startsWith('change-') ||
    ADMIN_SESSION_SECRET.length < 32
  )
) {
  console.error('Sécurité: configurez un mot de passe admin robuste et ADMIN_SESSION_SECRET (32 caractères minimum) avant la production.');
  process.exit(1);
}
if (
  isProduction &&
  (
    !UNSUBSCRIBE_SECRET ||
    UNSUBSCRIBE_SECRET.startsWith('change-') ||
    UNSUBSCRIBE_SECRET.length < 32
  )
) {
  console.error('Sécurité: configurez UNSUBSCRIBE_SECRET (32 caractères minimum) avant la production.');
  process.exit(1);
}

app.disable('x-powered-by');

if (TRUST_PROXY === 'false' || TRUST_PROXY === '0' || TRUST_PROXY === '') {
  app.set('trust proxy', false);
} else if (/^\d+$/.test(TRUST_PROXY)) {
  app.set('trust proxy', Number(TRUST_PROXY));
} else {
  app.set('trust proxy', TRUST_PROXY);
}

app.use(express.json({ limit: '64kb' }));
app.use(express.urlencoded({ extended: false, limit: '64kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
  );

  if (req.path === '/admin.html' || req.path.startsWith('/api/admin/')) {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
  }

  if (isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }

  next();
});

function rateLimit({ windowMs, max }) {
  const buckets = new Map();
  let operations = 0;

  return (req, res, next) => {
    const key = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    operations += 1;
    if (operations % 500 === 0) {
      for (const [bucketKey, bucket] of buckets.entries()) {
        if (bucket.resetAt <= now) {
          buckets.delete(bucketKey);
        }
      }
    }

    const current = buckets.get(key);
    if (!current || current.resetAt <= now) {
      buckets.set(key, { count: 1, resetAt: now + windowMs });
      return next();
    }
    current.count += 1;
    if (current.count > max) {
      const retryAfter = Math.ceil((current.resetAt - now) / 1000);
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ ok: false, message: 'Trop de tentatives. Réessayez dans quelques minutes.' });
    }
    next();
  };
}

function sameOriginOnly(req, res, next) {
  const origin = String(req.get('origin') || '').trim().replace(/\/$/, '');
  const referer = String(req.get('referer') || '').trim();

  if (origin && ALLOWED_ORIGINS.has(origin)) {
    return next();
  }

  if (!origin && referer) {
    try {
      const refererOrigin = new URL(referer).origin;
      if (ALLOWED_ORIGINS.has(refererOrigin)) {
        return next();
      }
    } catch {
      // Referer invalide: refus ci-dessous.
    }
  }

  // En développement uniquement, les commandes CLI locales peuvent ne pas
  // envoyer Origin/Referer. En production, l'absence des deux est refusée.
  if (!isProduction && !origin && !referer) {
    return next();
  }

  return res.status(403).json({
    ok: false,
    message: 'Origine non autorisée.',
  });
}

function cleanText(value, max = 80) {
  return String(value ?? '').trim().replace(/\s+/g, ' ').slice(0, max);
}

function cleanMultiline(value, max = 2000) {
  return String(value ?? '').trim().replace(/\r\n/g, '\n').slice(0, max);
}

function normalizeContact(raw) {
  const value = String(raw ?? '').trim();
  const email = value.toLowerCase();
  const emailOk = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(email);
  if (emailOk) return { type: 'email', raw: value, normalized: email };
  const phone = value.replace(/[^\d+]/g, '').replace(/(?!^)\+/g, '');
  const digits = phone.replace(/\D/g, '');
  if (digits.length >= 7 && digits.length <= 16) {
    return { type: 'whatsapp', raw: value, normalized: phone };
  }
  return null;
}

function normalizeEmail(raw) {
  const contact = normalizeContact(raw);
  return contact?.type === 'email' ? contact.normalized : null;
}

function normalizeHttpUrl(raw, { allowEmpty = false } = {}) {
  const value = String(raw ?? '').trim();
  if (!value && allowEmpty) return '';
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

function normalizeBooleanSetting(value, fallback = true) {
  if (value === undefined || value === null || value === '') return fallback ? 'true' : 'false';
  const normalized = String(value).trim().toLowerCase();
  return ['1', 'true', 'on', 'yes', 'oui'].includes(normalized) ? 'true' : 'false';
}

function normalizeWhatsappNumber(raw, { allowEmpty = true } = {}) {
  const value = String(raw ?? '').trim();
  if (!value && allowEmpty) return '';
  const digits = value.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

function normalizeOptionalEmail(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return '';
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(value) ? value : null;
}

function buildWhatsappUrl(number, message = '') {
  const digits = String(number || '').replace(/\D/g, '');
  if (!digits) return '';
  const url = new URL(`https://wa.me/${digits}`);
  const text = String(message || '').trim();
  if (text) url.searchParams.set('text', text);
  return url.toString();
}

const PUBLIC_ACTIONS = new Set([
  'signup',
  'concept',
  'platform',
  'whatsapp',
  'external',
  'email',
  'phone',
  'hidden',
]);

function normalizePhone(raw, { allowEmpty = true } = {}) {
  const value = String(raw ?? '').trim();
  if (!value && allowEmpty) return '';

  const normalized = value
    .replace(/[^\d+]/g, '')
    .replace(/(?!^)\+/g, '');

  const digits = normalized.replace(/\D/g, '');
  if (digits.length < 7 || digits.length > 16) return null;
  return normalized;
}

function sanitizePublicAction(actionRaw, valueRaw, fieldLabel) {
  const action = cleanText(actionRaw, 24).toLowerCase();
  const value = cleanText(valueRaw, 500);

  if (!PUBLIC_ACTIONS.has(action)) {
    return { error: `${fieldLabel} : action invalide.` };
  }

  if (['signup', 'concept', 'platform', 'whatsapp', 'hidden'].includes(action)) {
    return { action, value: '' };
  }

  if (action === 'external') {
    const url = normalizeHttpUrl(value, { allowEmpty: false });
    if (!url) {
      return { error: `${fieldLabel} : URL externe invalide.` };
    }
    return { action, value: url };
  }

  if (action === 'email') {
    const email = normalizeOptionalEmail(value);
    if (!email) {
      return { error: `${fieldLabel} : adresse e-mail invalide.` };
    }
    return { action, value: email };
  }

  if (action === 'phone') {
    const phone = normalizePhone(value, { allowEmpty: false });
    if (!phone) {
      return { error: `${fieldLabel} : numéro de téléphone invalide.` };
    }
    return { action, value: phone };
  }

  return { error: `${fieldLabel} : action invalide.` };
}

function resolvePublicAction(action, value, settings) {
  switch (action) {
    case 'signup':
      return { type: 'scroll', target: 'inscription' };

    case 'concept':
      return { type: 'scroll', target: 'concept' };

    case 'platform':
      return settings.platform_url
        ? { type: 'url', href: settings.platform_url }
        : { type: 'hidden' };

    case 'whatsapp': {
      const href = buildWhatsappUrl(
        settings.whatsapp_number,
        settings.whatsapp_message
      );
      return href
        ? { type: 'url', href }
        : { type: 'hidden' };
    }

    case 'external': {
      const href = normalizeHttpUrl(value, { allowEmpty: true });
      return href
        ? { type: 'url', href }
        : { type: 'hidden' };
    }

    case 'email': {
      const email = normalizeOptionalEmail(value);
      return email
        ? { type: 'url', href: `mailto:${email}` }
        : { type: 'hidden' };
    }

    case 'phone': {
      const phone = normalizePhone(value, { allowEmpty: true });
      return phone
        ? { type: 'url', href: `tel:${phone}` }
        : { type: 'hidden' };
    }

    case 'hidden':
    default:
      return { type: 'hidden' };
  }
}

function validateLead(body) {
  const prenom = cleanText(body.prenom, 80);
  const nom = cleanText(body.nom, 80);
  const ville = cleanText(body.ville, 80);
  const role = cleanText(body.role, 32).toLowerCase();
  const consent = body.consent === true || body.consent === 'true' || body.consent === 'on' || body.consent === '1';
  const website = cleanText(body.website, 120);
  const contact = normalizeContact(body.contact);

  if (website) return { spam: true };
  if (prenom.length < 2) return { error: 'Veuillez saisir un prénom valide.' };
  if (nom.length < 2) return { error: 'Veuillez saisir un nom valide.' };
  if (!contact) return { error: 'Saisissez une adresse e-mail ou un numéro WhatsApp valide.' };
  if (!['Libreville', 'Port-Gentil', 'Franceville', 'Autre'].includes(ville)) {
    return { error: 'Veuillez sélectionner une ville valide.' };
  }
  if (!['organisateur', 'entreprise', 'prestataire'].includes(role)) {
    return { error: 'Veuillez sélectionner un profil valide.' };
  }
  if (!consent) return { error: 'Votre consentement est requis pour l’inscription.' };

  return {
    lead: {
      prenom,
      nom,
      contactRaw: contact.raw,
      contactNormalized: contact.normalized,
      contactType: contact.type,
      ville,
      role,
    },
  };
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function safeEqualBuffer(a, b) {
  const aa = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return aa.length === bb.length && crypto.timingSafeEqual(aa, bb);
}

function safeEqualString(a, b) {
  const aa = crypto.createHash('sha256').update(String(a)).digest();
  const bb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(aa, bb);
}

function sha256(value) {
  return crypto
    .createHash('sha256')
    .update(String(value))
    .digest('hex');
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function sessionCookieName() {
  return isProduction
    ? '__Host-ledomen_admin'
    : 'ledomen_admin';
}

function sessionCookieValue(token) {
  const parts = [
    `${sessionCookieName()}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];

  if (isProduction) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function expiredSessionCookieValue() {
  const parts = [
    `${sessionCookieName()}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];

  if (isProduction) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function requestFingerprint(req) {
  return sha256(String(req.get('user-agent') || '').slice(0, 500));
}

function requestIpHash(req) {
  const ip = String(req.ip || req.socket.remoteAddress || 'unknown');
  return crypto
    .createHmac('sha256', ADMIN_SESSION_SECRET || 'development')
    .update(ip)
    .digest('hex');
}

function csrfTokenForSessionHash(tokenHash) {
  return crypto
    .createHmac('sha256', ADMIN_SESSION_SECRET)
    .update(`csrf:${tokenHash}`)
    .digest('base64url');
}

function signUnsubscribe(leadId, email) {
  const body = b64url(JSON.stringify({ v: 1, leadId: Number(leadId), email: String(email).toLowerCase() }));
  const sig = crypto.createHmac('sha256', UNSUBSCRIBE_SECRET).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyUnsubscribe(token) {
  if (!token || !UNSUBSCRIBE_SECRET) return null;
  const [body, sig] = String(token).split('.');
  if (!body || !sig) return null;
  const expected = crypto.createHmac('sha256', UNSUBSCRIBE_SECRET).update(body).digest('base64url');
  if (!safeEqualBuffer(sig, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (payload.v !== 1 || !Number.isInteger(payload.leadId) || !normalizeEmail(payload.email)) return null;
    return payload;
  } catch {
    return null;
  }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx > -1) out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

async function requireAdmin(req, res, next) {
  try {
    const rawToken = parseCookies(req)[sessionCookieName()];

    if (!rawToken || !/^[A-Za-z0-9_-]{40,180}$/.test(rawToken)) {
      return res.status(401).json({
        ok: false,
        message: 'Authentification requise.',
      });
    }

    const tokenHash = sha256(rawToken);
    const session = await getAdminSessionByTokenHash(tokenHash);

    if (
      !session ||
      session.admin_user !== ADMIN_USER ||
      (
        session.user_agent_hash &&
        session.user_agent_hash !== requestFingerprint(req)
      )
    ) {
      res.setHeader('Set-Cookie', expiredSessionCookieValue());
      return res.status(401).json({
        ok: false,
        message: 'Session expirée ou invalide.',
      });
    }

    req.admin = {
      user: session.admin_user,
      sessionId: session.id,
      tokenHash,
      csrfHash: session.csrf_hash,
      expiresAt: session.expires_at,
    };

    // Mise à jour légère de l'activité de session.
    const lastSeen = new Date(session.last_seen_at).getTime();
    if (!Number.isNaN(lastSeen) && Date.now() - lastSeen > 5 * 60 * 1000) {
      void touchAdminSession(session.id).catch((error) => {
        console.error('Session touch:', error?.message || error);
      });
    }

    next();
  } catch (error) {
    next(error);
  }
}

function requireCsrf(req, res, next) {
  const token = String(req.get('x-csrf-token') || '').trim();

  if (!token || !req.admin?.tokenHash) {
    return res.status(403).json({
      ok: false,
      message: 'Jeton de sécurité manquant. Rechargez l’administration.',
    });
  }

  const expected = csrfTokenForSessionHash(req.admin.tokenHash);

  if (
    !safeEqualString(token, expected) ||
    (
      req.admin.csrfHash &&
      !safeEqualString(sha256(token), req.admin.csrfHash)
    )
  ) {
    return res.status(403).json({
      ok: false,
      message: 'Jeton de sécurité invalide. Rechargez l’administration.',
    });
  }

  next();
}

async function audit(req, {
  action,
  target = null,
  success = true,
  details = {},
  adminUser = req.admin?.user || null,
} = {}) {
  try {
    await writeAuditLog({
      adminUser,
      action,
      target,
      success,
      ipHash: requestIpHash(req),
      userAgent: cleanText(req.get('user-agent'), 500),
      details,
    });
  } catch (error) {
    // Une panne d'audit ne doit pas rendre l'application indisponible.
    console.error('Audit log:', error?.message || error);
  }
}

function csvEscape(value) {
  let text = value == null ? '' : String(value);

  // Protection contre l'injection de formules dans Excel/LibreOffice.
  if (/^[=+\-@\t\r]/.test(text)) {
    text = `'${text}`;
  }

  return `"${text.replaceAll('"', '""')}"`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

async function getResolvedSettings() {
  const saved = await getAppSettings();
  return { ...DEFAULT_SETTINGS, ...saved };
}

function sanitizeSettings(body, { requirePlatformUrl = false } = {}) {
  const siteStatus = cleanText(body.site_status ?? body.siteStatus, 24).toLowerCase() || 'prelaunch';
  if (!['prelaunch', 'open'].includes(siteStatus)) {
    return { error: 'Statut de la plateforme invalide.' };
  }

  const rawPlatformUrl = body.platform_url ?? body.platformUrl ?? '';
  const platformUrl = normalizeHttpUrl(rawPlatformUrl, { allowEmpty: !requirePlatformUrl && siteStatus !== 'open' });
  if (platformUrl === null || (requirePlatformUrl && !platformUrl)) {
    return { error: 'Renseignez une URL de plateforme valide en http:// ou https://.' };
  }
  if (siteStatus === 'open' && !platformUrl) {
    return { error: 'L’URL de la plateforme est obligatoire lorsque le statut est « Ouvert ».' };
  }

  const launchDateRaw = String(body.launch_date ?? body.launchDate ?? LAUNCH_DATE).trim();
  const launchDate = new Date(launchDateRaw);
  if (Number.isNaN(launchDate.getTime())) {
    return { error: 'Date de lancement invalide.' };
  }

  const subject = cleanText(body.email_subject ?? body.emailSubject ?? DEFAULT_SETTINGS.email_subject, 180);
  const intro = cleanMultiline(body.email_intro ?? body.emailIntro ?? DEFAULT_SETTINGS.email_intro, 1800);
  const senderName = cleanText(body.sender_name ?? body.senderName ?? DEFAULT_SETTINGS.sender_name, 100);
  if (subject.length < 4) return { error: 'L’objet de l’e-mail est trop court.' };
  if (intro.length < 10) return { error: 'Le message d’introduction est trop court.' };
  if (senderName.length < 2) return { error: 'Le nom d’expéditeur est invalide.' };

  const whatsappNumber = normalizeWhatsappNumber(body.whatsapp_number ?? DEFAULT_SETTINGS.whatsapp_number);
  if (whatsappNumber === null) return { error: 'Le numéro WhatsApp est invalide.' };

  const facebookUrl = normalizeHttpUrl(body.facebook_url ?? DEFAULT_SETTINGS.facebook_url, { allowEmpty: true });
  const instagramUrl = normalizeHttpUrl(body.instagram_url ?? DEFAULT_SETTINGS.instagram_url, { allowEmpty: true });
  const linkedinUrl = normalizeHttpUrl(body.linkedin_url ?? DEFAULT_SETTINGS.linkedin_url, { allowEmpty: true });
  if (facebookUrl === null) return { error: 'Le lien Facebook est invalide.' };
  if (instagramUrl === null) return { error: 'Le lien Instagram est invalide.' };
  if (linkedinUrl === null) return { error: 'Le lien LinkedIn est invalide.' };

  const contactEmail = normalizeOptionalEmail(body.contact_email ?? DEFAULT_SETTINGS.contact_email);
  if (contactEmail === null) return { error: 'L’adresse e-mail de contact est invalide.' };

  const contactPhone = normalizePhone(
    body.contact_phone ?? DEFAULT_SETTINGS.contact_phone,
    { allowEmpty: true }
  );
  if (contactPhone === null) return { error: 'Le numéro de téléphone public est invalide.' };

  const navPrelaunchAction = sanitizePublicAction(
    body.nav_prelaunch_action ?? DEFAULT_SETTINGS.nav_prelaunch_action,
    body.nav_prelaunch_value ?? DEFAULT_SETTINGS.nav_prelaunch_value,
    'Bouton navigation avant lancement'
  );
  if (navPrelaunchAction.error) return navPrelaunchAction;

  const navOpenAction = sanitizePublicAction(
    body.nav_open_action ?? DEFAULT_SETTINGS.nav_open_action,
    body.nav_open_value ?? DEFAULT_SETTINGS.nav_open_value,
    'Bouton navigation après ouverture'
  );
  if (navOpenAction.error) return navOpenAction;

  const heroPrelaunchAction = sanitizePublicAction(
    body.hero_prelaunch_action ?? DEFAULT_SETTINGS.hero_prelaunch_action,
    body.hero_prelaunch_value ?? DEFAULT_SETTINGS.hero_prelaunch_value,
    'Bouton principal avant lancement'
  );
  if (heroPrelaunchAction.error) return heroPrelaunchAction;

  const heroOpenAction = sanitizePublicAction(
    body.hero_open_action ?? DEFAULT_SETTINGS.hero_open_action,
    body.hero_open_value ?? DEFAULT_SETTINGS.hero_open_value,
    'Bouton principal après ouverture'
  );
  if (heroOpenAction.error) return heroOpenAction;

  const conceptButtonAction = sanitizePublicAction(
    body.concept_button_action ?? DEFAULT_SETTINGS.concept_button_action,
    body.concept_button_value ?? DEFAULT_SETTINGS.concept_button_value,
    'Bouton secondaire'
  );
  if (conceptButtonAction.error) return conceptButtonAction;

  return {
    settings: {
      site_status: siteStatus,
      platform_url: platformUrl || '',
      launch_date: launchDate.toISOString(),
      promo_code: cleanText(body.promo_code ?? body.promoCode, 80),
      sender_name: senderName,
      email_subject: subject,
      email_intro: intro,

      whatsapp_number: whatsappNumber || '',
      whatsapp_message: cleanText(body.whatsapp_message ?? DEFAULT_SETTINGS.whatsapp_message, 300),
      show_whatsapp: normalizeBooleanSetting(body.show_whatsapp ?? DEFAULT_SETTINGS.show_whatsapp),
      facebook_url: facebookUrl || '',
      show_facebook: normalizeBooleanSetting(body.show_facebook ?? DEFAULT_SETTINGS.show_facebook),
      instagram_url: instagramUrl || '',
      show_instagram: normalizeBooleanSetting(body.show_instagram ?? DEFAULT_SETTINGS.show_instagram),
      linkedin_url: linkedinUrl || '',
      show_linkedin: normalizeBooleanSetting(body.show_linkedin ?? DEFAULT_SETTINGS.show_linkedin),
      contact_email: contactEmail || '',
      show_contact_email: normalizeBooleanSetting(body.show_contact_email ?? DEFAULT_SETTINGS.show_contact_email),
      contact_phone: contactPhone || '',
      show_contact_phone: normalizeBooleanSetting(body.show_contact_phone ?? DEFAULT_SETTINGS.show_contact_phone),
      contact_address: cleanText(body.contact_address ?? DEFAULT_SETTINGS.contact_address, 200),
      show_contact_address: normalizeBooleanSetting(body.show_contact_address ?? DEFAULT_SETTINGS.show_contact_address),

      nav_prelaunch_text: cleanText(body.nav_prelaunch_text ?? DEFAULT_SETTINGS.nav_prelaunch_text, 80),
      nav_prelaunch_action: navPrelaunchAction.action,
      nav_prelaunch_value: navPrelaunchAction.value,
      nav_open_text: cleanText(body.nav_open_text ?? DEFAULT_SETTINGS.nav_open_text, 80),
      nav_open_action: navOpenAction.action,
      nav_open_value: navOpenAction.value,

      hero_prelaunch_text: cleanText(body.hero_prelaunch_text ?? DEFAULT_SETTINGS.hero_prelaunch_text, 100),
      hero_prelaunch_action: heroPrelaunchAction.action,
      hero_prelaunch_value: heroPrelaunchAction.value,
      hero_open_text: cleanText(body.hero_open_text ?? DEFAULT_SETTINGS.hero_open_text, 100),
      hero_open_action: heroOpenAction.action,
      hero_open_value: heroOpenAction.value,

      concept_button_text: cleanText(body.concept_button_text ?? DEFAULT_SETTINGS.concept_button_text, 100),
      concept_button_action: conceptButtonAction.action,
      concept_button_value: conceptButtonAction.value,

      show_nav_cta: normalizeBooleanSetting(body.show_nav_cta ?? DEFAULT_SETTINGS.show_nav_cta),
      show_hero_primary: normalizeBooleanSetting(body.show_hero_primary ?? DEFAULT_SETTINGS.show_hero_primary),
      show_hero_secondary: normalizeBooleanSetting(body.show_hero_secondary ?? DEFAULT_SETTINGS.show_hero_secondary),
    },
  };
}

function renderLaunchEmail({ firstName, subject, message, platformUrl, promoCode, unsubscribeUrl = '', isTest = false }) {
  const safeName = escapeHtml(firstName || '');
  const safeSubject = escapeHtml(subject);
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br>');
  const safeUrl = escapeHtml(platformUrl);
  const safePromo = escapeHtml(promoCode || '');
  const greeting = safeName ? `Bonjour ${safeName},` : 'Bonjour,';
  const promoBlock = safePromo
    ? `<div style="margin:24px 0;padding:16px 18px;border:1px solid #D4AF37;border-radius:10px;background:#F7F4EC;color:#0A192F"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#7A641D">Votre avantage de lancement</div><div style="margin-top:5px;font-size:22px;font-weight:800;letter-spacing:.06em">${safePromo}</div></div>`
    : '';
  const unsubscribeBlock = isTest
    ? '<p style="margin:28px 0 0;font-size:12px;color:#667085">E-mail de test : le lien de désinscription n’est pas actif dans cet aperçu.</p>'
    : `<p style="margin:28px 0 0;font-size:12px;color:#667085">Vous recevez ce message car vous avez demandé à être informé du lancement de LeDomen.com. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#667085">Se désinscrire</a>.</p>`;

  const html = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:#F4F6F9;font-family:Arial,Helvetica,sans-serif;color:#162033">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F4F6F9;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #E3E7EE">
<tr><td style="background:#0A192F;padding:28px 32px;color:#FFFFFF"><div style="font-size:28px;font-weight:800">LeDomen<span style="color:#D4AF37">.com</span></div><div style="margin-top:5px;color:#CFE0FF;font-size:13px">Enjoy your Events</div></td></tr>
<tr><td style="padding:34px 32px">
<div style="font-size:15px;margin-bottom:18px">${greeting}</div>
<h1 style="font-size:28px;line-height:1.2;margin:0 0 18px;color:#0A192F">${safeSubject}</h1>
<p style="font-size:16px;line-height:1.7;margin:0 0 24px;color:#475467">${safeMessage}</p>
<a href="${safeUrl}" style="display:inline-block;background:#D4AF37;color:#0A192F;text-decoration:none;font-weight:800;padding:14px 22px;border-radius:9px">Accéder à LeDomen</a>
${promoBlock}
<p style="margin:28px 0 0;font-size:14px;line-height:1.6;color:#667085">À bientôt,<br><strong style="color:#0A192F">L’équipe LeDomen</strong></p>
${unsubscribeBlock}
</td></tr></table>
</td></tr></table></body></html>`;

  const text = `${greeting}\n\n${subject}\n\n${message}\n\nAccéder à LeDomen : ${platformUrl}${promoCode ? `\n\nVotre avantage de lancement : ${promoCode}` : ''}\n\nL’équipe LeDomen${isTest ? '\n\nE-mail de test.' : `\n\nSe désinscrire : ${unsubscribeUrl}`}`;
  return { html, text };
}

async function sendLaunchMail({ to, firstName, subject, message, platformUrl, promoCode, unsubscribeUrl, isTest = false, senderName }) {
  if (!mailTransporter) throw new Error('SMTP non configuré.');
  const rendered = renderLaunchEmail({ firstName, subject, message, platformUrl, promoCode, unsubscribeUrl, isTest });
  return mailTransporter.sendMail({
    from: { name: senderName || SMTP_FROM_NAME || 'LeDomen.com', address: SMTP_FROM_EMAIL },
    to,
    subject: isTest ? `[TEST] ${subject}` : subject,
    html: rendered.html,
    text: rendered.text,
    replyTo: process.env.SMTP_REPLY_TO || undefined,
  });
}

function unsubscribePage({ token = '', success = false, invalid = false }) {
  const safeToken = escapeHtml(token);
  let content;
  if (success) {
    content = '<h1>Désinscription confirmée</h1><p>Vous ne recevrez plus d’e-mails de lancement de LeDomen.com à cette adresse.</p><a class="btn" href="/">Retour à LeDomen.com</a>';
  } else if (invalid) {
    content = '<h1>Lien invalide</h1><p>Ce lien de désinscription est invalide ou ne correspond plus à une inscription active.</p><a class="btn" href="/">Retour à LeDomen.com</a>';
  } else {
    content = `<h1>Se désinscrire</h1><p>Confirmez que vous ne souhaitez plus recevoir les e-mails concernant le lancement de LeDomen.com.</p><form method="post" action="/api/unsubscribe"><input type="hidden" name="token" value="${safeToken}"><button class="btn" type="submit">Confirmer la désinscription</button></form>`;
  }
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Désinscription | LeDomen.com</title><style>body{margin:0;background:#0A192F;font-family:Arial,sans-serif;color:#fff}.box{max-width:600px;margin:12vh auto;padding:34px;background:#fff;color:#162033;border-radius:18px}.brand{font-weight:800;font-size:24px;color:#0A192F}.brand span{color:#D4AF37}.btn{display:inline-block;margin-top:18px;border:0;background:#D4AF37;color:#0A192F;padding:13px 18px;border-radius:9px;font-weight:800;text-decoration:none;cursor:pointer}p{line-height:1.6;color:#475467}</style></head><body><main class="box"><div class="brand">LeDomen<span>.com</span></div>${content}</main></body></html>`;
}

let workerBusy = false;
async function runEmailWorker() {
  if (workerBusy || !mailTransporter) return;
  workerBusy = true;
  try {
    await activateScheduledCampaigns();
    await recoverStaleDeliveries();
    const jobs = await claimQueuedDeliveries(EMAIL_BATCH_SIZE);
    for (const job of jobs) {
      const token = signUnsubscribe(job.lead_id, job.email);
      const unsubscribeUrl = `${PUBLIC_BASE_URL}/unsubscribe?token=${encodeURIComponent(token)}`;
      try {
        const info = await sendLaunchMail({
          to: job.email,
          firstName: job.prenom,
          subject: job.subject,
          message: job.message,
          platformUrl: job.platform_url,
          promoCode: job.promo_code || '',
          unsubscribeUrl,
          senderName: job.sender_name || SMTP_FROM_NAME || 'LeDomen.com',
        });
        await finishDelivery({
          deliveryId: job.delivery_id,
          sent: true,
          providerMessageId: info?.messageId || null,
          maxAttempts: EMAIL_MAX_ATTEMPTS,
        });
      } catch (error) {
        const retryDelayMinutes = Math.min(60, 2 ** Math.max(1, Number(job.attempts || 1)));
        console.error(`E-mail ${job.delivery_id} vers ${job.email}:`, error?.message || error);
        await finishDelivery({
          deliveryId: job.delivery_id,
          sent: false,
          errorMessage: error?.message || 'Erreur SMTP',
          maxAttempts: EMAIL_MAX_ATTEMPTS,
          retryDelayMinutes,
        });
      }
    }
  } catch (error) {
    console.error('Worker e-mail:', error);
  } finally {
    workerBusy = false;
  }
}

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

app.get('/api/config', async (_req, res) => {
  const settings = await getResolvedSettings();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    launchDate: settings.launch_date,
    earlyAccessLimit: EARLY_ACCESS_LIMIT,
    siteStatus: settings.site_status,
    platformUrl: settings.platform_url,

    buttons: {
      nav: {
        visible: settings.show_nav_cta === 'true',
        prelaunch: {
          label: settings.nav_prelaunch_text,
          behavior: resolvePublicAction(
            settings.nav_prelaunch_action,
            settings.nav_prelaunch_value,
            settings
          ),
        },
        open: {
          label: settings.nav_open_text,
          behavior: resolvePublicAction(
            settings.nav_open_action,
            settings.nav_open_value,
            settings
          ),
        },
      },

      heroPrimary: {
        visible: settings.show_hero_primary === 'true',
        prelaunch: {
          label: settings.hero_prelaunch_text,
          behavior: resolvePublicAction(
            settings.hero_prelaunch_action,
            settings.hero_prelaunch_value,
            settings
          ),
        },
        open: {
          label: settings.hero_open_text,
          behavior: resolvePublicAction(
            settings.hero_open_action,
            settings.hero_open_value,
            settings
          ),
        },
      },

      heroSecondary: {
        visible: settings.show_hero_secondary === 'true',
        label: settings.concept_button_text,
        behavior: resolvePublicAction(
          settings.concept_button_action,
          settings.concept_button_value,
          settings
        ),
      },
    },

    links: {
      whatsappUrl: buildWhatsappUrl(settings.whatsapp_number, settings.whatsapp_message),
      showWhatsapp: settings.show_whatsapp === 'true',
      facebookUrl: normalizeHttpUrl(settings.facebook_url, { allowEmpty: true }) || '',
      showFacebook: settings.show_facebook === 'true',
      instagramUrl: normalizeHttpUrl(settings.instagram_url, { allowEmpty: true }) || '',
      showInstagram: settings.show_instagram === 'true',
      linkedinUrl: normalizeHttpUrl(settings.linkedin_url, { allowEmpty: true }) || '',
      showLinkedin: settings.show_linkedin === 'true',
      contactEmail: normalizeOptionalEmail(settings.contact_email) || '',
      showContactEmail: settings.show_contact_email === 'true',
      contactPhone: normalizePhone(settings.contact_phone, { allowEmpty: true }) || '',
      showContactPhone: settings.show_contact_phone === 'true',
      contactAddress: settings.contact_address,
      showContactAddress: settings.show_contact_address === 'true',
    },
  });
});

app.get('/api/public/stats', async (_req, res) => {
  const count = await getLeadCount();
  res.setHeader('Cache-Control', 'no-store');
  res.json({
    registered: count,
    earlyAccessLimit: EARLY_ACCESS_LIMIT,
    earlyAccessRemaining: Math.max(0, EARLY_ACCESS_LIMIT - count),
  });
});

app.post('/api/leads', sameOriginOnly, rateLimit({ windowMs: 10 * 60 * 1000, max: 8 }), async (req, res) => {
  const validation = validateLead(req.body);
  if (validation.spam) return res.status(200).json({ ok: true, message: 'Inscription enregistrée.' });
  if (validation.error) return res.status(400).json({ ok: false, message: validation.error });

  try {
    const lead = await createLead({
      ...validation.lead,
      source: cleanText(req.body.source || 'landing-page', 80),
      userAgent: cleanText(req.get('user-agent'), 500),
    });
    return res.status(201).json({
      ok: true,
      message: 'Votre inscription est bien enregistrée.',
      lead: { id: lead.id, prenom: lead.prenom, createdAt: lead.created_at },
    });
  } catch (err) {
    if (err?.code === '23505') {
      return res.status(200).json({ ok: true, duplicate: true, message: 'Vous êtes déjà inscrit(e). Nous vous préviendrons au lancement.' });
    }
    console.error('POST /api/leads', err);
    return res.status(500).json({ ok: false, message: 'Erreur serveur. Merci de réessayer plus tard.' });
  }
});

app.get('/unsubscribe', (req, res) => {
  const token = String(req.query.token || '');
  const payload = verifyUnsubscribe(token);
  res.setHeader('Cache-Control', 'no-store');
  res.status(payload ? 200 : 400).send(unsubscribePage({ token, invalid: !payload }));
});

app.post('/api/unsubscribe', rateLimit({ windowMs: 10 * 60 * 1000, max: 20 }), async (req, res) => {
  const token = String(req.body.token || '');
  const payload = verifyUnsubscribe(token);
  if (!payload) return res.status(400).send(unsubscribePage({ invalid: true }));
  const lead = await unsubscribeLead({ leadId: payload.leadId, email: payload.email });
  if (!lead) return res.status(400).send(unsubscribePage({ invalid: true }));
  return res.status(200).send(unsubscribePage({ success: true }));
});

app.post('/api/admin/login', sameOriginOnly, async (req, res, next) => {
  try {
    const user = cleanText(req.body.user, 180).toLowerCase();
    const password = String(req.body.password || '');
    const ipKey = `admin-login-ip:${requestIpHash(req)}`;
    const userBucket = safeEqualString(user, ADMIN_USER.toLowerCase())
      ? ADMIN_USER.toLowerCase()
      : 'other';
    const userKey = `admin-login-user:${sha256(userBucket)}`;

    const [ipLimit, userLimit] = await Promise.all([
      consumeSecurityRateLimit({
        key: ipKey,
        windowSeconds: 15 * 60,
        max: 10,
      }),
      consumeSecurityRateLimit({
        key: userKey,
        windowSeconds: 15 * 60,
        max: 20,
      }),
    ]);

    if (!ipLimit.allowed || !userLimit.allowed) {
      const retryAfter = Math.max(
        ipLimit.retryAfterSeconds || 1,
        userLimit.retryAfterSeconds || 1
      );

      res.setHeader('Retry-After', String(retryAfter));

      await audit(req, {
        action: 'admin.login.blocked',
        target: user || null,
        success: false,
        adminUser: user || null,
      });

      return res.status(429).json({
        ok: false,
        message: 'Trop de tentatives de connexion. Réessayez plus tard.',
      });
    }

    const validUser = safeEqualString(
      user,
      ADMIN_USER.toLowerCase()
    );

    const validPassword = Boolean(ADMIN_PASSWORD) &&
      safeEqualString(password, ADMIN_PASSWORD);

    if (!validUser || !validPassword) {
      await audit(req, {
        action: 'admin.login.failed',
        target: user || null,
        success: false,
        adminUser: user || null,
      });

      return res.status(401).json({
        ok: false,
        message: 'Identifiants incorrects.',
      });
    }

    await Promise.all([
      clearSecurityRateLimit(ipKey),
      clearSecurityRateLimit(userKey),
      cleanupExpiredAdminSessions(),
    ]);

    const rawSessionToken = randomToken(32);
    const tokenHash = sha256(rawSessionToken);
    const csrfToken = csrfTokenForSessionHash(tokenHash);
    const expiresAt = new Date(
      Date.now() + ADMIN_SESSION_HOURS * 60 * 60 * 1000
    );

    await createAdminSession({
      tokenHash,
      csrfHash: sha256(csrfToken),
      adminUser: ADMIN_USER,
      userAgentHash: requestFingerprint(req),
      expiresAt,
    });

    res.setHeader(
      'Set-Cookie',
      sessionCookieValue(rawSessionToken)
    );

    res.setHeader('Cache-Control', 'no-store');

    await audit(req, {
      action: 'admin.login.success',
      target: ADMIN_USER,
      success: true,
      adminUser: ADMIN_USER,
    });

    return res.json({
      ok: true,
      user: ADMIN_USER,
      csrfToken,
      expiresAt: expiresAt.toISOString(),
    });
  } catch (error) {
    next(error);
  }
});

app.post(
  '/api/admin/logout',
  requireAdmin,
  sameOriginOnly,
  requireCsrf,
  async (req, res, next) => {
    try {
      await revokeAdminSessionByTokenHash(req.admin.tokenHash);

      await audit(req, {
        action: 'admin.logout',
        target: req.admin.user,
      });

      res.setHeader(
        'Set-Cookie',
        expiredSessionCookieValue()
      );

      res.setHeader('Clear-Site-Data', '"cache"');

      return res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  }
);

app.get('/api/admin/me', requireAdmin, async (req, res) => {
  const csrfToken = csrfTokenForSessionHash(req.admin.tokenHash);

  res.setHeader('Cache-Control', 'no-store');

  return res.json({
    ok: true,
    user: req.admin.user,
    csrfToken,
    expiresAt: new Date(req.admin.expiresAt).toISOString(),
  });
});

app.get('/api/admin/stats', requireAdmin, async (_req, res) => {
  const summary = await getLeadSummary();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, ...summary });
});

app.get('/api/admin/leads', requireAdmin, async (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
  const offset = Math.max(0, Number(req.query.offset || 0));
  const role = cleanText(req.query.role, 32).toLowerCase();
  const ville = cleanText(req.query.ville, 80);
  const [items, total] = await Promise.all([
    listLeads({ limit, offset, role, ville }),
    getLeadCount(),
  ]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, total, items });
});

app.get('/api/admin/export.csv', requireAdmin, async (_req, res) => {
  const rows = await exportAllLeads();
  const header = ['id','prenom','nom','contact','type_contact','ville','role','consent_at','desinscrit_at','email_lancement_envoye','created_at'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.id, r.prenom, r.nom, r.contact_raw, r.contact_type,
      r.ville, r.role, r.consent_at?.toISOString?.() || r.consent_at,
      r.unsubscribed_at?.toISOString?.() || r.unsubscribed_at,
      r.launch_notified ? 'oui' : 'non',
      r.created_at?.toISOString?.() || r.created_at,
    ].map(csvEscape).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ledomen-inscriptions.csv"');
  res.send('\uFEFF' + lines.join('\n'));
});

app.get('/api/admin/settings', requireAdmin, async (_req, res) => {
  const settings = await getResolvedSettings();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, settings });
});

app.put('/api/admin/settings', requireAdmin, sameOriginOnly, requireCsrf, async (req, res, next) => {
  try {
    const current = await getResolvedSettings();
    const validation = sanitizeSettings({ ...current, ...req.body });

    if (validation.error) {
      await audit(req, {
        action: 'settings.update.rejected',
        target: 'app_settings',
        success: false,
        details: { reason: validation.error },
      });

      return res.status(400).json({
        ok: false,
        message: validation.error,
      });
    }

    const settings = await upsertAppSettings(
      validation.settings,
      req.admin.user
    );

    await audit(req, {
      action: 'settings.update',
      target: 'app_settings',
      details: {
        keys: Object.keys(req.body || {}).slice(0, 100),
      },
    });

    return res.json({
      ok: true,
      settings: {
        ...DEFAULT_SETTINGS,
        ...settings,
      },
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/email/status', requireAdmin, (_req, res) => {
  res.json({
    ok: true,
    configured: mailConfigured,
    smtp: {
      host: SMTP_HOST || null,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      fromEmail: SMTP_FROM_EMAIL || null,
      fromName: SMTP_FROM_NAME || null,
    },
    worker: {
      batchSize: EMAIL_BATCH_SIZE,
      maxAttempts: EMAIL_MAX_ATTEMPTS,
      intervalMs: EMAIL_WORKER_INTERVAL_MS,
    },
  });
});

app.post('/api/admin/email/preview', requireAdmin, sameOriginOnly, requireCsrf, async (req, res) => {
  const current = await getResolvedSettings();
  const validation = sanitizeSettings({ ...current, ...(req.body.settings || {}) }, { requirePlatformUrl: true });
  if (validation.error) return res.status(400).json({ ok: false, message: validation.error });
  const settings = validation.settings;
  const rendered = renderLaunchEmail({
    firstName: 'Jean',
    subject: settings.email_subject,
    message: settings.email_intro,
    platformUrl: settings.platform_url,
    promoCode: settings.promo_code,
    isTest: true,
  });
  res.json({ ok: true, html: rendered.html });
});

app.post('/api/admin/email/test', requireAdmin, sameOriginOnly, requireCsrf, rateLimit({ windowMs: 5 * 60 * 1000, max: 10 }), async (req, res) => {
  if (!mailTransporter) {
    return res.status(409).json({ ok: false, message: 'SMTP non configuré. Renseignez les variables SMTP dans .env puis redémarrez le serveur.' });
  }
  const to = normalizeEmail(req.body.to);
  if (!to) return res.status(400).json({ ok: false, message: 'Adresse e-mail de test invalide.' });
  const current = await getResolvedSettings();
  const validation = sanitizeSettings({ ...current, ...(req.body.settings || {}) }, { requirePlatformUrl: true });
  if (validation.error) return res.status(400).json({ ok: false, message: validation.error });
  const settings = validation.settings;
  const info = await sendLaunchMail({
    to,
    firstName: 'Jean',
    subject: settings.email_subject,
    message: settings.email_intro,
    platformUrl: settings.platform_url,
    promoCode: settings.promo_code,
    isTest: true,
    senderName: settings.sender_name,
  });

  await audit(req, {
    action: 'email.test.sent',
    target: to,
  });

  res.json({ ok: true, message: `E-mail de test envoyé à ${to}.`, messageId: info?.messageId || null });
});

app.get('/api/admin/email/eligible-count', requireAdmin, async (req, res) => {
  const role = cleanText(req.query.role, 32).toLowerCase();
  const ville = cleanText(req.query.ville, 80);
  const onlyNotNotified = String(req.query.onlyNotNotified ?? 'true') !== 'false';
  if (role && !['organisateur', 'entreprise', 'prestataire'].includes(role)) {
    return res.status(400).json({ ok: false, message: 'Profil invalide.' });
  }
  if (ville && !['Libreville', 'Port-Gentil', 'Franceville', 'Autre'].includes(ville)) {
    return res.status(400).json({ ok: false, message: 'Ville invalide.' });
  }
  const count = await countEligibleEmailLeads({ targetRole: role, targetVille: ville, onlyNotNotified });
  res.json({ ok: true, count });
});

app.get('/api/admin/campaigns', requireAdmin, async (_req, res) => {
  const items = await listEmailCampaigns(100);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, items });
});

app.get('/api/admin/audit', requireAdmin, async (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
  const items = await listAuditLogs(limit);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ok: true, items });
});

app.post('/api/admin/campaigns', requireAdmin, sameOriginOnly, requireCsrf, rateLimit({ windowMs: 60_000, max: 10 }), async (req, res) => {
  if (!mailTransporter) {
    return res.status(409).json({ ok: false, message: 'SMTP non configuré. Impossible de lancer une campagne réelle.' });
  }
  const current = await getResolvedSettings();
  const validation = sanitizeSettings(current, { requirePlatformUrl: true });
  if (validation.error) return res.status(400).json({ ok: false, message: validation.error });
  const settings = validation.settings;

  const targetRole = cleanText(req.body.targetRole, 32).toLowerCase();
  const targetVille = cleanText(req.body.targetVille, 80);
  if (targetRole && !['organisateur', 'entreprise', 'prestataire'].includes(targetRole)) {
    return res.status(400).json({ ok: false, message: 'Profil cible invalide.' });
  }
  if (targetVille && !['Libreville', 'Port-Gentil', 'Franceville', 'Autre'].includes(targetVille)) {
    return res.status(400).json({ ok: false, message: 'Ville cible invalide.' });
  }

  let scheduledAt = null;
  if (req.body.scheduledAt) {
    const scheduled = new Date(req.body.scheduledAt);
    if (Number.isNaN(scheduled.getTime())) {
      return res.status(400).json({ ok: false, message: 'Date de programmation invalide.' });
    }
    scheduledAt = scheduled.toISOString();
  }

  const campaign = await createEmailCampaign({
    name: cleanText(req.body.name || `Annonce de lancement ${new Date().toLocaleDateString('fr-FR')}`, 140),
    subject: settings.email_subject,
    message: settings.email_intro,
    targetRole,
    targetVille,
    onlyNotNotified: req.body.onlyNotNotified !== false,
    scheduledAt,
    platformUrl: settings.platform_url,
    promoCode: settings.promo_code,
    senderName: settings.sender_name,
    createdBy: req.admin.user,
  });

  void runEmailWorker();

  await audit(req, {
    action: 'campaign.create',
    target: String(campaign.id),
    details: {
      name: campaign.name,
      status: campaign.status,
      totalRecipients: campaign.total_recipients,
    },
  });

  res.status(201).json({
    ok: true,
    campaign,
    message: campaign.total_recipients
      ? (campaign.status === 'scheduled' ? 'Campagne programmée.' : 'Campagne placée dans la file d’envoi.')
      : 'Campagne créée, mais aucun destinataire éligible ne correspond aux filtres.',
  });
});

app.post('/api/admin/campaigns/:id/cancel', requireAdmin, sameOriginOnly, requireCsrf, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, message: 'Campagne invalide.' });
  const campaign = await cancelEmailCampaign(id);
  if (!campaign) {
    return res.status(409).json({ ok: false, message: 'Cette campagne ne peut plus être annulée (elle est peut-être déjà en cours ou terminée).' });
  }

  await audit(req, {
    action: 'campaign.cancel',
    target: String(id),
  });

  res.json({ ok: true, message: 'Campagne annulée.' });
});

app.post('/api/admin/campaigns/:id/retry', requireAdmin, sameOriginOnly, requireCsrf, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ ok: false, message: 'Campagne invalide.' });
  const result = await retryFailedDeliveries(id);
  if (!result) return res.status(404).json({ ok: false, message: 'Campagne introuvable ou annulée.' });

  void runEmailWorker();

  await audit(req, {
    action: 'campaign.retry',
    target: String(id),
    details: { retried: result.retried },
  });

  res.json({ ok: true, message: `${result.retried} envoi(s) replacé(s) dans la file.`, ...result });
});

app.use(express.static(publicDir, {
  extensions: ['html'],
  setHeaders(res, filePath) {
    if (/\.(png|jpg|jpeg|webp|svg|woff2?)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  },
}));

app.use((_req, res) => {
  res.status(404).sendFile(path.join(publicDir, '404.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ ok: false, message: 'Erreur serveur.' });
});

async function initializeDefaultSettings() {
  const current = await getAppSettings();
  const missing = Object.fromEntries(Object.entries(DEFAULT_SETTINGS).filter(([key]) => !(key in current)));
  if (Object.keys(missing).length) await upsertAppSettings(missing, 'system');
}

async function start() {
  try {
    await ensureSchema();
    await initializeDefaultSettings();

    await Promise.all([
      cleanupExpiredAdminSessions(),
      cleanupSecurityRateLimits(),
    ]);

    app.listen(PORT, BIND_HOST, () => {
      console.log(`LeDomen lancé sur http://${BIND_HOST}:${PORT}`);
      console.log(`E-mail SMTP: ${mailConfigured ? 'configuré' : 'non configuré'}`);
    });

    setInterval(() => {
      void cleanupExpiredAdminSessions().catch((error) => {
        console.error('Nettoyage sessions:', error?.message || error);
      });
      void cleanupSecurityRateLimits().catch((error) => {
        console.error('Nettoyage rate-limit:', error?.message || error);
      });
    }, 60 * 60 * 1000).unref();

    if (mailConfigured) {
      setInterval(() => void runEmailWorker(), EMAIL_WORKER_INTERVAL_MS).unref();
      setTimeout(() => void runEmailWorker(), 1_000).unref();
    }
  } catch (err) {
    console.error('Impossible de démarrer LeDomen:', err);
    process.exit(1);
  }
}

start();
```

## `src/db.js`

```javascript
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
```

## `sql/schema.sql`

```sql
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

```

## `public/index.html`

```html
<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>LeDomen.com | Trouvez, comparez et réservez votre lieu événementiel à Libreville</title>
<meta name="description" content="LeDomen.com centralise les salles, hôtels, espaces de réception et prestataires événementiels du Gabon. Recherchez, comparez et réservez en quelques minutes. Ouverture prochaine à Libreville.">
<meta property="og:title" content="LeDomen.com — La référence gabonaise de l'organisation d'événements">
<meta property="og:description" content="Trouvez, comparez et réservez le lieu parfait pour votre événement à Libreville en quelques minutes.">
<meta property="og:type" content="website">
<meta property="og:locale" content="fr_FR">
<link rel="icon" type="image/png" href="/assets/favicon.png">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:opsz,wght@9..144,500;9..144,600;9..144,700;9..144,900&family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/css/styles.css">
</head>
<body>

<nav class="nav">
  <div class="wrap">
    <a class="brand brand-logo" href="/" aria-label="LeDomen.com"><img src="/assets/logo-ledomen.png" alt="LeDomen.com — Enjoy your Events"></a>
    <button class="nav-cta" id="nav-main-cta" type="button">Être informé</button>
  </div>
</nav>

<main id="contenu">
<!-- HERO -->
<header class="hero">
  <div class="wrap hero-grid">
    <div>
      <span class="eyebrow" id="hero-eyebrow">Bientôt à Libreville</span>
      <h1>Trouvez, comparez et réservez <span class="accent">le lieu parfait</span> pour votre événement.</h1>
      <p class="lead">La première plateforme gabonaise qui centralise salles, hôtels, espaces de réception et prestataires événementiels — mariage, anniversaire, conférence, séminaire, gala.</p>
      <div class="tags">
        <span class="tag">Mariage</span><span class="tag">Anniversaire</span><span class="tag">Conférence</span>
        <span class="tag">Séminaire</span><span class="tag">Formation</span><span class="tag">Baptême</span>
        <span class="tag">Gala</span><span class="tag">Réception</span>
      </div>
      <div class="cta-row">
        <button class="btn-primary" id="hero-main-cta" type="button">Je veux être informé du lancement</button>
        <button class="btn-secondary" id="concept-cta" type="button">Découvrir le concept</button>
      </div>
    </div>

    <!-- Élément signature : le Pass VIP -->
    <div class="pass-card reveal">
      <div class="pass-row">
        <span class="pass-label">Accès prioritaire</span>
        <span class="pass-code">#001</span>
      </div>
      <div class="countdown-public" id="public-countdown" aria-live="polite" aria-label="Compte à rebours avant l’ouverture de LeDomen">
        <div class="countdown-unit"><strong id="countdown-days">--</strong><span>jours</span></div>
        <div class="countdown-unit"><strong id="countdown-hours">--</strong><span>heures</span></div>
        <div class="countdown-unit"><strong id="countdown-minutes">--</strong><span>minutes</span></div>
        <div class="countdown-unit"><strong id="countdown-seconds">--</strong><span>secondes</span></div>
      </div>
      <div class="pass-sub" id="countdown-label">avant l'ouverture de LeDomen à Libreville</div>
      <div class="stat-line" id="early-access-stat">Chargement des inscriptions…</div>
      <div class="pass-divider"></div>
      <div class="pass-label">Détenteur</div>
      <div class="pass-code" style="font-size:1rem;color:var(--mist-200);">Votre code promo vous attend</div>
    </div>
  </div>
</header>

<!-- POURQUOI LEDOMEN -->
<section class="section-dark" id="concept">
  <div class="wrap">
    <div class="section-head reveal">
      <span class="eyebrow">Le constat</span>
      <h2>Organiser un événement au Gabon reste un parcours du combattant.</h2>
    </div>
    <div class="pain-grid reveal">
      <div class="pain-item"><span class="mark">—</span><span>Difficile de trouver une salle disponible à la bonne date.</span></div>
      <div class="pain-item"><span class="mark">—</span><span>Peu d'informations fiables sur les capacités et tarifs.</span></div>
      <div class="pain-item"><span class="mark">—</span><span>Impossible de comparer plusieurs lieux facilement.</span></div>
      <div class="pain-item"><span class="mark">—</span><span>Des heures perdues en appels et déplacements.</span></div>
      <div class="pain-item"><span class="mark">—</span><span>Aucune réservation en ligne centralisée.</span></div>
      <div class="pain-item"><span class="mark">—</span><span>Aucun moyen simple de trouver des prestataires de confiance.</span></div>
    </div>
  </div>
</section>

<!-- COMMENT CA MARCHE -->
<section class="section-light">
  <div class="wrap">
    <div class="section-head reveal">
      <span class="eyebrow">Le parcours</span>
      <h2>Comment ça fonctionne</h2>
    </div>
    <div class="steps reveal">
      <div class="step">
        <div class="num">1</div>
        <h3>Recherchez</h3>
        <p>Ville, date, budget et type d'événement.</p>
      </div>
      <div class="step">
        <div class="num">2</div>
        <h3>Comparez</h3>
        <p>Photos, capacités, tarifs et avis vérifiés.</p>
      </div>
      <div class="step">
        <div class="num">3</div>
        <h3>Réservez</h3>
        <p>Contact direct avec le propriétaire ou réservation en ligne.</p>
      </div>
      <div class="step">
        <div class="num">4</div>
        <h3>Organisez</h3>
        <p>Ajoutez vos prestataires en un clic.</p>
      </div>
    </div>
    <div class="provider-chip-row reveal">
      <span class="chip">Traiteur</span><span class="chip">DJ</span><span class="chip">Photographe</span>
      <span class="chip">Décoration</span><span class="chip">Sonorisation</span><span class="chip">Sécurité</span>
      <span class="chip">Location de véhicules</span><span class="chip">Animation</span>
    </div>
  </div>
</section>

<!-- POUR QUI -->
<section class="section-dark">
  <div class="wrap">
    <div class="section-head reveal">
      <span class="eyebrow">Pour qui</span>
      <h2>Une plateforme pour chaque acteur de l'événementiel</h2>
    </div>
    <div class="audience-grid reveal">
      <div class="audience-card">
        <h3>Organisateurs</h3>
        <ul>
          <li>Mariages</li><li>Anniversaires</li><li>Baptêmes</li><li>Réunions</li><li>Conférences</li><li>Galas</li>
        </ul>
      </div>
      <div class="audience-card">
        <h3>Entreprises</h3>
        <ul>
          <li>Séminaires</li><li>Lancements de produits</li><li>Formations</li><li>Afterworks</li><li>Cocktails</li>
        </ul>
      </div>
      <div class="audience-card">
        <h3>Prestataires</h3>
        <ul>
          <li>Salles & hôtels</li><li>Espaces de réception</li><li>Restaurants</li><li>Prestataires événementiels</li>
        </ul>
      </div>
    </div>
  </div>
</section>

<!-- AVANTAGES -->
<section class="section-light">
  <div class="wrap">
    <div class="section-head reveal">
      <span class="eyebrow">Les bénéfices</span>
      <h2>Pensé pour vous faire gagner du temps</h2>
    </div>
    <div class="adv-grid reveal">
      <div class="adv-card"><div class="adv-icon">⏱</div><h3>Gain de temps</h3><p>Trouvez une salle en quelques minutes.</p></div>
      <div class="adv-card"><div class="adv-icon">◈</div><h3>Transparence</h3><p>Informations claires, tarifs affichés.</p></div>
      <div class="adv-card"><div class="adv-icon">▦</div><h3>Choix</h3><p>Des centaines de lieux réunis au même endroit.</p></div>
      <div class="adv-card"><div class="adv-icon">✓</div><h3>Simplicité</h3><p>Réservez sans déplacement inutile.</p></div>
      <div class="adv-card"><div class="adv-icon">◆</div><h3>Sécurité</h3><p>Des établissements vérifiés.</p></div>
    </div>
  </div>
</section>

<!-- URGENCE -->
<section class="section-dark">
  <div class="wrap">
    <div class="urgency reveal">
      <div>
        <span class="eyebrow">Pourquoi s'inscrire maintenant</span>
        <h2 style="font-size:1.7rem;margin:14px 0 0;">Les premiers inscrits ont des avantages qui ne reviendront pas.</h2>
      </div>
      <ul class="perk-list">
        <li><span class="check">✓</span> Code promotionnel de lancement</li>
        <li><span class="check">✓</span> Accès prioritaire à la plateforme</li>
        <li><span class="check">✓</span> Offres exclusives réservées aux 100 premiers</li>
        <li><span class="check">✓</span> Invitations aux événements LeDomen</li>
        <li><span class="check">✓</span> Nouveautés en avant-première</li>
      </ul>
    </div>
  </div>
</section>

<!-- FORMULAIRE -->
<section class="section-light" id="inscription">
  <div class="wrap" style="max-width:760px;">
    <div class="section-head reveal" style="margin-bottom:24px;">
      <span class="eyebrow">Inscription</span>
      <h2>Soyez parmi les premiers</h2>
    </div>
    <form class="form-panel reveal" id="lead-form" action="/api/leads" method="post" novalidate>
      <input type="text" name="website" class="hp-field" tabindex="-1" autocomplete="off" aria-hidden="true">
      <input type="hidden" name="source" value="landing-page">
      <div class="form-grid">
        <div class="field">
          <label for="prenom">Prénom</label>
          <input type="text" id="prenom" name="prenom" required autocomplete="given-name">
        </div>
        <div class="field">
          <label for="nom">Nom</label>
          <input type="text" id="nom" name="nom" required autocomplete="family-name">
        </div>
        <div class="field">
          <label for="contact">E-mail ou numéro WhatsApp</label>
          <input type="text" id="contact" name="contact" placeholder="ex: +241 077... ou exemple@mail.com" required autocomplete="email">
        </div>
        <div class="field">
          <label for="ville">Ville</label>
          <select id="ville" name="ville" required>
            <option value="">Sélectionnez</option>
            <option>Libreville</option>
            <option>Port-Gentil</option>
            <option>Franceville</option>
            <option>Autre</option>
          </select>
        </div>
        <div class="field full">
          <label>Je suis :</label>
          <div class="role-group">
            <label class="role-option"><input type="radio" name="role" value="organisateur" checked>Organisateur</label>
            <label class="role-option"><input type="radio" name="role" value="entreprise">Entreprise</label>
            <label class="role-option"><input type="radio" name="role" value="prestataire">Prestataire</label>
          </div>
        </div>
      </div>
      <label class="consent">
        <input type="checkbox" id="consent" name="consent" required>
        J'accepte de recevoir des informations concernant le lancement de LeDomen.com. Consultez notre <a href="/privacy.html">politique de confidentialité</a>.
      </label>
      <button type="submit" class="form-submit">Recevoir mon invitation</button>
      <p class="form-note">Inscription gratuite. Aucune carte bancaire requise.</p>
      <div id="form-status" class="form-status" role="status" aria-live="polite"></div>
    </form>
  </div>
</section>

<!-- FAQ -->
<section class="section-dark">
  <div class="wrap" style="max-width:760px;">
    <div class="section-head reveal">
      <span class="eyebrow">Questions fréquentes</span>
      <h2>Tout ce qu'il faut savoir</h2>
    </div>
    <div class="reveal" style="background:var(--cream-50);border-radius:var(--radius-lg);padding:8px 28px;" id="faq-list">
      <div class="faq-item">
        <button class="faq-q">Quand la plateforme sera-t-elle disponible ? <span class="plus">+</span></button>
        <div class="faq-a"><p>Le lancement officiel est prévu très prochainement à Libreville. Les inscrits seront prévenus en priorité, avant toute annonce publique.</p></div>
      </div>
      <div class="faq-item">
        <button class="faq-q">L'inscription est-elle gratuite ? <span class="plus">+</span></button>
        <div class="faq-a"><p>Oui, l'inscription est entièrement gratuite et sans engagement.</p></div>
      </div>
      <div class="faq-item">
        <button class="faq-q">Recevrai-je un code promo ? <span class="plus">+</span></button>
        <div class="faq-a"><p>Oui. Les premiers inscrits bénéficient d'un code promotionnel et d'offres exclusives au lancement.</p></div>
      </div>
      <div class="faq-item">
        <button class="faq-q">Mes données sont-elles protégées ? <span class="plus">+</span></button>
        <div class="faq-a"><p>Oui, conformément à notre politique de confidentialité et aux exigences de protection des données personnelles applicables au Gabon.</p></div>
      </div>
    </div>
  </div>
</section>

</main>

<footer>
  <div class="wrap">
    <div class="foot-grid">
      <div class="foot-brand">
        <a class="brand brand-logo" href="/" aria-label="LeDomen.com"><img src="/assets/logo-ledomen.png" alt="LeDomen.com — Enjoy your Events"></a>
        <p>La plateforme gabonaise de réservation d'espaces événementiels. Libreville — Gabon.</p>
      </div>
      <div class="foot-col">
        <h4>Réseaux</h4>
        <a id="footer-whatsapp" href="#" hidden>WhatsApp</a>
        <a id="footer-facebook" href="#" hidden>Facebook</a>
        <a id="footer-instagram" href="#" hidden>Instagram</a>
        <a id="footer-linkedin" href="#" hidden>LinkedIn</a>
      </div>
      <div class="foot-col">
        <h4>Légal</h4>
        <a href="/legal.html">Mentions légales</a><a href="/privacy.html">Politique de confidentialité</a><a href="/terms.html">Conditions d'utilisation</a>
      </div>
      <div class="foot-col">
        <h4>Contact</h4>
        <a id="footer-contact-email" href="#" hidden></a>
        <a id="footer-contact-phone" href="#" hidden></a>
        <span id="footer-contact-address" class="foot-placeholder" hidden></span>
      </div>
    </div>
    <div class="foot-bottom">
      <span>© 2026 LeDomen.com — Plateforme technologique événementielle.</span>
      <span>Conçu à Libreville.</span>
    </div>
  </div>
</footer>

<script src="/js/app.js" defer></script>
</body>
</html>
```

## `public/admin.html`

```html
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="robots" content="noindex,nofollow">
  <title>Administration | LeDomen.com</title>
  <link rel="icon" type="image/png" href="/assets/favicon.png">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/css/admin.css">
</head>
<body>
  <header class="admin-topbar">
    <a href="/" class="admin-logo"><img src="/assets/logo-ledomen.png" alt="LeDomen.com"></a>
    <div class="admin-actions">
      <span id="admin-user"></span>
      <button id="logout-btn" class="secondary" type="button" hidden>Déconnexion</button>
    </div>
  </header>

  <main class="admin-shell">
    <section id="login-panel" class="panel login-panel">
      <h1>Administration</h1>
      <p>Connectez-vous pour gérer les inscriptions et le lancement de LeDomen.com.</p>
      <form id="login-form">
        <label>E-mail administrateur
          <input type="email" name="user" autocomplete="username" required>
        </label>
        <label>Mot de passe
          <input type="password" name="password" autocomplete="current-password" required>
        </label>
        <button type="submit">Se connecter</button>
        <p id="login-status" class="status" role="status" aria-live="polite"></p>
      </form>
    </section>

    <section id="dashboard" hidden>
      <div class="dashboard-head">
        <div>
          <span class="eyebrow">LeDomen.com</span>
          <h1>Console responsable</h1>
          <p class="subtle">Pré-lancement, lien de la plateforme et campagnes d’annonce.</p>
        </div>
        <a class="button-link" href="/api/admin/export.csv">Exporter les inscrits CSV</a>
      </div>

      <nav class="admin-tabs" aria-label="Sections administration">
        <button class="tab-button active" data-tab="leads" type="button">Inscriptions</button>
        <button class="tab-button" data-tab="launch" type="button">Lancement & e-mail</button>
        <button class="tab-button" data-tab="campaigns" type="button">Campagnes</button>
        <button class="tab-button" data-tab="content" type="button">Contenu & liens</button>
      </nav>

      <section class="tab-panel active" data-tab-panel="leads">
        <div class="metrics">
          <article class="metric"><span>Total</span><strong id="metric-total">—</strong></article>
          <article class="metric"><span>Organisateurs</span><strong id="metric-organisateurs">—</strong></article>
          <article class="metric"><span>Entreprises</span><strong id="metric-entreprises">—</strong></article>
          <article class="metric"><span>Prestataires</span><strong id="metric-prestataires">—</strong></article>
          <article class="metric metric-light"><span>E-mails éligibles</span><strong id="metric-emails">—</strong></article>
          <article class="metric metric-light"><span>Désinscrits</span><strong id="metric-unsubscribed">—</strong></article>
        </div>

        <div class="panel">
          <div class="filters">
            <label>Profil
              <select id="filter-role">
                <option value="">Tous</option>
                <option value="organisateur">Organisateur</option>
                <option value="entreprise">Entreprise</option>
                <option value="prestataire">Prestataire</option>
              </select>
            </label>
            <label>Ville
              <select id="filter-ville">
                <option value="">Toutes</option>
                <option>Libreville</option>
                <option>Port-Gentil</option>
                <option>Franceville</option>
                <option>Autre</option>
              </select>
            </label>
            <button id="refresh-btn" class="secondary" type="button">Actualiser</button>
          </div>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Date</th><th>Nom</th><th>Contact</th><th>Ville</th><th>Profil</th><th>Consentement</th><th>Lancement</th>
                </tr>
              </thead>
              <tbody id="lead-rows"></tbody>
            </table>
          </div>
          <p id="dashboard-status" class="status" role="status" aria-live="polite"></p>
        </div>
      </section>

      <section class="tab-panel" data-tab-panel="launch" hidden>
        <div class="two-col">
          <div class="panel">
            <div class="panel-head">
              <div>
                <span class="eyebrow">Paramètres</span>
                <h2>Lancement de la plateforme</h2>
              </div>
              <span id="site-status-badge" class="status-badge">Pré-lancement</span>
            </div>

            <form id="launch-settings-form" class="settings-form">
              <label>Statut de la plateforme
                <select name="site_status" id="site-status">
                  <option value="prelaunch">Pré-lancement</option>
                  <option value="open">Ouverte au public</option>
                </select>
              </label>

              <label>URL de la plateforme
                <input type="url" name="platform_url" id="platform-url" placeholder="https://app.ledomen.com">
                <small>Cette URL remplacera automatiquement les boutons « être informé » quand le statut passera à « Ouverte ».</small>
              </label>

              <label>Date de lancement
                <input type="datetime-local" name="launch_date" id="launch-date" required>
              </label>

              <label>Code promotionnel de lancement
                <input type="text" name="promo_code" id="promo-code" maxlength="80" placeholder="Ex. BIENVENUE10">
              </label>

              <label>Nom affiché comme expéditeur
                <input type="text" name="sender_name" id="sender-name" maxlength="100" placeholder="LeDomen.com" required>
              </label>

              <label>Objet de l’e-mail de lancement
                <input type="text" name="email_subject" id="email-subject" maxlength="180" required>
              </label>

              <label>Message d’introduction
                <textarea name="email_intro" id="email-intro" rows="6" maxlength="1800" required></textarea>
              </label>

              <div class="button-row">
                <button type="submit">Enregistrer les paramètres</button>
                <button id="preview-email-btn" class="secondary" type="button">Actualiser l’aperçu</button>
              </div>
              <p id="settings-status" class="status" role="status" aria-live="polite"></p>
            </form>
          </div>

          <div class="stack">
            <div class="panel">
              <div class="panel-head compact">
                <div>
                  <span class="eyebrow">Serveur e-mail</span>
                  <h2>État SMTP</h2>
                </div>
                <span id="smtp-badge" class="status-badge">Vérification…</span>
              </div>
              <p id="smtp-details" class="subtle">Chargement de la configuration…</p>
              <div class="test-mail-row">
                <label>E-mail de test
                  <input type="email" id="test-email" placeholder="vous@exemple.com">
                </label>
                <button id="send-test-btn" type="button">Envoyer un test</button>
              </div>
              <p id="test-email-status" class="status" role="status" aria-live="polite"></p>
            </div>

            <div class="panel preview-panel">
              <div class="panel-head compact">
                <div>
                  <span class="eyebrow">Aperçu</span>
                  <h2>E-mail reçu par l’inscrit</h2>
                </div>
              </div>
              <iframe id="email-preview" title="Aperçu de l’e-mail de lancement" sandbox="allow-popups allow-top-navigation-by-user-activation"></iframe>
            </div>
          </div>
        </div>
      </section>

      <section class="tab-panel" data-tab-panel="campaigns" hidden>
        <div class="two-col campaign-layout">
          <div class="panel">
            <span class="eyebrow">Nouvelle campagne</span>
            <h2>Annonce du lancement</h2>
            <p class="subtle">Seuls les inscrits ayant fourni une adresse e-mail, donné leur consentement et non désinscrits seront sélectionnés.</p>

            <form id="campaign-form" class="settings-form">
              <label>Nom interne de la campagne
                <input type="text" name="name" id="campaign-name" maxlength="140" placeholder="Ex. Lancement officiel — vague 1" required>
              </label>

              <div class="form-grid-2">
                <label>Profil ciblé
                  <select name="targetRole" id="campaign-role">
                    <option value="">Tous les profils</option>
                    <option value="organisateur">Organisateurs</option>
                    <option value="entreprise">Entreprises</option>
                    <option value="prestataire">Prestataires</option>
                  </select>
                </label>
                <label>Ville ciblée
                  <select name="targetVille" id="campaign-ville">
                    <option value="">Toutes les villes</option>
                    <option>Libreville</option>
                    <option>Port-Gentil</option>
                    <option>Franceville</option>
                    <option>Autre</option>
                  </select>
                </label>
              </div>

              <label class="check-row">
                <input type="checkbox" id="only-not-notified" checked>
                <span>N’envoyer qu’aux personnes qui n’ont encore reçu aucune annonce de lancement</span>
              </label>

              <label>Programmer l’envoi (facultatif)
                <input type="datetime-local" id="campaign-scheduled-at">
                <small>Laissez vide pour commencer l’envoi immédiatement.</small>
              </label>

              <div class="recipient-estimate">
                <span>Destinataires éligibles</span>
                <strong id="eligible-count">—</strong>
              </div>

              <button id="create-campaign-btn" type="submit">Lancer / programmer la campagne</button>
              <p class="warning-text">Une campagne immédiate commence à être traitée dès sa création. Envoyez d’abord un e-mail de test.</p>
              <p id="campaign-status" class="status" role="status" aria-live="polite"></p>
            </form>
          </div>

          <div class="panel">
            <div class="panel-head compact">
              <div>
                <span class="eyebrow">Historique</span>
                <h2>Campagnes e-mail</h2>
              </div>
              <button id="refresh-campaigns-btn" class="secondary" type="button">Actualiser</button>
            </div>
            <div id="campaign-list" class="campaign-list"></div>
            <p id="campaign-list-status" class="status" role="status" aria-live="polite"></p>
          </div>
        </div>
      </section>

      <section class="tab-panel" data-tab-panel="content" hidden>
        <div class="two-col">
          <div class="panel">
            <div class="panel-head">
              <div>
                <span class="eyebrow">Page publique</span>
                <h2>Contenu, contacts & boutons</h2>
              </div>
              <button id="content-refresh-btn" type="button" class="secondary">Actualiser</button>
            </div>

            <p class="subtle">
              Toutes les valeurs ci-dessous sont enregistrées dans PostgreSQL.
              Aucun HTML ou JavaScript libre n’est accepté.
            </p>

            <form id="content-settings-form" class="settings-form">

              <div class="settings-group">
                <h3>WhatsApp</h3>
                <label>Numéro WhatsApp
                  <input type="text" id="content-whatsapp-number" placeholder="+241 77 12 34 56" maxlength="30" autocomplete="tel">
                  <small>Le serveur génère lui-même le lien wa.me.</small>
                </label>
                <label>Message automatique
                  <textarea id="content-whatsapp-message" rows="3" maxlength="300" placeholder="Bonjour, je souhaite des informations sur LeDomen.com."></textarea>
                </label>
                <label class="check-row">
                  <input type="checkbox" id="content-show-whatsapp">
                  <span>Afficher WhatsApp dans le pied de page</span>
                </label>
              </div>

              <div class="settings-group">
                <h3>Réseaux sociaux</h3>

                <label>URL Facebook
                  <input type="url" id="content-facebook-url" placeholder="https://facebook.com/ledomen">
                </label>
                <label class="check-row">
                  <input type="checkbox" id="content-show-facebook">
                  <span>Afficher Facebook</span>
                </label>

                <label>URL Instagram
                  <input type="url" id="content-instagram-url" placeholder="https://instagram.com/ledomen">
                </label>
                <label class="check-row">
                  <input type="checkbox" id="content-show-instagram">
                  <span>Afficher Instagram</span>
                </label>

                <label>URL LinkedIn
                  <input type="url" id="content-linkedin-url" placeholder="https://linkedin.com/company/ledomen">
                </label>
                <label class="check-row">
                  <input type="checkbox" id="content-show-linkedin">
                  <span>Afficher LinkedIn</span>
                </label>
              </div>

              <div class="settings-group">
                <h3>Coordonnées publiques</h3>

                <label>E-mail public
                  <input type="email" id="content-contact-email" placeholder="contact@ledomen.com" autocomplete="email">
                </label>
                <label class="check-row">
                  <input type="checkbox" id="content-show-email">
                  <span>Afficher l’e-mail</span>
                </label>

                <label>Téléphone public
                  <input type="text" id="content-contact-phone" placeholder="+241 77 12 34 56" maxlength="80" autocomplete="tel">
                </label>
                <label class="check-row">
                  <input type="checkbox" id="content-show-phone">
                  <span>Afficher le téléphone</span>
                </label>

                <label>Adresse / localisation
                  <input type="text" id="content-contact-address" placeholder="Libreville — Gabon" maxlength="200">
                </label>
                <label class="check-row">
                  <input type="checkbox" id="content-show-address">
                  <span>Afficher l’adresse</span>
                </label>
              </div>

              <div class="settings-group">
                <span class="eyebrow">Boutons publics</span>
                <h3>Bouton de navigation</h3>

                <label class="check-row">
                  <input type="checkbox" id="content-show-nav-cta">
                  <span>Afficher le bouton de navigation</span>
                </label>

                <div class="action-box">
                  <strong>Avant le lancement</strong>
                  <label>Texte
                    <input type="text" id="content-nav-prelaunch-text" maxlength="80">
                  </label>
                  <label>Action
                    <select id="content-nav-prelaunch-action">
                      <option value="signup">Aller au formulaire d’inscription</option>
                      <option value="concept">Aller à la section concept</option>
                      <option value="platform">Ouvrir l’URL de la plateforme</option>
                      <option value="whatsapp">Ouvrir WhatsApp</option>
                      <option value="external">Ouvrir une URL externe</option>
                      <option value="email">Envoyer un e-mail</option>
                      <option value="phone">Appeler un numéro</option>
                      <option value="hidden">Masquer ce bouton</option>
                    </select>
                  </label>
                  <label>Destination personnalisée
                    <input type="text" id="content-nav-prelaunch-value" maxlength="300" placeholder="URL, e-mail ou téléphone — seulement si l’action l’exige">
                  </label>
                </div>

                <div class="action-box">
                  <strong>Après l’ouverture</strong>
                  <label>Texte
                    <input type="text" id="content-nav-open-text" maxlength="80">
                  </label>
                  <label>Action
                    <select id="content-nav-open-action">
                      <option value="platform">Ouvrir l’URL de la plateforme</option>
                      <option value="signup">Aller au formulaire d’inscription</option>
                      <option value="concept">Aller à la section concept</option>
                      <option value="whatsapp">Ouvrir WhatsApp</option>
                      <option value="external">Ouvrir une URL externe</option>
                      <option value="email">Envoyer un e-mail</option>
                      <option value="phone">Appeler un numéro</option>
                      <option value="hidden">Masquer ce bouton</option>
                    </select>
                  </label>
                  <label>Destination personnalisée
                    <input type="text" id="content-nav-open-value" maxlength="300" placeholder="URL, e-mail ou téléphone — seulement si l’action l’exige">
                  </label>
                </div>
              </div>

              <div class="settings-group">
                <h3>Bouton principal du hero</h3>

                <label class="check-row">
                  <input type="checkbox" id="content-show-hero-primary">
                  <span>Afficher le bouton principal</span>
                </label>

                <div class="action-box">
                  <strong>Avant le lancement</strong>
                  <label>Texte
                    <input type="text" id="content-hero-prelaunch-text" maxlength="100">
                  </label>
                  <label>Action
                    <select id="content-hero-prelaunch-action">
                      <option value="signup">Aller au formulaire d’inscription</option>
                      <option value="concept">Aller à la section concept</option>
                      <option value="platform">Ouvrir l’URL de la plateforme</option>
                      <option value="whatsapp">Ouvrir WhatsApp</option>
                      <option value="external">Ouvrir une URL externe</option>
                      <option value="email">Envoyer un e-mail</option>
                      <option value="phone">Appeler un numéro</option>
                      <option value="hidden">Masquer ce bouton</option>
                    </select>
                  </label>
                  <label>Destination personnalisée
                    <input type="text" id="content-hero-prelaunch-value" maxlength="300" placeholder="URL, e-mail ou téléphone — seulement si l’action l’exige">
                  </label>
                </div>

                <div class="action-box">
                  <strong>Après l’ouverture</strong>
                  <label>Texte
                    <input type="text" id="content-hero-open-text" maxlength="100">
                  </label>
                  <label>Action
                    <select id="content-hero-open-action">
                      <option value="platform">Ouvrir l’URL de la plateforme</option>
                      <option value="signup">Aller au formulaire d’inscription</option>
                      <option value="concept">Aller à la section concept</option>
                      <option value="whatsapp">Ouvrir WhatsApp</option>
                      <option value="external">Ouvrir une URL externe</option>
                      <option value="email">Envoyer un e-mail</option>
                      <option value="phone">Appeler un numéro</option>
                      <option value="hidden">Masquer ce bouton</option>
                    </select>
                  </label>
                  <label>Destination personnalisée
                    <input type="text" id="content-hero-open-value" maxlength="300" placeholder="URL, e-mail ou téléphone — seulement si l’action l’exige">
                  </label>
                </div>
              </div>

              <div class="settings-group">
                <h3>Bouton secondaire du hero</h3>

                <label class="check-row">
                  <input type="checkbox" id="content-show-hero-secondary">
                  <span>Afficher le bouton secondaire</span>
                </label>

                <label>Texte
                  <input type="text" id="content-concept-button-text" maxlength="100">
                </label>

                <label>Action
                  <select id="content-concept-button-action">
                    <option value="concept">Aller à la section concept</option>
                    <option value="signup">Aller au formulaire d’inscription</option>
                    <option value="platform">Ouvrir l’URL de la plateforme</option>
                    <option value="whatsapp">Ouvrir WhatsApp</option>
                    <option value="external">Ouvrir une URL externe</option>
                    <option value="email">Envoyer un e-mail</option>
                    <option value="phone">Appeler un numéro</option>
                    <option value="hidden">Masquer ce bouton</option>
                  </select>
                </label>

                <label>Destination personnalisée
                  <input type="text" id="content-concept-button-value" maxlength="300" placeholder="URL, e-mail ou téléphone — seulement si l’action l’exige">
                </label>
              </div>

              <button type="submit" id="content-save-btn">
                Enregistrer le contenu public
              </button>

              <p id="content-settings-status" class="status" role="status" aria-live="polite"></p>
            </form>
          </div>

          <div class="stack">
            <div class="panel">
              <span class="eyebrow">Aperçu</span>
              <h2>Page publique</h2>
              <p class="subtle">
                Les changements sont lus par la landing page sans modifier le HTML.
              </p>
              <div class="button-row">
                <a href="/" target="_blank" rel="noopener noreferrer" class="button-link">
                  Voir la page publique
                </a>
              </div>
            </div>

            <div class="panel">
              <span class="eyebrow">Sécurité</span>
              <h2>Valeurs filtrées côté serveur</h2>
              <p class="subtle">
                Les URL sont limitées à HTTP/HTTPS, les actions sont choisies dans une liste fermée,
                WhatsApp est construit côté serveur, et les modifications exigent une session
                administrateur valide ainsi qu’un jeton CSRF.
              </p>
            </div>
          </div>
        </div>
      </section>
    </section>
  </main>
  <script src="/js/admin.js" defer></script>
</body>
</html>
```

## `public/js/app.js`

```javascript
'use strict';

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

let countdownTimer = null;

function scrollToSection(id) {
  document.getElementById(id)?.scrollIntoView({
    behavior: 'smooth',
    block: 'start',
  });
}

function isSafePublicHref(value) {
  if (typeof value !== 'string' || !value.trim()) return false;

  const href = value.trim();

  if (/^(mailto:|tel:)/i.test(href)) {
    return !/[\r\n]/.test(href);
  }

  try {
    const url = new URL(href);
    return ['http:', 'https:'].includes(url.protocol);
  } catch {
    return false;
  }
}

function applyButton(element, spec = {}) {
  if (!element) return;

  const label = String(spec.label || '').trim();
  const behavior = spec.behavior || { type: 'hidden' };

  element.textContent = label || element.textContent;
  element.onclick = null;

  const hidden =
    spec.visible === false ||
    behavior.type === 'hidden';

  element.hidden = hidden;

  if (hidden) return;

  if (behavior.type === 'scroll') {
    const target = String(behavior.target || '');
    if (!['inscription', 'concept'].includes(target)) {
      element.hidden = true;
      return;
    }

    element.onclick = () => scrollToSection(target);
    return;
  }

  if (behavior.type === 'url' && isSafePublicHref(behavior.href)) {
    const href = behavior.href;

    element.onclick = () => {
      if (/^https?:\/\//i.test(href)) {
        window.location.assign(href);
      } else {
        window.location.href = href;
      }
    };
    return;
  }

  element.hidden = true;
}

function configurePublicButtons(config = {}) {
  const buttons = config.buttons || {};
  const phase = config.siteStatus === 'open' ? 'open' : 'prelaunch';

  const navSpec = buttons.nav || {};
  applyButton($('#nav-main-cta'), {
    ...(navSpec[phase] || {}),
    visible: navSpec.visible !== false,
  });

  const heroSpec = buttons.heroPrimary || {};
  applyButton($('#hero-main-cta'), {
    ...(heroSpec[phase] || {}),
    visible: heroSpec.visible !== false,
  });

  const secondarySpec = buttons.heroSecondary || {};
  applyButton($('#concept-cta'), {
    label: secondarySpec.label,
    behavior: secondarySpec.behavior,
    visible: secondarySpec.visible !== false,
  });

  const eyebrow = $('#hero-eyebrow');
  if (eyebrow) {
    eyebrow.textContent =
      config.siteStatus === 'open'
        ? 'LeDomen est disponible'
        : 'Bientôt à Libreville';
  }

  const label = $('#countdown-label');
  if (label && config.siteStatus === 'open') {
    label.textContent = 'La plateforme LeDomen est maintenant ouverte';
  }
}

function configurePublicLinks(links = {}) {
  const setLink = (id, visible, href, text) => {
    const element = byIdSafe(id);
    if (!element) return;

    const usable = Boolean(visible && isSafePublicHref(href));
    element.hidden = !usable;

    if (!usable) {
      element.removeAttribute('href');
      element.removeAttribute('target');
      element.removeAttribute('rel');
      return;
    }

    element.href = href;
    element.textContent = text;

    if (/^https?:\/\//i.test(href)) {
      element.target = '_blank';
      element.rel = 'noopener noreferrer';
    } else {
      element.removeAttribute('target');
      element.removeAttribute('rel');
    }
  };

  setLink(
    'footer-whatsapp',
    links.showWhatsapp,
    links.whatsappUrl || '',
    'WhatsApp'
  );

  setLink(
    'footer-facebook',
    links.showFacebook,
    links.facebookUrl || '',
    'Facebook'
  );

  setLink(
    'footer-instagram',
    links.showInstagram,
    links.instagramUrl || '',
    'Instagram'
  );

  setLink(
    'footer-linkedin',
    links.showLinkedin,
    links.linkedinUrl || '',
    'LinkedIn'
  );

  const email = String(links.contactEmail || '').trim();
  setLink(
    'footer-contact-email',
    links.showContactEmail,
    email ? `mailto:${email}` : '',
    email
  );

  const phone = String(links.contactPhone || '').trim();
  setLink(
    'footer-contact-phone',
    links.showContactPhone,
    phone ? `tel:${phone}` : '',
    phone
  );

  const address = byIdSafe('footer-contact-address');
  if (address) {
    const value = String(links.contactAddress || '').trim();
    address.hidden = !(links.showContactAddress && value);
    address.textContent = value;
  }
}

function byIdSafe(id) {
  return document.getElementById(id);
}

function setCountdown(values) {
  for (const [key, value] of Object.entries(values)) {
    const element = $(`#countdown-${key}`);
    if (element) element.textContent = value;
  }
}

function startCountdown(config = {}) {
  if (countdownTimer) {
    window.clearInterval(countdownTimer);
    countdownTimer = null;
  }

  const label = $('#countdown-label');

  if (config.siteStatus === 'open') {
    setCountdown({
      days: '00',
      hours: '00',
      minutes: '00',
      seconds: '00',
    });

    if (label) {
      label.textContent = 'La plateforme LeDomen est maintenant ouverte';
    }
    return;
  }

  const target = new Date(config.launchDate);

  if (Number.isNaN(target.getTime())) {
    setCountdown({
      days: '—',
      hours: '—',
      minutes: '—',
      seconds: '—',
    });

    if (label) {
      label.textContent = 'Ouverture prochaine de LeDomen';
    }
    return;
  }

  const render = () => {
    const remaining = Math.max(0, target.getTime() - Date.now());
    const totalSeconds = Math.floor(remaining / 1000);

    const days = Math.floor(totalSeconds / 86400);
    const hours = Math.floor((totalSeconds % 86400) / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;

    setCountdown({
      days: String(days).padStart(2, '0'),
      hours: String(hours).padStart(2, '0'),
      minutes: String(minutes).padStart(2, '0'),
      seconds: String(seconds).padStart(2, '0'),
    });

    if (label) {
      label.textContent = remaining > 0
        ? "avant l'ouverture de LeDomen à Libreville"
        : 'Ouverture imminente de LeDomen';
    }

    if (remaining === 0 && countdownTimer) {
      window.clearInterval(countdownTimer);
      countdownTimer = null;
    }
  };

  render();
  countdownTimer = window.setInterval(render, 1000);
}

async function loadPublicConfig() {
  const statEl = $('#early-access-stat');

  try {
    const [configResponse, statsResponse] = await Promise.all([
      fetch('/api/config', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
      }),
      fetch('/api/public/stats', {
        headers: { Accept: 'application/json' },
        cache: 'no-store',
        credentials: 'same-origin',
      }),
    ]);

    if (!configResponse.ok) {
      throw new Error('Configuration publique indisponible.');
    }

    const config = await configResponse.json();

    configurePublicButtons(config);
    configurePublicLinks(config.links || {});
    startCountdown(config);

    if (statsResponse.ok && statEl) {
      const stats = await statsResponse.json();
      const registered = Number(stats.registered) || 0;
      const remaining = Number(stats.earlyAccessRemaining) || 0;

      if (remaining > 0) {
        statEl.textContent =
          `${registered} inscrit${registered > 1 ? 's' : ''} · ` +
          `${remaining} accès prioritaire${remaining > 1 ? 's' : ''} ` +
          `restant${remaining > 1 ? 's' : ''}`;
      } else {
        statEl.textContent =
          `${registered} inscrit${registered > 1 ? 's' : ''} · liste prioritaire complète`;
      }
    }
  } catch (error) {
    console.error('Configuration publique:', error);

    setCountdown({
      days: '—',
      hours: '—',
      minutes: '—',
      seconds: '—',
    });

    if (statEl) {
      statEl.textContent = 'Ouverture prochaine à Libreville';
    }

    // Valeurs de secours sûres si l'API est momentanément indisponible.
    applyButton($('#nav-main-cta'), {
      label: 'Être informé',
      visible: true,
      behavior: { type: 'scroll', target: 'inscription' },
    });

    applyButton($('#hero-main-cta'), {
      label: 'Je veux être informé du lancement',
      visible: true,
      behavior: { type: 'scroll', target: 'inscription' },
    });

    applyButton($('#concept-cta'), {
      label: 'Découvrir le concept',
      visible: true,
      behavior: { type: 'scroll', target: 'concept' },
    });
  }
}

function initFaq() {
  $$('.faq-item').forEach((item) => {
    const button = $('.faq-q', item);
    const answer = $('.faq-a', item);

    if (!button || !answer) return;

    button.setAttribute('aria-expanded', 'false');

    button.addEventListener('click', () => {
      const wasOpen = item.classList.contains('open');

      $$('.faq-item.open').forEach((openItem) => {
        openItem.classList.remove('open');
        $('.faq-q', openItem)?.setAttribute('aria-expanded', 'false');

        const openAnswer = $('.faq-a', openItem);
        if (openAnswer) openAnswer.style.maxHeight = null;
      });

      if (!wasOpen) {
        item.classList.add('open');
        button.setAttribute('aria-expanded', 'true');
        answer.style.maxHeight = `${answer.scrollHeight}px`;
      }
    });
  });
}

function initReveal() {
  const elements = $$('.reveal');

  if (
    !('IntersectionObserver' in window) ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    elements.forEach((element) => element.classList.add('in'));
    return;
  }

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;

        entry.target.classList.add('in');
        observer.unobserve(entry.target);
      });
    },
    { threshold: 0.15 }
  );

  elements.forEach((element) => observer.observe(element));
}

function setFormStatus(message, type) {
  const status = $('#form-status');
  if (!status) return;

  status.textContent = message;
  status.className = `form-status show ${type}`;
}

function initLeadForm() {
  const form = $('#lead-form');
  if (!form) return;

  const submit = $('.form-submit', form);
  if (!submit) return;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!form.reportValidity()) return;

    const data = new FormData(form);
    const payload = Object.fromEntries(data.entries());
    payload.consent = $('#consent', form)?.checked === true;

    submit.disabled = true;
    const initialText = submit.textContent;
    submit.textContent = 'Inscription en cours…';

    setFormStatus(
      'Enregistrement de votre inscription…',
      'success'
    );

    try {
      const response = await fetch('/api/leads', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok || !result.ok) {
        throw new Error(
          result.message ||
          "Impossible d'enregistrer votre inscription."
        );
      }

      setFormStatus(
        result.message ||
        'Votre inscription est bien enregistrée.',
        'success'
      );

      submit.textContent = result.duplicate
        ? 'Déjà inscrit(e) ✓'
        : 'Inscription confirmée ✓';

      form.reset();
      await loadPublicConfig();

      window.setTimeout(() => {
        submit.disabled = false;
        submit.textContent = initialText;
      }, 4000);
    } catch (error) {
      setFormStatus(
        error.message ||
        'Erreur réseau. Réessayez dans quelques instants.',
        'error'
      );

      submit.disabled = false;
      submit.textContent = initialText;
    }
  });
}

initFaq();
initReveal();
initLeadForm();
void loadPublicConfig();
```

## `public/js/admin.js`

```javascript
'use strict';

const byId = (id) => document.getElementById(id);
const loginPanel = byId('login-panel');
const dashboard = byId('dashboard');
const logoutBtn = byId('logout-btn');
let smtpConfigured = false;
let settingsDirty = false;
let eligibleCount = null;
let csrfToken = '';

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/g, (ch) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'
  })[ch]);
}

function formatDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '—' : new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'short', timeStyle: 'short'
  }).format(d);
}

function toDatetimeLocal(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function setStatus(id, message, type = '') {
  const el = byId(id);
  if (!el) return;
  el.textContent = message;
  el.className = `status${type ? ` ${type}` : ''}`;
}

async function api(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);

  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  if (unsafe && csrfToken) {
    headers['X-CSRF-Token'] = csrfToken;
  }

  const response = await fetch(url, {
    ...options,
    method,
    credentials: 'same-origin',
    headers,
  });

  const contentType = response.headers.get('content-type') || '';
  const data = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : { message: await response.text().catch(() => '') };

  if (!response.ok) {
    const error = new Error(data.message || 'Erreur serveur');
    error.status = response.status;

    if (response.status === 401) {
      csrfToken = '';
    }

    throw error;
  }

  return data;
}

function showLogin() {
  csrfToken = '';
  loginPanel.hidden = false;
  dashboard.hidden = true;
  logoutBtn.hidden = true;
  byId('admin-user').textContent = '';
}

function showDashboard(user) {
  loginPanel.hidden = true;
  dashboard.hidden = false;
  logoutBtn.hidden = false;
  byId('admin-user').textContent = user;
}

function switchTab(name) {
  document.querySelectorAll('.tab-button').forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === name);
  });
  document.querySelectorAll('.tab-panel').forEach((panel) => {
    const active = panel.dataset.tabPanel === name;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  if (name === 'campaigns') {
    void Promise.all([loadCampaigns(), loadEligibleCount()]);
  }
  if (name === 'launch') {
    void loadEmailPreview();
  }
  if (name === 'content') {
    void loadContentSettings();
  }
}

async function checkSession() {
  try {
    const me = await api('/api/admin/me');
    csrfToken = me.csrfToken || '';
    showDashboard(me.user);
    await Promise.all([loadDashboard(), loadSettings(), loadEmailStatus(), loadCampaigns()]);
    await loadEligibleCount();
  } catch {
    showLogin();
  }
}

async function loadDashboard() {
  const status = byId('dashboard-status');
  status.textContent = 'Chargement…';
  status.className = 'status';
  const role = byId('filter-role').value;
  const ville = byId('filter-ville').value;
  const query = new URLSearchParams({ limit: '500' });
  if (role) query.set('role', role);
  if (ville) query.set('ville', ville);

  try {
    const [filtered, stats] = await Promise.all([
      api(`/api/admin/leads?${query}`),
      api('/api/admin/stats'),
    ]);
    const items = filtered.items || [];
    byId('metric-total').textContent = stats.total ?? 0;
    byId('metric-organisateurs').textContent = stats.organisateurs ?? 0;
    byId('metric-entreprises').textContent = stats.entreprises ?? 0;
    byId('metric-prestataires').textContent = stats.prestataires ?? 0;
    byId('metric-emails').textContent = stats.emails_eligibles ?? 0;
    byId('metric-unsubscribed').textContent = stats.desinscrits ?? 0;

    const tbody = byId('lead-rows');
    if (!items.length) {
      tbody.innerHTML = '<tr><td colspan="7">Aucune inscription pour ces filtres.</td></tr>';
    } else {
      tbody.innerHTML = items.map((item) => {
        let launchStatus = '<span class="muted-label">Non envoyé</span>';
        if (item.unsubscribed_at) {
          launchStatus = `<span class="danger-label">Désinscrit</span><br><small>${escapeHtml(formatDate(item.unsubscribed_at))}</small>`;
        } else if (item.launch_notified) {
          launchStatus = '<span class="consent-ok">E-mail envoyé ✓</span>';
        } else if (item.contact_type === 'whatsapp') {
          launchStatus = '<span class="muted-label">WhatsApp uniquement</span>';
        }
        return `
          <tr>
            <td>${escapeHtml(formatDate(item.created_at))}</td>
            <td><strong>${escapeHtml(item.prenom)} ${escapeHtml(item.nom)}</strong></td>
            <td>${escapeHtml(item.contact_raw)}<br><small>${escapeHtml(item.contact_type)}</small></td>
            <td>${escapeHtml(item.ville)}</td>
            <td><span class="pill">${escapeHtml(item.role)}</span></td>
            <td><span class="consent-ok">Oui</span><br><small>${escapeHtml(formatDate(item.consent_at))}</small></td>
            <td>${launchStatus}</td>
          </tr>`;
      }).join('');
    }
    status.textContent = `${items.length} ligne${items.length > 1 ? 's' : ''} affichée${items.length > 1 ? 's' : ''}.`;
  } catch (error) {
    if (error.status === 401) return showLogin();
    status.textContent = error.message;
    status.className = 'status error';
  }
}

function currentSettingsPayload() {
  return {
    site_status: byId('site-status').value,
    platform_url: byId('platform-url').value.trim(),
    launch_date: byId('launch-date').value ? new Date(byId('launch-date').value).toISOString() : '',
    promo_code: byId('promo-code').value.trim(),
    sender_name: byId('sender-name').value.trim(),
    email_subject: byId('email-subject').value.trim(),
    email_intro: byId('email-intro').value.trim(),
  };
}

function updateSiteStatusBadge() {
  const badge = byId('site-status-badge');
  const open = byId('site-status').value === 'open';
  badge.textContent = open ? 'Ouverte' : 'Pré-lancement';
  badge.className = `status-badge ${open ? 'ok' : ''}`;
}

async function loadSettings() {
  try {
    const data = await api('/api/admin/settings');
    const settings = data.settings || {};
    byId('site-status').value = settings.site_status || 'prelaunch';
    byId('platform-url').value = settings.platform_url || '';
    byId('launch-date').value = toDatetimeLocal(settings.launch_date);
    byId('promo-code').value = settings.promo_code || '';
    byId('sender-name').value = settings.sender_name || 'LeDomen.com';
    byId('email-subject').value = settings.email_subject || '';
    byId('email-intro').value = settings.email_intro || '';
    updateSiteStatusBadge();
    settingsDirty = false;
    if (settings.platform_url) await loadEmailPreview();
    else byId('email-preview').srcdoc = '<!doctype html><html><body style="font-family:Arial;padding:24px;color:#475467">Renseignez l’URL de la plateforme pour générer l’aperçu de l’e-mail.</body></html>';
  } catch (error) {
    setStatus('settings-status', error.message, 'error');
  }
}

async function saveSettings(event) {
  if (event) event.preventDefault();
  setStatus('settings-status', 'Enregistrement…');
  try {
    const data = await api('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(currentSettingsPayload()),
    });
    settingsDirty = false;
    updateSiteStatusBadge();
    setStatus('settings-status', 'Paramètres enregistrés. La landing page utilisera ces valeurs automatiquement.', 'success');
    await loadEmailPreview();
    return data.settings;
  } catch (error) {
    setStatus('settings-status', error.message, 'error');
    throw error;
  }
}

async function loadEmailStatus() {
  try {
    const data = await api('/api/admin/email/status');
    smtpConfigured = Boolean(data.configured);
    const badge = byId('smtp-badge');
    badge.textContent = smtpConfigured ? 'Configuré' : 'Non configuré';
    badge.className = `status-badge ${smtpConfigured ? 'ok' : 'bad'}`;
    if (smtpConfigured) {
      byId('smtp-details').textContent = `SMTP ${data.smtp.host}:${data.smtp.port} · expéditeur ${data.smtp.fromEmail} · file ${data.worker.batchSize} e-mails par lot.`;
    } else {
      byId('smtp-details').textContent = 'Ajoutez SMTP_HOST, SMTP_PORT, SMTP_FROM_EMAIL et, si nécessaire, SMTP_USER / SMTP_PASS dans le fichier .env puis redémarrez le serveur.';
    }
    byId('send-test-btn').disabled = !smtpConfigured;
    byId('create-campaign-btn').disabled = !smtpConfigured;
  } catch (error) {
    setStatus('test-email-status', error.message, 'error');
  }
}

async function loadEmailPreview() {
  const url = byId('platform-url').value.trim();
  if (!url) {
    byId('email-preview').srcdoc = '<!doctype html><html><body style="font-family:Arial;padding:24px;color:#475467">Renseignez d’abord l’URL de la plateforme.</body></html>';
    return;
  }
  try {
    const data = await api('/api/admin/email/preview', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings: currentSettingsPayload() }),
    });
    byId('email-preview').srcdoc = data.html;
  } catch (error) {
    byId('email-preview').srcdoc = `<!doctype html><html><body style="font-family:Arial;padding:24px;color:#B42318">${escapeHtml(error.message)}</body></html>`;
  }
}

async function sendTestEmail() {
  const to = byId('test-email').value.trim();
  if (!to) {
    setStatus('test-email-status', 'Renseignez une adresse e-mail de test.', 'error');
    return;
  }
  setStatus('test-email-status', 'Envoi du test…');
  byId('send-test-btn').disabled = true;
  try {
    const data = await api('/api/admin/email/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to, settings: currentSettingsPayload() }),
    });
    setStatus('test-email-status', data.message, 'success');
  } catch (error) {
    setStatus('test-email-status', error.message, 'error');
  } finally {
    byId('send-test-btn').disabled = !smtpConfigured;
  }
}

function campaignFiltersQuery() {
  const query = new URLSearchParams();
  const role = byId('campaign-role').value;
  const ville = byId('campaign-ville').value;
  if (role) query.set('role', role);
  if (ville) query.set('ville', ville);
  query.set('onlyNotNotified', byId('only-not-notified').checked ? 'true' : 'false');
  return query;
}

async function loadEligibleCount() {
  byId('eligible-count').textContent = '…';
  try {
    const data = await api(`/api/admin/email/eligible-count?${campaignFiltersQuery()}`);
    eligibleCount = data.count ?? 0;
    byId('eligible-count').textContent = String(eligibleCount);
  } catch (error) {
    eligibleCount = null;
    byId('eligible-count').textContent = '—';
    setStatus('campaign-status', error.message, 'error');
  }
}

function campaignStatusLabel(status) {
  return ({
    draft: 'Brouillon', scheduled: 'Programmée', queued: 'En file', sending: 'En cours', completed: 'Terminée', cancelled: 'Annulée'
  })[status] || status;
}

function renderCampaignCard(campaign) {
  const total = Number(campaign.total_recipients || 0);
  const sent = Number(campaign.sent_count || 0);
  const failed = Number(campaign.failed_count || 0);
  const skipped = Number(campaign.skipped_count || 0);
  const progress = total ? Math.round(((sent + failed + skipped) / total) * 100) : 100;
  const target = [campaign.target_role ? `Profil : ${campaign.target_role}` : 'Tous profils', campaign.target_ville ? `Ville : ${campaign.target_ville}` : 'Toutes villes'].join(' · ');
  const schedule = campaign.scheduled_at ? ` · prévue ${formatDate(campaign.scheduled_at)}` : '';
  const cancel = ['scheduled', 'queued'].includes(campaign.status)
    ? `<button class="small secondary campaign-action" data-action="cancel" data-id="${campaign.id}" type="button">Annuler</button>` : '';
  const retry = failed > 0 && campaign.status === 'completed'
    ? `<button class="small secondary campaign-action" data-action="retry" data-id="${campaign.id}" type="button">Réessayer les échecs</button>` : '';

  return `<article class="campaign-card">
    <div class="campaign-card-head">
      <div><strong>${escapeHtml(campaign.name)}</strong><small>${escapeHtml(formatDate(campaign.created_at))}${escapeHtml(schedule)}</small></div>
      <span class="campaign-status status-${escapeHtml(campaign.status)}">${escapeHtml(campaignStatusLabel(campaign.status))}</span>
    </div>
    <p>${escapeHtml(target)}</p>
    <div class="progress"><span style="width:${Math.max(0, Math.min(100, progress))}%"></span></div>
    <div class="campaign-numbers"><span>${sent} envoyés</span><span>${failed} échecs</span><span>${skipped} ignorés</span><span>${total} total</span></div>
    <div class="campaign-actions">${cancel}${retry}</div>
  </article>`;
}

async function loadCampaigns() {
  setStatus('campaign-list-status', 'Chargement…');
  try {
    const data = await api('/api/admin/campaigns');
    const items = data.items || [];
    byId('campaign-list').innerHTML = items.length
      ? items.map(renderCampaignCard).join('')
      : '<div class="empty-state">Aucune campagne e-mail pour le moment.</div>';
    setStatus('campaign-list-status', items.length ? `${items.length} campagne${items.length > 1 ? 's' : ''}.` : '');
  } catch (error) {
    setStatus('campaign-list-status', error.message, 'error');
  }
}

async function createCampaign(event) {
  event.preventDefault();
  if (!smtpConfigured) {
    setStatus('campaign-status', 'Le serveur SMTP doit être configuré avant un envoi réel.', 'error');
    return;
  }
  if (settingsDirty) {
    setStatus('campaign-status', 'Des paramètres de lancement ont été modifiés mais pas enregistrés. Enregistrez-les avant de créer la campagne.', 'error');
    return;
  }
  const name = byId('campaign-name').value.trim();
  if (!name) {
    setStatus('campaign-status', 'Donnez un nom interne à la campagne.', 'error');
    return;
  }

  await loadEligibleCount();
  if (!eligibleCount) {
    setStatus('campaign-status', 'Aucun destinataire éligible pour ces filtres.', 'error');
    return;
  }

  const scheduledValue = byId('campaign-scheduled-at').value;
  const scheduledAt = scheduledValue ? new Date(scheduledValue).toISOString() : null;
  const timingText = scheduledAt ? `programmée pour ${formatDate(scheduledAt)}` : 'envoyée dès maintenant';
  const confirmed = window.confirm(`Confirmer la campagne « ${name} » ?\n\n${eligibleCount} destinataire(s) éligible(s).\nLa campagne sera ${timingText}.`);
  if (!confirmed) return;

  const button = byId('create-campaign-btn');
  button.disabled = true;
  setStatus('campaign-status', 'Création de la campagne…');
  try {
    const data = await api('/api/admin/campaigns', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        targetRole: byId('campaign-role').value,
        targetVille: byId('campaign-ville').value,
        onlyNotNotified: byId('only-not-notified').checked,
        scheduledAt,
      }),
    });
    setStatus('campaign-status', `${data.message} ${data.campaign.total_recipients} destinataire(s).`, 'success');
    byId('campaign-name').value = '';
    byId('campaign-scheduled-at').value = '';
    await Promise.all([loadCampaigns(), loadDashboard(), loadEligibleCount()]);
  } catch (error) {
    setStatus('campaign-status', error.message, 'error');
  } finally {
    button.disabled = !smtpConfigured;
  }
}

async function handleCampaignAction(button) {
  const id = Number(button.dataset.id);
  const action = button.dataset.action;
  if (!id || !action) return;
  const message = action === 'cancel'
    ? 'Annuler cette campagne ? Les e-mails déjà envoyés ne peuvent pas être rappelés.'
    : 'Remettre les envois en échec dans la file ?';
  if (!window.confirm(message)) return;
  button.disabled = true;
  try {
    const data = await api(`/api/admin/campaigns/${id}/${action === 'cancel' ? 'cancel' : 'retry'}`, { method: 'POST' });
    setStatus('campaign-list-status', data.message, 'success');
    await Promise.all([loadCampaigns(), loadDashboard(), loadEligibleCount()]);
  } catch (error) {
    setStatus('campaign-list-status', error.message, 'error');
  }
}


function setChecked(id, value, fallback = true) {
  const element = byId(id);
  if (!element) return;

  if (value === undefined || value === null || value === '') {
    element.checked = fallback;
    return;
  }

  element.checked = String(value).toLowerCase() === 'true';
}

function fillContentForm(settings = {}) {
  const values = {
    'content-whatsapp-number': settings.whatsapp_number || '',
    'content-whatsapp-message': settings.whatsapp_message || '',
    'content-facebook-url': settings.facebook_url || '',
    'content-instagram-url': settings.instagram_url || '',
    'content-linkedin-url': settings.linkedin_url || '',
    'content-contact-email': settings.contact_email || '',
    'content-contact-phone': settings.contact_phone || '',
    'content-contact-address': settings.contact_address || '',

    'content-nav-prelaunch-text': settings.nav_prelaunch_text || 'Être informé',
    'content-nav-prelaunch-action': settings.nav_prelaunch_action || 'signup',
    'content-nav-prelaunch-value': settings.nav_prelaunch_value || '',
    'content-nav-open-text': settings.nav_open_text || 'Accéder à la plateforme',
    'content-nav-open-action': settings.nav_open_action || 'platform',
    'content-nav-open-value': settings.nav_open_value || '',

    'content-hero-prelaunch-text': settings.hero_prelaunch_text || 'Je veux être informé du lancement',
    'content-hero-prelaunch-action': settings.hero_prelaunch_action || 'signup',
    'content-hero-prelaunch-value': settings.hero_prelaunch_value || '',
    'content-hero-open-text': settings.hero_open_text || 'Accéder à LeDomen',
    'content-hero-open-action': settings.hero_open_action || 'platform',
    'content-hero-open-value': settings.hero_open_value || '',

    'content-concept-button-text': settings.concept_button_text || 'Découvrir le concept',
    'content-concept-button-action': settings.concept_button_action || 'concept',
    'content-concept-button-value': settings.concept_button_value || '',
  };

  Object.entries(values).forEach(([id, value]) => {
    const element = byId(id);
    if (element) element.value = value;
  });

  setChecked('content-show-whatsapp', settings.show_whatsapp, true);
  setChecked('content-show-facebook', settings.show_facebook, true);
  setChecked('content-show-instagram', settings.show_instagram, true);
  setChecked('content-show-linkedin', settings.show_linkedin, true);
  setChecked('content-show-email', settings.show_contact_email, true);
  setChecked('content-show-phone', settings.show_contact_phone, true);
  setChecked('content-show-address', settings.show_contact_address, true);
  setChecked('content-show-nav-cta', settings.show_nav_cta, true);
  setChecked('content-show-hero-primary', settings.show_hero_primary, true);
  setChecked('content-show-hero-secondary', settings.show_hero_secondary, true);

  updateAllActionValueStates();
}

function checkboxSetting(id) {
  return byId(id)?.checked ? 'true' : 'false';
}

function contentSettingsPayload() {
  return {
    whatsapp_number: byId('content-whatsapp-number').value.trim(),
    whatsapp_message: byId('content-whatsapp-message').value.trim(),
    show_whatsapp: checkboxSetting('content-show-whatsapp'),

    facebook_url: byId('content-facebook-url').value.trim(),
    show_facebook: checkboxSetting('content-show-facebook'),

    instagram_url: byId('content-instagram-url').value.trim(),
    show_instagram: checkboxSetting('content-show-instagram'),

    linkedin_url: byId('content-linkedin-url').value.trim(),
    show_linkedin: checkboxSetting('content-show-linkedin'),

    contact_email: byId('content-contact-email').value.trim(),
    show_contact_email: checkboxSetting('content-show-email'),

    contact_phone: byId('content-contact-phone').value.trim(),
    show_contact_phone: checkboxSetting('content-show-phone'),

    contact_address: byId('content-contact-address').value.trim(),
    show_contact_address: checkboxSetting('content-show-address'),

    nav_prelaunch_text: byId('content-nav-prelaunch-text').value.trim(),
    nav_prelaunch_action: byId('content-nav-prelaunch-action').value,
    nav_prelaunch_value: byId('content-nav-prelaunch-value').value.trim(),

    nav_open_text: byId('content-nav-open-text').value.trim(),
    nav_open_action: byId('content-nav-open-action').value,
    nav_open_value: byId('content-nav-open-value').value.trim(),

    hero_prelaunch_text: byId('content-hero-prelaunch-text').value.trim(),
    hero_prelaunch_action: byId('content-hero-prelaunch-action').value,
    hero_prelaunch_value: byId('content-hero-prelaunch-value').value.trim(),

    hero_open_text: byId('content-hero-open-text').value.trim(),
    hero_open_action: byId('content-hero-open-action').value,
    hero_open_value: byId('content-hero-open-value').value.trim(),

    concept_button_text: byId('content-concept-button-text').value.trim(),
    concept_button_action: byId('content-concept-button-action').value,
    concept_button_value: byId('content-concept-button-value').value.trim(),

    show_nav_cta: checkboxSetting('content-show-nav-cta'),
    show_hero_primary: checkboxSetting('content-show-hero-primary'),
    show_hero_secondary: checkboxSetting('content-show-hero-secondary'),
  };
}

const actionValuePairs = [
  ['content-nav-prelaunch-action', 'content-nav-prelaunch-value'],
  ['content-nav-open-action', 'content-nav-open-value'],
  ['content-hero-prelaunch-action', 'content-hero-prelaunch-value'],
  ['content-hero-open-action', 'content-hero-open-value'],
  ['content-concept-button-action', 'content-concept-button-value'],
];

function updateActionValueState(selectId, inputId) {
  const select = byId(selectId);
  const input = byId(inputId);
  if (!select || !input) return;

  const needsValue = ['external', 'email', 'phone'].includes(select.value);
  input.disabled = !needsValue;

  if (!needsValue) {
    input.setAttribute('aria-disabled', 'true');
  } else {
    input.removeAttribute('aria-disabled');
  }
}

function updateAllActionValueStates() {
  actionValuePairs.forEach(([selectId, inputId]) => {
    updateActionValueState(selectId, inputId);
  });
}

async function loadContentSettings() {
  setStatus('content-settings-status', 'Chargement…');

  try {
    const data = await api('/api/admin/settings');
    fillContentForm(data.settings || {});
    setStatus('content-settings-status', 'Paramètres chargés.', 'success');
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      return;
    }

    setStatus('content-settings-status', error.message, 'error');
  }
}

async function saveContentSettings(event) {
  event.preventDefault();

  const form = event.currentTarget;
  if (!form.reportValidity()) return;

  const button = byId('content-save-btn');
  button.disabled = true;
  setStatus('content-settings-status', 'Enregistrement…');

  try {
    const data = await api('/api/admin/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(contentSettingsPayload()),
    });

    fillContentForm(data.settings || {});
    setStatus(
      'content-settings-status',
      'Contenu, liens et actions des boutons enregistrés.',
      'success'
    );
  } catch (error) {
    if (error.status === 401) {
      showLogin();
      return;
    }

    setStatus('content-settings-status', error.message, 'error');
  } finally {
    button.disabled = false;
  }
}


byId('login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const status = byId('login-status');
  const form = event.currentTarget;
  const payload = Object.fromEntries(new FormData(form).entries());
  status.textContent = 'Connexion…';
  status.className = 'status';
  try {
    const data = await api('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    csrfToken = data.csrfToken || '';
    form.reset();
    showDashboard(data.user);
    await Promise.all([loadDashboard(), loadSettings(), loadEmailStatus(), loadCampaigns()]);
    await loadEligibleCount();
  } catch (error) {
    status.textContent = error.message;
    status.className = 'status error';
  }
});

logoutBtn.addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST' }); } catch {}
  showLogin();
});

byId('refresh-btn').addEventListener('click', loadDashboard);
byId('filter-role').addEventListener('change', loadDashboard);
byId('filter-ville').addEventListener('change', loadDashboard);
byId('launch-settings-form').addEventListener('submit', saveSettings);
byId('preview-email-btn').addEventListener('click', loadEmailPreview);
byId('send-test-btn').addEventListener('click', sendTestEmail);
byId('campaign-form').addEventListener('submit', createCampaign);
byId('refresh-campaigns-btn').addEventListener('click', loadCampaigns);

['campaign-role', 'campaign-ville', 'only-not-notified'].forEach((id) => {
  byId(id).addEventListener('change', loadEligibleCount);
});

byId('site-status').addEventListener('change', updateSiteStatusBadge);
byId('launch-settings-form').addEventListener('input', () => { settingsDirty = true; });

document.querySelectorAll('.tab-button').forEach((button) => {
  button.addEventListener('click', () => switchTab(button.dataset.tab));
});

byId('campaign-list').addEventListener('click', (event) => {
  const button = event.target.closest('.campaign-action');
  if (button) void handleCampaignAction(button);
});

byId('content-settings-form').addEventListener('submit', saveContentSettings);
byId('content-refresh-btn').addEventListener('click', loadContentSettings);

actionValuePairs.forEach(([selectId, inputId]) => {
  byId(selectId).addEventListener('change', () => {
    updateActionValueState(selectId, inputId);
  });
});

checkSession();
```

## `public/css/styles.css`

```css
/* ============ CHARTE GRAPHIQUE — LeDomen ============ */
:root{
  --navy-900:#0A192F;
  --navy-800:#0F2440;
  --navy-700:#152C4E;
  --gold-500:#D4AF37;
  --gold-300:#E9CD7C;
  --cream-50:#F7F4EC;
  --cream-100:#F0EBDD;
  --ink-900:#0A192F;
  --slate-400:#8C97B8;
  --mist-200:#CFE0FF;
  --white:#FFFFFF;

  --font-display:'Fraunces', Georgia, serif;
  --font-body:'Plus Jakarta Sans', 'Segoe UI', sans-serif;

  --radius-lg:20px;
  --radius-md:12px;
  --radius-sm:8px;
  --container:1120px;
}

*{box-sizing:border-box;margin:0;padding:0;}
html{scroll-behavior:smooth;}
body{
  font-family:var(--font-body);
  background:var(--navy-900);
  color:var(--white);
  line-height:1.6;
  -webkit-font-smoothing:antialiased;
}
img{max-width:100%;display:block;}
a{color:inherit;}
button{font-family:inherit;cursor:pointer;}
:focus-visible{outline:2px solid var(--gold-300);outline-offset:3px;}

.wrap{max-width:var(--container);margin:0 auto;padding:0 24px;}

.eyebrow{
  display:inline-flex;align-items:center;gap:8px;
  font-size:.72rem;letter-spacing:.14em;text-transform:uppercase;
  font-weight:700;color:var(--gold-300);
}
.eyebrow::before{content:'';width:18px;height:1px;background:var(--gold-300);display:inline-block;}

h1,h2,h3{font-family:var(--font-display);font-weight:600;letter-spacing:-.01em;}

/* ---------- NAV ---------- */
.nav{
  position:sticky;top:0;z-index:40;
  background:rgba(10,25,47,.85);
  backdrop-filter:blur(10px);
  border-bottom:1px solid rgba(212,175,55,.15);
}
.nav .wrap{display:flex;align-items:center;justify-content:space-between;height:72px;}
.brand{font-family:var(--font-display);font-size:1.4rem;font-weight:700;letter-spacing:.02em;}
.brand em{font-style:normal;color:var(--gold-500);}
.nav-cta{
  background:var(--gold-500);color:var(--navy-900);border:none;
  padding:10px 20px;border-radius:999px;font-weight:700;font-size:.88rem;
  transition:transform .2s ease, box-shadow .2s ease;
}
.nav-cta:hover{transform:translateY(-1px);box-shadow:0 8px 20px rgba(212,175,55,.35);}

/* ---------- HERO ---------- */
.hero{
  position:relative;overflow:hidden;
  padding:96px 0 80px;
  background:
    radial-gradient(560px 380px at 82% -10%, rgba(212,175,55,.16), transparent 60%),
    radial-gradient(600px 400px at -10% 40%, rgba(207,224,255,.06), transparent 60%),
    var(--navy-900);
}
.hero-grid{display:grid;grid-template-columns:1.1fr .9fr;gap:56px;align-items:center;}
.hero h1{font-size:clamp(2.2rem,4vw,3.4rem);line-height:1.12;margin:18px 0 20px;}
.hero h1 .accent{color:var(--gold-500);}
.hero p.lead{color:var(--mist-200);font-size:1.08rem;max-width:52ch;margin-bottom:10px;}
.hero .tags{display:flex;flex-wrap:wrap;gap:8px;margin:20px 0 28px;}
.tag{
  font-size:.8rem;color:var(--slate-400);border:1px solid rgba(140,151,184,.35);
  padding:6px 14px;border-radius:999px;
}
.cta-row{display:flex;flex-wrap:wrap;gap:14px;margin-top:8px;}
.btn-primary{
  background:var(--gold-500);color:var(--navy-900);border:none;
  padding:16px 28px;border-radius:var(--radius-sm);font-weight:800;font-size:1rem;
  transition:transform .2s ease, box-shadow .2s ease;
}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 12px 26px rgba(212,175,55,.35);}
.btn-secondary{
  background:transparent;color:var(--white);border:1px solid rgba(255,255,255,.28);
  padding:16px 26px;border-radius:var(--radius-sm);font-weight:700;font-size:1rem;
  transition:border-color .2s ease, background .2s ease;
}
.btn-secondary:hover{border-color:var(--gold-300);background:rgba(255,255,255,.04);}

/* Signature element — le "Pass VIP" (ticket évènementiel) */
.pass-card{
  position:relative;
  background:linear-gradient(160deg, var(--navy-700), var(--navy-800));
  border:1px solid rgba(212,175,55,.35);
  border-radius:var(--radius-lg);
  padding:32px 28px;
  max-width:340px;margin-left:auto;
  box-shadow:0 30px 60px rgba(0,0,0,.45);
}
.pass-card::before,.pass-card::after{
  content:'';position:absolute;width:26px;height:26px;background:var(--navy-900);
  border-radius:50%;top:50%;transform:translateY(-50%);
}
.pass-card::before{left:-13px;}
.pass-card::after{right:-13px;}
.pass-divider{
  border-top:2px dashed rgba(212,175,55,.4);margin:20px 0;
}
.pass-label{font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;color:var(--slate-400);font-weight:700;}
.pass-count{font-family:var(--font-display);font-size:3rem;color:var(--gold-500);line-height:1;margin:8px 0;font-weight:700;}
.countdown-public{
  display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:18px 0 10px;
}
.countdown-unit{
  min-width:0;text-align:center;padding:12px 6px 10px;border-radius:10px;
  background:rgba(255,255,255,.04);border:1px solid rgba(212,175,55,.22);
}
.countdown-unit strong{
  display:block;font-family:var(--font-display);font-size:clamp(1.45rem,3vw,2rem);
  color:var(--gold-500);line-height:1;font-weight:700;font-variant-numeric:tabular-nums;
}
.countdown-unit span{
  display:block;margin-top:7px;font-size:.64rem;letter-spacing:.05em;text-transform:uppercase;color:var(--mist-200);
}
.pass-sub{color:var(--mist-200);font-size:.92rem;}
.pass-row{display:flex;justify-content:space-between;align-items:baseline;}
.pass-code{font-family:var(--font-display);font-size:1.3rem;letter-spacing:.08em;color:var(--white);}

/* ---------- SECTION GENERIQUE ---------- */
section{padding:88px 0;}
.section-dark{background:var(--navy-900);}
.section-light{background:var(--cream-50);color:var(--ink-900);}
.section-head{max-width:640px;margin-bottom:48px;}
.section-head h2{font-size:clamp(1.7rem,3vw,2.4rem);margin-top:14px;}
.section-light .eyebrow{color:#9A7B1E;}
.section-light .eyebrow::before{background:#9A7B1E;}

/* Problème */
.pain-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:14px;margin-top:8px;}
.pain-item{
  display:flex;gap:14px;align-items:flex-start;
  background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.08);
  border-radius:var(--radius-md);padding:18px 20px;
}
.pain-item .mark{color:var(--gold-500);font-weight:800;font-size:1.1rem;}

/* Comment ça marche — timeline horizontale (ordre réel = information utile) */
.steps{display:grid;grid-template-columns:repeat(4,1fr);gap:0;position:relative;margin-top:12px;}
.steps::before{
  content:'';position:absolute;top:26px;left:6%;right:6%;height:1px;
  background:repeating-linear-gradient(90deg, rgba(10,25,47,.25) 0 8px, transparent 8px 16px);
}
.step{position:relative;padding-right:18px;}
.step .num{
  width:52px;height:52px;border-radius:50%;background:var(--navy-900);color:var(--gold-500);
  display:flex;align-items:center;justify-content:center;font-family:var(--font-display);
  font-weight:700;font-size:1.2rem;margin-bottom:18px;position:relative;z-index:1;
  border:1px solid rgba(10,25,47,.15);
}
.step h3{font-size:1.05rem;margin-bottom:6px;color:var(--ink-900);}
.step p{font-size:.92rem;color:#3E4A63;}
.provider-chip-row{display:flex;flex-wrap:wrap;gap:8px;margin-top:22px;}
.chip{
  background:var(--white);border:1px solid rgba(10,25,47,.12);color:var(--ink-900);
  font-size:.82rem;padding:7px 14px;border-radius:999px;
}

/* Pour qui — cartes */
.audience-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-top:8px;}
.audience-card{
  background:rgba(255,255,255,.03);border:1px solid rgba(212,175,55,.18);
  border-radius:var(--radius-lg);padding:28px 24px;
}
.audience-card h3{color:var(--gold-300);font-size:1.15rem;margin-bottom:14px;}
.audience-card ul{list-style:none;}
.audience-card li{color:var(--mist-200);font-size:.92rem;padding:6px 0;border-top:1px solid rgba(255,255,255,.06);}
.audience-card li:first-child{border-top:none;}

/* Avantages */
.adv-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:16px;margin-top:8px;}
.adv-card{text-align:left;}
.adv-icon{
  width:44px;height:44px;border-radius:12px;background:rgba(10,25,47,.06);
  display:flex;align-items:center;justify-content:center;margin-bottom:14px;
  border:1px solid rgba(10,25,47,.1);
}
.adv-card h3{font-size:1rem;color:var(--ink-900);margin-bottom:6px;}
.adv-card p{font-size:.86rem;color:#3E4A63;}

/* Urgence / incitations */
.urgency{
  background:linear-gradient(135deg, var(--navy-800), var(--navy-900));
  border:1px solid rgba(212,175,55,.25);border-radius:var(--radius-lg);
  padding:44px;display:grid;grid-template-columns:1.2fr 1fr;gap:40px;align-items:center;
}
.perk-list{list-style:none;display:grid;gap:12px;}
.perk-list li{display:flex;gap:12px;align-items:flex-start;color:var(--mist-200);font-size:.95rem;}
.perk-list .check{color:var(--gold-500);font-weight:800;}

/* Formulaire */
.form-panel{
  background:var(--white);color:var(--ink-900);
  border-radius:var(--radius-lg);padding:40px;
  box-shadow:0 30px 70px rgba(0,0,0,.35);
}
.form-grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:22px;}
.field{display:flex;flex-direction:column;gap:6px;}
.field.full{grid-column:1 / -1;}
.field label{font-size:.82rem;font-weight:600;color:#3E4A63;}
.field input, .field select{
  padding:13px 14px;border-radius:var(--radius-sm);border:1px solid #DDE2EC;
  font-size:.95rem;font-family:inherit;background:var(--cream-50);color:var(--ink-900);
  transition:border-color .2s ease, background .2s ease;
}
.field input:focus, .field select:focus{outline:none;border-color:var(--gold-500);background:var(--white);}
.role-group{display:flex;gap:10px;flex-wrap:wrap;}
.role-option{
  border:1px solid #DDE2EC;border-radius:999px;padding:9px 18px;font-size:.86rem;
  cursor:pointer;transition:all .2s ease;
}
.role-option input{display:none;}
.role-option:has(input:checked){background:var(--navy-900);color:var(--white);border-color:var(--navy-900);}
.consent{display:flex;gap:10px;align-items:flex-start;font-size:.82rem;color:#556080;margin-top:6px;}
.consent input{margin-top:3px;}
.form-note{font-size:.78rem;color:#8892B0;margin-top:14px;}
.form-submit{
  width:100%;margin-top:22px;background:var(--navy-900);color:var(--white);
  border:none;padding:16px;border-radius:var(--radius-sm);font-weight:800;font-size:1rem;
  transition:background .2s ease;
}
.form-submit:hover{background:#132644;}

/* FAQ */
.faq-item{border-bottom:1px solid rgba(10,25,47,.1);}
.faq-q{
  width:100%;text-align:left;background:none;border:none;padding:20px 4px;
  display:flex;justify-content:space-between;align-items:center;
  font-family:var(--font-display);font-size:1.05rem;color:var(--ink-900);font-weight:600;
}
.faq-q .plus{font-size:1.3rem;color:var(--gold-500);transition:transform .25s ease;}
.faq-item.open .faq-q .plus{transform:rotate(45deg);}
.faq-a{max-height:0;overflow:hidden;transition:max-height .3s ease;}
.faq-a p{padding:0 4px 20px;color:#3E4A63;font-size:.94rem;max-width:60ch;}

/* Footer */
footer{background:var(--navy-900);border-top:1px solid rgba(212,175,55,.15);padding:56px 0 30px;}
.foot-grid{display:grid;grid-template-columns:1.4fr 1fr 1fr 1fr;gap:40px;margin-bottom:40px;}
.foot-brand p{color:var(--slate-400);font-size:.9rem;margin-top:12px;max-width:32ch;}
.foot-col h4{font-size:.82rem;text-transform:uppercase;letter-spacing:.08em;color:var(--gold-300);margin-bottom:14px;}
.foot-col a{display:block;color:var(--slate-400);font-size:.9rem;padding:5px 0;text-decoration:none;}
.foot-col a:hover{color:var(--white);}
.foot-bottom{
  border-top:1px solid rgba(255,255,255,.08);padding-top:22px;
  display:flex;justify-content:space-between;color:var(--slate-400);font-size:.82rem;flex-wrap:wrap;gap:10px;
}

/* Scroll reveal */
.reveal{opacity:0;transform:translateY(18px);transition:opacity .6s ease, transform .6s ease;}
.reveal.in{opacity:1;transform:translateY(0);}

/* Responsive */
@media (max-width: 960px){
  .hero-grid{grid-template-columns:1fr;}
  .pass-card{margin:0 auto;}
  .pain-grid{grid-template-columns:1fr;}
  .steps{grid-template-columns:1fr 1fr;row-gap:32px;}
  .steps::before{display:none;}
  .audience-grid{grid-template-columns:1fr;}
  .adv-grid{grid-template-columns:repeat(2,1fr);}
  .urgency{grid-template-columns:1fr;padding:32px;}
  .form-grid{grid-template-columns:1fr;}
  .foot-grid{grid-template-columns:1fr 1fr;}
}
@media (prefers-reduced-motion: reduce){
  .reveal{opacity:1;transform:none;transition:none;}
  html{scroll-behavior:auto;}
}

/* ---------- LOGO OFFICIEL INTÉGRÉ ---------- */
.brand-logo{display:inline-flex;align-items:center;text-decoration:none;line-height:1;}
.brand-logo img{width:190px;height:auto;max-height:62px;object-fit:contain;object-position:left center;}
footer .brand-logo img{width:220px;max-height:none;}
.nav .wrap{height:82px;}

/* ---------- FORMULAIRE CONNECTÉ ---------- */
.hp-field{position:absolute!important;left:-9999px!important;width:1px!important;height:1px!important;overflow:hidden!important;opacity:0!important;pointer-events:none!important;}
.form-status{margin-top:14px;padding:12px 14px;border-radius:8px;font-size:.88rem;display:none;}
.form-status.show{display:block;}
.form-status.success{background:#EAF7EF;color:#155D32;border:1px solid #B8DEC6;}
.form-status.error{background:#FFF0F0;color:#8A1C1C;border:1px solid #F0C2C2;}
.form-submit:disabled{opacity:.7;cursor:not-allowed;}
.stat-line{margin-top:12px;font-size:.84rem;color:var(--slate-400);}

@media (max-width: 560px){
  .wrap{padding:0 18px;}
  .nav .wrap{height:70px;gap:12px;}
  .brand-logo img{width:142px;}
  .nav-cta{padding:9px 13px;font-size:.78rem;white-space:nowrap;}
  .hero{padding:72px 0 62px;}
  section{padding:64px 0;}
  .hero h1{font-size:2.05rem;}
  .form-panel{padding:26px 20px;}
  .urgency{padding:26px 20px;}
  .adv-grid{grid-template-columns:1fr;}
  .foot-grid{grid-template-columns:1fr;}
}

.foot-placeholder{display:block;color:var(--slate-400);font-size:.9rem;padding:5px 0;}

@media (max-width: 480px){
  .countdown-public{gap:5px;}
  .countdown-unit{padding:10px 3px 8px;}
  .countdown-unit span{font-size:.56rem;}
}
```

## `public/css/admin.css`

```css
:root{--navy:#0A192F;--navy2:#152C4E;--gold:#D4AF37;--cream:#F7F4EC;--ink:#162033;--muted:#667085;--white:#fff;--border:#E3E7EE;--green:#027A48;--red:#B42318;--amber:#9A6700}
*{box-sizing:border-box}body{margin:0;font-family:'Plus Jakarta Sans',system-ui,sans-serif;background:#F4F6F9;color:var(--ink)}button,input,select,textarea{font:inherit}.admin-topbar{height:82px;background:var(--navy);display:flex;align-items:center;justify-content:space-between;padding:0 32px;border-bottom:1px solid rgba(212,175,55,.25)}.admin-logo img{width:180px;max-height:68px;object-fit:contain}.admin-actions{display:flex;gap:14px;align-items:center;color:#CFE0FF;font-size:.86rem}.admin-shell{max-width:1280px;margin:0 auto;padding:42px 24px}.panel{background:var(--white);border:1px solid var(--border);border-radius:18px;padding:26px;box-shadow:0 12px 35px rgba(10,25,47,.06)}.login-panel{max-width:460px;margin:7vh auto}.login-panel h1,.dashboard-head h1{margin:.2rem 0 8px;color:var(--navy)}.login-panel p,.subtle{color:var(--muted);line-height:1.55}.subtle{margin:.3rem 0 0;font-size:.9rem}form{display:grid;gap:16px;margin-top:24px}label{display:grid;gap:7px;font-size:.84rem;font-weight:600;color:#475467}label small{font-weight:400;color:var(--muted);line-height:1.45}input,select,textarea{width:100%;border:1px solid #D0D5DD;border-radius:9px;padding:12px;background:#fff;color:var(--ink)}textarea{resize:vertical;min-height:120px}input:focus,select:focus,textarea:focus{outline:2px solid rgba(212,175,55,.28);border-color:var(--gold)}button,.button-link{border:0;border-radius:9px;background:var(--navy);color:#fff;padding:12px 17px;font-weight:700;cursor:pointer;text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:7px}button:disabled{opacity:.5;cursor:not-allowed}.secondary{background:#fff;color:var(--navy);border:1px solid #D0D5DD}.small{padding:8px 11px;font-size:.77rem}.status{min-height:1.3em;color:var(--muted);font-size:.86rem;line-height:1.45}.status.error{color:var(--red)}.status.success{color:var(--green)}.dashboard-head{display:flex;justify-content:space-between;align-items:end;gap:24px;margin-bottom:20px}.eyebrow{text-transform:uppercase;letter-spacing:.12em;font-size:.72rem;font-weight:800;color:#8A6D14}.admin-tabs{display:flex;gap:8px;margin:0 0 22px;padding:6px;background:#E9EDF3;border-radius:12px;width:max-content;max-width:100%;overflow:auto}.tab-button{background:transparent;color:#475467;padding:10px 15px;white-space:nowrap}.tab-button.active{background:var(--white);color:var(--navy);box-shadow:0 3px 10px rgba(10,25,47,.08)}.tab-panel{display:none}.tab-panel.active{display:block}.metrics{display:grid;grid-template-columns:repeat(6,1fr);gap:14px;margin-bottom:20px}.metric{background:var(--navy);color:#fff;border-radius:15px;padding:18px;border:1px solid rgba(212,175,55,.24);min-width:0}.metric span{display:block;color:#CFE0FF;font-size:.76rem}.metric strong{font-size:1.75rem;color:var(--gold);display:block;margin-top:6px}.metric-light{background:#fff;color:var(--navy);border:1px solid var(--border)}.metric-light span{color:var(--muted)}.metric-light strong{color:var(--navy)}.filters{display:flex;gap:14px;align-items:end;flex-wrap:wrap;margin-bottom:20px}.filters label{min-width:180px}.table-wrap{overflow:auto;border:1px solid var(--border);border-radius:12px}table{width:100%;border-collapse:collapse;min-width:980px}th,td{text-align:left;padding:13px 14px;border-bottom:1px solid #EEF1F5;font-size:.82rem;vertical-align:top}th{background:#F8FAFC;color:#475467;font-size:.74rem;text-transform:uppercase;letter-spacing:.04em}tbody tr:hover{background:#FBFCFE}.pill{display:inline-block;border-radius:999px;padding:5px 9px;background:#F1F5F9;font-size:.74rem;font-weight:700;text-transform:capitalize}.consent-ok{color:var(--green);font-weight:700}.danger-label{color:var(--red);font-weight:700}.muted-label{color:var(--muted);font-weight:600}.two-col{display:grid;grid-template-columns:minmax(0,1.08fr) minmax(0,.92fr);gap:20px;align-items:start}.campaign-layout{grid-template-columns:minmax(320px,.75fr) minmax(0,1.25fr)}.stack{display:grid;gap:20px}.panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:10px}.panel-head.compact{align-items:center}.panel h2{margin:5px 0 4px;color:var(--navy);font-size:1.25rem}.status-badge{display:inline-flex;align-items:center;border-radius:999px;padding:7px 11px;background:#FFF4D6;color:var(--amber);font-size:.76rem;font-weight:800;white-space:nowrap}.status-badge.ok{background:#ECFDF3;color:var(--green)}.status-badge.bad{background:#FEF3F2;color:var(--red)}.settings-form{margin-top:18px}.button-row{display:flex;flex-wrap:wrap;gap:10px}.test-mail-row{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:end;margin-top:18px}.preview-panel{padding-bottom:18px}#email-preview{display:block;width:100%;height:540px;border:1px solid var(--border);border-radius:12px;background:#fff}.form-grid-2{display:grid;grid-template-columns:1fr 1fr;gap:12px}.check-row{display:flex;grid-template-columns:none;align-items:flex-start;gap:10px;background:#F8FAFC;border:1px solid var(--border);padding:12px;border-radius:10px}.check-row input{width:auto;margin-top:3px}.check-row span{line-height:1.45}.recipient-estimate{display:flex;justify-content:space-between;align-items:center;padding:15px 17px;background:var(--navy);color:#fff;border-radius:12px}.recipient-estimate span{font-size:.84rem;color:#CFE0FF}.recipient-estimate strong{font-size:1.7rem;color:var(--gold)}.warning-text{font-size:.77rem;line-height:1.45;color:#8A4B09;margin:0}.campaign-list{display:grid;gap:12px}.campaign-card{border:1px solid var(--border);border-radius:13px;padding:16px;background:#FBFCFE}.campaign-card-head{display:flex;justify-content:space-between;gap:12px;align-items:flex-start}.campaign-card-head strong{display:block;color:var(--navy);font-size:.94rem}.campaign-card-head small{display:block;color:var(--muted);margin-top:4px;font-size:.72rem}.campaign-card p{margin:10px 0;color:var(--muted);font-size:.78rem;text-transform:capitalize}.campaign-status{border-radius:999px;padding:6px 9px;font-size:.7rem;font-weight:800;white-space:nowrap;background:#EEF2F6;color:#475467}.status-scheduled{background:#FFF4D6;color:var(--amber)}.status-queued,.status-sending{background:#EFF8FF;color:#175CD3}.status-completed{background:#ECFDF3;color:var(--green)}.status-cancelled{background:#FEF3F2;color:var(--red)}.progress{height:7px;background:#E9EDF3;border-radius:999px;overflow:hidden}.progress span{display:block;height:100%;background:var(--gold);border-radius:999px}.campaign-numbers{display:flex;gap:12px;flex-wrap:wrap;margin-top:9px;color:#475467;font-size:.72rem}.campaign-actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:12px}.empty-state{padding:28px;text-align:center;color:var(--muted);border:1px dashed #D0D5DD;border-radius:12px}@media(max-width:1100px){.metrics{grid-template-columns:repeat(3,1fr)}.two-col,.campaign-layout{grid-template-columns:1fr}}@media(max-width:800px){.admin-topbar{padding:0 16px}.admin-logo img{width:145px}.admin-shell{padding:28px 16px}.metrics{grid-template-columns:1fr 1fr}.dashboard-head{align-items:flex-start;flex-direction:column}.panel{padding:18px}.test-mail-row{grid-template-columns:1fr}.form-grid-2{grid-template-columns:1fr}#email-preview{height:460px}}@media(max-width:480px){.metrics{grid-template-columns:1fr}.admin-actions span{display:none}.admin-tabs{width:100%}.tab-button{flex:1}.campaign-card-head{flex-direction:column}.button-row{display:grid}.button-row button{width:100%}}


/* ===== CONTENU & LIENS ===== */
.settings-group{display:grid;gap:14px;padding:20px;border:1px solid var(--border);border-radius:14px;background:#FBFCFE}
.settings-group h3{margin:0;color:var(--navy);font-size:1rem}
.settings-group .eyebrow{margin-bottom:-5px}
.settings-group .check-row{margin-top:0}
#content-settings-form{gap:18px}
#content-settings-form textarea{min-height:90px}
#content-settings-form button[type="submit"]{margin-top:4px}

/* ===== ACTIONS DES BOUTONS PUBLICS ===== */
.action-box{
  display:grid;
  gap:12px;
  padding:16px;
  border:1px solid #D9E0E9;
  border-radius:12px;
  background:#FFFFFF;
}
.action-box > strong{
  color:var(--navy);
  font-size:.88rem;
}
.action-box input:disabled{
  background:#F2F4F7;
  color:#98A2B3;
  cursor:not-allowed;
}
#content-settings-form{
  margin-top:18px;
}
#content-save-btn{
  width:100%;
}

```

## `public/legal.html`

```html
<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Mentions légales | LeDomen.com</title><link rel="icon" href="/assets/favicon.png"><link rel="stylesheet" href="/css/legal.css"></head><body><header><a href="/"><img src="/assets/logo-ledomen.png" alt="LeDomen.com"></a></header><main><h1>Mentions légales</h1><p class="warning"><strong>Informations juridiques à compléter.</strong> Les fichiers fournis ne donnent pas la raison sociale, la forme juridique, l’immatriculation, l’adresse du siège, les responsables de publication ni l’hébergeur. Ces informations ne doivent pas être inventées.</p><h2>Éditeur</h2><p>LeDomen.com — <strong>[raison sociale / forme juridique / adresse / identifiant légal à compléter]</strong>.</p><h2>Responsable de publication</h2><p><strong>[nom et qualité à compléter]</strong>.</p><h2>Hébergement</h2><p><strong>[hébergeur, adresse et coordonnées à compléter]</strong>.</p><p><a href="/">← Retour à l’accueil</a></p></main></body></html>
```

## `public/privacy.html`

```html
<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="index,follow">
  <title>Politique de confidentialité | LeDomen.com</title>
  <link rel="icon" href="/assets/favicon.png">
  <link rel="stylesheet" href="/css/legal.css">
</head>
<body>
<header><a href="/"><img src="/assets/logo-ledomen.png" alt="LeDomen.com"></a></header>
<main>
  <h1>Politique de confidentialité</h1>
  <p class="warning"><strong>À compléter avant mise en production.</strong> Cette page fournit la structure nécessaire, mais l’identité juridique du responsable du traitement, les coordonnées officielles, la durée exacte de conservation et le prestataire d’envoi d’e-mails doivent être validés par LeDomen.</p>

  <h2>Données collectées</h2>
  <p>Le formulaire de pré-lancement collecte le prénom, le nom, une adresse e-mail ou un numéro WhatsApp, la ville, le profil déclaré, la source de l’inscription et la preuve de consentement.</p>

  <h2>Finalité</h2>
  <p>Ces données sont utilisées pour informer les personnes inscrites du lancement de LeDomen.com, gérer l’accès prioritaire et adapter les communications au profil renseigné.</p>

  <h2>Base du traitement</h2>
  <p>L’envoi des informations relatives au lancement repose sur le consentement explicite donné lors de l’inscription.</p>

  <h2>Envoi des e-mails</h2>
  <p>Lorsqu’une adresse e-mail est utilisée pour l’annonce du lancement, elle peut être transmise au prestataire technique d’envoi configuré par LeDomen uniquement pour acheminer le message. Le nom de ce prestataire et ses conditions de traitement doivent être renseignés ici avant la mise en production : <strong>[prestataire SMTP à compléter]</strong>.</p>

  <h2>Désinscription</h2>
  <p>Chaque e-mail de lancement contient un lien permettant de demander la désinscription. Après confirmation, l’adresse concernée est exclue des campagnes suivantes de lancement.</p>

  <h2>Conservation et accès</h2>
  <p>Les données sont stockées dans la base de données de LeDomen et accessibles aux seules personnes autorisées. La durée de conservation doit être définie dans la politique interne avant la mise en production.</p>

  <h2>Vos demandes</h2>
  <p>Ajoutez ici l’adresse officielle permettant d’exercer les droits applicables : <strong>[adresse e-mail à compléter]</strong>.</p>
  <p><a href="/">← Retour à l’accueil</a></p>
</main>
</body>
</html>
```

## `public/terms.html`

```html
<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Conditions d’utilisation | LeDomen.com</title><link rel="icon" href="/assets/favicon.png"><link rel="stylesheet" href="/css/legal.css"></head><body><header><a href="/"><img src="/assets/logo-ledomen.png" alt="LeDomen.com"></a></header><main><h1>Conditions d’utilisation</h1><p class="warning"><strong>Version de pré-lancement.</strong> Les conditions définitives de réservation, paiement, annulation, responsabilité et relation avec les prestataires devront être rédigées et validées avant l’ouverture du service transactionnel.</p><h2>Objet actuel</h2><p>Le site de pré-lancement présente LeDomen.com et permet aux visiteurs de s’inscrire pour être informés de son ouverture.</p><h2>Inscription</h2><p>L’inscription à la liste de pré-lancement est gratuite et n’emporte aucune obligation d’achat.</p><h2>Disponibilité</h2><p>Les fonctionnalités décrites sur la landing page peuvent évoluer avant le lancement officiel.</p><p><a href="/">← Retour à l’accueil</a></p></main></body></html>
```

## `public/404.html`

```html
<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Page introuvable | LeDomen.com</title><link rel="stylesheet" href="/css/legal.css"></head><body><header><a href="/"><img src="/assets/logo-ledomen.png" alt="LeDomen.com"></a></header><main><h1>Page introuvable</h1><p>La page demandée n’existe pas ou a été déplacée.</p><p><a href="/">Retourner à l’accueil</a></p></main></body></html>
```

## `scripts/smoke-static.mjs`

```javascript
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function fail(message) {
  console.error(`CHECK FAILED: ${message}`);
  process.exitCode = 1;
}

function requireText(content, value, label) {
  if (!content.includes(value)) {
    fail(`${label}: élément manquant -> ${value}`);
  }
}

const indexHtml = read('public/index.html');
const adminHtml = read('public/admin.html');
const appJs = read('public/js/app.js');
const adminJs = read('public/js/admin.js');

if (!indexHtml.trimStart().toLowerCase().startsWith('<!doctype html>')) {
  fail('public/index.html ne commence pas par <!DOCTYPE html>.');
}

if (!adminHtml.trimStart().toLowerCase().startsWith('<!doctype html>')) {
  fail('public/admin.html ne commence pas par <!DOCTYPE html>.');
}

if (!appJs.trimStart().startsWith("'use strict';")) {
  fail("public/js/app.js ne commence pas par 'use strict';");
}

if (!adminJs.trimStart().startsWith("'use strict';")) {
  fail("public/js/admin.js ne commence pas par 'use strict';");
}

for (const id of [
  'nav-main-cta',
  'hero-main-cta',
  'concept-cta',
  'countdown-days',
  'countdown-hours',
  'countdown-minutes',
  'countdown-seconds',
  'lead-form',
  'faq-list',
  'footer-whatsapp',
  'footer-facebook',
  'footer-instagram',
  'footer-linkedin',
  'footer-contact-email',
  'footer-contact-phone',
  'footer-contact-address',
]) {
  requireText(indexHtml, `id="${id}"`, 'public/index.html');
}

for (const text of [
  'Le constat',
  'Comment ça fonctionne',
  'Une plateforme pour chaque acteur',
  'Pensé pour vous faire gagner du temps',
  "Pourquoi s'inscrire maintenant",
  'Soyez parmi les premiers',
  "Tout ce qu'il faut savoir",
]) {
  requireText(indexHtml, text, 'public/index.html');
}

for (const tab of ['leads', 'launch', 'campaigns', 'content']) {
  requireText(adminHtml, `data-tab="${tab}"`, 'public/admin.html');
  requireText(adminHtml, `data-tab-panel="${tab}"`, 'public/admin.html');
}

for (const id of [
  'content-whatsapp-number',
  'content-facebook-url',
  'content-instagram-url',
  'content-linkedin-url',
  'content-contact-email',
  'content-contact-phone',
  'content-contact-address',
  'content-nav-prelaunch-action',
  'content-nav-open-action',
  'content-hero-prelaunch-action',
  'content-hero-open-action',
  'content-concept-button-action',
]) {
  requireText(adminHtml, `id="${id}"`, 'public/admin.html');
}

if (/on(click|submit|change|input)\s*=/i.test(indexHtml)) {
  fail('public/index.html contient un gestionnaire JavaScript inline.');
}

if (/href=["']\/admin\.html/i.test(indexHtml)) {
  fail('La page publique expose un lien direct vers /admin.html.');
}

if (!process.exitCode) {
  console.log('Static smoke checks: OK');
}
```

## `deploy/nginx.conf.example`

```text
# Exemple production après installation du certificat TLS (ex. Certbot).
# Le serveur Node doit écouter uniquement sur 127.0.0.1:3000.

server {
    listen 80;
    server_name ledomen.com www.ledomen.com;
    return 301 https://ledomen.com$request_uri;
}

server {
    listen 443 ssl http2;
    server_name www.ledomen.com;

    ssl_certificate /etc/letsencrypt/live/ledomen.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ledomen.com/privkey.pem;

    return 301 https://ledomen.com$request_uri;
}

server {
    listen 443 ssl http2;
    server_name ledomen.com;

    ssl_certificate /etc/letsencrypt/live/ledomen.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/ledomen.com/privkey.pem;

    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;

        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        proxy_read_timeout 60s;
    }
}
```

## `deploy/systemd/ledomen.service.example`

```text
[Unit]
Description=LeDomen.com Node.js application
After=network.target postgresql.service

[Service]
Type=simple
User=www-data
Group=www-data
WorkingDirectory=/var/www/ledomen
EnvironmentFile=/var/www/ledomen/.env
ExecStart=/usr/bin/node /var/www/ledomen/src/server.js
Restart=always
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
```

## `.github/workflows/ci.yml`

```yaml
name: LeDomen CI

on:
  push:
    branches: [main, master]
  pull_request:

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Setup Node.js
        uses: actions/setup-node@v4
        with:
          node-version: 20

      - name: Install dependencies
        run: npm install --ignore-scripts --no-audit --no-fund

      - name: Syntax checks
        run: npm run check
```

## `.github/workflows/deploy-vps.yml`

```yaml
name: Deploy LeDomen to VPS

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Configure SSH key
        shell: bash
        env:
          SSH_PRIVATE_KEY: ${{ secrets.SSH_PRIVATE_KEY }}
          SSH_HOST: ${{ secrets.SSH_HOST }}
        run: |
          set -e
          mkdir -p ~/.ssh
          printf '%s\n' "$SSH_PRIVATE_KEY" > ~/.ssh/id_ed25519
          chmod 600 ~/.ssh/id_ed25519
          ssh-keyscan -H "$SSH_HOST" >> ~/.ssh/known_hosts

      - name: Upload project
        shell: bash
        env:
          SSH_HOST: ${{ secrets.SSH_HOST }}
          SSH_USER: ${{ secrets.SSH_USER }}
          APP_DIR: ${{ secrets.APP_DIR }}
        run: |
          set -e
          rsync -az --delete \
            --exclude '.git/' \
            --exclude '.env' \
            --exclude 'node_modules/' \
            ./ "$SSH_USER@$SSH_HOST:$APP_DIR/"

      - name: Install and restart
        shell: bash
        env:
          SSH_HOST: ${{ secrets.SSH_HOST }}
          SSH_USER: ${{ secrets.SSH_USER }}
          APP_DIR: ${{ secrets.APP_DIR }}
        run: |
          set -e
          ssh "$SSH_USER@$SSH_HOST" "cd '$APP_DIR' && npm install --omit=dev --no-audit --no-fund && npm run check && sudo systemctl restart ledomen"
```

## `.github/dependabot.yml`

```yaml
version: 2
updates:
  - package-ecosystem: "npm"
    directory: "/"
    schedule:
      interval: "weekly"
    open-pull-requests-limit: 5
```

## `README.md`

```markdown
# LeDomen.com v1.5.0

Version complète de la landing page de pré-lancement + backend PostgreSQL + administration.

## Ce qui est conservé

La landing page complète reste présente : hero, Pass VIP + compteur, constat, parcours, publics,
bénéfices, avantages d'inscription, formulaire, FAQ et footer.

## Administration

`/admin.html` contient quatre onglets :

1. Inscriptions
2. Lancement & e-mail
3. Campagnes
4. Contenu & liens

L'onglet **Contenu & liens** gère :

- WhatsApp + message prérempli
- Facebook, Instagram, LinkedIn
- e-mail, téléphone, adresse
- visibilité des liens
- textes des boutons publics
- action de chaque bouton avant/après lancement
- destinations possibles : formulaire, concept, plateforme, WhatsApp, URL externe, e-mail, téléphone, masqué

Les actions et URL sont validées côté serveur. Aucun HTML/JavaScript arbitraire n'est accepté.

## Sécurité v1.5

- sessions admin opaques et aléatoires stockées côté serveur dans PostgreSQL
- révocation réelle de session à la déconnexion
- cookie HttpOnly + SameSite=Strict ; `__Host-` + Secure en production
- jeton CSRF lié cryptographiquement à chaque session admin
- contrôle Origin/Referer pour les mutations
- anti-bruteforce persistant PostgreSQL sur le login
- journal d'audit PostgreSQL
- requêtes SQL paramétrées
- validation serveur des entrées et URL
- protection XSS côté interface
- protection CSV contre l'injection de formules
- CSP et en-têtes de sécurité
- `/api/config` n'expose que la configuration publique
- `/api/health` n'expose plus les détails SMTP/DB
- en production Node écoute par défaut sur `127.0.0.1`

Aucune application web ne peut être déclarée « impossible à pirater ». Cette version réduit
nettement la surface d'attaque, mais la production doit également utiliser HTTPS, Nginx,
un pare-feu, des sauvegardes et des secrets robustes.

## Installation locale Windows

Gardez votre `.env` actuel et ajoutez si nécessaire :

```env
BIND_HOST=0.0.0.0
TRUST_PROXY=false
EXTRA_ALLOWED_ORIGINS=
```

Puis :

```powershell
npm install
npm audit
npm run check
npm run dev
```

Ouvrir :

- http://localhost:3000
- http://localhost:3000/admin.html
- http://localhost:3000/api/health

`ensureSchema()` crée automatiquement les nouvelles tables de sécurité :
`admin_sessions`, `security_rate_limits`, `audit_logs`.

## Production

Dans `.env` :

```env
NODE_ENV=production
BIND_HOST=127.0.0.1
TRUST_PROXY=1
APP_ORIGIN=https://ledomen.com
PUBLIC_BASE_URL=https://ledomen.com
```

Utilisez un mot de passe admin long et unique, ainsi que deux secrets aléatoires distincts
d'au moins 32 caractères pour `ADMIN_SESSION_SECRET` et `UNSUBSCRIBE_SECRET`.
```
