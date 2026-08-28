import type { BillingRow, ProjectRow } from './types'

function splitCsvLine(line: string): string[] {
  const cells: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
      continue
    }
    if (ch === ',' && !inQuotes) {
      cells.push(current)
      current = ''
      continue
    }
    current += ch
  }
  cells.push(current)
  return cells.map((c) => c.trim())
}

export function parseCsv(text: string): string[][] {
  const lines = text
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)

  return lines.map(splitCsvLine)
}

function headerIndex(headers: string[], ...aliases: string[]): number {
  const normalized = headers.map((h) => h.trim().toLowerCase())
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias.toLowerCase())
    if (idx >= 0) return idx
  }
  return -1
}

function emptyToNull(value: string | undefined): string | null {
  if (value == null) return null
  const t = value.trim()
  return t.length === 0 ? null : t
}

export function parseBillingCsv(text: string): BillingRow[] {
  const rows = parseCsv(text)
  if (rows.length < 2) return []
  const headers = rows[0]!
  const nameIdx = headerIndex(headers, 'client_name', 'client', 'name')
  const startIdx = headerIndex(headers, 'retainer_start', 'start_date', 'start')
  const endIdx = headerIndex(headers, 'retainer_end', 'end_date', 'renewal_date', 'end')
  const feeIdx = headerIndex(headers, 'monthly_fee_usd', 'monthly_fee', 'fee')
  const planIdx = headerIndex(headers, 'plan', 'package')

  if (nameIdx < 0 || endIdx < 0) {
    throw new Error('Billing CSV must include client_name and retainer_end columns')
  }

  return rows.slice(1).map((cells, i) => {
    const feeRaw = feeIdx >= 0 ? cells[feeIdx] : undefined
    const fee = feeRaw && feeRaw.trim() !== '' ? Number(feeRaw) : null
    return {
      clientName: cells[nameIdx] ?? '',
      retainerStart: (startIdx >= 0 ? emptyToNull(cells[startIdx]) : null) ?? '',
      retainerEnd: emptyToNull(cells[endIdx]),
      monthlyFeeUsd: fee != null && Number.isFinite(fee) ? fee : null,
      plan: (planIdx >= 0 ? cells[planIdx] : '') ?? '',
      sourceIndex: i + 2,
    }
  })
}

export function parseProjectsCsv(text: string): ProjectRow[] {
  const rows = parseCsv(text)
  if (rows.length < 2) return []
  const headers = rows[0]!
  const nameIdx = headerIndex(headers, 'brand_name', 'client_name', 'name', 'brand')
  const statusIdx = headerIndex(headers, 'project_status', 'status')
  const deliveryIdx = headerIndex(headers, 'last_delivery', 'last_delivered')
  const scopeIdx = headerIndex(headers, 'scope_summary', 'scope')
  const signedIdx = headerIndex(headers, 'signed_at', 'signed_date')

  if (nameIdx < 0) {
    throw new Error('Projects CSV must include brand_name column')
  }

  return rows.slice(1).map((cells, i) => ({
    brandName: cells[nameIdx] ?? '',
    projectStatus: (statusIdx >= 0 ? cells[statusIdx] : '') ?? '',
    lastDelivery: deliveryIdx >= 0 ? emptyToNull(cells[deliveryIdx]) : null,
    scopeSummary: (scopeIdx >= 0 ? cells[scopeIdx] : '') ?? '',
    signedAt: signedIdx >= 0 ? emptyToNull(cells[signedIdx]) : null,
    sourceIndex: i + 2,
  }))
}
