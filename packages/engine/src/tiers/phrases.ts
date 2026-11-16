import type { Category } from '../types.js';

export interface PhraseRule {
  /** Lowercased phrase to match on word boundaries. */
  from: string;
  /** Replacements, best first. An empty string deletes the phrase. */
  to: string[];
  category: Category;
  rule: string;
  title: string;
  detail?: string;
}

/**
 * Wordy phrases with shorter equivalents. This is the bulk of what users
 * recognize as Grammarly's "clarity" category, and it is pure table lookup.
 */
export const WORDY: PhraseRule[] = ([
  ['in order to', ['to']], ['in order for', ['for']], ['for the purpose of', ['to', 'for']],
  ['with the exception of', ['except for', 'besides']], ['in the event that', ['if']],
  ['in the event of', ['if']], ['due to the fact that', ['because']],
  ['owing to the fact that', ['because']], ['on account of the fact that', ['because']],
  ['for the reason that', ['because']], ['in spite of the fact that', ['although']],
  ['despite the fact that', ['although']], ['regardless of the fact that', ['although']],
  ['in view of the fact that', ['because', 'since']], ['the fact that', ['that']],
  ['at this point in time', ['now', 'currently']], ['at the present time', ['now']],
  ['at that point in time', ['then']], ['in this day and age', ['today', 'now']],
  ['on a daily basis', ['daily']], ['on a regular basis', ['regularly']],
  ['on a weekly basis', ['weekly']], ['on a monthly basis', ['monthly']],
  ['in a timely manner', ['promptly']], ['in a careful manner', ['carefully']],
  ['in the near future', ['soon']], ['until such time as', ['until']],
  ['during the course of', ['during']], ['in the course of', ['during']],
  ['prior to', ['before']], ['subsequent to', ['after']], ['in advance of', ['before']],
  ['in close proximity to', ['near']], ['in the vicinity of', ['near']],
  ['with regard to', ['about', 'regarding']], ['with respect to', ['about', 'regarding']],
  ['in reference to', ['about']], ['in relation to', ['about']],
  ['as regards', ['about']], ['pertaining to', ['about']],
  ['in connection with', ['about', 'with']], ['on the subject of', ['about']],
  ['a large number of', ['many']], ['a great number of', ['many']],
  ['a majority of', ['most']], ['a small number of', ['a few']],
  ['a sufficient number of', ['enough']], ['an adequate amount of', ['enough']],
  ['the vast majority of', ['most']], ['a total of', ['']],
  ['in the amount of', ['for']], ['in excess of', ['more than', 'over']],
  ['greater than', ['more than']], ['less than or equal to', ['at most']],
  ['has the ability to', ['can']], ['have the ability to', ['can']],
  ['has the capability of', ['can']], ['is able to', ['can']], ['are able to', ['can']],
  ['is in a position to', ['can']], ['it is possible that', ['possibly', 'maybe']],
  ['there is a possibility that', ['possibly', 'maybe']],
  ['it is necessary that', ['must']], ['it is imperative that', ['must']],
  ['it is incumbent upon', ['must']], ['is required to', ['must']],
  ['make a decision', ['decide']], ['reach a decision', ['decide']],
  ['come to a conclusion', ['conclude']], ['draw a conclusion', ['conclude']],
  ['give consideration to', ['consider']], ['take into consideration', ['consider']],
  ['make an assumption', ['assume']], ['make reference to', ['refer to']],
  ['make an adjustment', ['adjust']], ['make an inquiry', ['ask', 'inquire']],
  ['provide assistance to', ['help']], ['be of assistance to', ['help']],
  ['conduct an investigation', ['investigate']], ['perform an analysis', ['analyze']],
  ['carry out an evaluation', ['evaluate']], ['undertake a review', ['review']],
  ['put in place', ['set up', 'establish']], ['bring to a close', ['end', 'close']],
  ['have an effect on', ['affect']], ['have an impact on', ['affect']],
  ['serves to improve', ['improves']], ['acts as a', ['is a']],
  ['the utilization of', ['using']], ['utilization of', ['use of']],
  ['utilize', ['use']], ['utilizes', ['uses']], ['utilized', ['used']],
  ['utilizing', ['using']], ['facilitate', ['help', 'ease']],
  ['endeavor to', ['try to']], ['ascertain', ['find out', 'determine']],
  ['commence', ['begin', 'start']], ['terminate', ['end', 'stop']],
  ['demonstrate', ['show']], ['subsequently', ['later', 'then']],
  ['approximately', ['about']], ['sufficient', ['enough']],
  ['numerous', ['many']], ['additional', ['more', 'extra']],
  ['initiate', ['start', 'begin']], ['finalize', ['finish', 'complete']],
  ['methodology', ['method']], ['functionality', ['features']],
  ['individuals', ['people']], ['purchase', ['buy']],
  ['obtain', ['get']], ['require', ['need']], ['inquire', ['ask']],
  ['assist', ['help']], ['attempt', ['try']], ['currently', ['now', '']],
  ['is going to', ['will']], ['are going to', ['will']],
  ['whether or not', ['whether']], ['each and every', ['every', 'each']],
  ['first and foremost', ['first']], ['one and the same', ['the same']],
  ['various different', ['various', 'different']], ['few in number', ['few']],
  ['completely eliminate', ['eliminate']], ['totally destroyed', ['destroyed']],
  ['absolutely essential', ['essential']], ['basic fundamentals', ['fundamentals']],
  ['end result', ['result']], ['final outcome', ['outcome']],
  ['past history', ['history']], ['future plans', ['plans']],
  ['advance planning', ['planning']], ['close proximity', ['proximity', 'nearness']],
  ['unexpected surprise', ['surprise']], ['free gift', ['gift']],
  ['added bonus', ['bonus']], ['new innovation', ['innovation']],
  ['personal opinion', ['opinion']], ['brief summary', ['summary']],
  ['general consensus', ['consensus']], ['joint collaboration', ['collaboration']],
  ['mutual cooperation', ['cooperation']], ['revert back', ['revert']],
  ['return back', ['return']], ['refer back', ['refer']],
  ['repeat again', ['repeat']], ['combine together', ['combine']],
  ['merge together', ['merge']], ['collaborate together', ['collaborate']],
  ['plan ahead', ['plan']], ['rise up', ['rise']],
  ['ask the question', ['ask']], ['the reason why is because', ['because']],
  ['the reason is because', ['because']], ['needless to say', ['']],
  ['it should be noted that', ['']], ['it is worth noting that', ['']],
  ['it is important to note that', ['']], ['as a matter of fact', ['in fact', '']],
  ['for all intents and purposes', ['']], ['when all is said and done', ['']],
  ['at the end of the day', ['ultimately', '']],
  ['in my personal opinion', ['I think']], ['in my own opinion', ['I think']],
] as [string, string[]][]).map(([from, to]) => ({
  from,
  to,
  category: 'clarity' as Category,
  rule: `clarity:wordy/${from.replace(/\s+/g, '-')}`,
  title: to[0] === '' ? 'This phrase adds nothing' : `Wordy — try "${to[0]}"`,
  detail: to[0] === ''
    ? 'The sentence reads the same without it.'
    : 'A shorter phrase says the same thing.',
}));

/** Weak intensifiers and filler that dilute a sentence rather than strengthen it. */
export const FILLER: PhraseRule[] = ([
  'very', 'really', 'quite', 'rather', 'somewhat', 'fairly', 'pretty much',
  'just', 'actually', 'basically', 'literally', 'simply', 'totally',
  'definitely', 'certainly', 'absolutely', 'extremely', 'incredibly',
  'super', 'so very', 'kind of', 'sort of', 'a bit', 'a little bit',
  'in a sense', 'more or less', 'for the most part', 'as it were',
] as string[]).map((from) => ({
  from,
  to: [''],
  category: 'engagement' as Category,
  rule: `engagement:filler/${from.replace(/\s+/g, '-')}`,
  title: `"${from}" weakens the sentence`,
  detail: 'Intensifiers like this usually dilute the word they modify. Cutting it is stronger, or pick a sharper word.',
}));

/** Hedges that make a confident statement sound unsure. */
export const HEDGES: PhraseRule[] = ([
  'i think that', 'i think', 'i believe that', 'i believe', 'i feel like', 'i feel that',
  'i would say that', 'i would argue that', 'it seems that', 'it seems like',
  'it appears that', 'in my opinion', 'to be honest', 'if i am being honest',
  'i am not sure but', 'i could be wrong but', 'correct me if i am wrong but',
  'just my two cents', 'maybe we could', 'perhaps we could',
  'i was wondering if', 'i was just wondering', 'would it be possible to',
  'do you think you could', 'if you do not mind', 'if that is okay',
  'sorry to bother you', 'sorry for the delay', 'apologies for the delay',
  'i hope this is not too much trouble', 'does that make sense',
] as string[]).map((from) => ({
  from,
  to: [''],
  category: 'delivery' as Category,
  rule: `delivery:hedge/${from.replace(/\s+/g, '-')}`,
  title: 'This hedge softens your point',
  detail: 'Stating it directly reads as more confident. Keep the hedge only if you genuinely mean to signal doubt.',
}));

/** Tired figures of speech. */
export const CLICHES: PhraseRule[] = ([
  'think outside the box', 'low hanging fruit', 'move the needle',
  'circle back', 'touch base', 'boil the ocean', 'drink from the firehose',
  'take it to the next level', 'push the envelope', 'raise the bar',
  'hit the ground running', 'back to the drawing board', 'win-win',
  'par for the course', 'ahead of the curve',
  'last but not least', 'tip of the iceberg', 'few and far between',
  'needle in a haystack', 'avoid like the plague', 'easier said than done',
  'only time will tell', 'time will tell', 'the bottom line is',
  'a perfect storm', 'game changer', 'paradigm shift', 'synergy',
  'leverage our', 'best of both worlds', 'crystal clear',
  'in this economy', 'brave new world', 'tried and true',
] as string[]).map((from) => ({
  from,
  to: [],
  category: 'engagement' as Category,
  rule: `engagement:cliche/${from.replace(/\s+/g, '-')}`,
  title: 'This phrase has lost its force',
  detail: 'A reader skims past a cliché. Say the concrete thing you mean instead.',
}));

export const ALL_PHRASES: PhraseRule[] = [...WORDY, ...FILLER, ...HEDGES, ...CLICHES];
