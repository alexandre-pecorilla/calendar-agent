import type { Lang } from '../availability/timezone.js';
import { englishPossessive, frenchDe } from '../config/identity.js';

/**
 * Replies that never go through the model (scope §5.4). Identity comes from
 * the configuration; nothing here names anyone.
 */
export type FixedKind =
  | 'other_person'
  | 'self'
  | 'booking'
  | 'off_topic'
  | 'help'
  | 'clarify'
  | 'rate_limited'
  | 'over_capacity'
  | 'cannot_check'
  | 'past'
  | 'beyond_horizon';

export interface FixedParams {
  ownerName: string;
  botName: string;
  horizonWeeks?: number;
}

export function fixedReply(kind: FixedKind, lang: Lang, p: FixedParams): string {
  const o = p.ownerName;
  const weeks = p.horizonWeeks ?? 4;
  if (lang === 'fr') {
    const de = frenchDe(o);
    switch (kind) {
      case 'other_person':
        return `Je ne connais que les disponibilités ${de}, pas les agendas des autres personnes.`;
      case 'self':
        return `Je ne connais que les disponibilités ${de}, pas les vôtres.`;
      case 'booking':
        return `Je ne peux rien réserver, bloquer ni modifier. Envoyez directement une invitation à ${o}.`;
      case 'off_topic':
        return `Je peux seulement dire quand ${o} est disponible ou non.`;
      case 'help':
        return `Demandez-moi quand ${o} est disponible, par exemple : « ${o} est dispo lundi à 16h ? », « Disponibilités ${de} la semaine prochaine sauf mercredi ? », « Une heure mardi ? ». Je réponds dans votre langue et votre fuseau horaire. Je ne réserve jamais rien.`;
      case 'clarify':
        return `Je n'ai pas compris de quel jour ou de quelle heure vous parlez. Essayez par exemple « lundi à 16h » ou « la semaine prochaine ».`;
      case 'rate_limited':
        return `Trop de questions d'un coup. Réessayez dans une minute.`;
      case 'over_capacity':
        return `J'ai atteint ma limite quotidienne. Réessayez demain.`;
      case 'cannot_check':
        return `Je ne peux pas consulter l'agenda ${de} pour le moment. Réessayez un peu plus tard.`;
      case 'past':
        return `Cette date est déjà passée.`;
      case 'beyond_horizon':
        return `Je ne peux regarder que ${weeks} semaines à l'avance. Quelle semaine vous intéresse ?`;
    }
  }
  const poss = englishPossessive(o);
  switch (kind) {
    case 'other_person':
      return `I only know when ${o} is available, not other people's calendars.`;
    case 'self':
      return `I only know ${poss} availability, not yours.`;
    case 'booking':
      return `I can't book, hold or change anything. Please send ${o} an invite directly.`;
    case 'off_topic':
      return `I can only tell you when ${o} is free or busy.`;
    case 'help':
      return `Ask me when ${o} is available, for example: "Is ${o} free Monday at 4 pm?", "${poss} availability next week except Wednesday?", "Do you have an hour on Tuesday?". I answer in your language and timezone. I never book anything.`;
    case 'clarify':
      return `I didn't understand which day or time you mean. Try something like "Monday at 4 pm" or "next week".`;
    case 'rate_limited':
      return `Too many questions at once. Please try again in a minute.`;
    case 'over_capacity':
      return `I've reached my daily limit. Please try again tomorrow.`;
    case 'cannot_check':
      return `I can't check ${poss} calendar right now. Please try again a little later.`;
    case 'past':
      return `That date is already in the past.`;
    case 'beyond_horizon':
      return `I can only look up to ${weeks} weeks ahead. Which week would you like?`;
  }
}
