/** Fixed demo "today" so sample renewals stay stable in docs and screenshots. */
export const AS_OF_DATE = '2026-08-29'
export const RENEWAL_WINDOW_DAYS = 45

export type BillingRow = {
  clientName: string
  retainerStart: string
  retainerEnd: string | null
  monthlyFeeUsd: number | null
  plan: string
  sourceIndex: number
}

export type ProjectRow = {
  brandName: string
  projectStatus: string
  lastDelivery: string | null
  scopeSummary: string
  signedAt: string | null
  sourceIndex: number
}

export type MatchConfidence = 'high' | 'medium' | 'low' | 'none'

export type ClientMatch = {
  billing: BillingRow
  project: ProjectRow | null
  confidence: MatchConfidence
  score: number
  normalizedBilling: string
  normalizedProject: string | null
}

export type RadarRow = {
  displayName: string
  renewalDate: string
  daysUntil: number
  monthlyFeeUsd: number | null
  plan: string
  scopeSummary: string
  projectStatus: string
  confidence: MatchConfidence
  score: number
  isDuplicateRetainer: boolean
  billingSourceIndex: number
}

export type DataIssue = {
  kind:
    | 'missing_end_date'
    | 'unmatched_billing'
    | 'unmatched_project'
    | 'low_confidence'
    | 'duplicate_retainer'
  message: string
  detail: string
}

export type RadarResult = {
  asOf: string
  windowDays: number
  renewals: RadarRow[]
  outsideWindow: RadarRow[]
  issues: DataIssue[]
  matches: ClientMatch[]
}
