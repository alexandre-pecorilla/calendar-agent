# Demander au bot quand quelqu'un est disponible

Ce bot répond à une seule question : **à quel moment son propriétaire est
disponible.** Il lit l'état libre/occupé de son agenda et vous indique les
créneaux libres. Il ne montre jamais ce qu'il y a dans l'agenda et ne réserve
jamais rien : quand vous avez trouvé un créneau, envoyez une invitation au
propriétaire comme d'habitude.

Le bot porte le prénom du propriétaire suivi de `-calendar-agent`, par exemple
`alex-calendar-agent`. La commande slash porte le même nom.

## Trois façons de demander

| Où | Comment | Qui voit la réponse |
| --- | --- | --- |
| Message direct | Ouvrez un DM avec le bot et posez votre question | vous |
| Dans un canal | `@<nom-du-bot> <prénom> est dispo lundi à 16h ?` (le bot doit être membre du canal) | le canal, dans un fil sous votre message |
| N'importe où | `/<nom-du-bot> <votre question>` | vous seulement (message éphémère) |

Pas besoin de dire le prénom : « dispo lundi à 16h ? », « tu es libre demain ? »
et « <prénom> est disponible lundi ? » désignent tous le propriétaire.

## Ce que vous pouvez demander

- Un moment : « <prénom> est disponible lundi à 16h ? », « demain à 10h ? »
- Une journée : « Quand <prénom> est libre mardi ? », « jeudi matin ? » (le matin avant midi, l'après-midi à partir de midi, le soir à partir de 18h)
- Une période : « Disponibilités de <prénom> la semaine prochaine sauf mercredi ? », « un créneau dans les deux prochaines semaines ? »
- Sans date : « Quand <prénom> est dispo ? » donne les cinq prochains jours ouvrés.
- Avec une durée : « Une heure mardi ? » ne liste que les créneaux d'au moins une heure.
- Dans un autre fuseau : « lundi 9h heure de Paris ».

Posez la question en français ou en anglais ; le bot répond dans votre langue.

## À quoi ressemble la réponse

```
Oui, Alex est disponible lundi 12 octobre de 16h00 à 17h30, heure de Paris.

Disponibilités d'Alex du lundi 12 octobre au vendredi 16 octobre (sauf mercredi), heure de Paris :
• lundi 12 octobre : 9h00 à 11h30, 14h00 à 17h00
• mardi 13 octobre : 10h00 à 12h00
• jeudi 15 octobre : toute la journée, 9h00 à 18h00
• vendredi 16 octobre : aucune disponibilité
```

Les heures sont dans **votre** fuseau horaire, celui de votre profil Slack, et
le fuseau est toujours écrit dans la réponse. Si le fuseau de votre profil est
erroné ou si vous voyagez, nommez le fuseau voulu : « heure de Londres ».

## Ce que le bot ne fera pas

- Dire pourquoi le propriétaire est occupé, ni ce qu'est la réunion. Il ne connaît que libre ou occupé.
- Réserver, bloquer, déplacer ou annuler quoi que ce soit. Envoyez vous-même l'invitation.
- Regarder au-delà de quatre semaines, ni dans le passé.
- Répondre sur l'agenda de quelqu'un d'autre, ni sur le vôtre.

Si vous demandez quelque chose qu'il ne peut pas faire, il le dit en une ligne.
Tapez `aide` pour revoir des exemples.

## Bon à savoir

- Les créneaux libres suivent les heures habituelles du propriétaire. En dehors,
  le bot dit « en dehors des heures habituelles » plutôt qu'« occupé ».
- Une journée entièrement libre s'affiche « toute la journée ».
- Si une question est ambiguë, le bot vous demande de reformuler avec un jour
  ou une heure ; si ce n'est pas une question de disponibilité, il dit ce
  qu'il sait faire.
- Le bot répond en quelques secondes. Au-delà de quelques questions par minute,
  il vous demande de patienter.
