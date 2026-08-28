# Renewal Radar

Part of **Relay** for Harbourline (Palm Outsourcing trial — Question 2).

Account leads can see which rolling retainers renew in the **next 45 days** by joining a billing export and a project export — even when the two files share **no client ID**.

## Live app

**https://mharooney.github.io/harbourline-renewal-radar/**

## Why this exists

Two brands lapsed last quarter because renewal dates sat in a billing export nobody watched, while delivery context lived in a separate project file. Renewal Radar pulls both, fuzzy-matches clients by name, and surfaces what needs attention before the window closes.

## Constraints honored

- Browser UI for account leads (no terminal required)
- No new logins / auth
- No paid APIs
- Sample data invented and committed in-repo
- Optional CSV upload (processed entirely client-side)

## Demo “as of” date

Sample renewals are evaluated against a fixed date: **2026-08-29**. That keeps the 45-day window stable for reviewers.

## Sample data legend

| Issue | How it appears in the CSVs |
|-------|----------------------------|
| Spelling differences | `Harbour Brew Co` ↔ `Harbor Brew` |
| Casing differences | `ACME SHOP` ↔ `Acme Shop` |
| Legal suffixes | `Northwind Ltd` ↔ `Northwind Limited`; `Inc` ↔ `Incorporated` |
| Missing end date | `Cedar & Co.` has a blank `retainer_end` → Data issues, excluded from radar |
| Re-signed duplicate | `Riverstone Outfitters` appears twice in billing (old + new end dates) |
| Inside / outside 45 days | e.g. `Harbour Brew Co` (2026-09-15) in window; `Pine & Petal` (2026-12-15) outside |

Files: [`public/data/billing.csv`](public/data/billing.csv), [`public/data/projects.csv`](public/data/projects.csv).

## Matching rules (explainable)

1. Normalize names: lowercase, strip punctuation, `&` → `and`, map suffixes (`Limited`→`ltd`, `Incorporated`→`inc`, …), drop trailing `co`, sort tokens.
2. Score with normalized Levenshtein similarity.
3. Greedy best match per billing row (each project row used at most once).
4. Confidence: high ≥ 0.92, medium ≥ 0.80, low ≥ 0.68; below that → unmatched.
5. Missing end dates never enter the 45-day list; they are listed under **Data issues**.

## Run locally

```bash
npm install
npm run dev
```

Open the URL Vite prints (usually `http://localhost:5173/harbourline-renewal-radar/`).

```bash
npm test          # unit tests for normalize, match, windowing
npm run build     # production build
npm run preview   # serve dist locally
```

## Stack

Vite + TypeScript, Vitest, GitHub Pages. No backend.

## License

MIT
