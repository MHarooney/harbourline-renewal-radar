import { describeDateProblem } from './csv'
import {
  AMBIGUITY_GAP,
  AUTO_ACCEPT_SIMILARITY,
  REVIEW_FLOOR_SIMILARITY,
  formatScore,
  normalizeName,
  similarity,
} from './normalize'
import type {
  BillingRow,
  ClientRecord,
  Contract,
  DataIssue,
  MatchCandidate,
  MatchResult,
  ProjectEntity,
  ProjectRow,
  RadarResult,
  RadarSummary,
  RenewalStatus,
} from './types'
import { DEMO_AS_OF_DATE, RENEWAL_WINDOW_DAYS } from './types'

const MS_PER_DAY = 86_400_000

function toUtc(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number)
  return Date.UTC(y!, m! - 1, d!)
}

/**
 * Whole calendar days between two ISO dates. Both are treated as UTC midnight,
 * so the result never drifts with the viewer's timezone or DST — an account
 * lead in London and one in New York must see the same "3 days left".
 */
export function daysBetween(fromIso: string, toIso: string): number {
  return Math.round((toUtc(toIso) - toUtc(fromIso)) / MS_PER_DAY)
}

export function todayIso(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(
    now.getDate(),
  ).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Project entities
// ---------------------------------------------------------------------------

/** Statuses that mean "this engagement is over" rather than "in flight". */
const CLOSED_STATUSES = new Set(['closed', 'completed', 'cancelled', 'canceled', 'archived'])

function projectRecency(row: ProjectRow): number {
  const iso = row.signedAt.iso ?? row.lastDelivery.iso
  return iso ? toUtc(iso) : Number.NEGATIVE_INFINITY
}

/**
 * Collapse project rows into one entity per brand.
 *
 * A re-sign shows up on the project side too: Riverstone has an `active` row
 * for the new engagement and a `closed` row for the old one. Matching against
 * raw rows makes the join depend on file order — whichever row is scanned first
 * wins — so we pick a representative deterministically instead: prefer open
 * work, then the most recently signed. The other rows are kept as history.
 */
export function buildProjectEntities(projects: ProjectRow[]): ProjectEntity[] {
  const groups = new Map<string, ProjectRow[]>()
  for (const row of projects) {
    if (row.brandName.trim().length === 0) continue
    const key = normalizeName(row.brandName)
    if (key.length === 0) continue
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }

  const entities: ProjectEntity[] = []
  for (const [key, rows] of groups) {
    const ranked = [...rows].sort((a, b) => {
      const aOpen = CLOSED_STATUSES.has(a.projectStatus.toLowerCase()) ? 1 : 0
      const bOpen = CLOSED_STATUSES.has(b.projectStatus.toLowerCase()) ? 1 : 0
      if (aOpen !== bOpen) return aOpen - bOpen
      const recency = projectRecency(b) - projectRecency(a)
      if (recency !== 0) return recency
      return a.sourceLine - b.sourceLine
    })
    entities.push({
      key,
      brandName: ranked[0]!.brandName,
      primary: ranked[0]!,
      history: ranked.slice(1),
    })
  }

  // Stable order so the greedy assignment below is fully deterministic.
  entities.sort((a, b) => a.key.localeCompare(b.key))
  return entities
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

type ScoredPair = { billingKey: string; entity: ProjectEntity; score: number }

/**
 * Resolve billing clients against project brands.
 *
 * Pipeline: normalize -> score every pair -> assign globally best-first ->
 * classify each client against the runner-up. Deliberately NOT greedy in file
 * order: the previous version consumed project rows in whichever order billing
 * rows appeared, so adding a row at the top of the billing export could change
 * an unrelated client's match. Sorting all candidate pairs by score first makes
 * the result depend only on the data, not on row order.
 */
export function matchClients(
  billingKeys: Map<string, string>,
  entities: ProjectEntity[],
): Map<string, MatchResult> {
  // Every candidate above the floor, per billing client, best first.
  const candidatesByKey = new Map<string, MatchCandidate[]>()
  const pairs: ScoredPair[] = []

  for (const [billingKey] of billingKeys) {
    const scored: MatchCandidate[] = []
    for (const entity of entities) {
      const score = similarity(billingKey, entity.key)
      if (score >= REVIEW_FLOOR_SIMILARITY) {
        scored.push({
          brandName: entity.brandName,
          normalized: entity.key,
          score,
          sourceLine: entity.primary.sourceLine,
        })
        pairs.push({ billingKey, entity, score })
      }
    }
    scored.sort((a, b) => b.score - a.score || a.normalized.localeCompare(b.normalized))
    candidatesByKey.set(billingKey, scored)
  }

  // Global best-first assignment. Ties broken by name so runs are reproducible.
  pairs.sort(
    (a, b) =>
      b.score - a.score ||
      a.billingKey.localeCompare(b.billingKey) ||
      a.entity.key.localeCompare(b.entity.key),
  )
  const assignedClient = new Map<string, ProjectEntity>()
  const takenEntities = new Set<string>()
  for (const pair of pairs) {
    if (assignedClient.has(pair.billingKey)) continue
    if (takenEntities.has(pair.entity.key)) continue
    assignedClient.set(pair.billingKey, pair.entity)
    takenEntities.add(pair.entity.key)
  }

  const results = new Map<string, MatchResult>()
  for (const [billingKey, displayName] of billingKeys) {
    const candidates = candidatesByKey.get(billingKey) ?? []
    const best = candidates[0]
    const runnerUp = candidates[1]
    const bestScore = best?.score ?? 0
    const runnerUpScore = runnerUp?.score ?? 0
    const assigned = assignedClient.get(billingKey) ?? null

    if (!best || !assigned) {
      results.set(billingKey, {
        status: 'unmatched',
        project: null,
        method: 'none',
        score: bestScore,
        runnerUpScore,
        normalizedBilling: billingKey,
        candidates,
        explanation: `No project brand scored at least ${formatScore(
          REVIEW_FLOOR_SIMILARITY,
        )} against “${billingKey}”. Best was ${formatScore(bestScore)}.`,
        needsReview: true,
      })
      continue
    }

    // Two candidates too close to separate: refuse to pick. Attaching the wrong
    // brand's delivery history to a renewal is worse than showing no history.
    if (runnerUp && bestScore - runnerUpScore < AMBIGUITY_GAP) {
      results.set(billingKey, {
        status: 'ambiguous',
        project: null,
        method: 'fuzzy',
        score: bestScore,
        runnerUpScore,
        normalizedBilling: billingKey,
        candidates,
        explanation: `“${displayName}” is ${formatScore(bestScore)} similar to “${
          best.brandName
        }” and ${formatScore(runnerUpScore)} similar to “${
          runnerUp.brandName
        }”. The gap is under ${formatScore(AMBIGUITY_GAP)}, so no match was applied.`,
        needsReview: true,
      })
      continue
    }

    if (bestScore === 1) {
      results.set(billingKey, {
        status: 'exact',
        project: assigned,
        method: 'normalized_exact',
        score: 1,
        runnerUpScore,
        normalizedBilling: billingKey,
        candidates,
        explanation: `Both files normalize to “${billingKey}” after lowercasing, stripping punctuation and dropping legal suffixes.`,
        needsReview: false,
      })
      continue
    }

    if (bestScore >= AUTO_ACCEPT_SIMILARITY) {
      results.set(billingKey, {
        status: 'strong',
        project: assigned,
        method: 'fuzzy',
        score: bestScore,
        runnerUpScore,
        normalizedBilling: billingKey,
        candidates,
        explanation: `“${displayName}” and “${assigned.brandName}” are ${formatScore(
          bestScore,
        )} similar once normalized — above the ${formatScore(
          AUTO_ACCEPT_SIMILARITY,
        )} auto-accept line.${
          runnerUp
            ? ` The next closest brand, “${runnerUp.brandName}”, is ${formatScore(
                bestScore - runnerUpScore,
              )} behind.`
            : ' No other brand came close enough to be a candidate.'
        }`,
        needsReview: false,
      })
      continue
    }

    results.set(billingKey, {
      status: 'review',
      project: assigned,
      method: 'fuzzy',
      score: bestScore,
      runnerUpScore,
      normalizedBilling: billingKey,
      candidates,
      explanation: `“${displayName}” is the only candidate for “${
        assigned.brandName
      }” but scores ${formatScore(bestScore)}, below the ${formatScore(
        AUTO_ACCEPT_SIMILARITY,
      )} auto-accept line. Proposed, not confirmed.`,
      needsReview: true,
    })
  }

  return results
}

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

/**
 * Order contracts so the one the radar should use comes first.
 *
 * Judgement call: "current" is the contract with the **latest end date**, not
 * the latest start date and not the last row in the file. Renewal risk is about
 * when coverage runs out, so the contract that protects the client furthest into
 * the future is the one an account lead should be planning around. A contract
 * with no usable end date sorts last — an open-ended row must never displace a
 * dated one, or a data problem would hide a real renewal.
 */
function rankContracts(rows: BillingRow[]): BillingRow[] {
  return [...rows].sort((a, b) => {
    const aEnd = a.retainerEnd.iso
    const bEnd = b.retainerEnd.iso
    if (aEnd && bEnd && aEnd !== bEnd) return aEnd < bEnd ? 1 : -1
    if (aEnd && !bEnd) return -1
    if (!aEnd && bEnd) return 1
    const aStart = a.retainerStart.iso ?? ''
    const bStart = b.retainerStart.iso ?? ''
    if (aStart !== bStart) return aStart < bStart ? 1 : -1
    return b.sourceLine - a.sourceLine
  })
}

function buildContracts(rows: BillingRow[]): { current: Contract; all: Contract[] } {
  const ranked = rankContracts(rows)
  const contracts: Contract[] = ranked.map((row) => ({
    row,
    flags: [],
    supersededByLine: null,
  }))
  const current = contracts[0]!

  for (const contract of contracts.slice(1)) {
    contract.flags.push('superseded')
    contract.supersededByLine = current.row.sourceLine
  }

  // Overlapping coverage is legitimate (brands re-sign early) but it is also
  // how double-billing and stale rows look, so it is surfaced rather than fixed.
  for (let i = 0; i < contracts.length; i++) {
    for (let j = i + 1; j < contracts.length; j++) {
      const a = contracts[i]!.row
      const b = contracts[j]!.row
      const aStart = a.retainerStart.iso
      const aEnd = a.retainerEnd.iso
      const bStart = b.retainerStart.iso
      const bEnd = b.retainerEnd.iso
      if (!aStart || !aEnd || !bStart || !bEnd) continue
      // Half-open intervals: an old contract ending the day the new one starts
      // is a clean handover, not an overlap.
      if (aStart < bEnd && bStart < aEnd) {
        if (!contracts[i]!.flags.includes('overlaps_sibling')) {
          contracts[i]!.flags.push('overlaps_sibling')
        }
        if (!contracts[j]!.flags.includes('overlaps_sibling')) {
          contracts[j]!.flags.push('overlaps_sibling')
        }
      }
    }
  }

  return { current, all: contracts }
}

// ---------------------------------------------------------------------------
// Radar
// ---------------------------------------------------------------------------

/**
 * Classify a client against the review window.
 * The window is inclusive at both ends: day 0 and day 45 are both "due".
 */
export function classifyRenewal(
  daysToRenewal: number | null,
  windowDays: number,
): RenewalStatus {
  if (daysToRenewal == null) return 'unknown'
  if (daysToRenewal < 0) return 'overdue'
  if (daysToRenewal <= windowDays) return 'due'
  return 'upcoming'
}

export type RadarOptions = { asOf?: string; windowDays?: number }

export function buildRadar(
  billing: BillingRow[],
  projects: ProjectRow[],
  options: RadarOptions = {},
): RadarResult {
  const asOf = options.asOf ?? DEMO_AS_OF_DATE
  const windowDays = options.windowDays ?? RENEWAL_WINDOW_DAYS

  const issues: DataIssue[] = []
  const entities = buildProjectEntities(projects)

  // --- group billing rows into clients -------------------------------------
  const groups = new Map<string, BillingRow[]>()
  for (const row of billing) {
    for (const problem of row.problems) {
      issues.push({
        kind: 'malformed_row',
        severity: problem.kind === 'blank_name' ? 'blocking' : 'info',
        subject: row.clientName || `billing line ${row.sourceLine}`,
        title: `Billing line ${row.sourceLine} does not match the header`,
        detail: problem.detail,
        action:
          problem.kind === 'blank_name'
            ? 'Add the client name in the billing export; the row cannot be joined without it.'
            : 'Re-export the row, or confirm the values read below are correct.',
      })
    }
    if (row.clientName.trim().length === 0) continue
    const key = normalizeName(row.clientName)
    if (key.length === 0) continue
    const bucket = groups.get(key)
    if (bucket) bucket.push(row)
    else groups.set(key, [row])
  }

  // --- match ----------------------------------------------------------------
  const displayNames = new Map<string, string>()
  for (const [key, rows] of groups) {
    displayNames.set(key, rankContracts(rows)[0]!.clientName)
  }
  const matches = matchClients(displayNames, entities)

  // --- build client records -------------------------------------------------
  const clients: ClientRecord[] = []
  for (const [key, rows] of groups) {
    const { current, all } = buildContracts(rows)
    const match = matches.get(key)!
    const end = current.row.retainerEnd
    const daysToRenewal = end.iso ? daysBetween(asOf, end.iso) : null
    const renewalStatus = classifyRenewal(daysToRenewal, windowDays)
    const project = match.project?.primary ?? null

    clients.push({
      key,
      displayName: current.row.clientName,
      contracts: all,
      current,
      superseded: all.filter((c) => c.flags.includes('superseded')),
      match,
      renewalStatus,
      daysToRenewal,
      renewalDate: end.iso,
      renewalDateProblem: end.problem,
      monthlyFeeUsd: current.row.monthlyFeeUsd,
      plan: current.row.plan,
      scopeSummary: project?.scopeSummary || null,
      projectStatus: project?.projectStatus || null,
      lastDelivery: project?.lastDelivery.iso ?? null,
    })
  }

  // --- issues ---------------------------------------------------------------
  for (const project of projects) {
    for (const problem of project.problems) {
      issues.push({
        kind: 'malformed_row',
        severity: problem.kind === 'blank_name' ? 'blocking' : 'info',
        subject: project.brandName || `projects line ${project.sourceLine}`,
        title: `Projects line ${project.sourceLine} does not match the header`,
        detail: problem.detail,
        action:
          problem.kind === 'blank_name'
            ? 'Add the brand name in the project export; the row cannot be joined without it.'
            : 'Re-export the row, or confirm the values read below are correct.',
      })
    }
  }

  for (const client of clients) {
    if (client.renewalStatus === 'unknown') {
      const problem = client.renewalDateProblem
      issues.push({
        kind: 'unusable_renewal_date',
        severity: 'blocking',
        subject: client.displayName,
        title: `${client.displayName} has no usable renewal date`,
        detail: `Billing line ${client.current.row.sourceLine} has ${
          problem ? describeDateProblem(problem) : 'no usable value'
        }${client.current.row.retainerEnd.raw ? ` ("${client.current.row.retainerEnd.raw}")` : ''}. The client is excluded from the ${windowDays}-day radar rather than given a guessed date.`,
        action: 'Confirm the retainer end date with billing and correct the export.',
      })
    }

    switch (client.match.status) {
      case 'ambiguous':
        issues.push({
          kind: 'ambiguous_match',
          severity: 'attention',
          subject: client.displayName,
          title: `${client.displayName} matches more than one project brand`,
          detail: client.match.explanation,
          action: `Confirm which brand is correct: ${client.match.candidates
            .slice(0, 3)
            .map((c) => `“${c.brandName}” (${formatScore(c.score)})`)
            .join(', ')}.`,
        })
        break
      case 'review':
        issues.push({
          kind: 'review_match',
          severity: 'attention',
          subject: client.displayName,
          title: `${client.displayName} → ${client.match.project?.brandName} needs confirming`,
          detail: client.match.explanation,
          action: 'Confirm the join before relying on the scope and delivery history shown.',
        })
        break
      case 'unmatched':
        issues.push({
          kind: 'unmatched_billing',
          severity: 'attention',
          subject: client.displayName,
          title: `${client.displayName} has no project record`,
          detail: client.match.explanation,
          action:
            'Check the brand name in the project export, or confirm delivery has not been set up yet.',
        })
        break
    }

    const overlapping = client.contracts.filter((c) => c.flags.includes('overlaps_sibling'))
    if (overlapping.length > 1) {
      issues.push({
        kind: 'overlapping_contracts',
        severity: 'attention',
        subject: client.displayName,
        title: `${client.displayName} has overlapping retainer periods`,
        detail: `Billing lines ${overlapping
          .map((c) => c.row.sourceLine)
          .join(' and ')} cover the same dates (${overlapping
          .map((c) => `${c.row.retainerStart.raw || '?'} → ${c.row.retainerEnd.raw || '?'}`)
          .join('; ')}). The later end date is used for the radar; the earlier row is kept as history.`,
        action: 'Check whether the brand was double-billed during the overlap.',
      })
    }
  }

  const matchedEntityKeys = new Set(
    clients.map((c) => c.match.project?.key).filter((k): k is string => Boolean(k)),
  )
  for (const entity of entities) {
    if (matchedEntityKeys.has(entity.key)) continue
    issues.push({
      kind: 'unmatched_project',
      severity: 'info',
      subject: entity.brandName,
      title: `${entity.brandName} has no billing record`,
      detail: `Projects line ${entity.primary.sourceLine} normalizes to “${entity.key}” and did not match any billing client.`,
      action: 'Check whether a retainer was signed but never entered into billing.',
    })
  }

  for (const entity of entities) {
    if (entity.history.length === 0) continue
    issues.push({
      kind: 'duplicate_project_rows',
      severity: 'info',
      subject: entity.brandName,
      title: `${entity.brandName} appears ${entity.history.length + 1} times in the project export`,
      detail: `Line ${entity.primary.sourceLine} (${
        entity.primary.projectStatus || 'no status'
      }) is used for scope; ${entity.history
        .map((h) => `line ${h.sourceLine} (${h.projectStatus || 'no status'})`)
        .join(', ')} kept as history.`,
      action: 'No action needed if these are prior engagements for the same brand.',
    })
  }

  // --- buckets and summary --------------------------------------------------
  // Clients with no usable date sort last: they are a data problem to fix, not
  // a deadline to chase, and they must never push a real renewal down the list.
  const byUrgency = (a: ClientRecord, b: ClientRecord) =>
    (a.daysToRenewal ?? Number.POSITIVE_INFINITY) -
      (b.daysToRenewal ?? Number.POSITIVE_INFINITY) ||
    a.displayName.localeCompare(b.displayName)

  const overdue = clients.filter((c) => c.renewalStatus === 'overdue').sort(byUrgency)
  const due = clients.filter((c) => c.renewalStatus === 'due').sort(byUrgency)
  const upcoming = clients.filter((c) => c.renewalStatus === 'upcoming').sort(byUrgency)
  const unknown = clients
    .filter((c) => c.renewalStatus === 'unknown')
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
  const needsReview = clients
    .filter((c) => c.match.needsReview)
    .sort((a, b) => a.displayName.localeCompare(b.displayName))

  const summary: RadarSummary = {
    overdue: overdue.length,
    due: due.length,
    upcoming: upcoming.length,
    unknown: unknown.length,
    needsReview: needsReview.length,
    monthlyFeeAtRiskUsd: [...overdue, ...due].reduce((sum, c) => sum + (c.monthlyFeeUsd ?? 0), 0),
    clients: clients.length,
    billingRows: billing.length,
    projectRows: projects.length,
  }

  const severityRank = { blocking: 0, attention: 1, info: 2 } as const
  issues.sort(
    (a, b) => severityRank[a.severity] - severityRank[b.severity] || a.subject.localeCompare(b.subject),
  )

  return {
    asOf,
    windowDays,
    clients: [...clients].sort(byUrgency),
    overdue,
    due,
    upcoming,
    unknown,
    needsReview,
    issues,
    summary,
  }
}
