# Sonora — backend et suivi des téléchargements

Ce document explique le fonctionnement actuel du backend, en particulier le suivi de progression et le flux SSE qui relie le serveur à l’interface React.

## Vue d’ensemble

Le backend reçoit une demande HTTP, lance `yt-dlp`, lit les événements de progression produits par le processus, puis envoie les changements à l’interface avec **Server-Sent Events (SSE)**.

```text
Interface React ── POST /download ──> Backend Express ── spawn ──> yt-dlp
      ▲                                    │
      └──────── SSE /downloads/events ─────┘
```

Le suivi est géré par le backend : le navigateur ne fabrique pas de pourcentage. Il affiche les valeurs mesurées par `yt-dlp` et transmises par SSE.

## Démarrer le projet

Le backend et le frontend se lancent dans deux terminaux distincts. Node.js, les dépendances npm et l’exécutable `yt-dlp` doivent être disponibles sur la machine.

Dans `ms-back/` :

```bash
npm install
npm run dev
```

Par défaut, le serveur écoute sur `http://localhost:4000`. Le script `dev` lance `nodemon`, qui redémarre le serveur quand le code ou `.env` change.

Les variables backend sont chargées depuis `ms-back/.env` avec `dotenv`. Le fichier local `.env` est ignoré par Git ; `.env.example` contient le modèle sans valeur personnelle.

| Variable | Valeur par défaut | Utilisation |
|---|---:|---|
| `PORT` | `4000` | Port HTTP du serveur Express. |
| `SONORA_DOWNLOAD_DIR` | Vide, donc `os.tmpdir()/sonora-downloads` | Racine de stockage. Utiliser un chemin absolu si tu veux un emplacement précis. |
| `SONORA_FILE_RETENTION_HOURS` | `24` | Nombre d’heures avant suppression des fichiers terminés. |

Dans `ms-front/` :

```bash
npm install
npm run dev
```

Vite affiche l’adresse locale du frontend dans le terminal (habituellement `http://localhost:5173`). L’interface utilise actuellement `http://localhost:4000` comme adresse du backend.

Pour un test sur un autre appareil ou un déploiement, configure `VITE_API_URL` côté frontend avec l’adresse joignable du backend avant de lancer ou construire Vite. Sans cette variable, l’interface utilise `http://localhost:4000`.

## Organisation du backend

Le point d’entrée est [index.js](./index.js). Il configure Express, CORS (sans restriction d’origine dans la configuration actuelle) et le décodage JSON, crée la racine du stockage si elle est absente, puis expose cinq routes.

| Route | Rôle |
|---|---|
| `POST /download` | Crée une demande et démarre `yt-dlp`. Répond tout de suite avec un identifiant. |
| `GET /downloads` | Renvoie l’état courant de toutes les demandes, sous forme d’instantané JSON. |
| `GET /downloads/events` | Ouvre le flux SSE et envoie les nouveaux états au navigateur. |
| `GET /downloads/:downloadId/items/:itemId/file` | Envoie un morceau terminé comme pièce jointe au navigateur. |
| `GET /downloads/:downloadId/archive` | Envoie les titres terminés d’une playlist dans une archive ZIP. |

### Où sont enregistrés les fichiers

Le backend n’écrit plus les MP3 dans le dossier du code. Le répertoire racine est défini par `SONORA_DOWNLOAD_DIR`. Sans cette variable, le serveur utilise le dossier temporaire du système (`os.tmpdir()/sonora-downloads`). Les fichiers sont supprimés 24 heures après la fin du traitement par défaut ; `SONORA_FILE_RETENTION_HOURS` permet de régler ce délai. `PORT` configure le port HTTP et vaut `4000` par défaut. Ces trois variables sont déclarées dans `.env`. Exemple pour personnaliser le stockage et conserver les fichiers 48 heures :

```bash
SONORA_DOWNLOAD_DIR=/chemin/absolu/sonora SONORA_FILE_RETENTION_HOURS=48 npm run dev
```

Chaque demande a son propre sous-dossier UUID, sous le dossier `folderName` choisi dans l’interface. Ce sous-dossier est un nom simple, sans séparateur de chemin. Un manifeste JSON dans le dossier de chaque demande conserve l’URL, le titre de playlist, les titres terminés et les noms des fichiers.

Au démarrage, le backend lit ces manifestes, vérifie les fichiers sur disque, puis recharge la liste avant d’ouvrir les routes SSE et HTTP. Les tâches qui étaient en cours sont marquées **interrompues** ; les titres terminés restent téléchargeables. Pour les anciens dossiers sans manifeste, le serveur récupère les MP3 présents, mais l’URL source n’est pas connue. Les dossiers UUID expirés sont supprimés au démarrage suivant.

### Créer un téléchargement

Le frontend envoie une requête similaire à celle-ci :

```json
{
  "url": "https://www.youtube.com/watch?v=…",
  "isPlaylist": false,
  "folderName": "ma-musique"
}
```

`folderName` est facultatif. Sans valeur, le dossier `downloads/` est utilisé sous la racine de stockage configurée. Une valeur comme `ma-musique` crée un sous-dossier de regroupement. Elle ne choisit pas un dossier sur l’appareil de l’utilisateur : ce dossier reste sur la machine qui exécute le backend.

Le backend crée un objet de téléchargement avec un identifiant UUID et l’ajoute au début du tableau en mémoire `downloads`. Il répond sans attendre la fin du travail :

```json
{ "message": "Téléchargement lancé", "id": "…" }
```

Si `isPlaylist` est faux, `--no-playlist` demande à yt-dlp de ne traiter que la vidéo liée. Le backend lance le processus avec `spawn` et un tableau d’arguments : l’URL et le chemin ne sont donc pas interprétés par un shell.

### Comment yt-dlp fournit la progression

Le backend passe notamment ces options à yt-dlp :

- `--newline` écrit les mises à jour de progression sur des lignes séparées, que Node peut lire au fil de l’eau.
- `--progress-template` ajoute à chaque ligne un préfixe Sonora et les données utiles : identifiant, titre, position dans la playlist, pourcentage, octets reçus, taille totale, vitesse et temps restant.
- `--progress-delta 0.5` limite l’émission des mises à jour à environ deux par seconde.
- `--print after_move:…` signale qu’un fichier a fini les étapes de conversion et de déplacement.

Le titre et le chemin sont encodés par yt-dlp au format JSON dans ces lignes, afin que des caractères comme les tabulations ne brouillent pas les colonnes. Les lignes `SONORA_PROGRESS`, `SONORA_POST` et `SONORA_FINISHED` sont reconnues par `parseYtDlpLine`.

Le serveur écoute les sorties standard et d’erreur du processus. `consumeOutput` conserve les morceaux de texte incomplets entre deux événements `data`, puis transmet chaque ligne complète au parseur.

## Format de l’état suivi

Chaque demande possède des informations générales et un tableau `items` contenant les titres individuels. Pour une vidéo seule, `items` contient généralement un titre. Pour une playlist, chaque titre téléchargé a son propre objet :

```json
{
  "id": "identifiant-de-la-demande",
  "url": "https://www.youtube.com/playlist?list=…",
  "isPlaylist": true,
  "playlistTitle": "Nom de la playlist",
  "playlistTotal": 12,
  "completedCount": 3,
  "progress": 25,
  "status": "downloading",
  "items": [
    {
      "id": "identifiant-demande-4",
      "videoId": "identifiant-video",
      "title": "Nom du morceau",
      "index": 4,
      "total": 12,
      "status": "downloading",
      "progress": 42.5,
      "downloadedBytes": 4250000,
      "totalBytes": 10000000,
      "speed": 350000,
      "eta": 16,
      "filename": null,
      "error": null
    }
  ]
}
```

Les états des titres sont `queued`, `downloading`, `processing`, `completed` et `error`. L’état de la demande peut aussi être `completed_with_errors` si certains titres ont échoué après que d’autres ont abouti.

`progress` sur la demande est une progression agrégée : les titres terminés comptent pour 100 %, et le titre en cours contribue son pourcentage mesuré. Le dénominateur est le nombre total connu de titres de la playlist. `completedCount` ne compte que les morceaux terminés.

Un pourcentage peut être absent si yt-dlp ne connaît pas la taille du média. L’interface affiche alors un indicateur de progression sans pourcentage estimé. La vitesse et l’estimation de temps restant sont également absentes quand yt-dlp ne les fournit pas.

Les métadonnées de playlist émises sans `playlist_index` ne sont pas des morceaux : `ensureTrack` conserve leur titre dans `playlistTitle` et les exclut de `items` lorsque yt-dlp confirme une playlist de plusieurs titres. L’index sert de clé lorsque disponible, ce qui permet aussi de distinguer deux occurrences du même identifiant vidéo dans une playlist.

## SSE : émission et réception des événements

### Côté backend

Quand un navigateur ouvre `GET /downloads/events`, la route :

1. Configure la réponse HTTP en `text/event-stream` et désactive la mise en tampon côté proxy.
2. Envoie immédiatement un événement `snapshot` contenant le tableau `downloads` actuel.
3. Ajoute la connexion à `eventClients` pour qu’elle reçoive les prochains événements.
4. Retire la connexion de l’ensemble quand le navigateur la ferme.

`sendEvent(response, eventName, payload)` formate les événements SSE. `broadcast(eventName, download)` transmet la demande modifiée à chaque connexion active. Le backend émet principalement :

- `created` lorsque le travail vient d’être créé ;
- `update` après une progression, un changement d’étape ou la fin d’un titre ou du travail.

Un événement envoyé ressemble à ceci :

```text
event: update
data: {"download":{"id":"…","items":[…]}}

```

Le navigateur peut se déconnecter puis se reconnecter. `EventSource` réessaie automatiquement ; à chaque nouvelle connexion, le backend envoie un `snapshot` pour resynchroniser l’état. `GET /downloads` reste disponible pour inspection ou pour les clients qui n’utilisent pas SSE.

### Envoyer un MP3 au navigateur

Quand yt-dlp émet `SONORA_FINISHED`, le backend garde le nom de fichier dans l’objet du morceau. Après la fin de conversion, l’interface construit une URL avec l’identifiant de la tâche et celui du morceau, puis le navigateur appelle `GET /downloads/:downloadId/items/:itemId/file`.

La route vérifie que la tâche et le morceau existent, que l’état du morceau est `completed` et que le fichier est encore présent. `res.download()` envoie le MP3 avec un nom de fichier de pièce jointe ; le navigateur gère ensuite l’enregistrement sur l’appareil de l’utilisateur. Dans une application déployée, les octets sont transférés depuis le serveur vers le client. Le serveur ne peut pas enregistrer arbitrairement dans les dossiers locaux du client.

Le bouton **Partager** du frontend est proposé seulement si le navigateur indique qu’il accepte le partage de fichiers. Il récupère le MP3, crée un objet `File`, puis appelle `navigator.share()` avec ce fichier. Le système d’exploitation ouvre sa feuille de partage ; l’utilisateur choisit ensuite une application ou une destination. Le bouton **Télécharger** reste disponible comme chemin standard, notamment sur les navigateurs qui ne prennent pas en charge le partage de fichiers.

Pour les playlists terminées, le bouton **Télécharger en ZIP** appelle `/downloads/:downloadId/archive`. `archiver` ajoute les MP3 un à un dans le flux de réponse, avec leur position en préfixe de nom ; l’archive n’est donc pas assemblée dans un gros tampon mémoire avant l’envoi. Pour une playlist partiellement réussie, seuls les titres terminés sont inclus.

Le partage de fichiers via Web Share dépend du navigateur et de l’appareil. Il demande une interaction explicite de l’utilisateur et doit être vérifié sur les appareils ciblés. Le navigateur peut charger le fichier en mémoire pour créer l’objet `File` partagé ; pour des fichiers volumineux, le téléchargement classique est à privilégier.

### Côté frontend

La liaison se trouve dans [`ms-front/src/App.jsx`](../ms-front/src/App.jsx) :

1. Un `EventSource` se connecte à `http://localhost:4000/downloads/events` au montage de l’application.
2. `snapshot` remplace la liste locale par l’état complet du serveur.
3. `created` ajoute une nouvelle demande en haut de la liste.
4. `update` remplace uniquement la demande correspondante, en conservant l’ordre des autres.
5. Au démontage du composant, `events.close()` ferme proprement la connexion.

Si le navigateur ne propose pas `EventSource`, le frontend utilise `GET /downloads` avec une actualisation périodique comme solution de repli. En cas de coupure SSE, le navigateur gère lui-même les tentatives de reconnexion.

Le rendu utilise `items` pour les barres et détails par morceau. Les demandes playlist affichent `playlistTitle`, l’URL en sous-titre, un contrôle repliable et une zone à hauteur limitée avec défilement interne.

## Débogage rapide

- **Le flux ne se connecte pas :** dans les outils développeur du navigateur, ouvrez Réseau et vérifiez `GET /downloads/events` ainsi que son type de réponse `text/event-stream`.
- **La demande passe immédiatement en erreur :** vérifiez que `yt-dlp` est installé et accessible dans le `PATH` du processus Node.
- **La progression reste indéterminée :** yt-dlp n’a peut-être pas fourni la taille totale du média ; l’absence de pourcentage est alors normale.
- **Le titre de playlist ou son total semble incorrect :** vérifiez les lignes de progression yt-dlp et les valeurs `playlistTitle`, `playlistTotal`, `index` et `items` reçues dans `/downloads/events`.

## Limites actuelles

- Les manifestes JSON et les MP3 sont stockés sur le même disque local. Cette persistance convient à une seule instance du backend, pas à plusieurs serveurs partageant une liste de tâches.
- Les fichiers sont conservés 24 heures par défaut, durée configurable avec `SONORA_FILE_RETENTION_HOURS`. Régler ce délai selon les besoins et la capacité disque de l’hébergement.
- Le backend ne gère pas encore l’annulation ni une file d’exécution qui limiterait les téléchargements simultanés.
- SSE transmet des données du serveur vers le navigateur. Les actions utilisateur (par exemple lancer un téléchargement) continuent d’utiliser des requêtes HTTP normales.
- La validation backend de l’URL est minimale (`http` en préfixe). La validation YouTube plus stricte est faite par l’interface ; toute validation de sécurité côté serveur devra être ajoutée séparément si le backend est exposé à d’autres clients.

## Améliorations à envisager plus tard

- Remplacer les manifestes JSON par SQLite ou PostgreSQL si plusieurs instances doivent partager et mettre à jour le même historique.
- Remplacer le disque local par S3, R2 ou un autre stockage objet si le backend est déployé sur des serveurs éphémères ou répartis.
- Ajouter authentification et contrôle d’accès aux routes de téléchargement avant d’exposer le service publiquement.
- Ajouter une file d’attente, l’annulation des tâches et une interface de nettoyage des fichiers avant expiration.
- Ajouter éventuellement un sélecteur de dossier local avec l’API File System Access, en gardant le téléchargement navigateur standard pour les appareils non compatibles.
