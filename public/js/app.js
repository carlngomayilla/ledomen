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
