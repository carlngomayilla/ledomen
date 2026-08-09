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
