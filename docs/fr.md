# Meross

Pilotez vos prises, interrupteurs, lampes et portes de garage Meross depuis Gladys, et
suivez leur consommation sur votre tableau de bord.

## Ce que vous obtenez

Connectez-vous une fois avec votre compte Meross et tous les appareils compatibles du compte
apparaissent dans l'onglet **Découverte**, prêts à être ajoutés. Sans réappairage, sans
matériel supplémentaire.

| Votre appareil                                  | Ce que vous pouvez faire dans Gladys                              |
| ----------------------------------------------- | ----------------------------------------------------------------- |
| Prise ou interrupteur (MSS110, MSS210, MSS510…) | L'allumer et l'éteindre                                           |
| Prise avec mesure (MSS310)                      | Marche/arrêt, plus puissance, tension, courant et énergie du jour |
| Multiprise (MSS425…)                            | Chaque prise séparément                                           |
| Ampoule ou bandeau (MSL120, MSL320, MSL430…)    | Marche/arrêt, luminosité, couleur et température de blanc         |
| Ouvre-porte de garage (MSG100, MSG200)          | L'ouvrir, la fermer, et voir si elle est réellement ouverte       |

Les capteurs reliés à un **hub** Meross (MSH300 avec thermomètres MS100 ou vannes MTS100) ne
sont pas encore pris en charge : ils sont simplement ignorés.

## Configuration

1. Ouvrez l'onglet **Configuration** de l'intégration.
2. Saisissez l'**e-mail** et le **mot de passe** de votre compte Meross — les mêmes que dans
   l'application mobile Meross.
3. Choisissez la **région** de création de votre compte (Europe, Amérique, Asie/Pacifique).
   C'est la cause la plus fréquente d'un refus de connexion : dans le doute, essayez Europe,
   puis Global.
4. Enregistrez. Cliquez sur **Tester la connexion** pour vérifier : le nombre d'appareils
   trouvés s'affiche sous le bouton.
5. Vos appareils apparaissent dans l'onglet **Découverte**.

Votre mot de passe est stocké chiffré par Gladys. Il n'est jamais transmis en clair : seule
une forme hachée quitte l'intégration, et uniquement vers le serveur d'authentification
Meross.

### Local ou cloud ?

L'interrupteur **Préférer la connexion locale** (activé par défaut) demande à l'intégration
de parler directement à vos appareils sur votre réseau Wi-Fi, au lieu de passer par les
serveurs Meross. Le contrôle local est plus rapide et continue de fonctionner même si votre
connexion Internet est coupée.

Chaque appareil affiche un badge indiquant le canal réellement utilisé :

- **local** — les commandes ne quittent jamais votre réseau ;
- **cloud** — les commandes passent par Meross ;
- **cloud avec un point orange** — le local était préféré, mais cet appareil n'a pas répondu
  sur le réseau ; survolez le badge pour connaître la raison.

Certaines versions de firmware Meross refusent le contrôle local. C'est une limitation de
l'appareil : l'intégration bascule sur le cloud pour qu'il continue de fonctionner.

Notez que même en mode local, l'intégration se connecte une fois à Meross au démarrage : vos
appareils n'acceptent que les commandes signées avec la clé de votre compte, et seul Meross
peut la fournir.

### Intervalle de rafraîchissement

Seules les prises qui mesurent la consommation sont interrogées, à cet intervalle
(60 secondes par défaut). Tout le reste — marche/arrêt, couleurs, position de la porte de
garage — arrive **instantanément**, poussé par l'appareil, y compris lorsque quelqu'un
appuie sur un bouton physique ou utilise l'application Meross.

## Actions

- **Tester la connexion** — se connecte avec les identifiants du formulaire et indique
  combien d'appareils contient votre compte, et combien sont en ligne.
- **Rafraîchir la liste des appareils** — relit votre compte. À utiliser après avoir ajouté
  ou renommé un appareil dans l'application Meross.

## Dépannage

**« Meross a refusé les identifiants »** — vérifiez les trois champs ensemble : e-mail, mot
de passe et surtout la **région**. Un compte créé en Europe ne peut pas se connecter sur le
point d'accès américain.

**Un appareil reste hors ligne** — vérifiez d'abord qu'il est joignable dans l'application
Meross. Gladys rapporte ce que Meross lui indique : un appareil hors ligne pour Meross l'est
aussi ici.

**L'application Meross me déconnecte** — Meross limite le nombre de sessions simultanées par
compte. Reconnectez-vous simplement dans l'application : les deux sessions peuvent
coexister. L'intégration met sa session en cache et la libère à l'arrêt pour limiter le
phénomène.

**Un appareil est absent de l'onglet Découverte** — son type n'est probablement pas encore
pris en charge (les sous-appareils de hub en particulier). L'intégration écrit une ligne de
log pour chaque appareil ignoré.

**Rien ne fonctionne et je veux savoir pourquoi** — l'intégration journalise tout ce qu'elle
fait. Ouvrez les logs de l'intégration depuis l'interface Gladys (ou `docker logs` sur
l'hôte) ; passez `LOG_LEVEL` à `debug` pour le détail complet, y compris chaque message
échangé avec vos appareils.
