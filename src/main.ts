import { CsvFormatError, parseBillingCsv, parseProjectsCsv } from './lib/csv'
import { formatScore } from './lib/normalize'
import { buildRadar, todayIso } from './lib/radar'
import type { ClientRecord, DataIssue, RadarResult } from './lib/types'
import { DEMO_AS_OF_DATE, RENEWAL_WINDOW_DAYS } from './lib/types'
import './style.css'

// ---------------------------------------------------------------------------
// View state
// ---------------------------------------------------------------------------

type View = 'queue' | 'all' | 'review' | 'issues'

const VIEWS: { id: View; label: string; hint: string }[] = [
  { id: 'queue', label: 'Action queue', hint: 'Overdue and due inside the window' },
  { id: 'all', label: 'All clients', hint: 'Every client, soonest renewal first' },
  { id: 'review', label: 'Needs review', hint: 'Joins a human has to confirm' },
  { id: 'issues', label: 'Data issues', hint: 'Rows that cannot be trusted as-is' },
]

type AppState = {
  result: RadarResult | null
  view: View
  query: string
  asOf: string
  expanded: Set<string>
  status: { tone: 'info' | 'error'; message: string }
  loading: boolean
}

const state: AppState = {
  result: null,
  view: 'queue',
  query: '',
  asOf: DEMO_AS_OF_DATE,
  expanded: new Set(),
  status: { tone: 'info', message: 'Loading sample exports…' },
  loading: true,
}

let billingText = ''
let projectsText = ''

const app = document.querySelector<HTMLDivElement>('#app')!

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

const escapeHtml = (s: string): string =>
  s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')

const money = (value: number | null): string =>
  value == null
    ? '—'
    : new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        maximumFractionDigits: 0,
      }).format(value)

const longDate = (iso: string | null): string => {
  if (!iso) return '—'
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y!, m! - 1, d!)).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  })
}

/** Status wording carries the meaning; colour only reinforces it. */
function renewalLabel(client: ClientRecord): string {
  const days = client.daysToRenewal
  switch (client.renewalStatus) {
    case 'overdue':
      return `Lapsed ${Math.abs(days!)} ${Math.abs(days!) === 1 ? 'day' : 'days'} ago`
    case 'due':
      if (days === 0) return 'Renews today'
      return `Due in ${days} ${days === 1 ? 'day' : 'days'}`
    case 'upcoming':
      return `In ${days} days`
    case 'unknown':
      return 'No usable date'
  }
}

const ICONS: Record<string, string> = {
  overdue: '<path d="M8 1 15 14H1Z" /><path d="M8 6v4" class="glyph-line" /><circle cx="8" cy="12" r=".9" class="glyph-dot" />',
  due: '<circle cx="8" cy="8" r="6.4" /><path d="M8 4.4V8l2.6 1.6" class="glyph-line" />',
  upcoming: '<circle cx="8" cy="8" r="6.4" />',
  unknown: '<circle cx="8" cy="8" r="6.4" /><path d="M6.3 6.2a1.8 1.8 0 1 1 2.2 2.3v1" class="glyph-line" /><circle cx="8.2" cy="11.4" r=".9" class="glyph-dot" />',
  ok: '<path d="M3 8.4 6.4 12 13 4.6" class="glyph-line" />',
  review: '<path d="M8 1.6 14.4 13H1.6Z" /><path d="M8 6.3v3" class="glyph-line" /><circle cx="8" cy="11" r=".85" class="glyph-dot" />',
  none: '<circle cx="8" cy="8" r="6.4" /><path d="M4.6 4.6 11.4 11.4" class="glyph-line" />',
}

const icon = (name: keyof typeof ICONS): string =>
  `<svg class="glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`

const MATCH_LABELS: Record<ClientRecord['match']['status'], { text: string; glyph: string }> = {
  exact: { text: 'Exact', glyph: 'ok' },
  strong: { text: 'Strong', glyph: 'ok' },
  review: { text: 'Confirm', glyph: 'review' },
  ambiguous: { text: 'Ambiguous', glyph: 'review' },
  unmatched: { text: 'No match', glyph: 'none' },
}

const METHOD_LABELS: Record<ClientRecord['match']['method'], string> = {
  normalized_exact: 'normalized exact',
  fuzzy: 'fuzzy (edit distance)',
  none: 'no candidate',
}

const ISSUE_LABELS: Record<DataIssue['kind'], string> = {
  unusable_renewal_date: 'Renewal date',
  ambiguous_match: 'Ambiguous match',
  review_match: 'Match to confirm',
  unmatched_billing: 'Unmatched client',
  unmatched_project: 'Unmatched project',
  overlapping_contracts: 'Overlapping contracts',
  malformed_row: 'Malformed row',
  duplicate_project_rows: 'Duplicate project rows',
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function visibleClients(result: RadarResult): ClientRecord[] {
  const base =
    state.view === 'queue'
      ? [...result.overdue, ...result.due]
      : state.view === 'review'
        ? result.needsReview
        : result.clients
  const q = state.query.trim().toLowerCase()
  if (!q) return base
  return base.filter(
    (c) =>
      c.displayName.toLowerCase().includes(q) ||
      c.key.includes(q) ||
      (c.match.project?.brandName.toLowerCase().includes(q) ?? false),
  )
}

function visibleIssues(result: RadarResult): DataIssue[] {
  const q = state.query.trim().toLowerCase()
  if (!q) return result.issues
  return result.issues.filter(
    (i) => i.subject.toLowerCase().includes(q) || i.title.toLowerCase().includes(q),
  )
}

// ---------------------------------------------------------------------------
// Render: detail panel
// ---------------------------------------------------------------------------

function renderMatchDetail(client: ClientRecord): string {
  const m = client.match
  const candidateList =
    m.candidates.length > 0
      ? `<ul class="candidates">${m.candidates
          .slice(0, 4)
          .map(
            (c, i) =>
              `<li${i === 0 ? ' class="is-best"' : ''}><span>${escapeHtml(
                c.brandName,
              )}</span><span class="score">${formatScore(c.score)}</span></li>`,
          )
          .join('')}</ul>`
      : '<p class="detail-empty">No project brand scored above the review floor.</p>'

  return `
    <div class="detail-block">
      <h4>Why this match</h4>
      <dl class="kv">
        <dt>Method</dt><dd>${escapeHtml(METHOD_LABELS[m.method])}</dd>
        <dt>Confidence</dt><dd>${formatScore(m.score)}</dd>
        <dt>Join key</dt><dd><code>${escapeHtml(m.normalizedBilling)}</code></dd>
      </dl>
      <p class="detail-note">${escapeHtml(m.explanation)}</p>
      <h5>Candidates considered</h5>
      ${candidateList}
    </div>`
}

function renderContractDetail(client: ClientRecord): string {
  const rows = client.contracts
    .map((c) => {
      const isCurrent = c === client.current
      const flags = [
        isCurrent ? '<span class="tag tag-current">Current</span>' : '',
        c.flags.includes('superseded')
          ? `<span class="tag tag-past">Superseded by line ${c.supersededByLine}</span>`
          : '',
        c.flags.includes('overlaps_sibling')
          ? '<span class="tag tag-warn">Overlapping dates</span>'
          : '',
      ]
        .filter(Boolean)
        .join(' ')
      return `
        <tr${isCurrent ? ' class="is-current"' : ''}>
          <td>${c.row.sourceLine}</td>
          <td>${escapeHtml(c.row.retainerStart.raw || '—')}</td>
          <td>${escapeHtml(c.row.retainerEnd.raw || '—')}</td>
          <td>${money(c.row.monthlyFeeUsd)}</td>
          <td>${flags || '—'}</td>
        </tr>`
    })
    .join('')

  return `
    <div class="detail-block">
      <h4>Contract history <span class="count">${client.contracts.length}</span></h4>
      <table class="mini-table">
        <thead>
          <tr><th>Line</th><th>Start</th><th>End</th><th>Fee</th><th>Notes</th></tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
      ${
        client.superseded.length > 0
          ? `<p class="detail-note">The radar uses the contract with the latest end date. Earlier contracts are kept here, never deleted.</p>`
          : ''
      }
    </div>`
}

function renderDeliveryDetail(client: ClientRecord): string {
  if (!client.match.project) {
    return `
      <div class="detail-block">
        <h4>Delivery context</h4>
        <p class="detail-empty">No confirmed project record, so no scope or delivery history is shown. Renewal timing above comes from billing alone and is unaffected.</p>
      </div>`
  }
  const p = client.match.project
  return `
    <div class="detail-block">
      <h4>Delivery context</h4>
      <dl class="kv">
        <dt>Project brand</dt><dd>${escapeHtml(p.brandName)} <span class="muted">(line ${p.primary.sourceLine})</span></dd>
        <dt>Status</dt><dd>${escapeHtml(p.primary.projectStatus || '—')}</dd>
        <dt>Scope</dt><dd>${escapeHtml(p.primary.scopeSummary || '—')}</dd>
        <dt>Last delivery</dt><dd>${longDate(p.primary.lastDelivery.iso)}</dd>
      </dl>
      ${
        p.history.length > 0
          ? `<p class="detail-note">${p.history.length} earlier project row${
              p.history.length === 1 ? '' : 's'
            } for this brand kept as history (line${p.history.length === 1 ? '' : 's'} ${p.history
              .map((h) => h.sourceLine)
              .join(', ')}).</p>`
          : ''
      }
    </div>`
}

// ---------------------------------------------------------------------------
// Render: table
// ---------------------------------------------------------------------------

function renderClientRow(client: ClientRecord, windowDays: number): string {
  const open = state.expanded.has(client.key)
  const match = MATCH_LABELS[client.match.status]
  const flags: string[] = []
  if (client.superseded.length > 0) flags.push('<span class="tag tag-past">Re-signed</span>')
  if (client.contracts.some((c) => c.flags.includes('overlaps_sibling'))) {
    flags.push('<span class="tag tag-warn">Overlap</span>')
  }
  if (client.current.row.problems.length > 0) {
    flags.push('<span class="tag tag-warn">Row issue</span>')
  }

  const detailId = `detail-${client.key.replace(/[^a-z0-9]/g, '-')}`

  return `
    <tr class="client-row status-${client.renewalStatus}${open ? ' is-open' : ''}">
      <td class="cell-client">
        <button
          type="button"
          class="disclosure"
          data-client="${escapeHtml(client.key)}"
          aria-expanded="${open}"
          aria-controls="${detailId}"
        >
          <svg class="chevron" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3.5 10.5 8 6 12.5" /></svg>
          <span class="client-name">${escapeHtml(client.displayName)}</span>
        </button>
        ${flags.length ? `<div class="flag-row">${flags.join('')}</div>` : ''}
      </td>
      <td class="cell-renewal">
        <span class="renewal-date">${longDate(client.renewalDate)}</span>
      </td>
      <td class="cell-status">
        <span class="status-chip status-${client.renewalStatus}">
          ${icon(client.renewalStatus)}<span>${escapeHtml(renewalLabel(client))}</span>
        </span>
      </td>
      <td class="cell-num">${money(client.monthlyFeeUsd)}</td>
      <td class="cell-plan">${escapeHtml(client.plan || '—')}</td>
      <td class="cell-scope">${
        client.scopeSummary
          ? escapeHtml(client.scopeSummary)
          : '<span class="muted">Not joined</span>'
      }</td>
      <td class="cell-match">
        <span class="match-chip match-${client.match.status}">
          ${icon(match.glyph)}<span>${match.text}</span>
        </span>
        ${
          // A percentage under "Ambiguous"/"No match" would read as confidence
          // in a join that was deliberately not made.
          client.match.project
            ? `<span class="match-score">${formatScore(client.match.score)}</span>`
            : ''
        }
      </td>
    </tr>
    <tr class="detail-row${open ? '' : ' is-hidden'}" id="${detailId}">
      <td colspan="7">
        <div class="detail-grid">
          ${renderMatchDetail(client)}
          ${renderContractDetail(client)}
          ${renderDeliveryDetail(client)}
        </div>
        ${
          client.renewalStatus === 'unknown'
            ? `<p class="detail-callout">Excluded from the ${windowDays}-day radar: the renewal date could not be trusted, and a guessed date would look actionable when it is not.</p>`
            : ''
        }
      </td>
    </tr>`
}

function renderEmpty(title: string, body: string): string {
  return `
    <div class="empty-state">
      <svg viewBox="0 0 48 48" aria-hidden="true" focusable="false" class="empty-glyph">
        <circle cx="24" cy="24" r="17" />
        <path d="M16 24h16M24 16v16" />
      </svg>
      <p class="empty-title">${escapeHtml(title)}</p>
      <p class="empty-body">${escapeHtml(body)}</p>
    </div>`
}

function renderTable(clients: ClientRecord[], result: RadarResult): string {
  if (clients.length === 0) {
    return state.query
      ? renderEmpty('No clients match that search', `Nothing in this view matches “${state.query}”.`)
      : state.view === 'queue'
        ? renderEmpty(
            'Nothing needs chasing',
            `No retainer is overdue or renewing within ${result.windowDays} days of ${result.asOf}.`,
          )
        : renderEmpty('Nothing to show', 'This view is empty for the current data.')
  }

  return `
    <div class="table-wrap">
      <table class="client-table">
        <caption class="sr-only">
          Client retainers, soonest renewal first. Expand a row for match evidence and contract history.
        </caption>
        <thead>
          <tr>
            <th scope="col">Client</th>
            <th scope="col">Renewal date</th>
            <th scope="col">Status</th>
            <th scope="col" class="cell-num">Monthly fee</th>
            <th scope="col">Plan</th>
            <th scope="col">Scope (from projects)</th>
            <th scope="col">Join</th>
          </tr>
        </thead>
        <tbody>${clients.map((c) => renderClientRow(c, result.windowDays)).join('')}</tbody>
      </table>
    </div>`
}

function renderIssues(issues: DataIssue[]): string {
  if (issues.length === 0) {
    return state.query
      ? renderEmpty('No issues match that search', `Nothing matches “${state.query}”.`)
      : renderEmpty('No data issues', 'Both exports parsed cleanly and every client joined.')
  }
  return `
    <ul class="issue-list">
      ${issues
        .map(
          (i) => `
        <li class="issue severity-${i.severity}">
          <div class="issue-head">
            <span class="severity-chip severity-${i.severity}">${
              i.severity === 'blocking' ? 'Blocking' : i.severity === 'attention' ? 'Attention' : 'For info'
            }</span>
            <span class="issue-kind">${escapeHtml(ISSUE_LABELS[i.kind])}</span>
          </div>
          <p class="issue-title">${escapeHtml(i.title)}</p>
          <p class="issue-detail">${escapeHtml(i.detail)}</p>
          <p class="issue-action"><span class="issue-action-label">Do this</span> ${escapeHtml(i.action)}</p>
        </li>`,
        )
        .join('')}
    </ul>`
}

// ---------------------------------------------------------------------------
// Render: results region
// ---------------------------------------------------------------------------

function renderResults(): string {
  const result = state.result
  if (state.loading || !result) {
    return `
      <div class="skeleton" aria-hidden="true">
        ${Array.from({ length: 5 }, () => '<div class="skeleton-row"></div>').join('')}
      </div>
      <p class="sr-only">Loading renewal data.</p>`
  }

  if (state.view === 'issues') {
    const issues = visibleIssues(result)
    return `
      <p class="result-count" role="status">${issues.length} data issue${
        issues.length === 1 ? '' : 's'
      }${state.query ? ` matching “${escapeHtml(state.query)}”` : ''}</p>
      ${renderIssues(issues)}`
  }

  const clients = visibleClients(result)
  const view = VIEWS.find((v) => v.id === state.view)!
  return `
    <p class="result-count" role="status">${clients.length} client${
      clients.length === 1 ? '' : 's'
    } · ${escapeHtml(view.hint)}${state.query ? ` · filtered by “${escapeHtml(state.query)}”` : ''}</p>
    ${renderTable(clients, result)}`
}

function renderSummary(): string {
  const s = state.result?.summary
  const cards: { view: View; n: string; label: string; sub: string; tone: string }[] = [
    {
      view: 'queue',
      n: String(s?.overdue ?? '—'),
      label: 'Overdue',
      sub: 'Past the renewal date',
      tone: 'danger',
    },
    {
      view: 'queue',
      n: String(s?.due ?? '—'),
      label: `Due in ${RENEWAL_WINDOW_DAYS} days`,
      sub: 'Inside the review window',
      tone: 'warn',
    },
    {
      view: 'queue',
      n: money(s?.monthlyFeeAtRiskUsd ?? null),
      label: 'Monthly fee at risk',
      sub: 'Overdue + due combined',
      tone: 'neutral',
    },
    {
      view: 'review',
      n: String((s?.needsReview ?? 0) + (s?.unknown ?? 0)),
      label: 'Needs a human',
      sub: 'Uncertain joins and unusable dates',
      tone: 'info',
    },
  ]

  return cards
    .map(
      (c) => `
      <button type="button" class="stat tone-${c.tone}" data-view="${c.view}">
        <span class="stat-n">${c.n}</span>
        <span class="stat-label">${escapeHtml(c.label)}</span>
        <span class="stat-sub">${escapeHtml(c.sub)}</span>
      </button>`,
    )
    .join('')
}

// ---------------------------------------------------------------------------
// Shell (rendered once)
// ---------------------------------------------------------------------------

function renderShell(): string {
  return `
  <a class="skip-link" href="#results">Skip to renewal list</a>

  <header class="masthead">
    <div class="masthead-id">
      <p class="eyebrow">Harbourline · Relay</p>
      <h1>Renewal Radar</h1>
      <p class="lede">
        Rolling retainers, joined from the billing and project exports by client name.
        Everything inside <strong>${RENEWAL_WINDOW_DAYS} days</strong> — and everything already
        past due — in one list.
      </p>
    </div>
    <div class="asof">
      <label class="asof-label" for="asof-input">Evaluate as of</label>
      <div class="asof-controls">
        <input id="asof-input" type="date" value="${state.asOf}" />
        <button type="button" id="asof-today" class="btn btn-ghost">Today</button>
      </div>
      <p class="asof-note" id="asof-note"></p>
    </div>
  </header>

  <section class="summary" id="summary" aria-label="Renewal summary">${renderSummary()}</section>

  <section class="workspace">
    <div class="toolbar">
      <div class="tabs" role="tablist" aria-label="Renewal views">
        ${VIEWS.map(
          (v) => `
          <button
            type="button"
            role="tab"
            id="tab-${v.id}"
            class="tab"
            data-view="${v.id}"
            aria-selected="${state.view === v.id}"
            aria-controls="results"
            tabindex="${state.view === v.id ? '0' : '-1'}"
          >${v.label}<span class="tab-count" data-count="${v.id}"></span></button>`,
        ).join('')}
      </div>
      <div class="search">
        <svg class="search-glyph" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
          <circle cx="7" cy="7" r="4.6" /><path d="m10.6 10.6 3.2 3.2" />
        </svg>
        <label class="sr-only" for="search-input">Filter by client or brand</label>
        <input id="search-input" type="search" placeholder="Filter by client or brand" autocomplete="off" />
      </div>
    </div>
    <div id="results" class="results" role="tabpanel" aria-labelledby="tab-${state.view}" tabindex="-1">${renderResults()}</div>
  </section>

  <details class="datasource">
    <summary>
      <span>Data source</span>
      <span class="datasource-status" id="source-status"></span>
    </summary>
    <div class="datasource-body">
      <p class="muted">
        The bundled sample exports load automatically. You can drop in your own billing and
        project CSVs instead — they are parsed in this browser and never uploaded anywhere.
      </p>
      <div class="upload-row">
        <label class="file">
          <span>Billing CSV</span>
          <input id="billing-file" type="file" accept=".csv,text/csv" />
        </label>
        <label class="file">
          <span>Projects CSV</span>
          <input id="projects-file" type="file" accept=".csv,text/csv" />
        </label>
        <button type="button" id="reload-sample" class="btn btn-ghost">Reload sample data</button>
      </div>
      <p class="source-counts" id="source-counts"></p>
    </div>
  </details>

  <footer class="foot">
    <p>
      No logins, no paid APIs, no server. Matching is deterministic edit-distance on normalized
      names — expand any row to see exactly why it joined.
    </p>
  </footer>`
}

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------

function paintResults() {
  const results = document.querySelector<HTMLDivElement>('#results')!
  // Replacing the table collapses the document height for an instant, which
  // makes the browser reset the scroll position. Expanding a row halfway down
  // a long list must not throw the reader back to the top.
  const scrollY = window.scrollY
  results.innerHTML = renderResults()
  window.scrollTo({ top: scrollY })
  paintChrome()
}

/**
 * Repaint everything outside the results region. Split out so the error path
 * can call it too: if a CSV fails to parse we discard the old result, and the
 * summary must not keep showing counts from data that is no longer loaded.
 */
function paintChrome() {
  const results = document.querySelector<HTMLDivElement>('#results')!
  document.querySelector<HTMLElement>('#summary')!.innerHTML = renderSummary()
  bindSummary()

  for (const tab of document.querySelectorAll<HTMLButtonElement>('.tab')) {
    const selected = tab.dataset.view === state.view
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
  }
  results.setAttribute('aria-labelledby', `tab-${state.view}`)

  const r = state.result
  const counts: Record<View, number> = {
    queue: r ? r.overdue.length + r.due.length : 0,
    all: r ? r.clients.length : 0,
    review: r ? r.needsReview.length : 0,
    issues: r ? r.issues.length : 0,
  }
  for (const el of document.querySelectorAll<HTMLElement>('.tab-count')) {
    el.textContent = r ? String(counts[el.dataset.count as View]) : ''
  }

  const status = document.querySelector<HTMLElement>('#source-status')!
  status.textContent = state.status.message
  status.classList.toggle('is-error', state.status.tone === 'error')

  const sourceCounts = document.querySelector<HTMLElement>('#source-counts')!
  sourceCounts.textContent = r
    ? `${r.summary.billingRows} billing rows and ${r.summary.projectRows} project rows resolved into ${r.summary.clients} clients.`
    : ''

  const note = document.querySelector<HTMLElement>('#asof-note')!
  note.textContent =
    state.asOf === DEMO_AS_OF_DATE
      ? 'Demo date, so the sample boundary cases stay stable.'
      : `Recalculated against ${state.asOf}.`
}

function recompute() {
  try {
    const billing = parseBillingCsv(billingText)
    const projects = parseProjectsCsv(projectsText)
    state.result = buildRadar(billing, projects, {
      asOf: state.asOf,
      windowDays: RENEWAL_WINDOW_DAYS,
    })
    state.loading = false
  } catch (err) {
    state.result = null
    state.loading = false
    state.status = {
      tone: 'error',
      message:
        err instanceof CsvFormatError
          ? err.message
          : `Could not read that CSV: ${err instanceof Error ? err.message : String(err)}`,
    }
    const results = document.querySelector<HTMLDivElement>('#results')
    if (results) {
      results.innerHTML = `
        <div class="error-state" role="alert">
          <p class="error-title">That file could not be read</p>
          <p class="error-body">${escapeHtml(state.status.message)}</p>
          <p class="error-body muted">The previous data was discarded. Reload the sample exports to start again.</p>
        </div>`
    }
    paintChrome()
    document.querySelector<HTMLDetailsElement>('.datasource')?.setAttribute('open', '')
    return
  }
  paintResults()
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

function setView(view: View) {
  state.view = view
  paintResults()
}

function bindSummary() {
  for (const card of document.querySelectorAll<HTMLButtonElement>('.stat')) {
    card.addEventListener('click', () => setView(card.dataset.view as View))
  }
}

function bindShell() {
  const tabs = [...document.querySelectorAll<HTMLButtonElement>('.tab')]
  tabs.forEach((tab, i) => {
    tab.addEventListener('click', () => setView(tab.dataset.view as View))
    // Arrow-key navigation is expected of a tablist.
    tab.addEventListener('keydown', (event) => {
      const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
      if (delta === 0) return
      event.preventDefault()
      const next = tabs[(i + delta + tabs.length) % tabs.length]!
      setView(next.dataset.view as View)
      next.focus()
    })
  })

  const search = document.querySelector<HTMLInputElement>('#search-input')!
  search.addEventListener('input', () => {
    state.query = search.value
    paintResults()
  })

  const asOf = document.querySelector<HTMLInputElement>('#asof-input')!
  asOf.addEventListener('change', () => {
    if (!asOf.value) return
    state.asOf = asOf.value
    recompute()
  })

  document.querySelector<HTMLButtonElement>('#asof-today')!.addEventListener('click', () => {
    state.asOf = todayIso()
    asOf.value = state.asOf
    recompute()
  })

  // Row disclosure is delegated: rows are re-rendered on every repaint.
  document.querySelector<HTMLDivElement>('#results')!.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('.disclosure')
    if (!button) return
    const key = button.dataset.client!
    if (state.expanded.has(key)) state.expanded.delete(key)
    else state.expanded.add(key)
    paintResults()
    // Keep focus on the control the user just pressed.
    document
      .querySelector<HTMLButtonElement>(`.disclosure[data-client="${CSS.escape(key)}"]`)
      ?.focus({ preventScroll: true })
  })

  document.querySelector<HTMLButtonElement>('#reload-sample')!.addEventListener('click', () => {
    void loadSample()
  })

  bindFileInput('#billing-file', (text, name) => {
    billingText = text
    state.status = { tone: 'info', message: `Billing export: ${name}` }
  })
  bindFileInput('#projects-file', (text, name) => {
    projectsText = text
    state.status = { tone: 'info', message: `Project export: ${name}` }
  })

  bindSummary()
}

function bindFileInput(selector: string, apply: (text: string, name: string) => void) {
  const input = document.querySelector<HTMLInputElement>(selector)!
  input.addEventListener('change', async () => {
    const file = input.files?.[0]
    if (!file) return
    apply(await file.text(), file.name)
    state.expanded.clear()
    recompute()
  })
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

async function loadSample() {
  const base = import.meta.env.BASE_URL
  state.loading = true
  state.status = { tone: 'info', message: 'Loading sample exports…' }
  paintResults()

  const fetchText = async (path: string) => {
    const response = await fetch(`${base}data/${path}`)
    if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`)
    return response.text()
  }

  try {
    const [b, p] = await Promise.all([fetchText('billing.csv'), fetchText('projects.csv')])
    billingText = b
    projectsText = p
    state.status = { tone: 'info', message: 'Bundled sample exports' }
    state.expanded.clear()
    recompute()
  } catch (err) {
    state.loading = false
    state.status = {
      tone: 'error',
      message: err instanceof Error ? err.message : String(err),
    }
    document.querySelector<HTMLDivElement>('#results')!.innerHTML = `
      <div class="error-state" role="alert">
        <p class="error-title">Sample data could not be loaded</p>
        <p class="error-body">${escapeHtml(state.status.message)}</p>
        <p class="error-body muted">Upload your own billing and project CSVs below to carry on.</p>
      </div>`
    document.querySelector<HTMLDetailsElement>('.datasource')?.setAttribute('open', '')
  }
}

app.innerHTML = renderShell()
bindShell()
void loadSample()
