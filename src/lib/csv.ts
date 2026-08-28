import type { BillingRow, ParsedDate, ProjectRow, RowProblem } from './types'

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

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

type ParsedLine = { cells: string[]; line: number }

/**
 * Parse to cells, keeping the original 1-based line number on every row so
 * every data issue we raise can point at a line the user can open in Excel.
 * Blank lines are skipped but still consume a line number.
 */
export function parseCsv(text: string): ParsedLine[] {
  const out: ParsedLine[] = []
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!
    if (raw.trim().length === 0) continue
    out.push({ cells: splitCsvLine(raw), line: i + 1 })
  }
  return out
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const SLASHED_ISO = /^(\d{4})\/(\d{2})\/(\d{2})$/
/** 30/04/2026 or 04/30/2026 — impossible to disambiguate without a locale. */
const AMBIGUOUS_SLASHED = /^\d{1,2}[/.]\d{1,2}[/.]\d{2,4}$/

/**
 * Parse a date cell.
 *
 * Judgement call: we accept only unambiguous, year-first formats. Day-first and
 * month-first exports look identical for the first twelve days of any month, so
 * guessing would silently produce a renewal date that is wrong by up to eleven
 * months for some rows and right for others — the worst possible failure mode
 * for a tool whose entire job is "tell me when this renews". A flagged row
 * costs someone thirty seconds; a silently wrong date costs a retainer.
 */
export function parseDate(raw: string | undefined): ParsedDate {
  const value = (raw ?? '').trim()
  if (value.length === 0) return { raw: '', iso: null, problem: 'blank' }

  const m = ISO_DATE.exec(value) ?? SLASHED_ISO.exec(value)
  if (!m) {
    const problem = AMBIGUOUS_SLASHED.test(value) ? 'ambiguous_format' : 'unparseable'
    return { raw: value, iso: null, problem }
  }

  const year = Number(m[1])
  const month = Number(m[2])
  const day = Number(m[3])
  const iso = `${m[1]}-${m[2]}-${m[3]}`

  // Round-trip through UTC to reject dates that do not exist. JS silently rolls
  // 2026-02-30 forward to March 2nd, which would be a plausible-looking lie.
  const date = new Date(Date.UTC(year, month - 1, day))
  const rollsOver =
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  if (rollsOver) return { raw: value, iso: null, problem: 'impossible' }

  return { raw: value, iso, problem: null }
}

export function describeDateProblem(problem: import('./types').DateProblem): string {
  switch (problem) {
    case 'blank':
      return 'no value in the export'
    case 'unparseable':
      return 'not a recognisable date'
    case 'impossible':
      return 'a date that does not exist'
    case 'ambiguous_format':
      return 'day/month order is ambiguous, so it was not guessed'
  }
}

// ---------------------------------------------------------------------------
// Header mapping
// ---------------------------------------------------------------------------

function headerIndex(headers: string[], ...aliases: string[]): number {
  const normalized = headers.map((h) => h.trim().toLowerCase().replace(/\s+/g, '_'))
  for (const alias of aliases) {
    const idx = normalized.indexOf(alias)
    if (idx >= 0) return idx
  }
  return -1
}

export class CsvFormatError extends Error {}

function rowProblems(cells: string[], headerCount: number, name: string): RowProblem[] {
  const problems: RowProblem[] = []
  if (cells.length < headerCount) {
    problems.push({
      kind: 'short_row',
      detail: `${cells.length} of ${headerCount} columns present; missing values read as blank.`,
    })
  } else if (cells.length > headerCount) {
    problems.push({
      kind: 'long_row',
      detail: `${cells.length} columns for a ${headerCount}-column header; extra values ignored.`,
    })
  }
  if (name.trim().length === 0) {
    problems.push({ kind: 'blank_name', detail: 'No client/brand name, so the row cannot be joined.' })
  }
  return problems
}

function cell(cells: string[], idx: number): string {
  if (idx < 0) return ''
  return cells[idx] ?? ''
}

// ---------------------------------------------------------------------------
// Typed parsers
// ---------------------------------------------------------------------------

export function parseBillingCsv(text: string): BillingRow[] {
  const rows = parseCsv(text)
  if (rows.length === 0) throw new CsvFormatError('Billing CSV is empty.')

  const headers = rows[0]!.cells
  const nameIdx = headerIndex(headers, 'client_name', 'client', 'name')
  const startIdx = headerIndex(headers, 'retainer_start', 'start_date', 'start')
  const endIdx = headerIndex(headers, 'retainer_end', 'end_date', 'renewal_date', 'end')
  const feeIdx = headerIndex(headers, 'monthly_fee_usd', 'monthly_fee', 'fee')
  const planIdx = headerIndex(headers, 'plan', 'package', 'tier')

  const missing: string[] = []
  if (nameIdx < 0) missing.push('client_name')
  if (endIdx < 0) missing.push('retainer_end')
  if (missing.length > 0) {
    throw new CsvFormatError(
      `Billing CSV is missing required column(s): ${missing.join(', ')}. Found: ${headers.join(', ')}`,
    )
  }

  return rows.slice(1).map(({ cells, line }) => {
    const clientName = cell(cells, nameIdx)
    const feeRaw = cell(cells, feeIdx).replace(/[$,\s]/g, '')
    const fee = feeRaw === '' ? null : Number(feeRaw)
    return {
      clientName,
      retainerStart: parseDate(cell(cells, startIdx)),
      retainerEnd: parseDate(cell(cells, endIdx)),
      monthlyFeeUsd: fee != null && Number.isFinite(fee) ? fee : null,
      plan: cell(cells, planIdx),
      sourceLine: line,
      problems: rowProblems(cells, headers.length, clientName),
    }
  })
}

export function parseProjectsCsv(text: string): ProjectRow[] {
  const rows = parseCsv(text)
  if (rows.length === 0) throw new CsvFormatError('Projects CSV is empty.')

  const headers = rows[0]!.cells
  const nameIdx = headerIndex(headers, 'brand_name', 'client_name', 'name', 'brand')
  const statusIdx = headerIndex(headers, 'project_status', 'status')
  const deliveryIdx = headerIndex(headers, 'last_delivery', 'last_delivered')
  const scopeIdx = headerIndex(headers, 'scope_summary', 'scope')
  const signedIdx = headerIndex(headers, 'signed_at', 'signed_date')

  if (nameIdx < 0) {
    throw new CsvFormatError(
      `Projects CSV is missing required column: brand_name. Found: ${headers.join(', ')}`,
    )
  }

  return rows.slice(1).map(({ cells, line }) => {
    const brandName = cell(cells, nameIdx)
    return {
      brandName,
      projectStatus: cell(cells, statusIdx),
      lastDelivery: parseDate(cell(cells, deliveryIdx)),
      scopeSummary: cell(cells, scopeIdx),
      signedAt: parseDate(cell(cells, signedIdx)),
      sourceLine: line,
      problems: rowProblems(cells, headers.length, brandName),
    }
  })
}
