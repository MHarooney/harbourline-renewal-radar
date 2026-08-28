# Renewal Radar

**Live app → https://mharooney.github.io/harbourline-renewal-radar/**
**Question 1 brief → [Google Doc](https://docs.google.com/document/d/1Ne8oIgqKSdyNm1I4F_f0MdhdwGn2sRhpNJf6KfoOrJM/edit?usp=sharing)** · [HTML mirror](https://mharooney.github.io/harbourline-renewal-radar/q1/)

Part of **Relay** for Harbourline — Palm Outsourcing trial, Question 2.

---

## The problem

Harbourline runs rolling three-month retainers. Renewal dates live in a billing export. Scope and
delivery history live in a separate project export. The two files share **no client ID**, and the names
in them do not match. Two brands lapsed because nobody joined the files in time.

Renewal Radar joins them by name and puts one list in front of an account lead: what is already
overdue, what renews inside 45 days, and — just as importantly — what the join could not be trusted to
figure out on its own.

## What it does

- Loads both exports and resolves them into **clients**, not rows
- Picks the **current contract** per client when a brand has re-signed
- Shows **overdue** and **due within 45 days** as one action queue, most urgent first
- Explains **why** any two names were matched, with the score and the runners-up
- Refuses to guess: unusable dates and ambiguous matches become named, actionable data issues
- Runs entirely in the browser. No login, no server, no paid API, no LLM.

## Reading the app

| View | What it answers |
|------|-----------------|
| **Action queue** | What do I chase this week? |
| **All clients** | Where does every retainer sit? |
| **Needs review** | Which joins is the system unsure about? |
| **Data issues** | What is broken in the exports, and what do I do about it? |

Expand any row for the match evidence, the full contract history, and the delivery context.
The **Evaluate as of** control at the top re-runs every calculation against a different date.

---

## The rules, and why they are what they are

Every judgement call below is also asserted in the test suite, so the documented behaviour and the real
behaviour cannot drift apart.

### The 45-day window

```
daysToRenewal = renewalDate − asOfDate      (whole UTC calendar days)

days < 0                → overdue
0 ≤ days ≤ 45           → due          ← the radar
days > 45               → upcoming
no trustworthy date     → unknown, excluded
```

The window is **inclusive at both ends**. Day 0 ("renews today") and day 45 are both in the queue; day
46 is not. Dates are compared as UTC midnights so a lead in London and one in New York see the same
number. Tests pin −1, 0, 44, 45 and 46, and pin what happens when the as-of date moves.

> **Chosen:** overdue gets its own bucket above the window.
> **Why:** the product exists because two brands lapsed. A lapsed retainer sorted in with "outside the
> window" is the original failure, reproduced in software.
> **Alternative:** a single "next 45 days" list.
> **Why not:** it makes the worst case invisible.

### Re-signed clients

A brand that re-signs appears twice in the billing export. Both rows are real, and the earlier one still
has a renewal date that will scream at you.

Billing rows are grouped by normalized name into a client. The client's **current contract is the one
with the latest end date** — that is the one protecting the client furthest into the future, and it is
what an account lead should be planning around. Earlier contracts are marked `superseded`, kept in the
client record, and shown in the expanded row with the line number of the contract that replaced them.

In the sample data, Riverstone Outfitters' old contract ends in 3 days and the new one ends in 94. The
radar shows 94 days. **The 3-day row is not a renewal opportunity — it is already handled** — but it is
still there, one click away, with an audit trail.

> **Chosen:** latest end date wins.
> **Why:** renewal risk is about when coverage runs out.
> **Alternative:** latest start date, or last row in the file.
> **Why not:** last-row-wins depends on export order, and latest-start would pick a short contract that
> ends *before* one still running.

A contract with no usable end date can never displace a dated one, or a data problem would hide a real
renewal. And when two contracts for the same client cover overlapping dates, that is flagged as
`overlapping_contracts` rather than quietly resolved — it is equally the shape of a legitimate early
re-sign and the shape of double-billing, and only a person can tell which.

### Matching clients across the two files

Deterministic, five stages, no machine learning:

1. **Normalize** — lowercase, strip diacritics and punctuation, `&` → `and`, collapse equivalent legal
   suffixes (`Limited`→`ltd`, `Incorporated`→`inc`), drop trailing suffixes entirely so
   `Atlas Homewares LLC` = `Atlas Homewares`, then sort the tokens.
2. **Score** — Levenshtein distance normalized against the longer string, giving 0–1.
3. **Assign** — every candidate pair above the floor is sorted by score, best first, and assigned
   greedily. Deliberately *not* in file order: the result depends on the data, never on which row
   happens to be at the top of the export.
4. **Compare to the runner-up** — the winner has to beat second place by a clear margin.
5. **Classify** into one of five states.

| State | Rule | Behaviour |
|-------|------|-----------|
| `exact` | Normalized keys identical | Joined, no review |
| `strong` | ≥ 0.90 and ≥ 0.10 clear of runner-up | Joined, no review |
| `review` | ≥ 0.78, single plausible candidate | **Proposed**, flagged for confirmation |
| `ambiguous` | Two candidates within 0.10 of each other | **Not joined**, both candidates shown |
| `unmatched` | Nothing ≥ 0.78 | Not joined, raised as an issue |

The thresholds are calibrated against real cases rather than picked round: `Harbour Brew Co` ↔
`Harbor Brew` scores 92% and is accepted; `Ridgeway Outdoors` ↔ `Ridgeline Outdoors` scores 78% and is
rejected as the different brand it is.

> **Chosen:** the runner-up gap, not just the score.
> **Why:** score alone cannot tell you that a match is *unsafe*. `Marberry Home` is 92% similar to
> `Mayberry Home` and 85% similar to `Marbury Home`. A score-only system confidently picks the first
> and attaches the wrong brand's delivery history to a renewal decision. This one shows both and asks.
> **Alternative:** accept the top score above a threshold.
> **Why not:** it is wrong silently, which is the only kind of wrong that matters here.

> **Chosen:** no LLM.
> **Why:** three reasons, in order. It would make "why did these two names match?" unanswerable, and
> explainability is the entire point of the review states. It would need a paid API and a key, which
> the brief rules out. And it would be non-deterministic — the same two exports could join differently
> on Tuesday.
> **Alternative:** embeddings or an LLM judge for the hard cases.
> **Why not:** the hard cases are exactly where a human needs to see the evidence, not be handed
> another opaque verdict.

### Dates that cannot be trusted

Only unambiguous year-first formats are accepted (`2026-09-15`, `2026/09/15`). Everything else is
reported, never guessed:

| Cell | Result |
|------|--------|
| *(empty)* | `blank` |
| `2026-02-30` | `impossible` — the round-trip check catches it; JavaScript would silently roll it to 2 March |
| `30/04/2026` | `ambiguous_format` — day-first and month-first are indistinguishable for the first twelve days of any month |
| `TBC` | `unparseable` |

Any of these puts the client in the **unknown** bucket: excluded from the radar, listed as a *blocking*
data issue with the line number and the action required.

> **Chosen:** never infer a missing renewal date.
> **Why:** a three-month retainer starting 2026-04-01 "obviously" ends 2026-07-01 — but nothing in the
> brief supports that rule, and a guessed date looks exactly as actionable as a real one. Thirty
> seconds of someone's time is cheaper than a retainer lost to a confidently wrong date.
> **Alternative:** infer from `retainer_start + 3 months`.
> **Why not:** it would be right often enough to be trusted and wrong often enough to hurt.

### Malformed rows

A row with the wrong number of columns is **reported and still used**. A truncated export line is read
for what it has, with the missing values blank and a `malformed_row` issue naming the line. A row with
no client name cannot be joined at all, so it is dropped — and that drop is reported as *blocking*
rather than happening in silence.

---

## Sample data

Invented for this exercise: 22 billing rows and 23 project rows in
[`public/data/`](public/data/). Every row is there to demonstrate something, and
[`src/lib/sample-data.test.ts`](src/lib/sample-data.test.ts) asserts each case still holds — so the
demo cannot quietly lose its point.

| Case | In the data |
|------|-------------|
| Spelling difference | `Harbour Brew Co` ↔ `Harbor Brew` (92%, accepted) |
| Casing difference | `ACME SHOP` ↔ `Acme Shop` |
| Legal suffix, both directions | `Northwind Ltd` ↔ `Northwind Limited`; `Atlas Homewares` ↔ `Atlas Homewares LLC` |
| Missing end date | `Cedar & Co.` — blank cell |
| Impossible date | `Verity Skincare` — `2026-02-30` |
| Ambiguous date format | `Maple Row Studio` — `30/04/2026` |
| Re-sign, clean handover | `Riverstone Outfitters` — old ends the day the new one starts |
| Re-sign, overlapping | `Copperleaf Home` — new contract starts 50 days before the old one ends |
| Overdue | `Solstice Beauty` (−59 days), `Brightline Commerce` (−9) |
| Renews today | `Fernbrook Athletic` (0 days) |
| Exactly 45 days | `Atlas Homewares` — in the window |
| Exactly 46 days | `Kestrel Cycles Ltd` — out of it |
| Ambiguous match | `Marberry Home` vs `Mayberry Home` / `Marbury Home` |
| Match to confirm | `St. Ives Provisions` ↔ `Saint Ives Provisions` (86%) |
| Unmatched client | `Waverly Tea Co` — no project record |
| Unmatched project | `Tidewater Bakehouse` — no billing record |
| Duplicate project rows | `Riverstone Outfitters` — active and closed |
| Malformed row | `Nightjar Provisions` — missing its last column |
| Quoted field with a comma | `"Prior retainer, closed at re-sign"` |

The app is pinned to a demo date of **2026-08-29** so those boundary cases stay stable for reviewers.
Change it with the **Evaluate as of** control, or press **Today**.

---

## Testing

```bash
npm test
```

**103 tests** across four files. They target behaviour, not implementation:

- `normalize.test.ts` — casing, punctuation, diacritics, suffix collapsing, token order, and the
  suffixes we deliberately *don't* collapse (`Group` ≠ `Holdings`)
- `csv.test.ts` — every date failure mode, short/long/nameless rows, quoted commas, BOM, CRLF,
  currency-formatted fees, alternative header names, missing required columns
- `radar.test.ts` — the window boundaries (−1, 0, 44, 45, 46), moving the as-of date in both
  directions, re-sign handling including file-order independence, overlap detection, all five match
  states, and the assertion that every silently excluded client has an issue attached
- `sample-data.test.ts` — runs the shipped CSVs and asserts each demonstration case above still holds

Things worth knowing that the tests specifically prove:

- **The superseded Riverstone contract does not appear in the queue.** Direct regression test.
- **Reversing the row order in either file changes nothing.** Two tests, one per file.
- **Nothing is excluded silently.** Every `unknown` client is checked to have a matching data issue.

## Run it locally

```bash
npm install
npm run dev       # http://localhost:5173/harbourline-renewal-radar/
npm test
npm run build     # tsc + vite build
npm run preview   # serve the production build
```

## Architecture

```
src/lib/types.ts      domain model — dates, matches, contracts, clients, issues
src/lib/normalize.ts  name normalization, Levenshtein, thresholds
src/lib/csv.ts        parsing and date validation
src/lib/radar.ts      entity resolution, contract selection, windowing, issues
src/main.ts           rendering and interaction
```

`src/lib/` is pure, synchronous and DOM-free: same inputs, same outputs, every rule testable without a
browser. `main.ts` renders and nothing else. Deployed by GitHub Actions on push to `main`, which runs
the tests before it builds.

> **Chosen:** everything in the browser, no backend.
> **Why:** the inputs are two CSV files an account lead already has, and the whole computation is
> milliseconds. A server would add a login, a deployment, a place for client data to sit, and a thing
> to maintain — all against the brief's "no new logins".
> **Alternative:** a small API with stored uploads.
> **Why not:** it buys nothing here and costs the constraint.

> **Chosen:** GitHub Pages.
> **Why:** static hosting, free, no account for anyone to create, and the deploy is the same command as
> the build. Uploaded CSVs are read with the File API and never leave the browser.
> **Alternative:** Vercel or Netlify.
> **Why not:** no advantage for a static bundle, and one more service to sign into.

## Known limitations

- **Name matching has a ceiling.** It is the right tool for these two files, and the review states exist
  precisely because it cannot be made perfect. The real fix is a shared `client_id`, which is the point
  I raise in the Question 1 brief.
- **Review decisions are not persisted.** Confirming an ambiguous match is a judgement the app shows you
  how to make but has nowhere to store — that needs the backend this deliberately does not have.
- **Only year-first dates are accepted.** Adding a locale toggle would be easy; guessing would not be
  safe.
- **The fee at risk is a monthly figure**, not annualised contract value, because monthly fee is what
  the billing export actually contains.
- **No pagination.** At Harbourline's scale (~20 retainers) the full list is the right answer; a few
  hundred rows would need virtualisation.

## Licence

MIT
