import { AS_OF_DATE, RENEWAL_WINDOW_DAYS, type RadarResult, type RadarRow } from './lib/types'
import { buildRadar } from './lib/radar'
import { parseBillingCsv, parseProjectsCsv } from './lib/csv'
import './style.css'

type ViewFilter = 'window' | 'all' | 'issues'

const app = document.querySelector<HTMLDivElement>('#app')!

function money(value: number | null): string {
  if (value == null) return '—'
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 0,
  }).format(value)
}

function confidenceClass(c: RadarRow['confidence']): string {
  return `badge badge-${c}`
}

function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function renderTable(rows: RadarRow[]): string {
  if (rows.length === 0) {
    return `<p class="empty">No renewals in this view.</p>`
  }
  const body = rows
    .map(
      (r) => `
    <tr>
      <td>
        <strong>${escapeHtml(r.displayName)}</strong>
        ${r.isDuplicateRetainer ? '<span class="pill">re-signed</span>' : ''}
      </td>
      <td>${escapeHtml(r.renewalDate)}</td>
      <td><span class="days">${r.daysUntil}</span></td>
      <td>${money(r.monthlyFeeUsd)}</td>
      <td>${escapeHtml(r.plan || '—')}</td>
      <td>${escapeHtml(r.scopeSummary)}</td>
      <td>${escapeHtml(r.projectStatus)}</td>
      <td><span class="${confidenceClass(r.confidence)}">${escapeHtml(r.confidence)}</span></td>
    </tr>`,
    )
    .join('')

  return `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Client</th>
            <th>Renewal</th>
            <th>Days</th>
            <th>Fee</th>
            <th>Plan</th>
            <th>Scope (from projects)</th>
            <th>Status</th>
            <th>Match</th>
          </tr>
        </thead>
        <tbody>${body}</tbody>
      </table>
    </div>`
}

function renderIssues(result: RadarResult): string {
  if (result.issues.length === 0) {
    return `<p class="empty">No data issues detected.</p>`
  }
  return `
    <ul class="issue-list">
      ${result.issues
        .map(
          (i) => `
        <li>
          <span class="issue-kind">${escapeHtml(i.kind)}</span>
          <strong>${escapeHtml(i.message)}</strong>
          <span class="muted">${escapeHtml(i.detail)}</span>
        </li>`,
        )
        .join('')}
    </ul>`
}

function shell(result: RadarResult, filter: ViewFilter, statusMsg: string): string {
  const rows =
    filter === 'window'
      ? result.renewals
      : filter === 'all'
        ? [...result.renewals, ...result.outsideWindow].sort(
            (a, b) => a.daysUntil - b.daysUntil,
          )
        : []

  return `
  <header class="top">
    <div>
      <p class="eyebrow">Harbourline · Relay</p>
      <h1>Renewal Radar</h1>
      <p class="lede">
        Rolling retainers due within <strong>${result.windowDays} days</strong>
        (as of <strong>${escapeHtml(result.asOf)}</strong>).
        Billing and project exports are joined by fuzzy client name — no shared ID required.
      </p>
    </div>
    <div class="stats">
      <div class="stat"><span class="stat-n">${result.renewals.length}</span><span>in window</span></div>
      <div class="stat"><span class="stat-n">${result.outsideWindow.length}</span><span>outside</span></div>
      <div class="stat"><span class="stat-n">${result.issues.length}</span><span>data issues</span></div>
    </div>
  </header>

  <section class="controls card">
    <div class="control-block">
      <h2>Data source</h2>
      <p class="muted">Bundled sample CSVs load automatically. Or upload your own exports (client-side only).</p>
      <div class="upload-row">
        <label class="file">
          <span>Billing CSV</span>
          <input id="billing-file" type="file" accept=".csv,text/csv" />
        </label>
        <label class="file">
          <span>Projects CSV</span>
          <input id="projects-file" type="file" accept=".csv,text/csv" />
        </label>
        <button type="button" id="reload-sample" class="btn secondary">Reload sample data</button>
      </div>
      <p class="status" id="status">${escapeHtml(statusMsg)}</p>
    </div>
    <div class="control-block">
      <h2>View</h2>
      <div class="tabs" role="tablist">
        <button type="button" class="tab ${filter === 'window' ? 'active' : ''}" data-filter="window">Next ${RENEWAL_WINDOW_DAYS} days</button>
        <button type="button" class="tab ${filter === 'all' ? 'active' : ''}" data-filter="all">All dated retainers</button>
        <button type="button" class="tab ${filter === 'issues' ? 'active' : ''}" data-filter="issues">Data issues</button>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>${filter === 'issues' ? 'Data issues' : filter === 'window' ? `Renewals in the next ${RENEWAL_WINDOW_DAYS} days` : 'All retainers with an end date'}</h2>
    ${filter === 'issues' ? renderIssues(result) : renderTable(rows)}
  </section>

  <footer class="foot">
    <p>No logins. No paid APIs. Matching runs entirely in your browser.</p>
    <p class="muted">Sample data encodes spelling, casing, suffix, missing dates, re-signs, and in/out-of-window renewals.</p>
  </footer>`
}

let currentResult: RadarResult | null = null
let filter: ViewFilter = 'window'
let statusMsg = 'Loaded bundled sample data.'
let billingText = ''
let projectsText = ''

function paint() {
  if (!currentResult) return
  app.innerHTML = shell(currentResult, filter, statusMsg)
  bind()
}

function recompute() {
  const billing = parseBillingCsv(billingText)
  const projects = parseProjectsCsv(projectsText)
  currentResult = buildRadar(billing, projects, { asOf: AS_OF_DATE, windowDays: RENEWAL_WINDOW_DAYS })
  paint()
}

function bind() {
  app.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      filter = btn.dataset.filter as ViewFilter
      paint()
    })
  })

  app.querySelector<HTMLButtonElement>('#reload-sample')?.addEventListener('click', () => {
    void loadSample()
  })

  const billingInput = app.querySelector<HTMLInputElement>('#billing-file')
  const projectsInput = app.querySelector<HTMLInputElement>('#projects-file')

  billingInput?.addEventListener('change', async () => {
    const file = billingInput.files?.[0]
    if (!file) return
    billingText = await file.text()
    statusMsg = `Billing replaced with ${file.name}.`
    try {
      recompute()
    } catch (err) {
      statusMsg = err instanceof Error ? err.message : 'Failed to parse billing CSV.'
      paint()
    }
  })

  projectsInput?.addEventListener('change', async () => {
    const file = projectsInput.files?.[0]
    if (!file) return
    projectsText = await file.text()
    statusMsg = `Projects replaced with ${file.name}.`
    try {
      recompute()
    } catch (err) {
      statusMsg = err instanceof Error ? err.message : 'Failed to parse projects CSV.'
      paint()
    }
  })
}

async function loadSample() {
  const base = import.meta.env.BASE_URL
  const [b, p] = await Promise.all([
    fetch(`${base}data/billing.csv`).then((r) => {
      if (!r.ok) throw new Error('Could not load sample billing.csv')
      return r.text()
    }),
    fetch(`${base}data/projects.csv`).then((r) => {
      if (!r.ok) throw new Error('Could not load sample projects.csv')
      return r.text()
    }),
  ])
  billingText = b
  projectsText = p
  statusMsg = 'Loaded bundled sample data.'
  recompute()
}

void loadSample().catch((err) => {
  app.innerHTML = `<p class="error">${escapeHtml(err instanceof Error ? err.message : String(err))}</p>`
})
