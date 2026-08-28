const SUFFIX_MAP: Record<string, string> = {
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
}

/** Normalize client/brand names for fuzzy comparison. */
export function normalizeName(raw: string): string {
  let s = raw.normalize('NFKD').toLowerCase()
  s = s.replace(/&/g, ' and ')
  s = s.replace(/[^a-z0-9\s]/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()

  const tokens = s.split(' ').filter(Boolean).map((token) => {
    return SUFFIX_MAP[token] ?? token
  })

  // Drop trailing legal/generic suffixes so "Atlas Homewares LLC"
  // matches "Atlas Homewares" and "Harbour Brew Co" matches "Harbor Brew".
  const trailingNoise = new Set(['co', 'company', 'ltd', 'inc', 'llc', 'corp'])
  while (tokens.length > 1 && trailingNoise.has(tokens[tokens.length - 1]!)) {
    tokens.pop()
  }

  return tokens.sort().join(' ')
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (!a.length) return b.length
  if (!b.length) return a.length

  const prev = new Array<number>(b.length + 1)
  const curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j++) prev[j] = curr[j]!
  }
  return prev[b.length]!
}

/** Similarity in [0, 1] from normalized Levenshtein distance. */
export function similarity(a: string, b: string): number {
  if (!a && !b) return 1
  if (!a || !b) return 0
  const dist = levenshtein(a, b)
  const maxLen = Math.max(a.length, b.length)
  return 1 - dist / maxLen
}

export function confidenceFromScore(score: number): 'high' | 'medium' | 'low' | 'none' {
  if (score >= 0.92) return 'high'
  if (score >= 0.8) return 'medium'
  if (score >= 0.68) return 'low'
  return 'none'
}
