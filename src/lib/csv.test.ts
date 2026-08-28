import { describe, expect, it } from 'vitest'
import { CsvFormatError, parseBillingCsv, parseDate, parseProjectsCsv } from './csv'

describe('parseDate', () => {
  it('accepts unambiguous year-first dates', () => {
    expect(parseDate('2026-09-15')).toEqual({ raw: '2026-09-15', iso: '2026-09-15', problem: null })
    expect(parseDate('2026/09/15').iso).toBe('2026-09-15')
  })

  it('reports blank cells rather than defaulting', () => {
    expect(parseDate('')).toEqual({ raw: '', iso: null, problem: 'blank' })
    expect(parseDate('   ').problem).toBe('blank')
    expect(parseDate(undefined).problem).toBe('blank')
  })

  it('rejects dates that do not exist instead of rolling them forward', () => {
    // Date.UTC(2026, 1, 30) silently becomes 2 March — a plausible-looking lie.
    const parsed = parseDate('2026-02-30')
    expect(parsed.iso).toBeNull()
    expect(parsed.problem).toBe('impossible')
    expect(parseDate('2026-13-01').problem).toBe('impossible')
    expect(parseDate('2026-04-31').problem).toBe('impossible')
  })

  it('refuses to guess day/month order', () => {
    expect(parseDate('30/04/2026').problem).toBe('ambiguous_format')
    expect(parseDate('04/30/2026').problem).toBe('ambiguous_format')
    expect(parseDate('3.4.26').problem).toBe('ambiguous_format')
  })

  it('reports free text as unparseable', () => {
    expect(parseDate('TBC').problem).toBe('unparseable')
    expect(parseDate('rolling').problem).toBe('unparseable')
    expect(parseDate('n/a').problem).toBe('unparseable')
  })

  it('keeps the raw value for display', () => {
    expect(parseDate('TBC').raw).toBe('TBC')
  })
})

describe('parseBillingCsv', () => {
  const header = 'client_name,retainer_start,retainer_end,monthly_fee_usd,plan'

  it('parses a clean file', () => {
    const rows = parseBillingCsv(`${header}\nAcme Shop,2026-02-01,2026-09-30,6200,Scale`)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      clientName: 'Acme Shop',
      monthlyFeeUsd: 6200,
      plan: 'Scale',
      sourceLine: 2,
      problems: [],
    })
    expect(rows[0]!.retainerEnd.iso).toBe('2026-09-30')
  })

  it('reports the real line number, skipping blank lines', () => {
    const rows = parseBillingCsv(`${header}\n\nAcme Shop,2026-02-01,2026-09-30,6200,Scale`)
    expect(rows[0]!.sourceLine).toBe(3)
  })

  it('flags a row with too few columns but still reads what is there', () => {
    const rows = parseBillingCsv(`${header}\nNightjar Provisions,2026-03-01,2026-09-25,4200`)
    expect(rows[0]!.problems.map((p) => p.kind)).toEqual(['short_row'])
    expect(rows[0]!.retainerEnd.iso).toBe('2026-09-25')
    expect(rows[0]!.plan).toBe('')
  })

  it('flags a row with too many columns', () => {
    const rows = parseBillingCsv(`${header}\nAcme,2026-02-01,2026-09-30,6200,Scale,extra`)
    expect(rows[0]!.problems.map((p) => p.kind)).toEqual(['long_row'])
  })

  it('flags a row with no client name', () => {
    const rows = parseBillingCsv(`${header}\n,2026-02-01,2026-09-30,6200,Scale`)
    expect(rows[0]!.problems.map((p) => p.kind)).toContain('blank_name')
  })

  it('handles quoted fields containing commas', () => {
    const rows = parseBillingCsv(`${header}\n"Outfitters, Riverstone",2026-02-01,2026-09-30,6200,Scale`)
    expect(rows[0]!.clientName).toBe('Outfitters, Riverstone')
  })

  it('tolerates currency formatting in the fee column', () => {
    const rows = parseBillingCsv(`${header}\nAcme,2026-02-01,2026-09-30,"$6,200",Scale`)
    expect(rows[0]!.monthlyFeeUsd).toBe(6200)
  })

  it('reads a non-numeric fee as unknown rather than NaN', () => {
    const rows = parseBillingCsv(`${header}\nAcme,2026-02-01,2026-09-30,tbd,Scale`)
    expect(rows[0]!.monthlyFeeUsd).toBeNull()
  })

  it('accepts alternative header names', () => {
    const rows = parseBillingCsv('client,start_date,renewal_date,fee,tier\nAcme,2026-02-01,2026-09-30,6200,Scale')
    expect(rows[0]!.clientName).toBe('Acme')
    expect(rows[0]!.retainerEnd.iso).toBe('2026-09-30')
  })

  it('names the missing column when a required one is absent', () => {
    expect(() => parseBillingCsv('client_name,plan\nAcme,Scale')).toThrow(CsvFormatError)
    expect(() => parseBillingCsv('client_name,plan\nAcme,Scale')).toThrow(/retainer_end/)
  })

  it('strips a UTF-8 BOM from the first header', () => {
    const rows = parseBillingCsv(`﻿${header}\nAcme,2026-02-01,2026-09-30,6200,Scale`)
    expect(rows[0]!.clientName).toBe('Acme')
  })

  it('handles CRLF line endings', () => {
    const rows = parseBillingCsv(`${header}\r\nAcme,2026-02-01,2026-09-30,6200,Scale\r\n`)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.plan).toBe('Scale')
  })
})

describe('parseProjectsCsv', () => {
  const header = 'brand_name,project_status,last_delivery,scope_summary,signed_at'

  it('parses a clean file', () => {
    const rows = parseProjectsCsv(`${header}\nHarbor Brew,active,2026-08-12,CRO,2026-03-01`)
    expect(rows[0]).toMatchObject({ brandName: 'Harbor Brew', projectStatus: 'active' })
    expect(rows[0]!.lastDelivery.iso).toBe('2026-08-12')
  })

  it('requires a brand name column', () => {
    expect(() => parseProjectsCsv('status,scope\nactive,CRO')).toThrow(/brand_name/)
  })

  it('rejects an empty file', () => {
    expect(() => parseProjectsCsv('')).toThrow(CsvFormatError)
  })
})
