import { describe, expect, it } from 'vitest'
import { parseBillingCsv, parseProjectsCsv } from './csv'
import { confidenceFromScore, normalizeName, similarity } from './normalize'
import { buildRadar, matchClients } from './radar'
import { AS_OF_DATE } from './types'

describe('normalizeName', () => {
  it('lowercases and strips punctuation', () => {
    expect(normalizeName('ACME SHOP')).toBe(normalizeName('Acme Shop'))
  })

  it('maps legal suffixes', () => {
    expect(normalizeName('Northwind Ltd')).toBe(normalizeName('Northwind Limited'))
    expect(normalizeName('Lumen Apparel Inc')).toBe(
      normalizeName('Lumen Apparel Incorporated'),
    )
  })

  it('treats & and and as equivalent and drops trailing co', () => {
    expect(normalizeName('Cedar & Co.')).toBe(normalizeName('Cedar and Co'))
  })

  it('keeps harbour vs harbor close after normalize', () => {
    const a = normalizeName('Harbour Brew Co')
    const b = normalizeName('Harbor Brew')
    expect(similarity(a, b)).toBeGreaterThan(0.85)
  })
})

describe('confidenceFromScore', () => {
  it('buckets scores', () => {
    expect(confidenceFromScore(0.95)).toBe('high')
    expect(confidenceFromScore(0.85)).toBe('medium')
    expect(confidenceFromScore(0.7)).toBe('low')
    expect(confidenceFromScore(0.4)).toBe('none')
  })
})

const billingCsv = `client_name,retainer_start,retainer_end,monthly_fee_usd,plan
Harbour Brew Co,2026-03-01,2026-09-15,4500,Growth
ACME SHOP,2026-02-01,2026-09-30,6200,Scale
Northwind Ltd,2025-12-01,2026-10-01,3800,Growth
Cedar & Co.,2026-04-01,,2900,Starter
Riverstone Outfitters,2025-09-01,2026-09-01,5500,Scale
Riverstone Outfitters,2026-09-01,2026-12-01,5500,Scale
Pine & Petal,2026-06-01,2026-12-15,3500,Growth
`

const projectsCsv = `brand_name,project_status,last_delivery,scope_summary,signed_at
Harbor Brew,active,2026-08-12,Shopify CRO + email flows,2026-03-01
Acme Shop,active,2026-08-20,Paid social + landing pages,2026-02-01
Northwind Limited,active,2026-08-05,Full-funnel retention,2025-12-01
Cedar and Co,active,2026-07-30,Ongoing creatives only,2026-04-01
Riverstone Outfitters,active,2026-08-25,Re-signed Q3 growth package,2026-09-01
Riverstone Outfitters,closed,2026-08-01,Prior retainer closed at re-sign,2025-09-01
Orphan Project Only,active,2026-08-01,No billing row on purpose,2026-07-01
`

describe('csv parsing', () => {
  it('parses billing and treats blank end dates as null', () => {
    const rows = parseBillingCsv(billingCsv)
    expect(rows).toHaveLength(7)
    const cedar = rows.find((r) => r.clientName.startsWith('Cedar'))
    expect(cedar?.retainerEnd).toBeNull()
  })

  it('parses projects', () => {
    const rows = parseProjectsCsv(projectsCsv)
    expect(rows[0]?.brandName).toBe('Harbor Brew')
  })
})

describe('matchClients', () => {
  it('joins despite spelling, casing, and suffix differences', () => {
    const billing = parseBillingCsv(billingCsv)
    const projects = parseProjectsCsv(projectsCsv)
    const matches = matchClients(billing, projects)

    const brew = matches.find((m) => m.billing.clientName === 'Harbour Brew Co')
    expect(brew?.project?.brandName).toBe('Harbor Brew')
    expect(brew?.confidence).not.toBe('none')

    const acme = matches.find((m) => m.billing.clientName === 'ACME SHOP')
    expect(acme?.project?.brandName).toBe('Acme Shop')
    expect(acme?.confidence).toBe('high')

    const north = matches.find((m) => m.billing.clientName === 'Northwind Ltd')
    expect(north?.project?.brandName).toBe('Northwind Limited')
  })
})

describe('buildRadar', () => {
  it('shows renewals inside 45 days and keeps outside-window rows separate', () => {
    const result = buildRadar(parseBillingCsv(billingCsv), parseProjectsCsv(projectsCsv), {
      asOf: AS_OF_DATE,
      windowDays: 45,
    })

    const namesInWindow = result.renewals.map((r) => r.displayName)
    expect(namesInWindow).toContain('Harbour Brew Co') // 2026-09-15
    expect(namesInWindow).toContain('ACME SHOP') // 2026-09-30
    expect(namesInWindow).toContain('Riverstone Outfitters') // 2026-09-01

    const namesOutside = result.outsideWindow.map((r) => r.displayName)
    expect(namesOutside).toContain('Pine & Petal') // 2026-12-15
    expect(namesOutside).toContain('Riverstone Outfitters') // 2026-12-01 re-sign
  })

  it('flags missing end dates, unmatched projects, and duplicate retainers', () => {
    const result = buildRadar(parseBillingCsv(billingCsv), parseProjectsCsv(projectsCsv), {
      asOf: AS_OF_DATE,
    })

    expect(result.issues.some((i) => i.kind === 'missing_end_date')).toBe(true)
    expect(result.issues.some((i) => i.kind === 'unmatched_project')).toBe(true)
    expect(result.issues.some((i) => i.kind === 'duplicate_retainer')).toBe(true)

    // Cedar has no end date — must not appear in renewals
    expect(result.renewals.every((r) => !r.displayName.startsWith('Cedar'))).toBe(true)
  })

  it('sorts renewals by soonest first', () => {
    const result = buildRadar(parseBillingCsv(billingCsv), parseProjectsCsv(projectsCsv), {
      asOf: AS_OF_DATE,
    })
    const days = result.renewals.map((r) => r.daysUntil)
    expect(days).toEqual([...days].sort((a, b) => a - b))
  })
})
