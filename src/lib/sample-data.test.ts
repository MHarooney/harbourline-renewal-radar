/**
 * The brief requires the committed sample exports to demonstrate a specific set
 * of data problems. These tests pin that: if someone edits a CSV and quietly
 * removes the exactly-45-day row or the ambiguous pair, the suite fails rather
 * than the demo silently losing its point.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseBillingCsv, parseProjectsCsv } from './csv'
import { buildRadar } from './radar'
import type { ClientRecord } from './types'
import { DEMO_AS_OF_DATE, RENEWAL_WINDOW_DAYS } from './types'

const billing = parseBillingCsv(readFileSync('public/data/billing.csv', 'utf8'))
const projects = parseProjectsCsv(readFileSync('public/data/projects.csv', 'utf8'))
const result = buildRadar(billing, projects, {
  asOf: DEMO_AS_OF_DATE,
  windowDays: RENEWAL_WINDOW_DAYS,
})

const client = (name: string): ClientRecord => {
  const found = result.clients.find((c) => c.displayName === name)
  if (!found) throw new Error(`Sample data no longer contains "${name}"`)
  return found
}

describe('sample exports', () => {
  it('are large enough for the brief', () => {
    expect(billing.length + projects.length).toBeGreaterThanOrEqual(12)
  })

  it('parse without a fatal error', () => {
    expect(billing.length).toBeGreaterThan(0)
    expect(projects.length).toBeGreaterThan(0)
  })
})

describe('every required data problem is represented', () => {
  it('spelling difference', () => {
    expect(client('Harbour Brew Co').match.project?.brandName).toBe('Harbor Brew')
    expect(client('Harbour Brew Co').match.status).toBe('strong')
  })

  it('casing difference', () => {
    expect(client('ACME SHOP').match.project?.brandName).toBe('Acme Shop')
    expect(client('ACME SHOP').match.status).toBe('exact')
  })

  it('legal suffix difference in both directions', () => {
    expect(client('Northwind Ltd').match.project?.brandName).toBe('Northwind Limited')
    expect(client('Atlas Homewares').match.project?.brandName).toBe('Atlas Homewares LLC')
  })

  it('missing end date', () => {
    expect(client('Cedar & Co.').renewalStatus).toBe('unknown')
    expect(client('Cedar & Co.').renewalDateProblem).toBe('blank')
  })

  it('invalid and ambiguous end dates', () => {
    expect(client('Verity Skincare').renewalDateProblem).toBe('impossible')
    expect(client('Maple Row Studio').renewalDateProblem).toBe('ambiguous_format')
  })

  it('re-signed client with a clean handover', () => {
    const c = client('Riverstone Outfitters')
    expect(c.contracts).toHaveLength(2)
    expect(c.renewalDate).toBe('2026-12-01')
    expect(c.superseded).toHaveLength(1)
  })

  it('re-signed client with overlapping coverage', () => {
    const c = client('Copperleaf Home')
    expect(c.renewalDate).toBe('2026-11-15')
    expect(c.contracts.every((x) => x.flags.includes('overlaps_sibling'))).toBe(true)
  })

  it('renewals inside and outside the window', () => {
    expect(result.due.length).toBeGreaterThan(0)
    expect(result.upcoming.length).toBeGreaterThan(0)
  })

  it('the exact window boundaries: 0, 45 and 46 days', () => {
    expect(client('Fernbrook Athletic').daysToRenewal).toBe(0)
    expect(client('Fernbrook Athletic').renewalStatus).toBe('due')
    expect(client('Atlas Homewares').daysToRenewal).toBe(45)
    expect(client('Atlas Homewares').renewalStatus).toBe('due')
    expect(client('Kestrel Cycles Ltd').daysToRenewal).toBe(46)
    expect(client('Kestrel Cycles Ltd').renewalStatus).toBe('upcoming')
  })

  it('overdue renewals — the failure the product exists to prevent', () => {
    expect(result.overdue.map((c) => c.displayName)).toEqual([
      'Solstice Beauty',
      'Brightline Commerce',
    ])
  })

  it('all five match states', () => {
    const states = new Set(result.clients.map((c) => c.match.status))
    expect(states).toEqual(new Set(['exact', 'strong', 'review', 'ambiguous', 'unmatched']))
  })

  it('an ambiguous pair that is deliberately left unmatched', () => {
    const c = client('Marberry Home')
    expect(c.match.status).toBe('ambiguous')
    expect(c.match.project).toBeNull()
    expect(c.match.candidates.map((x) => x.brandName).sort()).toEqual([
      'Marbury Home',
      'Mayberry Home',
    ])
  })

  it('a match proposed for confirmation', () => {
    expect(client('St. Ives Provisions').match.status).toBe('review')
  })

  it('a billing client with no project record', () => {
    expect(client('Waverly Tea Co').match.status).toBe('unmatched')
  })

  it('a project brand with no billing record', () => {
    expect(result.issues.some((i) => i.kind === 'unmatched_project' && i.subject === 'Tidewater Bakehouse')).toBe(true)
  })

  it('a structurally malformed row that is reported, not dropped', () => {
    expect(result.issues.some((i) => i.kind === 'malformed_row')).toBe(true)
    expect(client('Nightjar Provisions').renewalStatus).toBe('due')
  })

  it('a quoted field containing a comma', () => {
    const row = projects.find((p) => p.scopeSummary.includes(','))
    expect(row?.scopeSummary).toBe('Prior retainer, closed at re-sign')
    expect(row?.problems).toEqual([])
  })
})

describe('the demo view an account lead sees', () => {
  it('puts the two overdue brands at the top of the queue', () => {
    const queue = [...result.overdue, ...result.due]
    expect(queue[0]!.displayName).toBe('Solstice Beauty')
    expect(queue[0]!.daysToRenewal).toBeLessThan(0)
  })

  it('does not show the superseded Riverstone contract as due in three days', () => {
    const queue = [...result.overdue, ...result.due]
    expect(queue.map((c) => c.displayName)).not.toContain('Riverstone Outfitters')
  })

  it('quantifies the money in the queue', () => {
    expect(result.summary.monthlyFeeAtRiskUsd).toBeGreaterThan(0)
  })

  it('leaves nothing silently excluded — every skipped client has an issue', () => {
    for (const c of result.clients) {
      if (c.renewalStatus !== 'unknown') continue
      expect(
        result.issues.some((i) => i.kind === 'unusable_renewal_date' && i.subject === c.displayName),
      ).toBe(true)
    }
  })
})
