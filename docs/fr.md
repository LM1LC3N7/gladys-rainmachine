# RainMachine pour Gladys

Affiche votre programmateur d'arrosage **RainMachine** (Mini-8, Touch HD,
Pro, HD-12/16, de la première à la troisième génération) dans Gladys par son
**API HTTPS locale** : sans le cloud RainMachine (l'« accès à distance »
n'est pas utilisé), directement sur votre réseau.

> **Jamais testé avec un vrai appareil.** Sans lien avec RainMachine.
> L'intégration suit regenmaschine, la bibliothèque RainMachine de Home
> Assistant, et ses captures de test. Une mise à jour du firmware peut changer
> l'API.

## Ce que vous obtenez

Un appareil pour le programmateur (repéré par son adresse MAC, pas par son
adresse IP), un par zone **active** et un par programme :

| Appareil      | Fonctionnalité                                                                              | Contenu                                                                         |
| ------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Programmateur | Arrosage en cours                                                                           | Oui / non (une zone arrose)                                                     |
| Programmateur | Report pour pluie, protection gel, capteur de pluie, restrictions horaire, du mois, du jour | Oui / non (les restrictions météo en vigueur ; pas sur une première génération) |
| Programmateur | Eau utilisée (débitmètre)                                                                   | En litres, le compteur du débitmètre, gardé (voir plus bas)                     |
| Programmateur | Arrêter tout l'arrosage                                                                     | Bouton, **toujours disponible**                                                 |
| Zone          | Arrosage en cours                                                                           | Oui / non (une zone en file derrière une autre est « non » jusqu'à son départ)  |
| Zone          | Temps restant                                                                               | En minutes                                                                      |
| Zone          | Démarrer l'arrosage                                                                         | Bouton (seulement avec « Autoriser l'arrosage »)                                |
| Zone          | Arrêter l'arrosage                                                                          | Bouton, **toujours disponible**                                                 |
| Programme     | En cours                                                                                    | Oui / non                                                                       |
| Programme     | Arrêter le programme                                                                        | Bouton, **toujours disponible**                                                 |

Gladys ne démarre jamais un programme : un programme arrose aussi longtemps
que le programmateur le calcule (météo, ajustement saisonnier), ce que
Gladys ne peut pas borner. Lecture toutes les 60 secondes par défaut (15 s à
10 min), une requête à la fois. Les programmes, les restrictions, le
débitmètre, le nom et les versions sont secondaires : quand l'un ne répond
pas, les autres valeurs sont publiées quand même et le statut dit « Non lu
cette fois : ... ».

## Installation

1. Donnez au programmateur une adresse IP fixe dans votre box.
2. Dans Gladys, installez l'intégration, saisissez l'adresse IP du
   programmateur (éventuellement suivie d'un port, 8080 par défaut) et son
   **mot de passe** (celui que demande l'application RainMachine).
3. Enregistrez, puis ajoutez les appareils depuis l'onglet **Découverte**.

Le mot de passe est gardé par Gladys dans sa base, jamais réaffiché, envoyé
seulement au programmateur, dans le corps de la connexion. Le jeton d'accès
que rend le programmateur est gardé en mémoire seulement (jamais sur le
disque) et envoyé avec chaque requête comme l'API le demande. Le
programmateur sert un **certificat autosigné** : il est **épinglé** à la
première connexion (son empreinte SHA-256 gardée dans `/data` avant que le
mot de passe parte). S'il change plus tard (programmateur réinitialisé ou
remplacé), rien ne lui est envoyé, le statut affiche la nouvelle empreinte,
et le bouton **Faire confiance au nouveau certificat** la prend en deux clics
(à 3 s à 5 min d'intervalle). La connexion est en TLS moderne (1.2 ou plus).
C'est seulement quand un programmateur le refuse à sa **première**
connexion par une alerte TLS (une remise à zéro ou une coupure ne compte
jamais) (une première génération ne parle que TLS 1.0 avec de vieilles
suites TLS RSA) que la poignée de main ancienne est utilisée (TLS 1.0,
niveau de sécurité 0, renégociation ancienne, comme regenmaschine), et
l'épingle s'en souvient : un programmateur épinglé en TLS moderne n'est plus
jamais contacté en TLS ancien. Avec une première génération, l'échange n'a
pas de confidentialité persistante (échange de clés RSA) et une clé de
certificat faible est acceptée puis épinglée : gardez-le sur un réseau de
confiance.

Un mot de passe refusé **n'est plus réessayé automatiquement** : enregistrez
le bon, ou cliquez sur **Tester la connexion** (un essai par minute au plus).

## Les arrêts

**Arrêter l'arrosage** (une zone), **Arrêter le programme** et **Arrêter
tout l'arrosage** (`watering/stopall`) ne dépendent ni de « Autoriser
l'arrosage », ni d'une lecture ou d'un démarrage en cours (ils les
interrompent), ni d'une pause après une erreur 429 ou 5xx, ni d'une lecture
en échec. Un démarrage arrivé avant un arrêt et pas encore parti est
abandonné.

Un arrêt réussit quand la relecture montre la zone (le programme, toutes les
zones et tous les programmes) sans arrosage. Sinon la réponse dit pourquoi,
et l'arrêt est gardé dans `/data` et vérifié toutes les 15 s. Il ne part pas
aussitôt, et reste gardé jusqu'à pouvoir partir, seulement dans ces cas (le
statut de l'intégration dit lequel) :

- **le programmateur ne répond pas** : nouvel essai toutes les 250 ms
  pendant 3 s, puis toutes les 15 s, sans limite de temps ;
- **le mot de passe n'est pas encore connu** : juste après un redémarrage,
  avant que Gladys donne la configuration (le mot de passe n'est jamais écrit
  dans `/data`) : envoyé dès qu'elle arrive ;
- **le mot de passe est refusé** : le clic tente une connexion (une par
  minute au plus) ; puis envoyé dès que le bon mot de passe est enregistré ou
  que **Tester la connexion** se connecte ;
- **le certificat a changé** : envoyé dès qu'il est approuvé, ou que
  l'épinglé revient (essai toutes les 15 s, rien n'est envoyé à un autre
  certificat) ;
- **plusieurs arrêts cliqués à la fois** (une scène) : tous écrits d'abord,
  l'un après l'autre, puis une seule relecture pour tous ; sur un
  programmateur lent (900 ms par échange), le cinquième part environ 4,5 s
  après le clic, et sa réponse dit « envoyé, sans confirmation » ;
- **`/data` est illisible, ou encore en lecture** après un redémarrage
  (l'épingle est inconnue), ou la première épingle ne peut pas être gardée :
  rien n'est envoyé (pas le mot de passe non plus), nouvel essai toutes les
  15 s et dès que /data est lu.

Il n'est refusé sans envoi que si aucune adresse de programmateur n'est
connue, ou si la dernière lecture a montré un autre programmateur (une autre
adresse MAC) à cette adresse.

Un arrêt envoyé mais **pas appliqué** (la zone arrose encore) est renvoyé par
les vérifications, 3 fois au plus une fois accepté par le programmateur,
puis gardé sans nouvel envoi et signalé dans le statut jusqu'à un nouveau
clic. Seul un envoi accepté par le programmateur compte comme essai : un
arrêt qui n'est jamais parti n'est jamais abandonné. Un arrêt gardé est
levé quand une lecture le montre appliqué, ou quand un démarrage de cette
zone cliqué ensuite dans Gladys est parti une fois l'arrêt lui-même parti (ce démarrage est le
souhait le plus récent ; un démarrage ne lève jamais l'arrêt d'une autre
zone, ni **Arrêter tout l'arrosage**, que seule une lecture lève), ou quand une lecture montre un autre programmateur (une autre
adresse MAC) à son adresse. Jamais par le temps. Un démarrage envoyé moins de 90 s avant
l'arrêt et appliqué après lui est contré. Une fois un arrêt vu appliqué, une
zone démarrée depuis l'application RainMachine n'est pas contrée.

## Démarrer l'arrosage (option)

Désactivé par défaut : activez **Autoriser l'arrosage**. C'est un bouton,
jamais un interrupteur (un « tout éteindre » n'atteint jamais une vanne).
Chaque démarrage relit le programmateur juste avant (identité, zones), part
dans les 3,5 s ou pas du tout, et arrose pendant la durée configurée (**1 à
60 minutes**, 10 par défaut, bornée à nouveau avant l'envoi) : le
programmateur ferme la vanne de lui-même à la fin. Il ne réussit que si la
relecture montre la zone en arrosage, ou mise en file par le programmateur
derrière une autre zone (il arrose une zone à la fois ; une zone déjà en
file avant n'est confirmée que par un temps restant égal à la durée
envoyée) ; « envoyé, pas encore appliqué » ou « envoyé, sans confirmation »
sinon (puis lectures à 5 et 20 s). La relecture attend moins quand la
réponse au clic (4,3 s) approche, et n'est pas tentée quand elle ne tient
plus.

Une scène qui démarre plusieurs zones à la fois : une lecture pour toutes
(identité, zones), puis un envoi chacune, l'un après l'autre, puis une
relecture. À 500 ms par échange, 5 zones sont envoyées et confirmées en
4,1 s ; à 900 ms, seules les deux premières peuvent partir dans les 3,5 s
(7 échanges pour 5 zones, environ 6,3 s) : les autres sont refusées, rien
envoyé. Gladys poursuit la scène ; une scène en colonnes successives les
démarre toutes.

Refusé aussi : une zone inactive, une zone que le programmateur n'a plus, un
autre programmateur à l'adresse, pendant une pause 429/5xx, avec un mot de
passe refusé, avant la lecture de la configuration, pendant un arrêt en cours, tant que
**Arrêter tout l'arrosage** est gardé (jusqu'à ce qu'une lecture montre
toutes les zones et programmes arrêtés ; quand les programmes sont
illisibles, deux lectures de suite de toutes les zones à l'arrêt), ou tant qu'un arrêt de cette zone
n'est pas encore parti.

## Eau utilisée (gardée)

Quand un débitmètre est réglé dans le programmateur, **Eau utilisée** est son
compteur en litres (ses impulsions divisées par ses impulsions par mètre
cube ; l'application RainMachine affiche des gallons en unités US, l'API
donne des mètres cubes). Compteur à vie, il passe par une **garde** :

- 0 ou absent n'est pas publié ;
- une hausse plausible (100 litres par minute en moyenne au plus) passe ;
- une **baisse** (débitmètre remis à zéro, programmateur remplacé) ou un
  **saut** est **retenu** : la dernière valeur reste, le statut l'affiche, la
  retenue est gardée dans `/data`. Ni le temps ni la répétition ne la
  confirment ;
- le bouton **Accepter le compteur d'eau retenu** la prend en **deux
  clics** : le premier affiche la valeur, le second (3 s à 5 min après) prend
  exactement cette valeur (plus ce qui a pu couler depuis).

## Bon à savoir

- Le programmateur n'est pas relu avant l'intervalle : ni par **Tester la
  connexion**, ni par une Découverte, une reconnexion à Gladys ou un
  redémarrage (l'heure de la dernière lecture est gardée dans `/data`).
  Seules les lectures qui suivent une commande (5 et 20 s) font exception.
- Une valeur de plus de 2 minutes n'est pas envoyée comme nouvelle.
- Rien de secret n'est écrit dans `/data` ni dans les journaux.
- L'application RainMachine, ses programmes et la météo peuvent aussi changer
  les zones : le dernier l'emporte.
