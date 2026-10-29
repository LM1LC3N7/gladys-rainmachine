// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature names, the status of the
// integration, the answers of the buttons and the command errors. None of
// them ever carries the password nor the access token.
// -----------------------------------------------------------------------------

import { FEATURES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** Two texts, one after the other, in both languages. */
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

const liters = (value) => String(Math.round(value * 10) / 10);
const litersFr = (value) => liters(value).replace('.', ',');

export const FEATURE_NAMES = {
  controller: {
    [FEATURES.WATERING]: both('Watering', 'Arrosage en cours'),
    [FEATURES.RAIN_DELAY]: both('Rain delay', 'Report pour pluie'),
    [FEATURES.FREEZE]: both('Freeze protection', 'Protection gel'),
    [FEATURES.RAIN_SENSOR]: both('Rain sensor', 'Capteur de pluie'),
    [FEATURES.HOURLY]: both('Hourly restriction', 'Restriction horaire'),
    [FEATURES.MONTH]: both('Month restriction', 'Restriction du mois'),
    [FEATURES.WEEKDAY]: both('Weekday restriction', 'Restriction du jour'),
    [FEATURES.WATER_USED]: both('Water used (flow sensor)', 'Eau utilisée (débitmètre)'),
    [FEATURES.STOP_ALL]: both('Stop all watering', "Arrêter tout l'arrosage"),
  },
  zone: {
    [FEATURES.WATERING]: both('Watering', 'Arrosage en cours'),
    [FEATURES.REMAINING]: both('Time remaining', 'Temps restant'),
    [FEATURES.START]: both('Start watering', "Démarrer l'arrosage"),
    [FEATURES.STOP]: both('Stop watering', "Arrêter l'arrosage"),
  },
  program: {
    [FEATURES.RUNNING]: both('Running', 'En cours'),
    [FEATURES.STOP]: both('Stop the program', 'Arrêter le programme'),
  },
};

const SECONDARY_NAMES = {
  programs: both('programs', 'programmes'),
  restrictions: both('restrictions', 'restrictions'),
  flow: both('flow sensor', 'débitmètre'),
  versions: both('versions', 'versions'),
};

export const T = {
  noHost: both(
    'Enter the address of the RainMachine controller and its password, then save.',
    "Saisissez l'adresse du programmateur RainMachine et son mot de passe, puis enregistrez.",
  ),
  invalidHost: (host) =>
    both(
      `"${host}" is not an IPv4 address nor a host name (port optional, 8080 by default).`,
      `« ${host} » n'est ni une adresse IPv4 ni un nom d'hôte (port facultatif, 8080 par défaut).`,
    ),
  hostCredentials: both(
    'The address holds a user name or a password: put the password in its own field, the address alone here.',
    "L'adresse contient un nom d'utilisateur ou un mot de passe : mettez le mot de passe dans son champ, l'adresse seule ici.",
  ),
  httpNotSupported: both(
    'The local API of the controller is reached over HTTPS: enter the address without http://.',
    "L'API locale du programmateur est jointe en HTTPS : saisissez l'adresse sans http://.",
  ),
  noPassword: both(
    'Enter the password of the controller (the one of the RainMachine app), then save.',
    "Saisissez le mot de passe du programmateur (celui de l'application RainMachine), puis enregistrez.",
  ),
  invalidPassword: both(
    'The password is not accepted (128 bytes at most, no control character): nothing sent.',
    "Le mot de passe n'est pas accepté (128 octets au plus, sans caractère de contrôle) : rien envoyé.",
  ),
  dataUnreadable: both(
    '/data cannot be read: the pinned certificate is unknown, nothing is sent to the controller. Check the volume of the integration.',
    "/data est illisible : le certificat épinglé est inconnu, rien n'est envoyé au programmateur. Vérifiez le volume de l'intégration.",
  ),
  pinNotSaved: both(
    'The certificate of the controller could not be kept in /data: nothing sent (the password leaves only once its certificate is pinned).',
    "Le certificat du programmateur n'a pas pu être gardé dans /data : rien envoyé (le mot de passe ne part qu'une fois son certificat épinglé).",
  ),
  certificateChanged: (fingerprint) =>
    both(
      `The certificate of the controller changed: nothing is sent to it. New SHA-256 fingerprint: ${fingerprint}. If you reset or replaced the controller, click "Trust the new certificate" twice (3 s to 5 min apart).`,
      `Le certificat du programmateur a changé : rien ne lui est envoyé. Nouvelle empreinte SHA-256 : ${fingerprint}. Si vous avez réinitialisé ou remplacé le programmateur, cliquez deux fois sur « Faire confiance au nouveau certificat » (à 3 s à 5 min d'intervalle).`,
    ),
  configUnreadable: both(
    'The configuration could not be read from Gladys: tried again every 30 s.',
    "La configuration n'a pas pu être lue depuis Gladys : nouvel essai toutes les 30 s.",
  ),
  connecting: both('Connecting to the controller...', 'Connexion au programmateur...'),
  connected: (summary) => both(`Connected: ${summary.en}`, `Connecté : ${summary.fr}`),
  summary: ({ name, zones, watering }) =>
    both(
      `${name}, ${zones} active zone(s), ${watering.length > 0 ? `watering: ${watering.join(', ')}` : 'not watering'}.`,
      `${name}, ${zones} zone(s) active(s), ${watering.length > 0 ? `arrosage : ${watering.join(', ')}` : "pas d'arrosage"}.`,
    ),
  wateringOff: both(
    'Starting a zone is off (option); the stops always work.',
    'Démarrage des zones désactivé (option) ; les arrêts fonctionnent toujours.',
  ),
  unreachable: (address, wait) =>
    both(
      `The controller does not answer at ${address}: next try in ${wait.en}.`,
      `Le programmateur ne répond pas à ${address} : nouvel essai dans ${wait.fr}.`,
    ),
  failing: (reason, wait) =>
    both(
      `The controller answered with an error (${reason}): next try in ${wait.en}.`,
      `Le programmateur a répondu par une erreur (${reason}) : nouvel essai dans ${wait.fr}.`,
    ),
  rateLimited: (wait) =>
    both(
      `The controller asks to slow down (429): pause for ${wait.en}, the stops still go.`,
      `Le programmateur demande de ralentir (429) : pause de ${wait.fr}, les arrêts passent toujours.`,
    ),
  serverError: (wait) =>
    both(
      `The controller answered a server error (5xx): pause for ${wait.en}, the stops still go.`,
      `Le programmateur a répondu une erreur serveur (5xx) : pause de ${wait.fr}, les arrêts passent toujours.`,
    ),
  passwordRefused: both(
    'The controller refuses the password: not tried again automatically. Save the right one, or click "Test the connection" (one try a minute).',
    "Le programmateur refuse le mot de passe : plus d'essai automatique. Enregistrez le bon, ou cliquez sur « Tester la connexion » (un essai par minute).",
  ),
  otherController: (names) =>
    both(
      `Another controller answers at this address: ${names} is no longer read (delete it or put its address back).`,
      `Un autre programmateur répond à cette adresse : ${names} n'est plus lu (supprimez-le ou remettez son adresse).`,
    ),
  notRead: (keys) => {
    const list = (lang) => keys.map((k) => SECONDARY_NAMES[k]?.[lang] ?? k).join(', ');
    return both(`Not read this time: ${list('en')}.`, `Non lu cette fois : ${list('fr')}.`);
  },
  stopLabels: {
    all: both('Stop all', 'Arrêt de tout'),
    zone: (name) => both(`Stop of zone ${name}`, `Arrêt de la zone ${name}`),
    program: (name) => both(`Stop of program ${name}`, `Arrêt du programme ${name}`),
  },
  stopStates: {
    noPassword: both(
      'kept, not sent yet: it leaves once Gladys gives the password',
      'gardé, pas encore parti : il part dès que Gladys donne le mot de passe',
    ),
    passwordRefused: both(
      'kept, not sent yet: it leaves once the password is accepted (save it, or "Test the connection")',
      'gardé, pas encore parti : il part dès que le mot de passe est accepté (enregistrez-le, ou « Tester la connexion »)',
    ),
    certificate: both(
      'kept, not sent yet: it leaves once the certificate is trusted or the pinned one is back',
      "gardé, pas encore parti : il part dès que le certificat est approuvé ou que l'épinglé revient",
    ),
    notSent: both(
      'kept, not sent yet: tried again every 15 s',
      'gardé, pas encore parti : nouvel essai toutes les 15 s',
    ),
    notApplied: (resends) =>
      both(
        `sent, not seen applied yet: checked every 15 s (sent again ${resends}/3)`,
        `envoyé, pas encore vu appliqué : vérifié toutes les 15 s (renvoyé ${resends}/3)`,
      ),
    held: both(
      'sent 4 times, still not applied: no more sent until a new click; check the controller',
      "envoyé 4 fois, toujours pas appliqué : plus d'envoi avant un nouveau clic ; vérifiez le programmateur",
    ),
  },
  stopKept: (label, state) => both(`${label.en}: ${state.en}.`, `${label.fr} : ${state.fr}.`),
  held: ({ direction, from, to }) =>
    direction === 'down'
      ? both(
          `Water counter held back: it dropped from ${liters(from)} to ${liters(to)} L (flow sensor reset or controller replaced?). "Accept the held water counter" (configuration, two clicks) takes it.`,
          `Compteur d'eau retenu : baisse de ${litersFr(from)} à ${litersFr(to)} L (débitmètre remis à zéro ou programmateur remplacé ?). « Accepter le compteur d'eau retenu » (configuration, deux clics) la prend.`,
        )
      : both(
          `Water counter held back: a jump from ${liters(from)} to ${liters(to)} L. "Accept the held water counter" (configuration, two clicks) takes it.`,
          `Compteur d'eau retenu : saut de ${litersFr(from)} à ${litersFr(to)} L. « Accepter le compteur d'eau retenu » (configuration, deux clics) le prend.`,
        ),
  accept: {
    nothing: both('No water counter is held back.', "Aucun compteur d'eau n'est retenu."),
    confirm: ({ direction, from, to }) =>
      both(
        `Held: ${direction === 'down' ? 'a drop' : 'a jump'} from ${liters(from)} to ${liters(to)} L. Click again in 3 s to 5 min to take it.`,
        `Retenu : ${direction === 'down' ? 'une baisse' : 'un saut'} de ${litersFr(from)} à ${litersFr(to)} L. Recliquez dans 3 s à 5 min pour le prendre.`,
      ),
    changed: both(
      'The value held changed since the first click: nothing taken. Click again to see it.',
      'La valeur retenue a changé depuis le premier clic : rien pris. Recliquez pour la voir.',
    ),
    done: ({ from, to }) =>
      both(
        `Taken: ${liters(from)} → ${liters(to)} L, published at the next read.`,
        `Pris : ${litersFr(from)} → ${litersFr(to)} L, publié à la prochaine lecture.`,
      ),
  },
  trust: {
    nothing: both('No new certificate to trust.', 'Aucun nouveau certificat à approuver.'),
    confirm: (fingerprint) =>
      both(
        `New certificate, SHA-256 fingerprint ${fingerprint}. Compare it with the controller if you can, then click again in 3 s to 5 min to trust it.`,
        `Nouveau certificat, empreinte SHA-256 ${fingerprint}. Comparez-la si possible avec le programmateur, puis recliquez dans 3 s à 5 min pour l'approuver.`,
      ),
    done: (fingerprint) =>
      both(
        `Trusted: ${fingerprint}. The controller is read at the next interval.`,
        `Approuvé : ${fingerprint}. Le programmateur est lu au prochain intervalle.`,
      ),
    notSaved: both(
      'The certificate could not be kept in /data: nothing trusted.',
      "Le certificat n'a pas pu être gardé dans /data : rien d'approuvé.",
    ),
  },
  test: {
    notSooner: (wait) =>
      both(
        `(Not read again sooner than the interval: next read in ${wait.en}.)`,
        `(Pas relu avant l'intervalle : prochaine lecture dans ${wait.fr}.)`,
      ),
  },
};

export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badButton: both('Unexpected value for a button.', 'Valeur inattendue pour un bouton.'),
  disabled: both(
    'Watering from Gladys is off: turn on "Allow watering" in the configuration. Nothing sent.',
    "L'arrosage depuis Gladys est désactivé : activez « Autoriser l'arrosage » dans la configuration. Rien envoyé.",
  ),
  unknownController: both(
    'The configuration changed or is incomplete: nothing sent.',
    'La configuration a changé ou est incomplète : rien envoyé.',
  ),
  notReadYet: both(
    'The configuration is not read yet: nothing sent.',
    "La configuration n'est pas encore lue : rien envoyé.",
  ),
  stopMeanwhile: both(
    'A stop was clicked meanwhile: the start is not sent.',
    "Un arrêt a été cliqué entre-temps : le démarrage n'est pas envoyé.",
  ),
  paused: (wait) =>
    both(
      `The controller asked to slow down (429): pause for ${wait.en}. Nothing sent.`,
      `Le programmateur a demandé de ralentir (429) : pause de ${wait.fr}. Rien envoyé.`,
    ),
  pausedServer: (wait) =>
    both(
      `The controller answered a server error: pause for ${wait.en}. Nothing sent.`,
      `Le programmateur a répondu une erreur serveur : pause de ${wait.fr}. Rien envoyé.`,
    ),
  passwordRefused: both(
    'The controller refuses the password: nothing sent.',
    'Le programmateur refuse le mot de passe : rien envoyé.',
  ),
  certificate: both(
    'The certificate of the controller changed: nothing sent.',
    'Le certificat du programmateur a changé : rien envoyé.',
  ),
  tooSlow: both(
    'The controller did not answer in time: nothing sent.',
    "Le programmateur n'a pas répondu à temps : rien envoyé.",
  ),
  unknownState: (reason) =>
    both(
      `The state of the zone could not be read (${reason}): nothing sent.`,
      `L'état de la zone n'a pas pu être lu (${reason}) : rien envoyé.`,
    ),
  otherController: both(
    'Another controller answers at this address: nothing sent.',
    'Un autre programmateur répond à cette adresse : rien envoyé.',
  ),
  noZone: both(
    'The controller no longer has this zone: nothing sent.',
    "Le programmateur n'a plus cette zone : rien envoyé.",
  ),
  inactiveZone: both(
    'This zone is inactive in the controller: nothing sent.',
    'Cette zone est inactive dans le programmateur : rien envoyé.',
  ),
  missing: both(
    'A value needed to decide could not be read: nothing sent.',
    "Une valeur nécessaire n'a pas pu être lue : rien envoyé.",
  ),
  notSent: (reason) => both(`Not sent (${reason}).`, `Non envoyé (${reason}).`),
  refused: (reason) =>
    both(
      `The controller refused the command (${reason}): not applied.`,
      `Le programmateur a refusé la commande (${reason}) : non appliquée.`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Sent, without confirmation (${reason}): checked again in 5 s and 20 s.`,
      `Envoyé, sans confirmation (${reason}) : revérifié dans 5 s et 20 s.`,
    ),
  notApplied: both(
    'Sent, not applied yet: the zone still reads dry. Checked again in 5 s and 20 s.',
    "Envoyé, pas encore appliqué : la zone se lit toujours à l'arrêt. Revérifié dans 5 s et 20 s.",
  ),
  queued: both(
    'Sent: the controller queued the zone behind another one (it waters after it).',
    'Envoyé : le programmateur a mis la zone en file derrière une autre (elle arrosera ensuite).',
  ),
  sentDiffers: both(
    'Sent, the controller reads another state than asked: checked again in 5 s and 20 s.',
    'Envoyé, le programmateur lit un autre état que demandé : revérifié dans 5 s et 20 s.',
  ),
  noAddress: both(
    'No address of a controller is known: nothing sent.',
    "Aucune adresse de programmateur n'est connue : rien envoyé.",
  ),
  stopOtherController: both(
    'The last read showed another controller at this address: this stop is not for it, nothing sent.',
    "La dernière lecture a montré un autre programmateur à cette adresse : cet arrêt n'est pas pour lui, rien envoyé.",
  ),
  stopPending: both(
    'Stop not sent yet: kept, it leaves as soon as the controller can be reached (checked every 15 s).',
    'Arrêt pas encore parti : gardé, il part dès que le programmateur est joignable (vérifié toutes les 15 s).',
  ),
  stopNotSent: (reason) =>
    both(
      `Stop not sent yet (${reason}): kept, tried again every 15 s.`,
      `Arrêt pas encore parti (${reason}) : gardé, nouvel essai toutes les 15 s.`,
    ),
  stopNoPassword: both(
    'Stop not sent yet: the password is not known yet (configuration not read). Kept, it leaves as soon as it is.',
    "Arrêt pas encore parti : le mot de passe n'est pas encore connu (configuration non lue). Gardé, il part dès qu'il l'est.",
  ),
  stopPasswordRefused: both(
    'Stop not sent yet: the controller refuses the password. Kept, it leaves once the right password is saved or a login succeeds.',
    "Arrêt pas encore parti : le programmateur refuse le mot de passe. Gardé, il part dès que le bon mot de passe est enregistré ou qu'une connexion réussit.",
  ),
  stopCertificate: both(
    'Stop not sent yet: the certificate of the controller changed. Kept, it leaves once the certificate is trusted or the pinned one is back.',
    "Arrêt pas encore parti : le certificat du programmateur a changé. Gardé, il part dès que le certificat est approuvé ou que l'épinglé revient.",
  ),
  stopSentUnconfirmed: (reason) =>
    both(
      `Stop sent, without confirmation (${reason}): kept and checked every 15 s.`,
      `Arrêt envoyé, sans confirmation (${reason}) : gardé et vérifié toutes les 15 s.`,
    ),
  stopUnconfirmed: both(
    'Stop sent, not confirmed yet: kept and checked every 15 s.',
    'Arrêt envoyé, pas encore confirmé : gardé et vérifié toutes les 15 s.',
  ),
  stopNotApplied: both(
    'Stop sent, still watering: kept, sent again by the checks every 15 s (3 times at most).',
    "Arrêt envoyé, l'arrosage continue : gardé, renvoyé par les vérifications toutes les 15 s (3 fois au plus).",
  ),
};
