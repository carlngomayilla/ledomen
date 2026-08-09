import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import nodemailer from 'nodemailer';
import ExcelJS from 'exceljs';

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

const isProduction =
  process.env.NODE_ENV === 'production';

const BIND_HOST = String(
  process.env.BIND_HOST ||
  (isProduction ? '127.0.0.1' : '0.0.0.0')
).trim();

const APP_ORIGIN = String(
  process.env.APP_ORIGIN ||
  `http://localhost:${PORT}`
).replace(/\/$/, '');

const PUBLIC_BASE_URL = String(
  process.env.PUBLIC_BASE_URL ||
  APP_ORIGIN
).replace(/\/$/, '');

const EXTRA_ALLOWED_ORIGINS = String(
  process.env.EXTRA_ALLOWED_ORIGINS || ''
)
  .split(',')
  .map((value) =>
    value.trim().replace(/\/$/, '')
  )
  .filter(Boolean);

const DEVELOPMENT_ORIGINS =
  isProduction
    ? []
    : [
        `http://localhost:${PORT}`,
        `http://127.0.0.1:${PORT}`,
      ];

const ALLOWED_ORIGINS = new Set([
  APP_ORIGIN,
  ...DEVELOPMENT_ORIGINS,
  ...EXTRA_ALLOWED_ORIGINS,
]);

const TRUST_PROXY = String(
  process.env.TRUST_PROXY ??
  (isProduction ? '1' : 'false')
).trim();

const ADMIN_USER =
  process.env.ADMIN_USER ||
  'admin@ledomen.com';

const ADMIN_PASSWORD =
  process.env.ADMIN_PASSWORD ||
  '';

const ADMIN_SESSION_SECRET =
  process.env.ADMIN_SESSION_SECRET ||
  '';

const UNSUBSCRIBE_SECRET =
  process.env.UNSUBSCRIBE_SECRET ||
  ADMIN_SESSION_SECRET;

const ADMIN_SESSION_HOURS =
  Math.max(
    1,
    Number(
      process.env.ADMIN_SESSION_HOURS ||
      8
    )
  );

const EARLY_ACCESS_LIMIT =
  Math.max(
    1,
    Number(
      process.env.EARLY_ACCESS_LIMIT ||
      100
    )
  );

const LAUNCH_DATE =
  process.env.LAUNCH_DATE ||
  '2026-09-15T00:00:00+01:00';

const EMAIL_BATCH_SIZE =
  Math.min(
    50,
    Math.max(
      1,
      Number(
        process.env.EMAIL_BATCH_SIZE ||
        10
      )
    )
  );

const EMAIL_MAX_ATTEMPTS =
  Math.min(
    10,
    Math.max(
      1,
      Number(
        process.env.EMAIL_MAX_ATTEMPTS ||
        3
      )
    )
  );

const EMAIL_WORKER_INTERVAL_MS =
  Math.max(
    5_000,
    Number(
      process.env.EMAIL_WORKER_INTERVAL_MS ||
      15_000
    )
  );

const SMTP_HOST =
  String(
    process.env.SMTP_HOST || ''
  ).trim();

const SMTP_PORT =
  Math.max(
    1,
    Number(
      process.env.SMTP_PORT ||
      587
    )
  );

const SMTP_SECURE =
  String(
    process.env.SMTP_SECURE || ''
  ).toLowerCase() === 'true' ||
  SMTP_PORT === 465;

const SMTP_USER =
  String(
    process.env.SMTP_USER || ''
  ).trim();

const SMTP_PASS =
  String(
    process.env.SMTP_PASS || ''
  );

const SMTP_FROM_EMAIL =
  String(
    process.env.SMTP_FROM_EMAIL || ''
  ).trim();

const SMTP_FROM_NAME =
  String(
    process.env.SMTP_FROM_NAME ||
    'LeDomen.com'
  ).trim();

const mailConfigured =
  Boolean(
    SMTP_HOST &&
    SMTP_FROM_EMAIL
  );

const mailTransporter =
  mailConfigured
    ? nodemailer.createTransport({
        host: SMTP_HOST,
        port: SMTP_PORT,
        secure: SMTP_SECURE,

        auth: SMTP_USER
          ? {
              user: SMTP_USER,
              pass: SMTP_PASS,
            }
          : undefined,

        pool: true,
        maxConnections: 3,
        maxMessages: 100,

        disableFileAccess: true,
        disableUrlAccess: true,
      })
    : null;

const DEFAULT_SETTINGS = {
  site_status: 'prelaunch',

  platform_url: '',

  launch_date:
    LAUNCH_DATE,

  promo_code: '',

  sender_name:
    SMTP_FROM_NAME ||
    'LeDomen.com',

  email_subject:
    'LeDomen.com est maintenant disponible',

  email_intro:
    'Bonne nouvelle : la plateforme LeDomen.com est officiellement ouverte. Vous pouvez maintenant rechercher, comparer et réserver vos espaces et prestataires événementiels.',

  whatsapp_number: '',

  whatsapp_message:
    'Bonjour, je souhaite des informations sur LeDomen.com.',

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

  contact_address:
    'Libreville — Gabon',

  show_contact_address:
    'true',

  nav_prelaunch_text:
    'Être informé',

  nav_prelaunch_action:
    'signup',

  nav_prelaunch_value:
    '',

  nav_open_text:
    'Accéder à la plateforme',

  nav_open_action:
    'platform',

  nav_open_value:
    '',

  hero_prelaunch_text:
    'Je veux être informé du lancement',

  hero_prelaunch_action:
    'signup',

  hero_prelaunch_value:
    '',

  hero_open_text:
    'Accéder à LeDomen',

  hero_open_action:
    'platform',

  hero_open_value:
    '',

  concept_button_text:
    'Découvrir le concept',

  concept_button_action:
    'concept',

  concept_button_value:
    '',

  show_nav_cta:
    'true',

  show_hero_primary:
    'true',

  show_hero_secondary:
    'true',
};

if (!process.env.DATABASE_URL) {
  console.error(
    'DATABASE_URL est obligatoire. Copiez .env.example vers .env et configurez PostgreSQL.'
  );

  process.exit(1);
}

if (
  !ADMIN_PASSWORD ||
  !ADMIN_SESSION_SECRET
) {
  console.error(
    'ADMIN_PASSWORD et ADMIN_SESSION_SECRET sont obligatoires.'
  );

  process.exit(1);
}

if (
  isProduction &&
  (
    !ADMIN_PASSWORD ||
    ADMIN_PASSWORD.startsWith(
      'change-'
    ) ||
    ADMIN_PASSWORD.length < 14 ||
    !ADMIN_SESSION_SECRET ||
    ADMIN_SESSION_SECRET.startsWith(
      'change-'
    ) ||
    ADMIN_SESSION_SECRET.length < 32
  )
) {
  console.error(
    'Sécurité: configurez un mot de passe admin robuste et ADMIN_SESSION_SECRET (32 caractères minimum) avant la production.'
  );

  process.exit(1);
}

if (
  isProduction &&
  (
    !UNSUBSCRIBE_SECRET ||
    UNSUBSCRIBE_SECRET.startsWith(
      'change-'
    ) ||
    UNSUBSCRIBE_SECRET.length < 32
  )
) {
  console.error(
    'Sécurité: configurez UNSUBSCRIBE_SECRET (32 caractères minimum) avant la production.'
  );

  process.exit(1);
}

app.disable(
  'x-powered-by'
);

if (
  TRUST_PROXY === 'false' ||
  TRUST_PROXY === '0' ||
  TRUST_PROXY === ''
) {
  app.set(
    'trust proxy',
    false
  );
} else if (
  /^\d+$/.test(
    TRUST_PROXY
  )
) {
  app.set(
    'trust proxy',
    Number(
      TRUST_PROXY
    )
  );
} else {
  app.set(
    'trust proxy',
    TRUST_PROXY
  );
}

app.use(
  express.json({
    limit: '64kb',
  })
);

app.use(
  express.urlencoded({
    extended: false,
    limit: '64kb',
  })
);

app.use(
  (
    req,
    res,
    next
  ) => {
    res.setHeader(
      'X-Content-Type-Options',
      'nosniff'
    );

    res.setHeader(
      'Referrer-Policy',
      'strict-origin-when-cross-origin'
    );

    res.setHeader(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()'
    );

    res.setHeader(
      'X-Frame-Options',
      'DENY'
    );

    res.setHeader(
      'X-DNS-Prefetch-Control',
      'off'
    );

    res.setHeader(
      'Cross-Origin-Opener-Policy',
      'same-origin'
    );

    res.setHeader(
      'Cross-Origin-Resource-Policy',
      'same-origin'
    );

    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    );

    if (
      req.path === '/admin.html' ||
      req.path.startsWith(
        '/api/admin/'
      )
    ) {
      res.setHeader(
        'Cache-Control',
        'no-store'
      );

      res.setHeader(
        'Pragma',
        'no-cache'
      );
    }

    if (
      isProduction
    ) {
      res.setHeader(
        'Strict-Transport-Security',
        'max-age=31536000; includeSubDomains'
      );
    }

    next();
  }
);

function rateLimit({
  windowMs,
  max,
}) {
  const buckets =
    new Map();

  let operations = 0;

  return (
    req,
    res,
    next
  ) => {
    const key =
      req.ip ||
      req.socket.remoteAddress ||
      'unknown';

    const now =
      Date.now();

    operations += 1;

    if (
      operations %
      500 ===
      0
    ) {
      for (
        const [
          bucketKey,
          bucket,
        ] of buckets.entries()
      ) {
        if (
          bucket.resetAt <=
          now
        ) {
          buckets.delete(
            bucketKey
          );
        }
      }
    }

    const current =
      buckets.get(
        key
      );

    if (
      !current ||
      current.resetAt <=
      now
    ) {
      buckets.set(
        key,
        {
          count: 1,
          resetAt:
            now +
            windowMs,
        }
      );

      return next();
    }

    current.count += 1;

    if (
      current.count >
      max
    ) {
      const retryAfter =
        Math.ceil(
          (
            current.resetAt -
            now
          ) /
          1000
        );

      res.setHeader(
        'Retry-After',
        String(
          retryAfter
        )
      );

      return res
        .status(429)
        .json({
          ok: false,
          message:
            'Trop de tentatives. Réessayez dans quelques minutes.',
        });
    }

    next();
  };
}

function sameOriginOnly(
  req,
  res,
  next
) {
  const origin =
    String(
      req.get(
        'origin'
      ) || ''
    )
      .trim()
      .replace(
        /\/$/,
        ''
      );

  const referer =
    String(
      req.get(
        'referer'
      ) || ''
    ).trim();

  if (
    origin &&
    ALLOWED_ORIGINS.has(
      origin
    )
  ) {
    return next();
  }

  if (
    !origin &&
    referer
  ) {
    try {
      const refererOrigin =
        new URL(
          referer
        ).origin;

      if (
        ALLOWED_ORIGINS.has(
          refererOrigin
        )
      ) {
        return next();
      }
    } catch {
      // Refus plus bas.
    }
  }

  if (
    !isProduction &&
    !origin &&
    !referer
  ) {
    return next();
  }

  return res
    .status(403)
    .json({
      ok: false,
      message:
        'Origine non autorisée.',
    });
}

function cleanText(
  value,
  max = 80
) {
  return String(
    value ?? ''
  )
    .trim()
    .replace(
      /\s+/g,
      ' '
    )
    .slice(
      0,
      max
    );
}

function cleanMultiline(
  value,
  max = 2000
) {
  return String(
    value ?? ''
  )
    .trim()
    .replace(
      /\r\n/g,
      '\n'
    )
    .slice(
      0,
      max
    );
}

function normalizeContact(
  raw
) {
  const value =
    String(
      raw ?? ''
    ).trim();

  const email =
    value.toLowerCase();

  const emailOk =
    /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(
      email
    );

  if (
    emailOk
  ) {
    return {
      type: 'email',
      raw: value,
      normalized:
        email,
    };
  }

  const phone =
    value
      .replace(
        /[^\d+]/g,
        ''
      )
      .replace(
        /(?!^)\+/g,
        ''
      );

  const digits =
    phone.replace(
      /\D/g,
      ''
    );

  if (
    digits.length >=
      7 &&
    digits.length <=
      16
  ) {
    return {
      type:
        'whatsapp',

      raw:
        value,

      normalized:
        phone,
    };
  }

  return null;
}

function normalizeEmail(
  raw
) {
  const contact =
    normalizeContact(
      raw
    );

  return contact?.type ===
    'email'
    ? contact.normalized
    : null;
}

function normalizeHttpUrl(
  raw,
  {
    allowEmpty = false,
  } = {}
) {
  const value =
    String(
      raw ?? ''
    ).trim();

  if (
    !value &&
    allowEmpty
  ) {
    return '';
  }

  try {
    const url =
      new URL(
        value
      );

    if (
      ![
        'http:',
        'https:',
      ].includes(
        url.protocol
      )
    ) {
      return null;
    }

    return url
      .toString()
      .replace(
        /\/$/,
        ''
      );
  } catch {
    return null;
  }
}

function normalizeBooleanSetting(
  value,
  fallback = true
) {
  if (
    value === undefined ||
    value === null ||
    value === ''
  ) {
    return fallback
      ? 'true'
      : 'false';
  }

  const normalized =
    String(
      value
    )
      .trim()
      .toLowerCase();

  return [
    '1',
    'true',
    'on',
    'yes',
    'oui',
  ].includes(
    normalized
  )
    ? 'true'
    : 'false';
}

function normalizeWhatsappNumber(
  raw,
  {
    allowEmpty = true,
  } = {}
) {
  const value =
    String(
      raw ?? ''
    ).trim();

  if (
    !value &&
    allowEmpty
  ) {
    return '';
  }

  const digits =
    value.replace(
      /\D/g,
      ''
    );

  if (
    digits.length <
      7 ||
    digits.length >
      15
  ) {
    return null;
  }

  return digits;
}

function normalizeOptionalEmail(
  raw
) {
  const value =
    String(
      raw ?? ''
    )
      .trim()
      .toLowerCase();

  if (
    !value
  ) {
    return '';
  }

  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/i.test(
    value
  )
    ? value
    : null;
}

function buildWhatsappUrl(
  number,
  message = ''
) {
  const digits =
    String(
      number || ''
    ).replace(
      /\D/g,
      ''
    );

  if (
    !digits
  ) {
    return '';
  }

  const url =
    new URL(
      `https://wa.me/${digits}`
    );

  const text =
    String(
      message || ''
    ).trim();

  if (
    text
  ) {
    url.searchParams.set(
      'text',
      text
    );
  }

  return url.toString();
}

const PUBLIC_ACTIONS =
  new Set([
    'signup',
    'concept',
    'platform',
    'whatsapp',
    'external',
    'email',
    'phone',
    'hidden',
  ]);

function normalizePhone(
  raw,
  {
    allowEmpty = true,
  } = {}
) {
  const value =
    String(
      raw ?? ''
    ).trim();

  if (
    !value &&
    allowEmpty
  ) {
    return '';
  }

  const normalized =
    value
      .replace(
        /[^\d+]/g,
        ''
      )
      .replace(
        /(?!^)\+/g,
        ''
      );

  const digits =
    normalized.replace(
      /\D/g,
      ''
    );

  if (
    digits.length <
      7 ||
    digits.length >
      16
  ) {
    return null;
  }

  return normalized;
}

function sanitizePublicAction(
  actionRaw,
  valueRaw,
  fieldLabel
) {
  const action =
    cleanText(
      actionRaw,
      24
    ).toLowerCase();

  const value =
    cleanText(
      valueRaw,
      500
    );

  if (
    !PUBLIC_ACTIONS.has(
      action
    )
  ) {
    return {
      error:
        `${fieldLabel} : action invalide.`,
    };
  }

  if (
    [
      'signup',
      'concept',
      'platform',
      'whatsapp',
      'hidden',
    ].includes(
      action
    )
  ) {
    return {
      action,
      value: '',
    };
  }

  if (
    action ===
    'external'
  ) {
    const url =
      normalizeHttpUrl(
        value,
        {
          allowEmpty:
            false,
        }
      );

    if (
      !url
    ) {
      return {
        error:
          `${fieldLabel} : URL externe invalide.`,
      };
    }

    return {
      action,
      value: url,
    };
  }

  if (
    action ===
    'email'
  ) {
    const email =
      normalizeOptionalEmail(
        value
      );

    if (
      !email
    ) {
      return {
        error:
          `${fieldLabel} : adresse e-mail invalide.`,
      };
    }

    return {
      action,
      value: email,
    };
  }

  if (
    action ===
    'phone'
  ) {
    const phone =
      normalizePhone(
        value,
        {
          allowEmpty:
            false,
        }
      );

    if (
      !phone
    ) {
      return {
        error:
          `${fieldLabel} : numéro de téléphone invalide.`,
      };
    }

    return {
      action,
      value: phone,
    };
  }

  return {
    error:
      `${fieldLabel} : action invalide.`,
  };
}

function resolvePublicAction(
  action,
  value,
  settings
) {
  switch (
    action
  ) {
    case 'signup':
      return {
        type:
          'scroll',
        target:
          'inscription',
      };

    case 'concept':
      return {
        type:
          'scroll',
        target:
          'concept',
      };

    case 'platform':
      return settings.platform_url
        ? {
            type:
              'url',
            href:
              settings.platform_url,
          }
        : {
            type:
              'hidden',
          };

    case 'whatsapp': {
      const href =
        buildWhatsappUrl(
          settings.whatsapp_number,
          settings.whatsapp_message
        );

      return href
        ? {
            type:
              'url',
            href,
          }
        : {
            type:
              'hidden',
          };
    }

    case 'external': {
      const href =
        normalizeHttpUrl(
          value,
          {
            allowEmpty:
              true,
          }
        );

      return href
        ? {
            type:
              'url',
            href,
          }
        : {
            type:
              'hidden',
          };
    }

    case 'email': {
      const email =
        normalizeOptionalEmail(
          value
        );

      return email
        ? {
            type:
              'url',
            href:
              `mailto:${email}`,
          }
        : {
            type:
              'hidden',
          };
    }

    case 'phone': {
      const phone =
        normalizePhone(
          value,
          {
            allowEmpty:
              true,
          }
        );

      return phone
        ? {
            type:
              'url',
            href:
              `tel:${phone}`,
          }
        : {
            type:
              'hidden',
          };
    }

    case 'hidden':
    default:
      return {
        type:
          'hidden',
      };
  }
}

function validateLead(
  body
) {
  const prenom =
    cleanText(
      body.prenom,
      80
    );

  const nom =
    cleanText(
      body.nom,
      80
    );

  const ville =
    cleanText(
      body.ville,
      80
    );

  const role =
    cleanText(
      body.role,
      32
    ).toLowerCase();

  const consent =
    body.consent ===
      true ||
    body.consent ===
      'true' ||
    body.consent ===
      'on' ||
    body.consent ===
      '1';

  const website =
    cleanText(
      body.website,
      120
    );

  const contact =
    normalizeContact(
      body.contact
    );

  if (
    website
  ) {
    return {
      spam: true,
    };
  }

  if (
    prenom.length <
    2
  ) {
    return {
      error:
        'Veuillez saisir un prénom valide.',
    };
  }

  if (
    nom.length <
    2
  ) {
    return {
      error:
        'Veuillez saisir un nom valide.',
    };
  }

  if (
    !contact
  ) {
    return {
      error:
        'Saisissez une adresse e-mail ou un numéro WhatsApp valide.',
    };
  }

  if (
    ![
      'Libreville',
      'Port-Gentil',
      'Franceville',
      'Autre',
    ].includes(
      ville
    )
  ) {
    return {
      error:
        'Veuillez sélectionner une ville valide.',
    };
  }

  if (
    ![
      'organisateur',
      'entreprise',
      'prestataire',
    ].includes(
      role
    )
  ) {
    return {
      error:
        'Veuillez sélectionner un profil valide.',
    };
  }

  if (
    !consent
  ) {
    return {
      error:
        'Votre consentement est requis pour l’inscription.',
    };
  }

  return {
    lead: {
      prenom,
      nom,

      contactRaw:
        contact.raw,

      contactNormalized:
        contact.normalized,

      contactType:
        contact.type,

      ville,
      role,
    },
  };
}

function b64url(
  input
) {
  return Buffer
    .from(
      input
    )
    .toString(
      'base64url'
    );
}

function safeEqualBuffer(
  a,
  b
) {
  const aa =
    Buffer.from(
      String(a)
    );

  const bb =
    Buffer.from(
      String(b)
    );

  return (
    aa.length ===
      bb.length &&
    crypto.timingSafeEqual(
      aa,
      bb
    )
  );
}

function safeEqualString(
  a,
  b
) {
  const aa =
    crypto
      .createHash(
        'sha256'
      )
      .update(
        String(a)
      )
      .digest();

  const bb =
    crypto
      .createHash(
        'sha256'
      )
      .update(
        String(b)
      )
      .digest();

  return crypto.timingSafeEqual(
    aa,
    bb
  );
}

function sha256(
  value
) {
  return crypto
    .createHash(
      'sha256'
    )
    .update(
      String(
        value
      )
    )
    .digest(
      'hex'
    );
}

function randomToken(
  bytes = 32
) {
  return crypto
    .randomBytes(
      bytes
    )
    .toString(
      'base64url'
    );
}

function sessionCookieName() {
  return isProduction
    ? '__Host-ledomen_admin'
    : 'ledomen_admin';
}

function sessionCookieValue(
  token
) {
  const parts = [
    `${sessionCookieName()}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];

  if (
    isProduction
  ) {
    parts.push(
      'Secure'
    );
  }

  return parts.join(
    '; '
  );
}

function expiredSessionCookieValue() {
  const parts = [
    `${sessionCookieName()}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
  ];

  if (
    isProduction
  ) {
    parts.push(
      'Secure'
    );
  }

  return parts.join(
    '; '
  );
}

function requestFingerprint(
  req
) {
  return sha256(
    String(
      req.get(
        'user-agent'
      ) || ''
    ).slice(
      0,
      500
    )
  );
}

function requestIpHash(
  req
) {
  const ip =
    String(
      req.ip ||
      req.socket.remoteAddress ||
      'unknown'
    );

  return crypto
    .createHmac(
      'sha256',
      ADMIN_SESSION_SECRET ||
      'development'
    )
    .update(
      ip
    )
    .digest(
      'hex'
    );
}

function csrfTokenForSessionHash(
  tokenHash
) {
  return crypto
    .createHmac(
      'sha256',
      ADMIN_SESSION_SECRET
    )
    .update(
      `csrf:${tokenHash}`
    )
    .digest(
      'base64url'
    );
}

function signUnsubscribe(
  leadId,
  email
) {
  const body =
    b64url(
      JSON.stringify({
        v: 1,
        leadId:
          Number(
            leadId
          ),
        email:
          String(
            email
          ).toLowerCase(),
      })
    );

  const sig =
    crypto
      .createHmac(
        'sha256',
        UNSUBSCRIBE_SECRET
      )
      .update(
        body
      )
      .digest(
        'base64url'
      );

  return `${body}.${sig}`;
}

function verifyUnsubscribe(
  token
) {
  if (
    !token ||
    !UNSUBSCRIBE_SECRET
  ) {
    return null;
  }

  const [
    body,
    sig,
  ] =
    String(
      token
    ).split(
      '.'
    );

  if (
    !body ||
    !sig
  ) {
    return null;
  }

  const expected =
    crypto
      .createHmac(
        'sha256',
        UNSUBSCRIBE_SECRET
      )
      .update(
        body
      )
      .digest(
        'base64url'
      );

  if (
    !safeEqualBuffer(
      sig,
      expected
    )
  ) {
    return null;
  }

  try {
    const payload =
      JSON.parse(
        Buffer
          .from(
            body,
            'base64url'
          )
          .toString(
            'utf8'
          )
      );

    if (
      payload.v !== 1 ||
      !Number.isInteger(
        payload.leadId
      ) ||
      !normalizeEmail(
        payload.email
      )
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

function parseCookies(
  req
) {
  const out = {};

  const raw =
    req.headers.cookie ||
    '';

  for (
    const part of raw.split(
      ';'
    )
  ) {
    const idx =
      part.indexOf(
        '='
      );

    if (
      idx > -1
    ) {
      out[
        part
          .slice(
            0,
            idx
          )
          .trim()
      ] =
        decodeURIComponent(
          part
            .slice(
              idx + 1
            )
            .trim()
        );
    }
  }

  return out;
}

async function requireAdmin(
  req,
  res,
  next
) {
  try {
    const rawToken =
      parseCookies(
        req
      )[
        sessionCookieName()
      ];

    if (
      !rawToken ||
      !/^[A-Za-z0-9_-]{40,180}$/.test(
        rawToken
      )
    ) {
      return res
        .status(401)
        .json({
          ok: false,
          message:
            'Authentification requise.',
        });
    }

    const tokenHash =
      sha256(
        rawToken
      );

    const session =
      await getAdminSessionByTokenHash(
        tokenHash
      );

    if (
      !session ||
      session.admin_user !==
        ADMIN_USER ||
      (
        session.user_agent_hash &&
        session.user_agent_hash !==
          requestFingerprint(
            req
          )
      )
    ) {
      res.setHeader(
        'Set-Cookie',
        expiredSessionCookieValue()
      );

      return res
        .status(401)
        .json({
          ok: false,
          message:
            'Session expirée ou invalide.',
        });
    }

    req.admin = {
      user:
        session.admin_user,

      sessionId:
        session.id,

      tokenHash,

      csrfHash:
        session.csrf_hash,

      expiresAt:
        session.expires_at,
    };

    const lastSeen =
      new Date(
        session.last_seen_at
      ).getTime();

    if (
      !Number.isNaN(
        lastSeen
      ) &&
      Date.now() -
        lastSeen >
        5 *
        60 *
        1000
    ) {
      void touchAdminSession(
        session.id
      ).catch(
        (
          error
        ) => {
          console.error(
            'Session touch:',
            error?.message ||
            error
          );
        }
      );
    }

    next();
  } catch (
    error
  ) {
    next(
      error
    );
  }
}

function requireCsrf(
  req,
  res,
  next
) {
  const token =
    String(
      req.get(
        'x-csrf-token'
      ) || ''
    ).trim();

  if (
    !token ||
    !req.admin?.tokenHash
  ) {
    return res
      .status(403)
      .json({
        ok: false,
        message:
          'Jeton de sécurité manquant. Rechargez l’administration.',
      });
  }

  const expected =
    csrfTokenForSessionHash(
      req.admin.tokenHash
    );

  if (
    !safeEqualString(
      token,
      expected
    ) ||
    (
      req.admin.csrfHash &&
      !safeEqualString(
        sha256(
          token
        ),
        req.admin.csrfHash
      )
    )
  ) {
    return res
      .status(403)
      .json({
        ok: false,
        message:
          'Jeton de sécurité invalide. Rechargez l’administration.',
      });
  }

  next();
}

async function audit(
  req,
  {
    action,
    target = null,
    success = true,
    details = {},
    adminUser =
      req.admin?.user ||
      null,
  } = {}
) {
  try {
    await writeAuditLog({
      adminUser,
      action,
      target,
      success,

      ipHash:
        requestIpHash(
          req
        ),

      userAgent:
        cleanText(
          req.get(
            'user-agent'
          ),
          500
        ),

      details,
    });
  } catch (
    error
  ) {
    console.error(
      'Audit log:',
      error?.message ||
      error
    );
  }
}

function safeExcelText(
  value
) {
  const text =
    value == null
      ? ''
      : String(
          value
        );

  return /^[=+\-@\t\r]/.test(
    text
  )
    ? `'${text}`
    : text;
}

function escapeHtml(
  value
) {
  return String(
    value ?? ''
  ).replace(
    /[&<>"']/g,
    (
      char
    ) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    })[
      char
    ]
  );
}

async function getResolvedSettings() {
  const saved =
    await getAppSettings();

  return {
    ...DEFAULT_SETTINGS,
    ...saved,
  };
}

function sanitizeSettings(
  body,
  {
    requirePlatformUrl = false,
  } = {}
) {
  const siteStatus =
    cleanText(
      body.site_status ??
      body.siteStatus,
      24
    ).toLowerCase() ||
    'prelaunch';

  if (
    ![
      'prelaunch',
      'open',
    ].includes(
      siteStatus
    )
  ) {
    return {
      error:
        'Statut de la plateforme invalide.',
    };
  }

  const rawPlatformUrl =
    body.platform_url ??
    body.platformUrl ??
    '';

  const platformUrl =
    normalizeHttpUrl(
      rawPlatformUrl,
      {
        allowEmpty:
          !requirePlatformUrl &&
          siteStatus !==
            'open',
      }
    );

  if (
    platformUrl ===
      null ||
    (
      requirePlatformUrl &&
      !platformUrl
    )
  ) {
    return {
      error:
        'Renseignez une URL de plateforme valide en http:// ou https://.',
    };
  }

  if (
    siteStatus ===
      'open' &&
    !platformUrl
  ) {
    return {
      error:
        'L’URL de la plateforme est obligatoire lorsque le statut est « Ouvert ».',
    };
  }

  const launchDateRaw =
    String(
      body.launch_date ??
      body.launchDate ??
      LAUNCH_DATE
    ).trim();

  const launchDate =
    new Date(
      launchDateRaw
    );

  if (
    Number.isNaN(
      launchDate.getTime()
    )
  ) {
    return {
      error:
        'Date de lancement invalide.',
    };
  }

  const subject =
    cleanText(
      body.email_subject ??
      body.emailSubject ??
      DEFAULT_SETTINGS.email_subject,
      180
    );

  const intro =
    cleanMultiline(
      body.email_intro ??
      body.emailIntro ??
      DEFAULT_SETTINGS.email_intro,
      1800
    );

  const senderName =
    cleanText(
      body.sender_name ??
      body.senderName ??
      DEFAULT_SETTINGS.sender_name,
      100
    );

  if (
    subject.length <
    4
  ) {
    return {
      error:
        'L’objet de l’e-mail est trop court.',
    };
  }

  if (
    intro.length <
    10
  ) {
    return {
      error:
        'Le message d’introduction est trop court.',
    };
  }

  if (
    senderName.length <
    2
  ) {
    return {
      error:
        'Le nom d’expéditeur est invalide.',
    };
  }

  const whatsappNumber =
    normalizeWhatsappNumber(
      body.whatsapp_number ??
      DEFAULT_SETTINGS.whatsapp_number
    );

  if (
    whatsappNumber ===
    null
  ) {
    return {
      error:
        'Le numéro WhatsApp est invalide.',
    };
  }

  const facebookUrl =
    normalizeHttpUrl(
      body.facebook_url ??
      DEFAULT_SETTINGS.facebook_url,
      {
        allowEmpty:
          true,
      }
    );

  const instagramUrl =
    normalizeHttpUrl(
      body.instagram_url ??
      DEFAULT_SETTINGS.instagram_url,
      {
        allowEmpty:
          true,
      }
    );

  const linkedinUrl =
    normalizeHttpUrl(
      body.linkedin_url ??
      DEFAULT_SETTINGS.linkedin_url,
      {
        allowEmpty:
          true,
      }
    );

  if (
    facebookUrl ===
    null
  ) {
    return {
      error:
        'Le lien Facebook est invalide.',
    };
  }

  if (
    instagramUrl ===
    null
  ) {
    return {
      error:
        'Le lien Instagram est invalide.',
    };
  }

  if (
    linkedinUrl ===
    null
  ) {
    return {
      error:
        'Le lien LinkedIn est invalide.',
    };
  }

  const contactEmail =
    normalizeOptionalEmail(
      body.contact_email ??
      DEFAULT_SETTINGS.contact_email
    );

  if (
    contactEmail ===
    null
  ) {
    return {
      error:
        'L’adresse e-mail de contact est invalide.',
    };
  }

  const contactPhone =
    normalizePhone(
      body.contact_phone ??
      DEFAULT_SETTINGS.contact_phone,
      {
        allowEmpty:
          true,
      }
    );

  if (
    contactPhone ===
    null
  ) {
    return {
      error:
        'Le numéro de téléphone public est invalide.',
    };
  }

  const navPrelaunchAction =
    sanitizePublicAction(
      body.nav_prelaunch_action ??
      DEFAULT_SETTINGS.nav_prelaunch_action,

      body.nav_prelaunch_value ??
      DEFAULT_SETTINGS.nav_prelaunch_value,

      'Bouton navigation avant lancement'
    );

  if (
    navPrelaunchAction.error
  ) {
    return navPrelaunchAction;
  }

  const navOpenAction =
    sanitizePublicAction(
      body.nav_open_action ??
      DEFAULT_SETTINGS.nav_open_action,

      body.nav_open_value ??
      DEFAULT_SETTINGS.nav_open_value,

      'Bouton navigation après ouverture'
    );

  if (
    navOpenAction.error
  ) {
    return navOpenAction;
  }

  const heroPrelaunchAction =
    sanitizePublicAction(
      body.hero_prelaunch_action ??
      DEFAULT_SETTINGS.hero_prelaunch_action,

      body.hero_prelaunch_value ??
      DEFAULT_SETTINGS.hero_prelaunch_value,

      'Bouton principal avant lancement'
    );

  if (
    heroPrelaunchAction.error
  ) {
    return heroPrelaunchAction;
  }

  const heroOpenAction =
    sanitizePublicAction(
      body.hero_open_action ??
      DEFAULT_SETTINGS.hero_open_action,

      body.hero_open_value ??
      DEFAULT_SETTINGS.hero_open_value,

      'Bouton principal après ouverture'
    );

  if (
    heroOpenAction.error
  ) {
    return heroOpenAction;
  }

  const conceptButtonAction =
    sanitizePublicAction(
      body.concept_button_action ??
      DEFAULT_SETTINGS.concept_button_action,

      body.concept_button_value ??
      DEFAULT_SETTINGS.concept_button_value,

      'Bouton secondaire'
    );

  if (
    conceptButtonAction.error
  ) {
    return conceptButtonAction;
  }

  return {
    settings: {
      site_status:
        siteStatus,

      platform_url:
        platformUrl ||
        '',

      launch_date:
        launchDate.toISOString(),

      promo_code:
        cleanText(
          body.promo_code ??
          body.promoCode,
          80
        ),

      sender_name:
        senderName,

      email_subject:
        subject,

      email_intro:
        intro,

      whatsapp_number:
        whatsappNumber ||
        '',

      whatsapp_message:
        cleanText(
          body.whatsapp_message ??
          DEFAULT_SETTINGS.whatsapp_message,
          300
        ),

      show_whatsapp:
        normalizeBooleanSetting(
          body.show_whatsapp ??
          DEFAULT_SETTINGS.show_whatsapp
        ),

      facebook_url:
        facebookUrl ||
        '',

      show_facebook:
        normalizeBooleanSetting(
          body.show_facebook ??
          DEFAULT_SETTINGS.show_facebook
        ),

      instagram_url:
        instagramUrl ||
        '',

      show_instagram:
        normalizeBooleanSetting(
          body.show_instagram ??
          DEFAULT_SETTINGS.show_instagram
        ),

      linkedin_url:
        linkedinUrl ||
        '',

      show_linkedin:
        normalizeBooleanSetting(
          body.show_linkedin ??
          DEFAULT_SETTINGS.show_linkedin
        ),

      contact_email:
        contactEmail ||
        '',

      show_contact_email:
        normalizeBooleanSetting(
          body.show_contact_email ??
          DEFAULT_SETTINGS.show_contact_email
        ),

      contact_phone:
        contactPhone ||
        '',

      show_contact_phone:
        normalizeBooleanSetting(
          body.show_contact_phone ??
          DEFAULT_SETTINGS.show_contact_phone
        ),

      contact_address:
        cleanText(
          body.contact_address ??
          DEFAULT_SETTINGS.contact_address,
          200
        ),

      show_contact_address:
        normalizeBooleanSetting(
          body.show_contact_address ??
          DEFAULT_SETTINGS.show_contact_address
        ),

      nav_prelaunch_text:
        cleanText(
          body.nav_prelaunch_text ??
          DEFAULT_SETTINGS.nav_prelaunch_text,
          80
        ),

      nav_prelaunch_action:
        navPrelaunchAction.action,

      nav_prelaunch_value:
        navPrelaunchAction.value,

      nav_open_text:
        cleanText(
          body.nav_open_text ??
          DEFAULT_SETTINGS.nav_open_text,
          80
        ),

      nav_open_action:
        navOpenAction.action,

      nav_open_value:
        navOpenAction.value,

      hero_prelaunch_text:
        cleanText(
          body.hero_prelaunch_text ??
          DEFAULT_SETTINGS.hero_prelaunch_text,
          100
        ),

      hero_prelaunch_action:
        heroPrelaunchAction.action,

      hero_prelaunch_value:
        heroPrelaunchAction.value,

      hero_open_text:
        cleanText(
          body.hero_open_text ??
          DEFAULT_SETTINGS.hero_open_text,
          100
        ),

      hero_open_action:
        heroOpenAction.action,

      hero_open_value:
        heroOpenAction.value,

      concept_button_text:
        cleanText(
          body.concept_button_text ??
          DEFAULT_SETTINGS.concept_button_text,
          100
        ),

      concept_button_action:
        conceptButtonAction.action,

      concept_button_value:
        conceptButtonAction.value,

      show_nav_cta:
        normalizeBooleanSetting(
          body.show_nav_cta ??
          DEFAULT_SETTINGS.show_nav_cta
        ),

      show_hero_primary:
        normalizeBooleanSetting(
          body.show_hero_primary ??
          DEFAULT_SETTINGS.show_hero_primary
        ),

      show_hero_secondary:
        normalizeBooleanSetting(
          body.show_hero_secondary ??
          DEFAULT_SETTINGS.show_hero_secondary
        ),
    },
  };
}

function renderLaunchEmail({
  firstName,
  subject,
  message,
  platformUrl,
  promoCode,
  unsubscribeUrl = '',
  isTest = false,
}) {
  const safeName =
    escapeHtml(
      firstName ||
      ''
    );

  const safeSubject =
    escapeHtml(
      subject
    );

  const safeMessage =
    escapeHtml(
      message
    ).replace(
      /\n/g,
      '<br>'
    );

  const safeUrl =
    escapeHtml(
      platformUrl
    );

  const safePromo =
    escapeHtml(
      promoCode ||
      ''
    );

  const greeting =
    safeName
      ? `Bonjour ${safeName},`
      : 'Bonjour,';

  const promoBlock =
    safePromo
      ? `<div style="margin:24px 0;padding:16px 18px;border:1px solid #D4AF37;border-radius:10px;background:#F7F4EC;color:#0A192F"><div style="font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#7A641D">Votre avantage de lancement</div><div style="margin-top:5px;font-size:22px;font-weight:800;letter-spacing:.06em">${safePromo}</div></div>`
      : '';

  const unsubscribeBlock =
    isTest
      ? '<p style="margin:28px 0 0;font-size:12px;color:#667085">E-mail de test : le lien de désinscription n’est pas actif dans cet aperçu.</p>'
      : `<p style="margin:28px 0 0;font-size:12px;color:#667085">Vous recevez ce message car vous avez demandé à être informé du lancement de LeDomen.com. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#667085">Se désinscrire</a>.</p>`;

  const html =
    `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
</head>
<body style="margin:0;background:#F4F6F9;font-family:Arial,Helvetica,sans-serif;color:#162033">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#F4F6F9;padding:28px 12px">
<tr>
<td align="center">
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:620px;background:#FFFFFF;border-radius:16px;overflow:hidden;border:1px solid #E3E7EE">
<tr>
<td style="background:#0A192F;padding:28px 32px;color:#FFFFFF">
<div style="font-size:28px;font-weight:800">
LeDomen<span style="color:#D4AF37">.com</span>
</div>
<div style="margin-top:5px;color:#CFE0FF;font-size:13px">
Enjoy your Events
</div>
</td>
</tr>

<tr>
<td style="padding:34px 32px">

<div style="font-size:15px;margin-bottom:18px">
${greeting}
</div>

<h1 style="font-size:28px;line-height:1.2;margin:0 0 18px;color:#0A192F">
${safeSubject}
</h1>

<p style="font-size:16px;line-height:1.7;margin:0 0 24px;color:#475467">
${safeMessage}
</p>

<a href="${safeUrl}" style="display:inline-block;background:#D4AF37;color:#0A192F;text-decoration:none;font-weight:800;padding:14px 22px;border-radius:9px">
Accéder à LeDomen
</a>

${promoBlock}

<p style="margin:28px 0 0;font-size:14px;line-height:1.6;color:#667085">
À bientôt,<br>
<strong style="color:#0A192F">L’équipe LeDomen</strong>
</p>

${unsubscribeBlock}

</td>
</tr>
</table>
</td>
</tr>
</table>
</body>
</html>`;

  const text =
    `${greeting}

${subject}

${message}

Accéder à LeDomen : ${platformUrl}${promoCode ? `

Votre avantage de lancement : ${promoCode}` : ''}

L’équipe LeDomen${isTest ? `

E-mail de test.` : `

Se désinscrire : ${unsubscribeUrl}`}`;

  return {
    html,
    text,
  };
}

async function sendLaunchMail({
  to,
  firstName,
  subject,
  message,
  platformUrl,
  promoCode,
  unsubscribeUrl,
  isTest = false,
  senderName,
}) {
  if (
    !mailTransporter
  ) {
    throw new Error(
      'SMTP non configuré.'
    );
  }

  const rendered =
    renderLaunchEmail({
      firstName,
      subject,
      message,
      platformUrl,
      promoCode,
      unsubscribeUrl,
      isTest,
    });

  return mailTransporter.sendMail({
    from: {
      name:
        senderName ||
        SMTP_FROM_NAME ||
        'LeDomen.com',

      address:
        SMTP_FROM_EMAIL,
    },

    to,

    subject:
      isTest
        ? `[TEST] ${subject}`
        : subject,

    html:
      rendered.html,

    text:
      rendered.text,

    replyTo:
      process.env.SMTP_REPLY_TO ||
      undefined,
  });
}

function unsubscribePage({
  token = '',
  success = false,
  invalid = false,
}) {
  const safeToken =
    escapeHtml(
      token
    );

  let content;

  if (
    success
  ) {
    content =
      '<h1>Désinscription confirmée</h1><p>Vous ne recevrez plus d’e-mails de lancement de LeDomen.com à cette adresse.</p><a class="btn" href="/">Retour à LeDomen.com</a>';
  } else if (
    invalid
  ) {
    content =
      '<h1>Lien invalide</h1><p>Ce lien de désinscription est invalide ou ne correspond plus à une inscription active.</p><a class="btn" href="/">Retour à LeDomen.com</a>';
  } else {
    content =
      `<h1>Se désinscrire</h1>
<p>Confirmez que vous ne souhaitez plus recevoir les e-mails concernant le lancement de LeDomen.com.</p>
<form method="post" action="/api/unsubscribe">
<input type="hidden" name="token" value="${safeToken}">
<button class="btn" type="submit">Confirmer la désinscription</button>
</form>`;
  }

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Désinscription | LeDomen.com</title>
<style>
body{margin:0;background:#0A192F;font-family:Arial,sans-serif;color:#fff}
.box{max-width:600px;margin:12vh auto;padding:34px;background:#fff;color:#162033;border-radius:18px}
.brand{font-weight:800;font-size:24px;color:#0A192F}
.brand span{color:#D4AF37}
.btn{display:inline-block;margin-top:18px;border:0;background:#D4AF37;color:#0A192F;padding:13px 18px;border-radius:9px;font-weight:800;text-decoration:none;cursor:pointer}
p{line-height:1.6;color:#475467}
</style>
</head>
<body>
<main class="box">
<div class="brand">LeDomen<span>.com</span></div>
${content}
</main>
</body>
</html>`;
}

let workerBusy =
  false;

async function runEmailWorker() {
  if (
    workerBusy ||
    !mailTransporter
  ) {
    return;
  }

  workerBusy =
    true;

  try {
    await activateScheduledCampaigns();

    await recoverStaleDeliveries();

    const jobs =
      await claimQueuedDeliveries(
        EMAIL_BATCH_SIZE
      );

    for (
      const job of jobs
    ) {
      const token =
        signUnsubscribe(
          job.lead_id,
          job.email
        );

      const unsubscribeUrl =
        `${PUBLIC_BASE_URL}/unsubscribe?token=${encodeURIComponent(token)}`;

      try {
        const info =
          await sendLaunchMail({
            to:
              job.email,

            firstName:
              job.prenom,

            subject:
              job.subject,

            message:
              job.message,

            platformUrl:
              job.platform_url,

            promoCode:
              job.promo_code ||
              '',

            unsubscribeUrl,

            senderName:
              job.sender_name ||
              SMTP_FROM_NAME ||
              'LeDomen.com',
          });

        await finishDelivery({
          deliveryId:
            job.delivery_id,

          sent:
            true,

          providerMessageId:
            info?.messageId ||
            null,

          maxAttempts:
            EMAIL_MAX_ATTEMPTS,
        });
      } catch (
        error
      ) {
        const retryDelayMinutes =
          Math.min(
            60,
            2 **
            Math.max(
              1,
              Number(
                job.attempts ||
                1
              )
            )
          );

        console.error(
          `E-mail ${job.delivery_id} vers ${job.email}:`,
          error?.message ||
          error
        );

        await finishDelivery({
          deliveryId:
            job.delivery_id,

          sent:
            false,

          errorMessage:
            error?.message ||
            'Erreur SMTP',

          maxAttempts:
            EMAIL_MAX_ATTEMPTS,

          retryDelayMinutes,
        });
      }
    }
  } catch (
    error
  ) {
    console.error(
      'Worker e-mail:',
      error
    );
  } finally {
    workerBusy =
      false;
  }
}

app.get(
  '/api/health',
  async (
    _req,
    res
  ) => {
    try {
      await pool.query(
        'SELECT 1'
      );

      res.setHeader(
        'Cache-Control',
        'no-store'
      );

      res.json({
        ok: true,
      });
    } catch {
      res
        .status(503)
        .json({
          ok: false,
        });
    }
  }
);

app.get(
  '/api/config',
  async (
    _req,
    res
  ) => {
    const settings =
      await getResolvedSettings();

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    res.json({
      launchDate:
        settings.launch_date,

      earlyAccessLimit:
        EARLY_ACCESS_LIMIT,

      siteStatus:
        settings.site_status,

      platformUrl:
        settings.platform_url,

      buttons: {
        nav: {
          visible:
            settings.show_nav_cta ===
            'true',

          prelaunch: {
            label:
              settings.nav_prelaunch_text,

            behavior:
              resolvePublicAction(
                settings.nav_prelaunch_action,
                settings.nav_prelaunch_value,
                settings
              ),
          },

          open: {
            label:
              settings.nav_open_text,

            behavior:
              resolvePublicAction(
                settings.nav_open_action,
                settings.nav_open_value,
                settings
              ),
          },
        },

        heroPrimary: {
          visible:
            settings.show_hero_primary ===
            'true',

          prelaunch: {
            label:
              settings.hero_prelaunch_text,

            behavior:
              resolvePublicAction(
                settings.hero_prelaunch_action,
                settings.hero_prelaunch_value,
                settings
              ),
          },

          open: {
            label:
              settings.hero_open_text,

            behavior:
              resolvePublicAction(
                settings.hero_open_action,
                settings.hero_open_value,
                settings
              ),
          },
        },

        heroSecondary: {
          visible:
            settings.show_hero_secondary ===
            'true',

          label:
            settings.concept_button_text,

          behavior:
            resolvePublicAction(
              settings.concept_button_action,
              settings.concept_button_value,
              settings
            ),
        },
      },

      links: {
        whatsappUrl:
          buildWhatsappUrl(
            settings.whatsapp_number,
            settings.whatsapp_message
          ),

        showWhatsapp:
          settings.show_whatsapp ===
          'true',

        facebookUrl:
          normalizeHttpUrl(
            settings.facebook_url,
            {
              allowEmpty:
                true,
            }
          ) || '',

        showFacebook:
          settings.show_facebook ===
          'true',

        instagramUrl:
          normalizeHttpUrl(
            settings.instagram_url,
            {
              allowEmpty:
                true,
            }
          ) || '',

        showInstagram:
          settings.show_instagram ===
          'true',

        linkedinUrl:
          normalizeHttpUrl(
            settings.linkedin_url,
            {
              allowEmpty:
                true,
            }
          ) || '',

        showLinkedin:
          settings.show_linkedin ===
          'true',

        contactEmail:
          normalizeOptionalEmail(
            settings.contact_email
          ) || '',

        showContactEmail:
          settings.show_contact_email ===
          'true',

        contactPhone:
          normalizePhone(
            settings.contact_phone,
            {
              allowEmpty:
                true,
            }
          ) || '',

        showContactPhone:
          settings.show_contact_phone ===
          'true',

        contactAddress:
          settings.contact_address,

        showContactAddress:
          settings.show_contact_address ===
          'true',
      },
    });
  }
);

app.get(
  '/api/public/stats',
  async (
    _req,
    res
  ) => {
    const count =
      await getLeadCount();

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    res.json({
      registered:
        count,

      earlyAccessLimit:
        EARLY_ACCESS_LIMIT,

      earlyAccessRemaining:
        Math.max(
          0,
          EARLY_ACCESS_LIMIT -
          count
        ),
    });
  }
);

app.post(
  '/api/leads',
  sameOriginOnly,

  rateLimit({
    windowMs:
      10 *
      60 *
      1000,

    max:
      8,
  }),

  async (
    req,
    res
  ) => {
    const validation =
      validateLead(
        req.body
      );

    if (
      validation.spam
    ) {
      return res
        .status(200)
        .json({
          ok: true,
          message:
            'Inscription enregistrée.',
        });
    }

    if (
      validation.error
    ) {
      return res
        .status(400)
        .json({
          ok: false,
          message:
            validation.error,
        });
    }

    try {
      const lead =
        await createLead({
          ...validation.lead,

          source:
            cleanText(
              req.body.source ||
              'landing-page',
              80
            ),

          userAgent:
            cleanText(
              req.get(
                'user-agent'
              ),
              500
            ),
        });

      return res
        .status(201)
        .json({
          ok: true,

          message:
            'Votre inscription est bien enregistrée.',

          lead: {
            id:
              lead.id,

            prenom:
              lead.prenom,

            createdAt:
              lead.created_at,
          },
        });
    } catch (
      err
    ) {
      if (
        err?.code ===
        '23505'
      ) {
        return res
          .status(200)
          .json({
            ok: true,

            duplicate:
              true,

            message:
              'Vous êtes déjà inscrit(e). Nous vous préviendrons au lancement.',
          });
      }

      console.error(
        'POST /api/leads',
        err
      );

      return res
        .status(500)
        .json({
          ok: false,

          message:
            'Erreur serveur. Merci de réessayer plus tard.',
        });
    }
  }
);

app.get(
  '/unsubscribe',
  (
    req,
    res
  ) => {
    const token =
      String(
        req.query.token ||
        ''
      );

    const payload =
      verifyUnsubscribe(
        token
      );

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    res
      .status(
        payload
          ? 200
          : 400
      )
      .send(
        unsubscribePage({
          token,
          invalid:
            !payload,
        })
      );
  }
);

app.post(
  '/api/unsubscribe',

  rateLimit({
    windowMs:
      10 *
      60 *
      1000,

    max:
      20,
  }),

  async (
    req,
    res
  ) => {
    const token =
      String(
        req.body.token ||
        ''
      );

    const payload =
      verifyUnsubscribe(
        token
      );

    if (
      !payload
    ) {
      return res
        .status(400)
        .send(
          unsubscribePage({
            invalid:
              true,
          })
        );
    }

    const lead =
      await unsubscribeLead({
        leadId:
          payload.leadId,

        email:
          payload.email,
      });

    if (
      !lead
    ) {
      return res
        .status(400)
        .send(
          unsubscribePage({
            invalid:
              true,
          })
        );
    }

    return res
      .status(200)
      .send(
        unsubscribePage({
          success:
            true,
        })
      );
  }
);

app.post(
  '/api/admin/login',
  sameOriginOnly,

  async (
    req,
    res,
    next
  ) => {
    try {
      const user =
        cleanText(
          req.body.user,
          180
        ).toLowerCase();

      const password =
        String(
          req.body.password ||
          ''
        );

      const ipKey =
        `admin-login-ip:${requestIpHash(req)}`;

      const userBucket =
        safeEqualString(
          user,
          ADMIN_USER.toLowerCase()
        )
          ? ADMIN_USER.toLowerCase()
          : 'other';

      const userKey =
        `admin-login-user:${sha256(userBucket)}`;

      const [
        ipLimit,
        userLimit,
      ] =
        await Promise.all([
          consumeSecurityRateLimit({
            key:
              ipKey,

            windowSeconds:
              15 *
              60,

            max:
              10,
          }),

          consumeSecurityRateLimit({
            key:
              userKey,

            windowSeconds:
              15 *
              60,

            max:
              20,
          }),
        ]);

      if (
        !ipLimit.allowed ||
        !userLimit.allowed
      ) {
        const retryAfter =
          Math.max(
            ipLimit.retryAfterSeconds ||
            1,

            userLimit.retryAfterSeconds ||
            1
          );

        res.setHeader(
          'Retry-After',
          String(
            retryAfter
          )
        );

        await audit(
          req,
          {
            action:
              'admin.login.blocked',

            target:
              user ||
              null,

            success:
              false,

            adminUser:
              user ||
              null,
          }
        );

        return res
          .status(429)
          .json({
            ok: false,

            message:
              'Trop de tentatives de connexion. Réessayez plus tard.',
          });
      }

      const validUser =
        safeEqualString(
          user,
          ADMIN_USER.toLowerCase()
        );

      const validPassword =
        Boolean(
          ADMIN_PASSWORD
        ) &&
        safeEqualString(
          password,
          ADMIN_PASSWORD
        );

      if (
        !validUser ||
        !validPassword
      ) {
        await audit(
          req,
          {
            action:
              'admin.login.failed',

            target:
              user ||
              null,

            success:
              false,

            adminUser:
              user ||
              null,
          }
        );

        return res
          .status(401)
          .json({
            ok: false,

            message:
              'Identifiants incorrects.',
          });
      }

      await Promise.all([
        clearSecurityRateLimit(
          ipKey
        ),

        clearSecurityRateLimit(
          userKey
        ),

        cleanupExpiredAdminSessions(),
      ]);

      const rawSessionToken =
        randomToken(
          32
        );

      const tokenHash =
        sha256(
          rawSessionToken
        );

      const csrfToken =
        csrfTokenForSessionHash(
          tokenHash
        );

      const expiresAt =
        new Date(
          Date.now() +
          ADMIN_SESSION_HOURS *
          60 *
          60 *
          1000
        );

      await createAdminSession({
        tokenHash,

        csrfHash:
          sha256(
            csrfToken
          ),

        adminUser:
          ADMIN_USER,

        userAgentHash:
          requestFingerprint(
            req
          ),

        expiresAt,
      });

      res.setHeader(
        'Set-Cookie',
        sessionCookieValue(
          rawSessionToken
        )
      );

      res.setHeader(
        'Cache-Control',
        'no-store'
      );

      await audit(
        req,
        {
          action:
            'admin.login.success',

          target:
            ADMIN_USER,

          success:
            true,

          adminUser:
            ADMIN_USER,
        }
      );

      return res.json({
        ok:
          true,

        user:
          ADMIN_USER,

        csrfToken,

        expiresAt:
          expiresAt.toISOString(),
      });
    } catch (
      error
    ) {
      next(
        error
      );
    }
  }
);

app.post(
  '/api/admin/logout',

  requireAdmin,
  sameOriginOnly,
  requireCsrf,

  async (
    req,
    res,
    next
  ) => {
    try {
      await revokeAdminSessionByTokenHash(
        req.admin.tokenHash
      );

      await audit(
        req,
        {
          action:
            'admin.logout',

          target:
            req.admin.user,
        }
      );

      res.setHeader(
        'Set-Cookie',
        expiredSessionCookieValue()
      );

      res.setHeader(
        'Clear-Site-Data',
        '"cache"'
      );

      return res.json({
        ok:
          true,
      });
    } catch (
      error
    ) {
      next(
        error
      );
    }
  }
);

app.get(
  '/api/admin/me',
  requireAdmin,

  async (
    req,
    res
  ) => {
    const csrfToken =
      csrfTokenForSessionHash(
        req.admin.tokenHash
      );

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    return res.json({
      ok:
        true,

      user:
        req.admin.user,

      csrfToken,

      expiresAt:
        new Date(
          req.admin.expiresAt
        ).toISOString(),
    });
  }
);

app.get(
  '/api/admin/stats',
  requireAdmin,

  async (
    _req,
    res
  ) => {
    const summary =
      await getLeadSummary();

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    res.json({
      ok:
        true,

      ...summary,
    });
  }
);

app.get(
  '/api/admin/leads',
  requireAdmin,

  async (
    req,
    res
  ) => {
    const limit =
      Math.min(
        500,
        Math.max(
          1,
          Number(
            req.query.limit ||
            100
          )
        )
      );

    const offset =
      Math.max(
        0,
        Number(
          req.query.offset ||
          0
        )
      );

    const role =
      cleanText(
        req.query.role,
        32
      ).toLowerCase();

    const ville =
      cleanText(
        req.query.ville,
        80
      );

    const [
      items,
      total,
    ] =
      await Promise.all([
        listLeads({
          limit,
          offset,
          role,
          ville,
        }),

        getLeadCount(),
      ]);

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    res.json({
      ok:
        true,

      total,
      items,
    });
  }
);

app.get(
  '/api/admin/export.xlsx',
  requireAdmin,

  async (
    req,
    res,
    next
  ) => {
    try {
      const rows =
        await exportAllLeads();

      const workbook =
        new ExcelJS.Workbook();

      workbook.creator =
        'LeDomen.com';

      workbook.lastModifiedBy =
        'LeDomen.com';

      workbook.created =
        new Date();

      workbook.modified =
        new Date();

      const worksheet =
        workbook.addWorksheet(
          'Inscriptions',
          {
            views: [
              {
                state:
                  'frozen',

                ySplit:
                  1,
              },
            ],

            properties: {
              defaultRowHeight:
                20,
            },
          }
        );

      worksheet.columns = [
        {
          header:
            'ID',

          key:
            'id',

          width:
            10,
        },

        {
          header:
            'Prénom',

          key:
            'prenom',

          width:
            22,
        },

        {
          header:
            'Nom',

          key:
            'nom',

          width:
            22,
        },

        {
          header:
            'Contact',

          key:
            'contact',

          width:
            34,
        },

        {
          header:
            'Type de contact',

          key:
            'type_contact',

          width:
            18,
        },

        {
          header:
            'Ville',

          key:
            'ville',

          width:
            20,
        },

        {
          header:
            'Profil',

          key:
            'role',

          width:
            20,
        },

        {
          header:
            'Consentement',

          key:
            'consent_at',

          width:
            22,
        },

        {
          header:
            'Désinscription',

          key:
            'unsubscribed_at',

          width:
            22,
        },

        {
          header:
            'E-mail lancement envoyé',

          key:
            'launch_notified',

          width:
            24,
        },

        {
          header:
            'Inscription',

          key:
            'created_at',

          width:
            22,
        },
      ];

      const headerRow =
        worksheet.getRow(
          1
        );

      headerRow.font = {
        bold:
          true,
      };

      headerRow.alignment = {
        vertical:
          'middle',

        horizontal:
          'center',
      };

      headerRow.height =
        24;

      for (
        const r of rows
      ) {
        worksheet.addRow({
          id:
            r.id,

          prenom:
            safeExcelText(
              r.prenom
            ),

          nom:
            safeExcelText(
              r.nom
            ),

          contact:
            safeExcelText(
              r.contact_raw
            ),

          type_contact:
            safeExcelText(
              r.contact_type
            ),

          ville:
            safeExcelText(
              r.ville
            ),

          role:
            safeExcelText(
              r.role
            ),

          consent_at:
            r.consent_at
              ? new Date(
                  r.consent_at
                )
              : null,

          unsubscribed_at:
            r.unsubscribed_at
              ? new Date(
                  r.unsubscribed_at
                )
              : null,

          launch_notified:
            r.launch_notified
              ? 'Oui'
              : 'Non',

          created_at:
            r.created_at
              ? new Date(
                  r.created_at
                )
              : null,
        });
      }

      for (
        const key of [
          'consent_at',
          'unsubscribed_at',
          'created_at',
        ]
      ) {
        worksheet
          .getColumn(
            key
          )
          .numFmt =
            'dd/mm/yyyy hh:mm';
      }

      worksheet.autoFilter = {
        from:
          'A1',

        to:
          'K1',
      };

      worksheet.eachRow(
        (
          row,
          rowNumber
        ) => {
          row.alignment = {
            vertical:
              'middle',

            wrapText:
              true,

            ...(
              rowNumber ===
              1
                ? {
                    horizontal:
                      'center',
                  }
                : {}
            ),
          };
        }
      );

      const buffer =
        await workbook.xlsx.writeBuffer();

      await audit(
        req,
        {
          action:
            'leads.export.xlsx',

          target:
            'leads',

          details: {
            count:
              rows.length,
          },
        }
      );

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      );

      res.setHeader(
        'Content-Disposition',
        'attachment; filename="ledomen-inscriptions.xlsx"'
      );

      res.setHeader(
        'Cache-Control',
        'no-store'
      );

      return res.send(
        Buffer.from(
          buffer
        )
      );
    } catch (
      error
    ) {
      return next(
        error
      );
    }
  }
);

app.get(
  '/api/admin/settings',
  requireAdmin,

  async (
    _req,
    res
  ) => {
    const settings =
      await getResolvedSettings();

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    res.json({
      ok:
        true,

      settings,
    });
  }
);

app.put(
  '/api/admin/settings',

  requireAdmin,
  sameOriginOnly,
  requireCsrf,

  async (
    req,
    res,
    next
  ) => {
    try {
      const current =
        await getResolvedSettings();

      const validation =
        sanitizeSettings({
          ...current,
          ...req.body,
        });

      if (
        validation.error
      ) {
        await audit(
          req,
          {
            action:
              'settings.update.rejected',

            target:
              'app_settings',

            success:
              false,

            details: {
              reason:
                validation.error,
            },
          }
        );

        return res
          .status(400)
          .json({
            ok:
              false,

            message:
              validation.error,
          });
      }

      const settings =
        await upsertAppSettings(
          validation.settings,
          req.admin.user
        );

      await audit(
        req,
        {
          action:
            'settings.update',

          target:
            'app_settings',

          details: {
            keys:
              Object.keys(
                req.body ||
                {}
              ).slice(
                0,
                100
              ),
          },
        }
      );

      return res.json({
        ok:
          true,

        settings: {
          ...DEFAULT_SETTINGS,
          ...settings,
        },
      });
    } catch (
      error
    ) {
      next(
        error
      );
    }
  }
);

app.get(
  '/api/admin/email/status',
  requireAdmin,

  (
    _req,
    res
  ) => {
    res.json({
      ok:
        true,

      configured:
        mailConfigured,

      smtp: {
        host:
          SMTP_HOST ||
          null,

        port:
          SMTP_PORT,

        secure:
          SMTP_SECURE,

        fromEmail:
          SMTP_FROM_EMAIL ||
          null,

        fromName:
          SMTP_FROM_NAME ||
          null,
      },

      worker: {
        batchSize:
          EMAIL_BATCH_SIZE,

        maxAttempts:
          EMAIL_MAX_ATTEMPTS,

        intervalMs:
          EMAIL_WORKER_INTERVAL_MS,
      },
    });
  }
);

app.post(
  '/api/admin/email/preview',

  requireAdmin,
  sameOriginOnly,
  requireCsrf,

  async (
    req,
    res
  ) => {
    const current =
      await getResolvedSettings();

    const validation =
      sanitizeSettings(
        {
          ...current,
          ...(
            req.body.settings ||
            {}
          ),
        },
        {
          requirePlatformUrl:
            true,
        }
      );

    if (
      validation.error
    ) {
      return res
        .status(400)
        .json({
          ok:
            false,

          message:
            validation.error,
        });
    }

    const settings =
      validation.settings;

    const rendered =
      renderLaunchEmail({
        firstName:
          'Jean',

        subject:
          settings.email_subject,

        message:
          settings.email_intro,

        platformUrl:
          settings.platform_url,

        promoCode:
          settings.promo_code,

        isTest:
          true,
      });

    res.json({
      ok:
        true,

      html:
        rendered.html,
    });
  }
);

app.post(
  '/api/admin/email/test',

  requireAdmin,
  sameOriginOnly,
  requireCsrf,

  rateLimit({
    windowMs:
      5 *
      60 *
      1000,

    max:
      10,
  }),

  async (
    req,
    res
  ) => {
    if (
      !mailTransporter
    ) {
      return res
        .status(409)
        .json({
          ok:
            false,

          message:
            'SMTP non configuré. Renseignez les variables SMTP dans .env puis redémarrez le serveur.',
        });
    }

    const to =
      normalizeEmail(
        req.body.to
      );

    if (
      !to
    ) {
      return res
        .status(400)
        .json({
          ok:
            false,

          message:
            'Adresse e-mail de test invalide.',
        });
    }

    const current =
      await getResolvedSettings();

    const validation =
      sanitizeSettings(
        {
          ...current,
          ...(
            req.body.settings ||
            {}
          ),
        },
        {
          requirePlatformUrl:
            true,
        }
      );

    if (
      validation.error
    ) {
      return res
        .status(400)
        .json({
          ok:
            false,

          message:
            validation.error,
        });
    }

    const settings =
      validation.settings;

    const info =
      await sendLaunchMail({
        to,

        firstName:
          'Jean',

        subject:
          settings.email_subject,

        message:
          settings.email_intro,

        platformUrl:
          settings.platform_url,

        promoCode:
          settings.promo_code,

        isTest:
          true,

        senderName:
          settings.sender_name,
      });

    await audit(
      req,
      {
        action:
          'email.test.sent',

        target:
          to,
      }
    );

    res.json({
      ok:
        true,

      message:
        `E-mail de test envoyé à ${to}.`,

      messageId:
        info?.messageId ||
        null,
    });
  }
);

app.get(
  '/api/admin/email/eligible-count',
  requireAdmin,

  async (
    req,
    res
  ) => {
    const role =
      cleanText(
        req.query.role,
        32
      ).toLowerCase();

    const ville =
      cleanText(
        req.query.ville,
        80
      );

    const onlyNotNotified =
      String(
        req.query.onlyNotNotified ??
        'true'
      ) !==
      'false';

    if (
      role &&
      ![
        'organisateur',
        'entreprise',
        'prestataire',
      ].includes(
        role
      )
    ) {
      return res
        .status(400)
        .json({
          ok:
            false,

          message:
            'Profil invalide.',
        });
    }

    if (
      ville &&
      ![
        'Libreville',
        'Port-Gentil',
        'Franceville',
        'Autre',
      ].includes(
        ville
      )
    ) {
      return res
        .status(400)
        .json({
          ok:
            false,

          message:
            'Ville invalide.',
        });
    }

    const count =
      await countEligibleEmailLeads({
        targetRole:
          role,

        targetVille:
          ville,

        onlyNotNotified,
      });

    res.json({
      ok:
        true,

      count,
    });
  }
);

app.get(
  '/api/admin/campaigns',
  requireAdmin,

  async (
    _req,
    res
  ) => {
    const items =
      await listEmailCampaigns(
        100
      );

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    res.json({
      ok:
        true,

      items,
    });
  }
);

app.get(
  '/api/admin/audit',
  requireAdmin,

  async (
    req,
    res
  ) => {
    const limit =
      Math.min(
        200,
        Math.max(
          1,
          Number(
            req.query.limit ||
            50
          )
        )
      );

    const items =
      await listAuditLogs(
        limit
      );

    res.setHeader(
      'Cache-Control',
      'no-store'
    );

    res.json({
      ok:
        true,

      items,
    });
  }
);

app.post(
  '/api/admin/campaigns',

  requireAdmin,
  sameOriginOnly,
  requireCsrf,

  rateLimit({
    windowMs:
      60_000,

    max:
      10,
  }),

  async (
    req,
    res
  ) => {
    if (
      !mailTransporter
    ) {
      return res
        .status(409)
        .json({
          ok:
            false,

          message:
            'SMTP non configuré. Impossible de lancer une campagne réelle.',
        });
    }

    const current =
      await getResolvedSettings();

    const validation =
      sanitizeSettings(
        current,
        {
          requirePlatformUrl:
            true,
        }
      );

    if (
      validation.error
    ) {
      return res
        .status(400)
        .json({
          ok:
            false,

          message:
            validation.error,
        });
    }

    const settings =
      validation.settings;

    const targetRole =
      cleanText(
        req.body.targetRole,
        32
      ).toLowerCase();

    const targetVille =
      cleanText(
        req.body.targetVille,
        80
      );

    if (
      targetRole &&
      ![
        'organisateur',
        'entreprise',
        'prestataire',
      ].includes(
        targetRole
      )
    ) {
      return res
        .status(400)
        .json({
          ok:
            false,

          message:
            'Profil cible invalide.',
        });
    }

    if (
      targetVille &&
      ![
        'Libreville',
        'Port-Gentil',
        'Franceville',
        'Autre',
      ].includes(
        targetVille
      )
    ) {
      return res
        .status(400)
        .json({
          ok:
            false,

          message:
            'Ville cible invalide.',
        });
    }

    let scheduledAt =
      null;

    if (
      req.body.scheduledAt
    ) {
      const scheduled =
        new Date(
          req.body.scheduledAt
        );

      if (
        Number.isNaN(
          scheduled.getTime()
        )
      ) {
        return res
          .status(400)
          .json({
            ok:
              false,

            message:
              'Date de programmation invalide.',
          });
      }

      scheduledAt =
        scheduled.toISOString();
    }

    const campaign =
      await createEmailCampaign({
        name:
          cleanText(
            req.body.name ||
            `Annonce de lancement ${new Date().toLocaleDateString('fr-FR')}`,
            140
          ),

        subject:
          settings.email_subject,

        message:
          settings.email_intro,

        targetRole,

        targetVille,

        onlyNotNotified:
          req.body.onlyNotNotified !==
          false,

        scheduledAt,

        platformUrl:
          settings.platform_url,

        promoCode:
          settings.promo_code,

        senderName:
          settings.sender_name,

        createdBy:
          req.admin.user,
      });

    void runEmailWorker();

    await audit(
      req,
      {
        action:
          'campaign.create',

        target:
          String(
            campaign.id
          ),

        details: {
          name:
            campaign.name,

          status:
            campaign.status,

          totalRecipients:
            campaign.total_recipients,
        },
      }
    );

    res
      .status(201)
      .json({
        ok:
          true,

        campaign,

        message:
          campaign.total_recipients
            ? (
                campaign.status ===
                'scheduled'
                  ? 'Campagne programmée.'
                  : 'Campagne placée dans la file d’envoi.'
              )
            : 'Campagne créée, mais aucun destinataire éligible ne correspond aux filtres.',
      });
  }
);

app.post(
  '/api/admin/campaigns/:id/cancel',

  requireAdmin,
  sameOriginOnly,
  requireCsrf,

  async (
    req,
    res
  ) => {
    const id =
      Number(
        req.params.id
      );

    if (
      !Number.isInteger(
        id
      ) ||
      id < 1
    ) {
      return res
        .status(400)
        .json({
          ok:
            false,

          message:
            'Campagne invalide.',
        });
    }

    const campaign =
      await cancelEmailCampaign(
        id
      );

    if (
      !campaign
    ) {
      return res
        .status(409)
        .json({
          ok:
            false,

          message:
            'Cette campagne ne peut plus être annulée (elle est peut-être déjà en cours ou terminée).',
        });
    }

    await audit(
      req,
      {
        action:
          'campaign.cancel',

        target:
          String(
            id
          ),
      }
    );

    res.json({
      ok:
        true,

      message:
        'Campagne annulée.',
    });
  }
);

app.post(
  '/api/admin/campaigns/:id/retry',

  requireAdmin,
  sameOriginOnly,
  requireCsrf,

  async (
    req,
    res
  ) => {
    const id =
      Number(
        req.params.id
      );

    if (
      !Number.isInteger(
        id
      ) ||
      id < 1
    ) {
      return res
        .status(400)
        .json({
          ok:
            false,

          message:
            'Campagne invalide.',
        });
    }

    const result =
      await retryFailedDeliveries(
        id
      );

    if (
      !result
    ) {
      return res
        .status(404)
        .json({
          ok:
            false,

          message:
            'Campagne introuvable ou annulée.',
        });
    }

    void runEmailWorker();

    await audit(
      req,
      {
        action:
          'campaign.retry',

        target:
          String(
            id
          ),

        details: {
          retried:
            result.retried,
        },
      }
    );

    res.json({
      ok:
        true,

      message:
        `${result.retried} envoi(s) replacé(s) dans la file.`,

      ...result,
    });
  }
);

app.use(
  express.static(
    publicDir,
    {
      extensions: [
        'html',
      ],

      setHeaders(
        res,
        filePath
      ) {
        if (
          /\.(png|jpg|jpeg|webp|svg|woff2?)$/i.test(
            filePath
          )
        ) {
          res.setHeader(
            'Cache-Control',
            'public, max-age=604800'
          );
        }
      },
    }
  )
);

app.use(
  (
    _req,
    res
  ) => {
    res
      .status(404)
      .sendFile(
        path.join(
          publicDir,
          '404.html'
        )
      );
  }
);

app.use(
  (
    err,
    _req,
    res,
    _next
  ) => {
    console.error(
      err
    );

    res
      .status(500)
      .json({
        ok:
          false,

        message:
          'Erreur serveur.',
      });
  }
);

async function initializeDefaultSettings() {
  const current =
    await getAppSettings();

  const missing =
    Object.fromEntries(
      Object
        .entries(
          DEFAULT_SETTINGS
        )
        .filter(
          (
            [key]
          ) =>
            !(
              key in
              current
            )
        )
    );

  if (
    Object.keys(
      missing
    ).length
  ) {
    await upsertAppSettings(
      missing,
      'system'
    );
  }
}

async function start() {
  try {
    await ensureSchema();

    await initializeDefaultSettings();

    await Promise.all([
      cleanupExpiredAdminSessions(),
      cleanupSecurityRateLimits(),
    ]);

    app.listen(
      PORT,
      BIND_HOST,
      () => {
        console.log(
          `LeDomen lancé sur http://${BIND_HOST}:${PORT}`
        );

        console.log(
          `E-mail SMTP: ${mailConfigured ? 'configuré' : 'non configuré'}`
        );
      }
    );

    setInterval(
      () => {
        void cleanupExpiredAdminSessions()
          .catch(
            (
              error
            ) => {
              console.error(
                'Nettoyage sessions:',
                error?.message ||
                error
              );
            }
          );

        void cleanupSecurityRateLimits()
          .catch(
            (
              error
            ) => {
              console.error(
                'Nettoyage rate-limit:',
                error?.message ||
                error
              );
            }
          );
      },
      60 *
      60 *
      1000
    ).unref();

    if (
      mailConfigured
    ) {
      setInterval(
        () =>
          void runEmailWorker(),
        EMAIL_WORKER_INTERVAL_MS
      ).unref();

      setTimeout(
        () =>
          void runEmailWorker(),
        1_000
      ).unref();
    }
  } catch (
    err
  ) {
    console.error(
      'Impossible de démarrer LeDomen:',
      err
    );

    process.exit(
      1
    );
  }
}

start();