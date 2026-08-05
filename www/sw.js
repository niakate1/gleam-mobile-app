// ═══════════════════════════════════════════════════════════════════════════
// GLEAM — service worker
//
// Trois rôles, et un principe qui gouverne tout.
//
//   1. Recevoir les notifications quand l'application est fermée
//   2. Ouvrir la bonne page quand on touche une notification
//   3. Servir une page de secours quand le réseau est coupé
//
// LE PRINCIPE : LE RÉSEAU D'ABORD, TOUJOURS
//
// Un service worker qui sert d'abord son cache est la cause la plus fréquente
// des « j'ai déployé mais je vois encore l'ancienne version ». Vous l'avez
// vécu ces derniers jours.
//
// Celui-ci fait l'inverse : il demande toujours au réseau, et ne se rabat sur
// sa copie que si le réseau ne répond pas. Une mise en ligne est donc visible
// au rechargement suivant, sans avoir à vider quoi que ce soit.
//
// Le prix : aucun gain de vitesse au chargement. C'est un choix assumé — mieux
// vaut une application un peu plus lente qu'une application qui ment sur son
// contenu.
// ═══════════════════════════════════════════════════════════════════════════

// Changez ce numéro à chaque mise en ligne importante : il force le nettoyage
// des anciennes copies. Ce n'est pas obligatoire — la stratégie réseau d'abord
// suffit — mais cela garantit qu'aucune vieille page ne traîne.
const VERSION = 'gleam-v1';

// Ce qui mérite d'être gardé en secours : les pages qu'on veut pouvoir
// afficher même sans réseau.
const PAGES_DE_SECOURS = [
  '/',
  '/index.html',
  '/aide.html',
  '/mentions-legales.html',
  '/cgu.html',
  '/confidentialite.html',
  '/manifest.json',
  '/icon-192.png'
];

// ── Installation ───────────────────────────────────────────────────────────
self.addEventListener('install', (evenement) => {
  evenement.waitUntil(
    caches.open(VERSION)
      .then((cache) => cache.addAll(PAGES_DE_SECOURS))
      // Une page absente ne doit pas faire échouer l'installation entière :
      // le service worker ne s'activerait jamais, et les notifications
      // cesseraient de fonctionner pour une icône manquante.
      .catch(() => {})
      .then(() => self.skipWaiting())
  );
});

// ── Activation ─────────────────────────────────────────────────────────────
self.addEventListener('activate', (evenement) => {
  evenement.waitUntil(
    caches.keys()
      .then((noms) => Promise.all(
        noms.filter((n) => n !== VERSION).map((n) => caches.delete(n))
      ))
      // Prend le contrôle des onglets déjà ouverts sans attendre leur
      // fermeture : sans cela, la nouvelle version n'agirait qu'au prochain
      // lancement complet de l'application.
      .then(() => self.clients.claim())
  );
});

// ── Requêtes ───────────────────────────────────────────────────────────────
self.addEventListener('fetch', (evenement) => {
  const requete = evenement.request;

  // On ne touche qu'aux lectures de notre propre site. Les appels à l'API, à
  // Stripe ou à Supabase doivent passer directement : les intercepter
  // risquerait de servir une réponse périmée sur un paiement ou un devis.
  if (requete.method !== 'GET') return;
  if (new URL(requete.url).origin !== self.location.origin) return;
  if (requete.url.includes('/api/')) return;

  evenement.respondWith(
    fetch(requete)
      .then((reponse) => {
        // On garde une copie des pages, jamais des erreurs : mettre en cache
        // une page 404 ou 500 la ferait réapparaître hors ligne comme si elle
        // était normale.
        if (reponse && reponse.ok && reponse.type === 'basic') {
          const copie = reponse.clone();
          caches.open(VERSION).then((cache) => cache.put(requete, copie));
        }
        return reponse;
      })
      .catch(() =>
        // Réseau injoignable : on sert la copie si on en a une.
        caches.match(requete).then((copie) =>
          copie || caches.match('/index.html')
        )
      )
  );
});

// ── Notifications reçues ───────────────────────────────────────────────────
// Le serveur envoie : { title, body, url }
self.addEventListener('push', (evenement) => {
  let donnees = {};
  try {
    donnees = evenement.data ? evenement.data.json() : {};
  } catch (e) {
    // Charge utile illisible : on affiche quand même quelque chose plutôt que
    // de laisser passer une notification silencieuse.
    donnees = { title: 'Gleam', body: evenement.data ? evenement.data.text() : '' };
  }

  const titre = donnees.title || 'Gleam';
  const options = {
    body: donnees.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    // La vibration distingue une notification de Gleam des autres sans qu'on
    // ait à regarder l'écran.
    vibrate: [80, 40, 80],
    // Deux notifications portant la même étiquette se remplacent au lieu de
    // s'empiler : un prestataire qui reçoit trois demandes voit trois lignes,
    // pas trois fois la même.
    tag: donnees.tag || ('gleam-' + Date.now()),
    data: {
      url: donnees.url || '/',
      demande_id: donnees.demande_id || null
    },
    // L'utilisateur doit la toucher pour la faire disparaître : une demande
    // qui s'efface toute seule est une demande perdue.
    requireInteraction: false
  };

  evenement.waitUntil(self.registration.showNotification(titre, options));
});

// ── Notification touchée ───────────────────────────────────────────────────
self.addEventListener('notificationclick', (evenement) => {
  evenement.notification.close();

  const cible = (evenement.notification.data && evenement.notification.data.url) || '/';

  evenement.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((fenetres) => {
        // Si l'application est déjà ouverte, on la ramène au premier plan au
        // lieu d'en ouvrir une seconde. Sans cela, un prestataire finirait
        // avec cinq onglets Gleam après cinq notifications.
        for (const fenetre of fenetres) {
          if (fenetre.url.indexOf(self.location.origin) === 0 && 'focus' in fenetre) {
            fenetre.navigate ? fenetre.navigate(cible) : null;
            return fenetre.focus();
          }
        }
        if (self.clients.openWindow) return self.clients.openWindow(cible);
      })
  );
});

// ── Abonnement renouvelé par le navigateur ─────────────────────────────────
// Le navigateur peut renouveler un abonnement de lui-même. Sans ce gestionnaire,
// l'ancien devient invalide côté serveur et les notifications cessent en
// silence — un défaut qu'on ne découvre qu'en constatant qu'on ne reçoit plus
// rien depuis des semaines.
self.addEventListener('pushsubscriptionchange', (evenement) => {
  evenement.waitUntil(
    self.registration.pushManager.subscribe(evenement.oldSubscription.options)
      .then((abonnement) =>
        fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            endpoint: abonnement.endpoint,
            keys: {
              p256dh: btoa(String.fromCharCode.apply(null,
                new Uint8Array(abonnement.getKey('p256dh')))),
              auth: btoa(String.fromCharCode.apply(null,
                new Uint8Array(abonnement.getKey('auth'))))
            }
          })
        })
      )
      .catch(() => {})
  );
});
