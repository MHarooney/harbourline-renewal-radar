import { describe, expect, it } from 'vitest'
import { parseBillingCsv, parseProjectsCsv } from './csv'
import { buildProjectEntities, buildRadar, classifyRenewal, daysBetween } from './radar'
import type { ClientRecord, RadarResult } from './types'

const AS_OF = '2026-08-29'

const BILLING_HEADER = 'client_name,retainer_start,retainer_end,monthly_fee_usd,plan'
const PROJECT_HEADER = 'brand_name,project_status,last_delivery,scope_summary,signed_at'

/** Build a radar from inline CSV so each test states its own fixture. */
function radar(billingRows: string[], projectRows: string[] = [], asOf = AS_OF): RadarResult {
  return buildRadar(
    parseBillingCsv([BILLING_HEADER, ...billingRows].join('\n')),
    parseProjectsCsv([PROJECT_HEADER, ...projectRows].join('\n')),
    { asOf },
  )
}

const find = (result: RadarResult, name: string): ClientRecord => {
  const client = result.clients.find((c) => c.displayName === name)
  if (!client) throw new Error(`No client named ${name}. Got: ${result.clients.map((c) => c.displayName).join(', ')}`)
  return client
}

const names = (clients: ClientRecord[]) => clients.map((c) => c.displayName)

// ---------------------------------------------------------------------------

describe('daysBetween', () => {
  it('counts whole calendar days', () => {
    expect(daysBetween('2026-08-29', '2026-08-29')).toBe(0)
    expect(daysBetween('2026-08-29', '2026-09-15')).toBe(17)
    expect(daysBetween('2026-08-29', '2026-08-20')).toBe(-9)
  })

  it('is unaffected by month and year boundaries', () => {
    expect(daysBetween('2026-12-31', '2027-01-01')).toBe(1)
    expect(daysBetween('2028-02-28', '2028-03-01')).toBe(2) // 2028 is a leap year
  })
})

describe('classifyRenewal — the 45-day rule', () => {
  it('treats both ends of the window as inside it', () => {
    expect(classifyRenewal(0, 45)).toBe('due')
    expect(classifyRenewal(45, 45)).toBe('due')
  })

  it('separates overdue, due, and upcoming', () => {
    expect(classifyRenewal(-1, 45)).toBe('overdue')
    expect(classifyRenewal(44, 45)).toBe('due')
    expect(classifyRenewal(46, 45)).toBe('upcoming')
  })

  it('never classifies an unknown date as a renewal', () => {
    expect(classifyRenewal(null, 45)).toBe('unknown')
  })
})

describe('window boundaries end to end', () => {
  const rows = [
    'Zero Day,2026-01-01,2026-08-29,1000,Growth', // 0
    'Forty Four,2026-01-01,2026-10-12,1000,Growth', // 44
    'Forty Five,2026-01-01,2026-10-13,1000,Growth', // 45 — inclusive
    'Forty Six,2026-01-01,2026-10-14,1000,Growth', // 46 — outside
    'Just Lapsed,2026-01-01,2026-08-28,1000,Growth', // -1
  ]

  it('includes day 0 through day 45 and excludes day 46', () => {
    const result = radar(rows)
    expect(names(result.due)).toEqual(['Zero Day', 'Forty Four', 'Forty Five'])
    expect(names(result.upcoming)).toEqual(['Forty Six'])
    expect(names(result.overdue)).toEqual(['Just Lapsed'])
  })

  it('reports the exact day count for each boundary', () => {
    const result = radar(rows)
    expect(find(result, 'Zero Day').daysToRenewal).toBe(0)
    expect(find(result, 'Forty Five').daysToRenewal).toBe(45)
    expect(find(result, 'Forty Six').daysToRenewal).toBe(46)
    expect(find(result, 'Just Lapsed').daysToRenewal).toBe(-1)
  })

  it('re-classifies everything when the as-of date moves', () => {
    // One day later, day 46 becomes day 45 and moves into the window.
    const later = radar(rows, [], '2026-08-30')
    expect(names(later.due)).toContain('Forty Six')
    expect(later.upcoming).toHaveLength(0)
    // ...and day 0 becomes overdue.
    expect(names(later.overdue)).toContain('Zero Day')
  })

  it('moves lapsed renewals back into the window when the as-of date moves back', () => {
    const earlier = radar(rows, [], '2026-08-01')
    expect(earlier.overdue).toHaveLength(0)
    expect(names(earlier.due)).toContain('Zero Day')
  })

  it('sorts the queue most urgent first', () => {
    const result = radar(rows)
    const queue = [...result.overdue, ...result.due]
    expect(queue.map((c) => c.daysToRenewal)).toEqual([-1, 0, 44, 45])
  })

  it('counts fee at risk from overdue and due clients only', () => {
    const result = radar(rows)
    // Four rows at $1,000: -1, 0, 44, 45. The 46-day row is excluded.
    expect(result.summary.monthlyFeeAtRiskUsd).toBe(4000)
  })
})

// ---------------------------------------------------------------------------

describe('re-signed clients', () => {
  const RESIGN = [
    'Riverstone Outfitters,2025-09-01,2026-09-01,5500,Scale', // old, ends in 3 days
    'Riverstone Outfitters,2026-09-01,2026-12-01,5900,Scale', // new, ends in 94 days
  ]
  const PROJECTS = [
    'Riverstone Outfitters,active,2026-08-25,Re-signed Q3 growth package,2026-09-01',
    'Riverstone Outfitters,closed,2026-08-01,Prior retainer,2025-09-01',
  ]

  it('resolves both billing rows into one client', () => {
    const result = radar(RESIGN, PROJECTS)
    expect(result.clients).toHaveLength(1)
    expect(result.summary.billingRows).toBe(2)
    expect(result.summary.clients).toBe(1)
  })

  it('uses the contract with the latest end date as current', () => {
    const client = find(radar(RESIGN, PROJECTS), 'Riverstone Outfitters')
    expect(client.renewalDate).toBe('2026-12-01')
    expect(client.daysToRenewal).toBe(94)
    expect(client.current.row.monthlyFeeUsd).toBe(5900)
  })

  it('does NOT show the superseded contract as a live renewal', () => {
    const result = radar(RESIGN, PROJECTS)
    // The old contract ends in 3 days. Before this rule existed, the account
    // lead saw a false alarm and chased a renewal that was already signed.
    expect(result.due).toHaveLength(0)
    expect(result.overdue).toHaveLength(0)
    expect(names(result.upcoming)).toEqual(['Riverstone Outfitters'])
  })

  it('keeps the superseded contract rather than deleting it', () => {
    const client = find(radar(RESIGN, PROJECTS), 'Riverstone Outfitters')
    expect(client.contracts).toHaveLength(2)
    expect(client.superseded).toHaveLength(1)
    expect(client.superseded[0]!.row.retainerEnd.iso).toBe('2026-09-01')
    expect(client.superseded[0]!.supersededByLine).toBe(3)
  })

  it('does not depend on the order of rows in the file', () => {
    const forwards = find(radar(RESIGN, PROJECTS), 'Riverstone Outfitters')
    const backwards = find(radar([...RESIGN].reverse(), PROJECTS), 'Riverstone Outfitters')
    expect(backwards.renewalDate).toBe(forwards.renewalDate)
    expect(backwards.superseded).toHaveLength(1)
  })

  it('treats an end date equal to the next start date as a clean handover', () => {
    const client = find(radar(RESIGN, PROJECTS), 'Riverstone Outfitters')
    expect(client.contracts.some((c) => c.flags.includes('overlaps_sibling'))).toBe(false)
  })

  it('flags genuinely overlapping coverage as suspicious', () => {
    const result = radar([
      'Copperleaf Home,2025-11-01,2026-09-20,4400,Growth',
      'Copperleaf Home,2026-08-01,2026-11-15,4800,Growth', // starts 50 days early
    ])
    const client = find(result, 'Copperleaf Home')
    expect(client.contracts.every((c) => c.flags.includes('overlaps_sibling'))).toBe(true)
    expect(result.issues.some((i) => i.kind === 'overlapping_contracts')).toBe(true)
    // The overlap is surfaced, not silently corrected: the later end still wins.
    expect(client.renewalDate).toBe('2026-11-15')
  })

  it('never lets a contract with no end date displace a dated one', () => {
    const client = find(
      radar([
        'Cedar & Co.,2026-04-01,2026-09-10,2900,Starter',
        'Cedar & Co.,2026-05-01,,2900,Starter',
      ]),
      'Cedar & Co.',
    )
    expect(client.renewalDate).toBe('2026-09-10')
    expect(client.renewalStatus).toBe('due')
  })

  it('collapses duplicate project rows to one entity and keeps the rest as history', () => {
    const entities = buildProjectEntities(parseProjectsCsv([PROJECT_HEADER, ...PROJECTS].join('\n')))
    expect(entities).toHaveLength(1)
    // The open engagement wins over the closed one, regardless of file order.
    expect(entities[0]!.primary.projectStatus).toBe('active')
    expect(entities[0]!.history).toHaveLength(1)
    expect(entities[0]!.history[0]!.projectStatus).toBe('closed')
  })

  it('reports duplicate project rows as traceable, not as an error', () => {
    const result = radar(RESIGN, PROJECTS)
    const issue = result.issues.find((i) => i.kind === 'duplicate_project_rows')
    expect(issue?.severity).toBe('info')
  })
})

// ---------------------------------------------------------------------------

describe('client matching', () => {
  const PROJECTS = [
    'Harbor Brew,active,2026-08-12,Shopify CRO,2026-03-01',
    'Acme Shop,active,2026-08-20,Paid social,2026-02-01',
    'Northwind Limited,active,2026-08-05,Retention,2025-12-01',
    'Atlas Homewares LLC,active,2026-08-08,SEO,2026-05-01',
  ]

  it('accepts a normalized exact match without review', () => {
    const client = find(radar(['ACME SHOP,2026-02-01,2026-09-30,6200,Scale'], PROJECTS), 'ACME SHOP')
    expect(client.match.status).toBe('exact')
    expect(client.match.method).toBe('normalized_exact')
    expect(client.match.score).toBe(1)
    expect(client.match.needsReview).toBe(false)
    expect(client.match.project?.brandName).toBe('Acme Shop')
  })

  it('matches across a legal suffix difference', () => {
    const client = find(radar(['Northwind Ltd,2025-12-01,2026-10-01,3800,Growth'], PROJECTS), 'Northwind Ltd')
    expect(client.match.status).toBe('exact')
    expect(client.match.project?.brandName).toBe('Northwind Limited')
  })

  it('matches when only one side carries the legal suffix', () => {
    const client = find(radar(['Atlas Homewares,2026-05-01,2026-10-13,4100,Growth'], PROJECTS), 'Atlas Homewares')
    expect(client.match.project?.brandName).toBe('Atlas Homewares LLC')
  })

  it('accepts a strong fuzzy match and says why', () => {
    const client = find(radar(['Harbour Brew Co,2026-03-01,2026-09-15,4500,Growth'], PROJECTS), 'Harbour Brew Co')
    expect(client.match.status).toBe('strong')
    expect(client.match.method).toBe('fuzzy')
    expect(client.match.needsReview).toBe(false)
    expect(client.match.score).toBeGreaterThan(0.9)
    expect(client.match.explanation).toContain('Harbor Brew')
  })

  it('proposes but does not confirm a middling single candidate', () => {
    const client = find(
      radar(
        ['St. Ives Provisions,2026-04-05,2026-10-08,3200,Growth'],
        ['Saint Ives Provisions,active,2026-08-16,Wholesale ops,2026-04-05'],
      ),
      'St. Ives Provisions',
    )
    expect(client.match.status).toBe('review')
    expect(client.match.needsReview).toBe(true)
    // The proposal is still attached so the lead can judge it.
    expect(client.match.project?.brandName).toBe('Saint Ives Provisions')
  })

  it('refuses to choose between two near-tied candidates', () => {
    const result = radar(
      ['Marberry Home,2026-03-20,2026-09-28,3700,Growth'],
      [
        'Mayberry Home,active,2026-08-14,Lifecycle email,2026-03-20',
        'Marbury Home,active,2026-08-09,Paid social,2026-02-01',
      ],
    )
    const client = find(result, 'Marberry Home')
    expect(client.match.status).toBe('ambiguous')
    expect(client.match.project).toBeNull()
    expect(client.match.needsReview).toBe(true)
    expect(client.match.candidates.length).toBeGreaterThanOrEqual(2)
    // The renewal date is unaffected — it comes from billing alone.
    expect(client.daysToRenewal).toBe(30)
    expect(result.issues.some((i) => i.kind === 'ambiguous_match')).toBe(true)
  })

  it('leaves a weak match unmatched rather than guessing', () => {
    const result = radar(['Waverly Tea Co,2026-06-15,2026-11-05,2400,Starter'], PROJECTS)
    const client = find(result, 'Waverly Tea Co')
    expect(client.match.status).toBe('unmatched')
    expect(client.match.project).toBeNull()
    expect(client.scopeSummary).toBeNull()
    expect(result.issues.some((i) => i.kind === 'unmatched_billing')).toBe(true)
  })

  it('picks the closer of two similar brands when the gap is clear', () => {
    const client = find(
      radar(
        ['Ridgeway Outdoors,2026-04-10,2026-10-05,4600,Growth'],
        [
          'Ridgeline Outdoors,active,2026-08-13,Content + SEO,2026-05-20',
          'Ridgeway Outdoor,active,2026-08-17,Wholesale,2026-04-10',
        ],
      ),
      'Ridgeway Outdoors',
    )
    expect(client.match.status).toBe('strong')
    expect(client.match.project?.brandName).toBe('Ridgeway Outdoor')
  })

  it('does not let two clients claim the same project record', () => {
    const result = radar(
      [
        'Acme Shop,2026-02-01,2026-09-30,6200,Scale',
        'ACME SHOP,2026-02-01,2026-10-30,6200,Scale', // same normalized key
      ],
      ['Acme Shop,active,2026-08-20,Paid social,2026-02-01'],
    )
    // Same key, so they are one client with two contracts — not two claimants.
    expect(result.clients).toHaveLength(1)
    expect(result.clients[0]!.contracts).toHaveLength(2)
  })

  it('produces the same result regardless of project row order', () => {
    const billing = ['Harbour Brew Co,2026-03-01,2026-09-15,4500,Growth']
    const forwards = find(radar(billing, PROJECTS), 'Harbour Brew Co')
    const backwards = find(radar(billing, [...PROJECTS].reverse()), 'Harbour Brew Co')
    expect(backwards.match.project?.brandName).toBe(forwards.match.project?.brandName)
    expect(backwards.match.score).toBe(forwards.match.score)
  })

  it('reports project brands with no billing record', () => {
    const result = radar(['ACME SHOP,2026-02-01,2026-09-30,6200,Scale'], [
      'Acme Shop,active,2026-08-20,Paid social,2026-02-01',
      'Tidewater Bakehouse,active,2026-08-07,Discovery sprint,2026-08-01',
    ])
    const issue = result.issues.find((i) => i.kind === 'unmatched_project')
    expect(issue?.subject).toBe('Tidewater Bakehouse')
  })
})

// ---------------------------------------------------------------------------

describe('unusable renewal dates', () => {
  const CASES: [string, string, string][] = [
    ['blank', 'Cedar & Co.,2026-04-01,,2900,Starter', 'blank'],
    ['impossible', 'Verity Skincare,2025-10-01,2026-02-30,3100,Growth', 'impossible'],
    ['ambiguous', 'Maple Row Studio,2026-01-05,30/04/2026,2600,Starter', 'ambiguous_format'],
    ['free text', 'Rolling Brand,2026-01-05,TBC,2600,Starter', 'unparseable'],
  ]

  for (const [label, row, problem] of CASES) {
    it(`excludes a ${label} renewal date from the radar and explains why`, () => {
      const result = radar([row])
      const client = result.clients[0]!
      expect(client.renewalStatus).toBe('unknown')
      expect(client.daysToRenewal).toBeNull()
      expect(client.renewalDateProblem).toBe(problem)
      expect(result.due).toHaveLength(0)
      expect(result.overdue).toHaveLength(0)
      expect(result.upcoming).toHaveLength(0)

      const issue = result.issues.find((i) => i.kind === 'unusable_renewal_date')
      expect(issue?.severity).toBe('blocking')
      expect(issue?.action.length).toBeGreaterThan(0)
    })
  }

  it('never infers a renewal date from the retainer length', () => {
    // A three-month rolling retainer starting 2026-04-01 "obviously" ends
    // 2026-07-01, but nothing in the brief says that rule holds, so we do not
    // apply it. A guessed date would look actionable when it is not.
    const client = radar(['Cedar & Co.,2026-04-01,,2900,Starter']).clients[0]!
    expect(client.renewalDate).toBeNull()
  })

  it('sorts unknown-date clients last so they cannot bury a real deadline', () => {
    const result = radar([
      'No Date,2026-04-01,,2900,Starter',
      'Due Soon,2026-01-01,2026-09-05,1000,Growth',
    ])
    expect(names(result.clients)).toEqual(['Due Soon', 'No Date'])
  })
})

// ---------------------------------------------------------------------------

describe('malformed rows', () => {
  it('reports a short row but still uses the values it could read', () => {
    const result = radar(['Nightjar Provisions,2026-03-01,2026-09-25,4200'])
    expect(result.issues.some((i) => i.kind === 'malformed_row')).toBe(true)
    const client = find(result, 'Nightjar Provisions')
    expect(client.daysToRenewal).toBe(27)
    expect(client.renewalStatus).toBe('due')
  })

  it('drops a row with no client name and says so', () => {
    const result = radar([',2026-03-01,2026-09-25,4200,Growth'])
    expect(result.clients).toHaveLength(0)
    const issue = result.issues.find((i) => i.kind === 'malformed_row')
    expect(issue?.severity).toBe('blocking')
  })

  it('handles empty exports without throwing', () => {
    const result = radar([], [])
    expect(result.clients).toHaveLength(0)
    expect(result.issues).toHaveLength(0)
    expect(result.summary.monthlyFeeAtRiskUsd).toBe(0)
  })
})

// ---------------------------------------------------------------------------

describe('issues are actionable', () => {
  it('gives every issue a subject, a detail, and a next step', () => {
    const result = radar(
      [
        'Cedar & Co.,2026-04-01,,2900,Starter',
        'Waverly Tea Co,2026-06-15,2026-11-05,2400,Starter',
        'Nightjar Provisions,2026-03-01,2026-09-25,4200',
      ],
      ['Tidewater Bakehouse,active,2026-08-07,Discovery sprint,2026-08-01'],
    )
    expect(result.issues.length).toBeGreaterThan(0)
    for (const issue of result.issues) {
      expect(issue.subject.length).toBeGreaterThan(0)
      expect(issue.title.length).toBeGreaterThan(0)
      expect(issue.detail.length).toBeGreaterThan(0)
      expect(issue.action.length).toBeGreaterThan(0)
    }
  })

  it('orders blocking issues before attention and info', () => {
    const result = radar(
      ['Cedar & Co.,2026-04-01,,2900,Starter'],
      ['Tidewater Bakehouse,active,2026-08-07,Discovery sprint,2026-08-01'],
    )
    const severities = result.issues.map((i) => i.severity)
    expect(severities.indexOf('blocking')).toBeLessThan(severities.indexOf('info'))
  })
})

// ---------------------------------------------------------------------------

describe('summary', () => {
  it('reconciles bucket counts with the client list', () => {
    const result = radar([
      'A,2026-01-01,2026-08-01,100,Growth', // overdue
      'B,2026-01-01,2026-09-05,200,Growth', // due
      'C,2026-01-01,2026-12-05,300,Growth', // upcoming
      'D,2026-01-01,,400,Growth', // unknown
    ])
    const { summary } = result
    expect(summary.overdue + summary.due + summary.upcoming + summary.unknown).toBe(
      result.clients.length,
    )
    expect(summary.monthlyFeeAtRiskUsd).toBe(300)
  })

  it('counts every client that needs a human decision', () => {
    const result = radar(
      ['Waverly Tea Co,2026-06-15,2026-11-05,2400,Starter'],
      ['Totally Different Brand,active,2026-08-07,Scope,2026-08-01'],
    )
    expect(result.summary.needsReview).toBe(1)
  })
})
