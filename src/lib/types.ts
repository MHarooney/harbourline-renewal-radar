/**
 * Domain model for Renewal Radar.
 *
 * The shape here encodes the two judgement calls the product rests on:
 *  1. A *client* is not a CSV row. Billing exports contain multiple contracts
 *     per client after a re-sign, so we resolve rows into client entities and
 *     pick one "current" contract per client for the operational radar.
 *  2. A match is not a boolean. Name-only joins have to expose *why* they
 *     matched so an account lead can decide whether to trust the joined scope.
 */

/**
 * Fixed demo "today". The deployed sample data is authored around this date so
 * reviewers see the same boundary cases (0 days, exactly 45, 46, overdue) that
 * the tests assert. The UI lets you change it; nothing else depends on it.
 */
export const DEMO_AS_OF_DATE = '2026-08-29'

/** Harbourline's stated review window. Inclusive on both ends: 0..45. */
export const RENEWAL_WINDOW_DAYS = 45

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/**
 * Why a date could not be used. We never substitute a guess for a bad date —
 * a wrong renewal date is worse than a visibly missing one, because it looks
 * actionable.
 */
export type DateProblem =
  | 'blank'
  /** Not a date at all, e.g. "TBC", "n/a". */
  | 'unparseable'
  /** Well-formed but does not exist, e.g. 2026-02-30. */
  | 'impossible'
  /** Real-looking but order-ambiguous, e.g. 30/04/2026 vs 04/30/2026. */
  | 'ambiguous_format'

export type ParsedDate = {
  /** Exactly what was in the cell, for display in the data-issue list. */
  raw: string
  /** ISO YYYY-MM-DD, or null when the value could not be trusted. */
  iso: string | null
  problem: DateProblem | null
}

// ---------------------------------------------------------------------------
// Raw rows
// ---------------------------------------------------------------------------

export type RowProblem = {
  kind: 'short_row' | 'long_row' | 'blank_name'
  detail: string
}

export type BillingRow = {
  clientName: string
  retainerStart: ParsedDate
  retainerEnd: ParsedDate
  monthlyFeeUsd: number | null
  plan: string
  /** 1-based line number in the source file, so issues point at a real line. */
  sourceLine: number
  problems: RowProblem[]
}

export type ProjectRow = {
  brandName: string
  projectStatus: string
  lastDelivery: ParsedDate
  scopeSummary: string
  signedAt: ParsedDate
  sourceLine: number
  problems: RowProblem[]
}

// ---------------------------------------------------------------------------
// Entity resolution
// ---------------------------------------------------------------------------

/**
 * Outcome of joining one billing client to the project export.
 *
 * `exact` / `strong` are safe to use without human input. `review` and
 * `ambiguous` are deliberately NOT auto-accepted as fact — they are shown to
 * the account lead with the evidence needed to confirm or reject them.
 */
export type MatchStatus =
  /** Normalized names are identical. */
  | 'exact'
  /** Fuzzy, clearly above threshold and clearly ahead of the runner-up. */
  | 'strong'
  /** Single plausible candidate, but similarity is only middling. */
  | 'review'
  /** Two or more candidates too close together to choose between. */
  | 'ambiguous'
  /** Nothing scored above the floor. */
  | 'unmatched'

export type MatchCandidate = {
  brandName: string
  normalized: string
  score: number
  sourceLine: number
}

export type MatchResult = {
  status: MatchStatus
  /** The project entity we joined to, or null for ambiguous/unmatched. */
  project: ProjectEntity | null
  method: 'normalized_exact' | 'fuzzy' | 'none'
  /** Similarity of the winning candidate, 0..1. */
  score: number
  /** Similarity of the next-best candidate, for the ambiguity check. */
  runnerUpScore: number
  normalizedBilling: string
  /** Everything scoring above the review floor, best first. */
  candidates: MatchCandidate[]
  /** Plain-English reason shown in the UI. */
  explanation: string
  /** True when a human should confirm before trusting the joined scope. */
  needsReview: boolean
}

// ---------------------------------------------------------------------------
// Clients and contracts
// ---------------------------------------------------------------------------

export type ContractFlag =
  /** This contract was superseded by one with a later end date. */
  | 'superseded'
  /** Coverage overlaps a sibling contract for the same client. */
  | 'overlaps_sibling'

export type Contract = {
  row: BillingRow
  flags: ContractFlag[]
  /** Set on superseded contracts: which contract replaced it. */
  supersededByLine: number | null
}

export type ProjectEntity = {
  key: string
  brandName: string
  /** The row we treat as authoritative (prefers open work, then most recent). */
  primary: ProjectRow
  /** Other rows for the same brand, kept for traceability. */
  history: ProjectRow[]
}

/** Where a client sits relative to the review window. */
export type RenewalStatus =
  | 'overdue'
  /** Inside the inclusive 0..windowDays window. */
  | 'due'
  /** Dated, but beyond the window. */
  | 'upcoming'
  /** No trustworthy renewal date. Never enters the radar. */
  | 'unknown'

export type ClientRecord = {
  /** Normalized join key. */
  key: string
  /** Name as written on the current contract. */
  displayName: string
  /** All contracts for this client, newest coverage first. */
  contracts: Contract[]
  /** The contract the radar is computed from. */
  current: Contract
  /** Contracts retained for history but not used for the radar. */
  superseded: Contract[]
  match: MatchResult
  renewalStatus: RenewalStatus
  /** Days from as-of to renewal. Negative when overdue, null when unknown. */
  daysToRenewal: number | null
  renewalDate: string | null
  /** Why the renewal date is unusable, when it is. */
  renewalDateProblem: DateProblem | null
  monthlyFeeUsd: number | null
  plan: string
  scopeSummary: string | null
  projectStatus: string | null
  lastDelivery: string | null
}

// ---------------------------------------------------------------------------
// Data quality
// ---------------------------------------------------------------------------

export type IssueSeverity = 'blocking' | 'attention' | 'info'

export type DataIssueKind =
  | 'unusable_renewal_date'
  | 'ambiguous_match'
  | 'review_match'
  | 'unmatched_billing'
  | 'unmatched_project'
  | 'overlapping_contracts'
  | 'malformed_row'
  | 'duplicate_project_rows'

export type DataIssue = {
  kind: DataIssueKind
  severity: IssueSeverity
  /** Client or brand the issue belongs to, for grouping and search. */
  subject: string
  title: string
  detail: string
  /** What a human has to do. Every issue must be actionable. */
  action: string
}

export type RadarSummary = {
  overdue: number
  due: number
  upcoming: number
  unknown: number
  needsReview: number
  /** Monthly fee attached to overdue + due clients. */
  monthlyFeeAtRiskUsd: number
  clients: number
  billingRows: number
  projectRows: number
}

export type RadarResult = {
  asOf: string
  windowDays: number
  clients: ClientRecord[]
  overdue: ClientRecord[]
  due: ClientRecord[]
  upcoming: ClientRecord[]
  unknown: ClientRecord[]
  needsReview: ClientRecord[]
  issues: DataIssue[]
  summary: RadarSummary
}
