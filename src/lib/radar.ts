import { confidenceFromScore, normalizeName, similarity } from './normalize'
import type {
  BillingRow,
  ClientMatch,
  DataIssue,
  ProjectRow,
  RadarResult,
  RadarRow,
} from './types'
import { AS_OF_DATE, RENEWAL_WINDOW_DAYS } from './types'

function parseDateOnly(value: string): Date {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d!))
}

function daysBetween(asOf: string, endDate: string): number {
  const a = parseDateOnly(asOf).getTime()
  const b = parseDateOnly(endDate).getTime()
  return Math.round((b - a) / (24 * 60 * 60 * 1000))
}

export function matchClients(billing: BillingRow[], projects: ProjectRow[]): ClientMatch[] {
  const projectPool = projects.map((project) => ({
    project,
    normalized: normalizeName(project.brandName),
    used: false,
  }))

  const matches: ClientMatch[] = []

  for (const row of billing) {
    const normalizedBilling = normalizeName(row.clientName)
    let bestIdx = -1
    let bestScore = -1

    for (let i = 0; i < projectPool.length; i++) {
      const candidate = projectPool[i]!
      if (candidate.used) continue
      const score = similarity(normalizedBilling, candidate.normalized)
      if (score > bestScore) {
        bestScore = score
        bestIdx = i
      }
    }

    const confidence = confidenceFromScore(bestScore)
    if (bestIdx >= 0 && confidence !== 'none') {
      const chosen = projectPool[bestIdx]!
      chosen.used = true
      matches.push({
        billing: row,
        project: chosen.project,
        confidence,
        score: bestScore,
        normalizedBilling,
        normalizedProject: chosen.normalized,
      })
    } else {
      matches.push({
        billing: row,
        project: null,
        confidence: 'none',
        score: Math.max(0, bestScore),
        normalizedBilling,
        normalizedProject: null,
      })
    }
  }

  return matches
}

function findDuplicateBillingNames(billing: BillingRow[]): Set<string> {
  const counts = new Map<string, number>()
  for (const row of billing) {
    const key = normalizeName(row.clientName)
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const dupes = new Set<string>()
  for (const [key, count] of counts) {
    if (count > 1) dupes.add(key)
  }
  return dupes
}

export function buildRadar(
  billing: BillingRow[],
  projects: ProjectRow[],
  options?: { asOf?: string; windowDays?: number },
): RadarResult {
  const asOf = options?.asOf ?? AS_OF_DATE
  const windowDays = options?.windowDays ?? RENEWAL_WINDOW_DAYS
  const matches = matchClients(billing, projects)
  const duplicateKeys = findDuplicateBillingNames(billing)

  const renewals: RadarRow[] = []
  const outsideWindow: RadarRow[] = []
  const issues: DataIssue[] = []

  const usedProjectIndexes = new Set(
    matches.filter((m) => m.project).map((m) => m.project!.sourceIndex),
  )

  for (const match of matches) {
    const { billing: b, project, confidence, score } = match
    const key = normalizeName(b.clientName)
    const isDuplicateRetainer = duplicateKeys.has(key)

    if (!b.retainerEnd) {
      issues.push({
        kind: 'missing_end_date',
        message: `Missing retainer end date: ${b.clientName}`,
        detail: `Billing row ${b.sourceIndex} has no renewal date and is excluded from the 45-day radar.`,
      })
      continue
    }

    if (!project) {
      issues.push({
        kind: 'unmatched_billing',
        message: `No project match for billing client: ${b.clientName}`,
        detail: `Normalized as "${match.normalizedBilling}". Best score ${score.toFixed(2)}.`,
      })
    } else if (confidence === 'low') {
      issues.push({
        kind: 'low_confidence',
        message: `Low-confidence match: ${b.clientName} ↔ ${project.brandName}`,
        detail: `Score ${score.toFixed(2)}. Review before trusting scope history.`,
      })
    }

    if (isDuplicateRetainer) {
      issues.push({
        kind: 'duplicate_retainer',
        message: `Duplicate retainer rows for ${b.clientName}`,
        detail: `End date ${b.retainerEnd}. Prefer the latest end date when planning outreach.`,
      })
    }

    const daysUntil = daysBetween(asOf, b.retainerEnd)
    const row: RadarRow = {
      displayName: b.clientName,
      renewalDate: b.retainerEnd,
      daysUntil,
      monthlyFeeUsd: b.monthlyFeeUsd,
      plan: b.plan,
      scopeSummary: project?.scopeSummary ?? '—',
      projectStatus: project?.projectStatus ?? 'unmatched',
      confidence,
      score,
      isDuplicateRetainer,
      billingSourceIndex: b.sourceIndex,
    }

    if (daysUntil >= 0 && daysUntil <= windowDays) {
      renewals.push(row)
    } else {
      outsideWindow.push(row)
    }
  }

  for (const project of projects) {
    if (!usedProjectIndexes.has(project.sourceIndex)) {
      issues.push({
        kind: 'unmatched_project',
        message: `No billing match for project brand: ${project.brandName}`,
        detail: `Projects row ${project.sourceIndex}.`,
      })
    }
  }

  renewals.sort((a, b) => a.daysUntil - b.daysUntil || a.displayName.localeCompare(b.displayName))
  outsideWindow.sort((a, b) => a.daysUntil - b.daysUntil || a.displayName.localeCompare(b.displayName))

  // De-dupe duplicate_retainer issue noise: keep one issue per normalized name
  const seenDup = new Set<string>()
  const dedupedIssues = issues.filter((issue) => {
    if (issue.kind !== 'duplicate_retainer') return true
    if (seenDup.has(issue.message)) return false
    seenDup.add(issue.message)
    return true
  })

  return {
    asOf,
    windowDays,
    renewals,
    outsideWindow,
    issues: dedupedIssues,
    matches,
  }
}
