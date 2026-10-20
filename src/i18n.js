// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, buttons, device and feature
// names), in English and French.
// -----------------------------------------------------------------------------

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

const both = (en, fr) => ({ en, fr });

/** Two messages one after the other, in each language. */
export const join = (...messages) =>
  both(messages.map((m) => m.en).join(' '), messages.map((m) => m.fr).join(' '));

/** "25 min" / "3 h", for the pauses. */
export function age(ms) {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 120) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

/** A number of kWh, as shown: "1,234.5 kWh" / "1 234,5 kWh". */
const kwh = (value) =>
  both(
    `${value.toLocaleString('en-US', { maximumFractionDigits: 3 })} kWh`,
    `${value.toLocaleString('fr-FR', { maximumFractionDigits: 3 }).replace(/\u202f|\u00a0/g, ' ')} kWh`,
  );

/** The suffix of each device of a plant (none for the plant itself). */
export const DEVICE_NAMES = {
  plant: both('', ''),
  grid: both('grid', 'réseau'),
  battery: both('battery', 'batterie'),
};

/** Feature names, in the language chosen in the configuration. */
export const FEATURE_NAMES = {
  pv_power: both('Solar power', 'Puissance solaire'),
  production_index: both('Solar production (index)', 'Production solaire (index)'),
  production_today: both('Solar production today (kWh)', 'Production solaire du jour (kWh)'),
  load_power: both('Home consumption power (W)', 'Puissance consommée par la maison (W)'),
  load_today: both('Home consumption today (kWh)', 'Consommation de la maison du jour (kWh)'),
  load_total: both('Home consumption, total (kWh)', 'Consommation de la maison, total (kWh)'),
  import_index: both('Energy bought from the grid (index)', 'Énergie achetée au réseau (index)'),
  grid_power: both(
    'Grid power (W, sign as given by iSolarCloud)',
    'Puissance réseau (W, signe donné par iSolarCloud)',
  ),
  import_today: both('Bought from the grid today (kWh)', 'Achetée au réseau du jour (kWh)'),
  export_today: both('Fed into the grid today (kWh)', 'Injectée au réseau du jour (kWh)'),
  export_total: both('Fed into the grid, total (kWh)', 'Injectée au réseau, total (kWh)'),
  battery_level: both('Battery charge', 'Charge de la batterie'),
  battery_power: both(
    'Battery power (W, sign as given by iSolarCloud)',
    'Puissance de la batterie (W, signe donné par iSolarCloud)',
  ),
  charge_today: both('Battery charged today (kWh)', 'Batterie chargée du jour (kWh)'),
  discharge_today: both('Battery discharged today (kWh)', 'Batterie déchargée du jour (kWh)'),
  charge_total: both('Battery charged, total (kWh)', 'Batterie chargée, total (kWh)'),
  discharge_total: both('Battery discharged, total (kWh)', 'Batterie déchargée, total (kWh)'),
};

export const T = {
  noClient: both(
    'Enter the app key, the secret key and the app id of your iSolarCloud developer app (see the guide), save, then click Connect.',
    'Saisissez la clé d’application, la clé secrète et l’identifiant de votre application développeur iSolarCloud (voir le guide), enregistrez, puis cliquez sur Connecter.',
  ),
  signedOut: both(
    'Not signed in to iSolarCloud: click Connect (see the steps above). The integration never signs in by itself.',
    'Non connecté à iSolarCloud : cliquez sur Connecter (voir les étapes plus haut). L’intégration ne se connecte jamais d’elle-même.',
  ),
  expired: both(
    'The iSolarCloud session ended (renewal refused): click Connect to authorize again. Nothing is retried by itself.',
    'La session iSolarCloud a pris fin (renouvellement refusé) : cliquez sur Connecter pour autoriser de nouveau. Rien n’est réessayé de lui-même.',
  ),
  unauthorized: both(
    'iSolarCloud refused the access even with a new token, or refused the developer app: check the app key and the secret key, then click Connect (or "Test iSolarCloud"). Nothing is retried by itself.',
    'iSolarCloud a refusé l’accès même avec un nouveau jeton, ou a refusé l’application développeur : vérifiez la clé d’application et la clé secrète, puis cliquez sur Connecter (ou « Tester iSolarCloud »). Rien n’est réessayé de lui-même.',
  ),
  connecting: both('Reading iSolarCloud…', 'Lecture d’iSolarCloud…'),
  nextRead: (wait) =>
    both(
      `iSolarCloud: next read in ${wait.en}.`,
      `iSolarCloud : prochaine lecture dans ${wait.fr}.`,
    ),
  connected: (count) =>
    both(
      `Connected to iSolarCloud: ${count} plant(s). Open Discovery to add them.`,
      `Connecté à iSolarCloud : ${count} centrale(s). Ouvrez Découverte pour les ajouter.`,
    ),
  noPlant: both(
    'Connected to iSolarCloud, but no plant was authorized for this app: click Connect and select your plant on the iSolarCloud page.',
    'Connecté à iSolarCloud, mais aucune centrale n’est autorisée pour cette application : cliquez sur Connecter et cochez votre centrale sur la page d’iSolarCloud.',
  ),
  partial: (names) =>
    both(
      `No data this time for: ${names.join(', ')} (tried again at the next read).`,
      `Aucune donnée cette fois pour : ${names.join(', ')} (nouvel essai à la prochaine lecture).`,
    ),
  held: (name, held) =>
    both(
      `Index held back, ${name.en}: ${kwh(held.from).en} → ${kwh(held.to).en} (${held.direction === 'up' ? 'jump' : 'drop'}). If it is right, click "Accept the held indexes".`,
      `Index retenu, ${name.fr} : ${kwh(held.from).fr} → ${kwh(held.to).fr} (${held.direction === 'up' ? 'saut' : 'baisse'}). S’il est juste, cliquez sur « Accepter les index retenus ».`,
    ),
  rateLimited: (wait) =>
    both(
      `iSolarCloud asks to slow down: pause of ${wait.en}.`,
      `iSolarCloud demande de ralentir : pause de ${wait.fr}.`,
    ),
  unavailable: (wait) =>
    both(
      `iSolarCloud is unavailable (server error): next try in ${wait.en}.`,
      `iSolarCloud est indisponible (erreur du serveur) : nouvel essai dans ${wait.fr}.`,
    ),
  budget: (wait) =>
    both(
      `The daily number of requests of this integration is reached: next read in ${wait.en} (after midnight UTC).`,
      `Le nombre de requêtes du jour de cette intégration est atteint : prochaine lecture dans ${wait.fr} (après minuit UTC).`,
    ),
  unreachable: (reason, wait) =>
    both(
      `iSolarCloud could not be read (${reason}): next try in ${wait.en}.`,
      `iSolarCloud n’a pas pu être lu (${reason}) : nouvel essai dans ${wait.fr}.`,
    ),
  renewWaiting: (reason, wait) =>
    both(
      `The iSolarCloud session could not be renewed (${reason}): next try in ${wait.en}.`,
      `La session iSolarCloud n’a pas pu être renouvelée (${reason}) : nouvel essai dans ${wait.fr}.`,
    ),
  busy: both(
    'A read is already running: try again in a moment.',
    'Une lecture est déjà en cours : réessayez dans un instant.',
  ),
  test: {
    cooldown: both('Tested less than 30 seconds ago.', 'Testé il y a moins de 30 secondes.'),
  },
  accept: {
    nothing: both('No index is held back.', 'Aucun index n’est retenu.'),
    done: (names) =>
      both(
        `Accepted: ${names.map((n) => n.en).join(', ')}. Taken at the next read, if it still shows the same value (plus what was produced or drawn meanwhile).`,
        `Accepté : ${names.map((n) => n.fr).join(', ')}. Pris à la prochaine lecture, si elle montre toujours la même valeur (plus ce qui a été produit ou consommé entre-temps).`,
      ),
  },
  signIn: {
    redirectHint: (address) =>
      both(
        `The return address of this Gladys is ${address} — it must be the redirect URL of your iSolarCloud developer app.`,
        `L’adresse de retour de ce Gladys est ${address} — ce doit être l’URL de redirection de votre application développeur iSolarCloud.`,
      ),
    noRedirect: both(
      'Gladys gave no return address: write the redirect URL of your developer app in the configuration.',
      'Gladys n’a donné aucune adresse de retour : saisissez l’URL de redirection de votre application développeur dans la configuration.',
    ),
    noCode: both(
      'No authorization code in the pasted text: paste the whole address the browser ended on (it holds code= and state=).',
      'Aucun code d’autorisation dans le texte collé : collez l’adresse complète sur laquelle le navigateur s’est arrêté (elle contient code= et state=).',
    ),
    unknown: both(
      'This address does not belong to an authorization started in the last 15 minutes: click Connect again.',
      'Cette adresse ne correspond à aucune autorisation démarrée dans les 15 dernières minutes : cliquez de nouveau sur Connecter.',
    ),
    cancelled: (detail) =>
      both(
        `iSolarCloud did not authorize the app (${detail}): click Connect again.`,
        `iSolarCloud n’a pas autorisé l’application (${detail}) : cliquez de nouveau sur Connecter.`,
      ),
    refused: (detail) =>
      both(
        `iSolarCloud refused the authorization (${detail}): check the server, the app key, the secret key and the redirect URL, then click Connect again.`,
        `iSolarCloud a refusé l’autorisation (${detail}) : vérifiez le serveur, la clé d’application, la clé secrète et l’URL de redirection, puis cliquez de nouveau sur Connecter.`,
      ),
    failed: (reason) =>
      both(
        `iSolarCloud could not be reached (${reason}): paste the same address again in a moment.`,
        `iSolarCloud n’a pas pu être joint (${reason}) : collez de nouveau la même adresse dans un instant.`,
      ),
    wrongAddress: both(
      'This address is not the redirect URL of the authorization: paste the address the browser ended on after the iSolarCloud page (the authorization stays usable).',
      'Cette adresse n’est pas l’URL de redirection de l’autorisation : collez l’adresse sur laquelle le navigateur s’est arrêté après la page d’iSolarCloud (l’autorisation reste utilisable).',
    ),
    retryConnect: (reason) =>
      both(
        `iSolarCloud could not be reached (${reason}): click Connect again.`,
        `iSolarCloud n’a pas pu être joint (${reason}) : cliquez de nouveau sur Connecter.`,
      ),
    slow: both(
      'iSolarCloud is slow to answer: click Connect again.',
      'iSolarCloud lent, cliquez de nouveau sur Connecter.',
    ),
    noRefresh: both(
      'iSolarCloud gave no renewal token: click Connect again.',
      'iSolarCloud n’a donné aucun jeton de renouvellement : cliquez de nouveau sur Connecter.',
    ),
    done: both(
      'Authorized by iSolarCloud: reading the plants…',
      'Autorisé par iSolarCloud : lecture des centrales…',
    ),
  },
};
