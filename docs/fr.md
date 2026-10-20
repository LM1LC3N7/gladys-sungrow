# Sungrow iSolarCloud pour Gladys Assistant

Cette intégration lit vos **onduleurs et batteries Sungrow** par l'API
officielle **iSolarCloud OpenAPI**, **en lecture seule** : rien n'est jamais
commandé (ni mode de batterie, ni limite d'injection).

> Connecteur non officiel, **sans lien avec Sungrow**. **Jamais testé avec un
> vrai compte** iSolarCloud, et **jamais testé avec un vrai appareil**
> (onduleur, batterie) pour l'instant : il suit la bibliothèque `pysolarcloud`
> (MIT), utilisée par Home Assistant. Vos retours sont les bienvenus sur le
> forum Gladys. Sungrow et iSolarCloud sont des marques de leur propriétaire.

## Ce que vous obtenez

Pour chaque centrale (« plant ») que vous autorisez, jusqu'à trois appareils :

| Appareil                               | Fonction                                       | Unité / type                   |
| -------------------------------------- | ---------------------------------------------- | ------------------------------ |
| **Centrale** (toujours)                | Puissance solaire                              | W, production                  |
|                                        | Production solaire (index)                     | kWh, **index de production**   |
|                                        | Production solaire (30 minutes)                | kWh, remplie par Gladys        |
|                                        | Production solaire du jour                     | capteur simple (kWh)           |
|                                        | Puissance, consommation du jour et totale      | capteurs simples (W, kWh)      |
| **Réseau** (si iSolarCloud le donne)   | Énergie achetée au réseau (index)              | kWh, **index de consommation** |
|                                        | Puissance réseau (signe donné par iSolarCloud) | capteur simple (W)             |
|                                        | Achetée du jour, injectée du jour et totale    | capteurs simples (kWh)         |
| **Batterie** (si iSolarCloud la donne) | Charge de la batterie                          | %                              |
|                                        | Puissance de la batterie                       | capteur simple (W)             |
|                                        | Chargée et déchargée, du jour et totales       | capteurs simples (kWh)         |

### Les deux index d'énergie

- **Production solaire (index)** : le total produit par la centrale depuis sa
  mise en service. Il est accompagné de la fonction **Production solaire
  (30 minutes)**, que Gladys remplit elle-même depuis l'index (l'intégration
  n'y écrit jamais) : c'est elle qui alimente le suivi d'énergie.
- **Énergie achetée au réseau (index)** : le total acheté au réseau, compté
  par Gladys comme consommation électrique (avec son coût, selon votre
  contrat d'énergie dans Gladys).

Si un autre compteur alimente déjà Gladys (Linky, P1, compteur Zigbee…),
**n'ajoutez pas l'appareil « réseau »** : la même consommation serait comptée
deux fois. L'appareil « centrale » reste utile seul.

Ces deux index passent par une **garde** (la même que l'intégration P1
Monitor) avant d'être envoyés à Gladys, parce que Gladys compte chaque
hausse en entier :

- une valeur à 0 ou absente n'est jamais envoyée ;
- une hausse plausible (pas plus que la **puissance maximale de
  l'installation** depuis la lecture précédente, 36 kW par défaut) passe ;
- une **baisse** ou un **saut** n'est jamais confirmé par le temps ni par la
  répétition : la valeur est **retenue** (la dernière valeur acceptée est
  renvoyée), le statut de l'intégration l'affiche, et elle reste retenue
  après un redémarrage ;
- si la valeur retenue est juste (compteur remplacé, remise à zéro), cliquez
  sur **Accepter les index retenus** : elle est prise à la lecture suivante,
  une seule fois, et seulement si c'est bien la valeur affichée (plus ce qui a
  pu être produit ou consommé entre-temps).

Tous les autres totaux et valeurs du jour sont des **capteurs simples** : Gladys
ne les compte nulle part.

## Étape 1 : créer votre application développeur Sungrow

L'API iSolarCloud demande une **application développeur** que vous créez
vous-même, une seule fois, sur le portail de Sungrow. Les quatre étapes
ci-dessous sont celles de la bibliothèque `pysolarcloud` :

1. Créez un compte sur le portail développeur iSolarCloud :
   <https://developer-api.isolarcloud.com/>.
2. Créez une **application** dans le portail :
   - à la question « authorize with OAuth2.0 », répondez **Yes** ;
   - donnez une **Redirect URL** (elle peut être changée plus tard) :
     l'adresse vers laquelle iSolarCloud renverra votre navigateur après
     l'autorisation. Deux possibilités :
     - **l'adresse de retour de votre Gladys** (recommandé). Pour la
       connaître : faites d'abord l'étape 2 ci-dessous sans URL de
       redirection, cliquez une fois sur **Connecter** : le statut de
       l'intégration affiche « L'adresse de retour de ce Gladys est … ».
       Copiez-la dans le portail ;
     - **une autre adresse à vous** en https : il faudra alors copier-coller
       l'adresse finale (voir plus bas).
3. Attendez que Sungrow **valide** l'application.
4. Dans le portail, relevez :
   - l'**Appkey** ;
   - la **Secret Key** ;
   - l'**Application Id** : il apparaît dans l'URL d'autorisation affichée par
     le portail, après `applicationId=` (un nombre).

Non vérifié, d'après d'autres projets : le portail accepterait aussi les
identifiants de votre compte Sungrow (essayez-les avant d'en créer un
nouveau) ; la durée de la validation et la façon dont le portail l'affiche
ne sont pas connues.

## Étape 2 : configurer l'intégration

Dans **Intégrations → Sungrow iSolarCloud → Configuration** :

1. **Serveur iSolarCloud** : celui de votre compte (**Europe** pour la France,
   la Belgique, la Suisse). Non vérifié : l'application développeur est
   probablement liée au même serveur.
2. **Appkey**, **Secret Key**, **Application Id** : ceux de l'étape 1.
3. Laissez **URL de redirection** vide si l'application renvoie vers Gladys ;
   sinon, saisissez l'adresse enregistrée dans le portail.
4. Enregistrez.

## Étape 3 : autoriser

1. Cliquez sur **Connecter** : la page d'iSolarCloud s'ouvre.
2. Connectez-vous avec votre compte iSolarCloud habituel. **Votre mot de passe
   se saisit sur la page d'iSolarCloud seulement** : l'intégration ne le voit
   jamais.
3. **Cochez la ou les centrales** à partager, puis autorisez.
4. iSolarCloud vous renvoie vers Gladys : l'intégration lit vos centrales.
   Ajoutez les appareils depuis l'onglet **Découverte**.

### Avec une autre URL de redirection

1. Après l'autorisation, le navigateur s'arrête sur votre adresse (la page
   peut afficher une erreur, c'est normal). Copiez **l'adresse complète** de
   la barre d'adresse : elle contient `code=` et `state=`.
2. Collez-la dans l'action **Terminer l'autorisation**, dans les 15 minutes.
   Elle doit commencer par l'URL de redirection configurée : une autre
   adresse est refusée (l'autorisation reste alors utilisable).

Une autorisation démarrée ne sert qu'une fois. Si iSolarCloud tarde à répondre
(plus de 3,5 secondes au retour vers Gladys), l'intégration affiche
« iSolarCloud lent, cliquez de nouveau sur Connecter » : recommencez.

## Ce que l'intégration garde

- La **Secret Key** est gardée par Gladys dans sa base, comme toute valeur de
  configuration : jamais réaffichée, envoyée seulement à iSolarCloud.
- Les **jetons** d'iSolarCloud (accès et renouvellement) sont gardés en clair
  dans le fichier `/data/sungrow-state.json` du volume de l'intégration,
  lisible par son conteneur seulement (droits 0600), et envoyés seulement à
  iSolarCloud. Le même fichier garde les pauses, les arrêts, la liste des
  centrales, le nombre de requêtes du jour et l'état des gardes d'index.
  Aucun mot de passe n'y est jamais écrit.

## Rythme et limites de l'API

- iSolarCloud met à jour ses données **toutes les 5 minutes** : l'intégration
  lit **toutes les centrales en une seule requête**, toutes les 5 minutes par
  défaut (5 minutes au minimum, 60 au plus).
- La liste des centrales est relue toutes les 6 heures (et sur demande depuis
  Découverte).
- Le jeton est renouvelé par un minuteur un peu avant sa fin, jamais deux
  fois dans la même minute.
- **Au plus 600 requêtes par jour** (UTC) au total, autorisation et
  renouvellements compris : environ 320 au rythme par défaut. Si ce plafond
  est atteint (ce qui ne devrait jamais arriver), tout attend le lendemain.
- Après un redémarrage, la première lecture attend la fin de l'intervalle
  depuis la dernière lecture et la fin d'une pause en cours.

Sungrow ne publie pas le nombre de requêtes permises : l'intégration réagit à
un refus (HTTP 429 ou réponse « trop fréquent ») par une pause.

## Erreurs et arrêts

| Situation                                                     | Ce que fait l'intégration                                                           |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| iSolarCloud demande de ralentir (HTTP 429, « trop fréquent ») | pause de 1 minute à 6 heures (15 minutes par défaut), gardée après un redémarrage   |
| iSolarCloud indisponible (erreur 5xx, « occupé »)             | pause de 5 minutes à 1 heure, gardée après un redémarrage                           |
| Plafond de requêtes du jour atteint                           | pause jusqu'au lendemain (minuit UTC)                                               |
| Réseau coupé, réponse inattendue                              | nouvel essai après l'intervalle, puis 5, 15, 30 minutes, gardé après un redémarrage |
| Une centrale sans données                                     | les autres continuent ; ses appareils passent « injoignables »                      |
| Renouvellement refusé par iSolarCloud                         | arrêt « session terminée », gardé : cliquez sur Connecter                           |
| Accès refusé même avec un nouveau jeton, ou clés refusées     | arrêt gardé : vérifiez les clés, puis Connecter ou « Tester iSolarCloud »           |

L'intégration ne se reconnecte jamais d'elle-même et ne réessaie jamais un
refus : seul un clic le fait. Le bouton **Tester iSolarCloud** ne relit
jamais plus vite que l'intervalle ni pendant une pause : il affiche le
dernier résultat et l'heure de la prochaine lecture, et ne lit que si
l'intervalle est écoulé depuis la dernière lecture. Il relit tout de suite
une seule fois après un arrêt « accès refusé » (c'est ainsi qu'on le lève).
Une fois toutes les 30 secondes au plus.

## Dépannage

- **« Saisissez la clé d'application »** : Appkey, Secret Key ou Application
  Id manquant (l'Application Id est un nombre).
- **iSolarCloud refuse l'autorisation** : serveur, Appkey, Secret Key ou URL
  de redirection faux, application pas encore validée par Sungrow, ou adresse
  collée de plus de 15 minutes.
- **Aucune centrale** : cliquez de nouveau sur Connecter et cochez la centrale
  sur la page d'iSolarCloud.
- **Un index retenu** : voir « Les deux index d'énergie » plus haut.
- **Une fonction reste vide** : toutes les centrales ne donnent pas tous les
  points de mesure (cela dépend du modèle d'onduleur et du compteur).

## Limites

- Lecture seule : aucune commande (ni batterie, ni injection).
- Les valeurs viennent du cloud iSolarCloud (mises à jour toutes les 5
  minutes), pas de l'onduleur en local.
- Le signe des puissances du réseau et de la batterie est celui d'iSolarCloud,
  non vérifié.
- Jamais testé avec un vrai compte ni un vrai appareil : les points de mesure
  et les unités suivent `pysolarcloud` 0.5.0.
