/**
 * Name normalization and similarity scoring.
 *
 * Deterministic and dependency-free on purpose. An account lead has to be able
 * to look at two names and understand why the system joined them; an LLM or an
 * opaque embedding model would make "why did these match?" unanswerable, and it
 * would also break the "no paid APIs / no new logins" constraint.
 */

/**
 * Legal and generic company suffixes collapsed to one spelling. Only variants
 * that mean the same thing are mapped — "Group" and "Holdings" are NOT here,
 * because "Halden Group" and "Halden Holdings" can be different entities.
 */
const SUFFIX_ALIASES: Record<string, string> = {
  limited: 'ltd',
  ltd: 'ltd',
  incorporated: 'inc',
  incorporation: 'inc',
  inc: 'inc',
  llc: 'llc',
  co: 'co',
  company: 'co',
  corp: 'corp',
  corporation: 'corp',
  plc: 'plc',
  gmbh: 'gmbh',
}

/**
 * Suffixes dropped entirely when trailing. Billing exports carry the registered
 * entity ("Atlas Homewares LLC") while project boards carry the trading name
 * ("Atlas Homewares"), so the suffix is noise for matching purposes.
 */
const DROPPABLE_SUFFIXES = new Set(['ltd', 'inc', 'llc', 'co', 'corp', 'plc', 'gmbh'])

/**
 * Normalize a client/brand name into a comparable key.
 *
 * Judgement call: tokens are sorted alphabetically, so "Riverstone Outfitters"
 * and "Outfitters, Riverstone" collapse to the same key. Exports genuinely do
 * flip word order (last-name-first conventions, CRM re-formatting). The cost is
 * that word order carries no signal; that is an acceptable trade for this
 * dataset because brand names here are distinctive on their tokens.
 */
export function normalizeName(raw: string): string {
  let s = raw.normalize('NFKD').toLowerCase()
  // Strip combining marks so "Café Noir" and "Cafe Noir" agree.
  s = s.replace(/[\u0300-\u036f]/g, '')
  s = s.replace(/&/g, ' and ')
  s = s.replace(/[^a-z0-9\s]/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()

  const tokens = s
    .split(' ')
    .filter(Boolean)
    .map((token) => SUFFIX_ALIASES[token] ?? token)

  // Drop trailing legal suffixes, but never reduce a name to nothing.
  while (tokens.length > 1 && DROPPABLE_SUFFIXES.has(tokens[tokens.length - 1]!)) {
    tokens.pop()
  }

  return tokens.sort().join(' ')
}

/** Standard Levenshtein edit distance, two-row implementation. */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1]! + 1, prev[j]! + 1, prev[j - 1]! + cost)
    }
    const swap = prev
    prev = curr
    curr = swap
  }
  return prev[b.length]!
}

/**
 * Similarity in [0, 1] from edit distance relative to the longer string.
 * 1.0 means the normalized keys are identical.
 */
export function similarity(a: string, b: string): number {
  if (a === b) return 1
  if (!a || !b) return 0
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length)
}

// ---------------------------------------------------------------------------
// Thresholds
// ---------------------------------------------------------------------------

/**
 * At or above this, a fuzzy match is trusted without human confirmation.
 * Calibrated so a one-character difference in a typical 15-25 character brand
 * key clears it ("Ridgeway Outdoors" vs "Ridgeway Outdoor" = 0.94) while a
 * different-word lookalike does not ("Ridgeline Outdoors" = 0.78).
 */
export const AUTO_ACCEPT_SIMILARITY = 0.9

/**
 * Below this, no candidate is proposed at all. Deliberately high: an unmatched
 * client is a visible, fixable gap, whereas a wrong join silently attaches
 * another brand's delivery history to a renewal decision.
 */
export const REVIEW_FLOOR_SIMILARITY = 0.78

/**
 * The winner must beat the runner-up by at least this much. If two brands are
 * this close, no amount of score tuning makes the choice safe — a human has to
 * look. This is what stops the system from confidently picking "Mayberry Home"
 * over "Marbury Home" for a billing row that reads "Marberry Home".
 */
export const AMBIGUITY_GAP = 0.1

export function formatScore(score: number): string {
  return `${Math.round(score * 100)}%`
}
