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
