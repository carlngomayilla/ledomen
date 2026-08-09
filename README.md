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
