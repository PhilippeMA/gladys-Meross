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
| Prise avec mesure (MSS310, MOP320)              | Marche/arrêt, plus puissance, tension, courant et énergie du jour |
| Multiprise (MSS425…)                            | Chaque prise séparément                                           |
| Ampoule ou bandeau (MSL120, MSL320, MSL430…)    | Marche/arrêt, luminosité, couleur et température de blanc         |
| Ouvre-porte de garage (MSG100, MSG200)          | L'ouvrir, la fermer, et voir si elle est réellement ouverte       |
| Hub (MSH300, MSH400)                            | Tout ce qui lui est appairé — voir ci-dessous                     |

### Appareils reliés à un hub

Un hub est une passerelle : il n'a rien à allumer ou éteindre par lui-même. Le hub
n'apparaît donc pas dans Gladys — **chaque capteur qui lui est appairé, si**, sous le nom que
vous lui avez donné dans l'application Meross.

| Appareil appairé                  | Ce que vous obtenez dans Gladys                                       |
| --------------------------------- | --------------------------------------------------------------------- |
| Thermomètre (MS100)               | Température, humidité, niveau de batterie                             |
| Vanne thermostatique (MTS100/150) | Température de consigne, température ambiante, marche/arrêt, batterie |
| Détecteur de fuite (MS400)        | Fuite détectée, niveau de batterie                                    |
| Capteur d'ouverture (MS200)       | Ouverture, niveau de batterie                                         |
| Programmateur d'arrosage (MST100) | Lancer un arrosage, régler sa durée, batterie                         |

Si votre hub semble ne rien faire, vérifiez qu'au moins un capteur lui est **appairé dans
l'application Meross** : un hub sans capteur n'a rien à afficher. Le bouton **Diagnostiquer
mes appareils** liste ce que l'intégration a trouvé derrière lui.

Le _mode_ des vannes (confort, éco, programmation) n'est pas encore disponible — seulement la
température de consigne, qui est l'essentiel pour les automatisations.

#### Programmateurs d'arrosage

Un programmateur MST100 sur un hub MSH400 vous donne un interrupteur **« Watering »**, trois
durées en minutes et son **niveau de batterie**.

Activez **Watering** et le programmateur arrose, puis s'arrête tout seul — exactement comme le
bouton « arroser maintenant » de l'application Meross. Désactivez-le pour arrêter avant la
fin. L'interrupteur se remet à zéro quand l'arrosage se termine.

##### Les trois durées

| Fonctionnalité                           | Ce qu'elle représente                                   |
| ---------------------------------------- | ------------------------------------------------------- |
| **Default watering duration**            | Le réglage de l'appareil, celui de l'application Meross |
| **Next watering duration (0 = default)** | La durée du prochain arrosage lancé depuis Gladys       |
| **Last watering duration**               | Ce que le dernier arrosage a réellement duré            |

**Default watering duration** est **la valeur réglée sur le programmateur lui-même** — la même
que dans l'application Meross. La modifier depuis Gladys l'écrit sur l'appareil, donc
l'application verra le changement, et inversement. Il n'y a qu'une seule valeur et elle
appartient au matériel. Tant que le programmateur n'a rien communiqué, elle reste vide plutôt
qu'affichée avec une valeur inventée.

**Next watering duration** est une durée exceptionnelle, pour un seul arrosage. Elle
**n'est jamais écrite sur l'appareil** : votre réglage de l'application Meross reste intact.

- À **0** — sa valeur au repos — Gladys ne dit rien sur la durée et le programmateur applique
  la sienne. C'est le comportement par défaut, exactement comme avant.
- À une autre valeur, le prochain arrosage lancé depuis Gladys durera ce temps-là.

Elle se règle avec un curseur, de **0 à 120 minutes**. Ce plafond est plus bas que celui de la
durée par défaut, et volontairement : Gladys affiche une durée modifiable sous forme de
curseur, donc plus la plage est large, moins le réglage est précis. Pour un arrosage plus long,
c'est la **durée par défaut** qu'il faut régler — elle va jusqu'à 24 h.

Elle **revient à 0 dès que l'arrosage démarre** : elle est consommée. Le champ se vide sous
vos yeux, et c'est **Last watering duration** qui vous indique la durée réellement appliquée.
Si le hub refuse la commande, la valeur est conservée — vous n'avez pas à la resaisir.

Dans une scène, réglez **Next watering duration** puis allumez **Watering** : les deux actions
s'enchaînent dans l'ordre.

Un arrosage lancé depuis l'application Meross ou par la programmation du hub utilise la durée
par défaut et ne consomme pas votre valeur.

Cette durée n'est pas conservée si l'intégration redémarre : au démarrage elle est à 0, donc
un arrosage lancé après un redémarrage utilise la durée par défaut. C'est délibéré — une durée
saisie il y a des semaines ne doit pas s'appliquer en silence à l'arrosage d'aujourd'hui.

Gladys parle à votre hub en direct sur votre réseau local quand il est joignable, et via les
serveurs Meross sinon. Si l'arrosage échoue, le message d'erreur nomme les deux canaux et
l'adresse qui n'a pas répondu ; **Diagnostiquer mes appareils** affiche l'adresse locale de
chaque appareil et le canal réellement utilisé.

Les **programmations** d'arrosage restent dans l'application Meross : le hub n'en autorise ni
la lecture ni la modification depuis l'extérieur.

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

Les prises qui mesurent la consommation et les capteurs derrière un hub sont lus à cet
intervalle. Choisissez-le dans la liste : **chaque minute** (valeur par défaut, et intervalle
le plus lent que Gladys accepte) jusqu'à chaque seconde.

Tout le reste — marche/arrêt, couleurs, position de la porte de garage — arrive
**instantanément**, poussé par l'appareil, y compris lorsque quelqu'un appuie sur un bouton
physique ou utilise l'application Meross. L'intervalle le plus lent convient donc à la
plupart des installations ; un intervalle plus rapide ne fait qu'augmenter le nombre de
requêtes vers Meross.

## Actions

- **Tester la connexion** — se connecte avec les identifiants du formulaire et indique
  combien d'appareils contient votre compte, et combien sont en ligne.
- **Rafraîchir la liste des appareils** — relit votre compte. À utiliser après avoir ajouté
  ou renommé un appareil dans l'application Meross, ou appairé un capteur à un hub.
- **Diagnostiquer mes appareils** — liste chaque appareil du compte, ses capacités, les
  capteurs trouvés derrière un hub, et la façon dont l'intégration a traité chacun.
  Commencez par là quand un appareil manque.

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

**Un appareil est absent de l'onglet Découverte** — cliquez sur **Diagnostiquer mes
appareils** : le rapport indique si l'appareil a été vu, ce qu'il annonce, et si
l'intégration a su le traiter. S'il s'agit d'un capteur censé être derrière un hub, vérifiez
qu'il est bien appairé à ce hub dans l'application Meross. L'intégration écrit également une
ligne de log pour chaque appareil ignoré, en précisant ce qu'elle a vu.

**L'adresse locale de mon appareil ne répond pas** — l'intégration bascule sur le cloud et
le signale dans les logs, avec la raison :

- _no route to the device_ — Gladys n'est pas sur le même réseau que l'appareil. C'est le cas
  habituel quand Gladys tourne dans Docker sur un autre sous-réseau ou un autre VLAN.
- _connection refused_ — l'adresse répond mais rien n'écoute : ce n'est probablement plus
  votre appareil (bail DHCP qui a changé). Utilisez **Rafraîchir la liste des appareils**.
- _no answer before the timeout_ — un pare-feu bloque les paquets.

Cliquez sur **Diagnostiquer mes appareils** pour un vrai test : il envoie une requête
correctement signée et rapporte ce que chaque adresse répond. Un `curl` à la main n'apprend
pas grand-chose ici — un appareil Meross accepte la connexion puis ignore en silence toute
requête non signée, si bien qu'un appareil en pleine forme ressemble à un appareil mort.

Toute réponse autre qu'une erreur de connexion signifie que l'appareil est joignable. Sinon,
la correction est côté réseau. La lecture des états et la plupart des commandes continuent
de fonctionner par le cloud ; **l'arrosage, lui, exige ce canal local** sur les hubs MSH400.

Le bouton **Diagnostiquer mes appareils** teste l'adresse locale port par port et affiche ce
que chacun répond — c'est plus fiable qu'un `curl` à la main, car un appareil Meross accepte
la connexion puis ignore en silence toute requête non signée.

**Rien ne fonctionne et je veux savoir pourquoi** — l'intégration journalise tout ce qu'elle
fait. Ouvrez les logs de l'intégration depuis l'interface Gladys (ou `docker logs` sur
l'hôte) ; passez `LOG_LEVEL` à `debug` pour le détail complet, y compris chaque message
échangé avec vos appareils.
