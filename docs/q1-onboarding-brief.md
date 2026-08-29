# What Relay should do about client onboarding

**For:** Nadia · Harbourline Operations  ·  **From:** the Relay build  ·  Palm Outsourcing trial, Question 1

**What you told me:** nine manual steps across three people, about half a day per brand, the process
varies by person, things get missed, one brand went two weeks without store access, six more brands
next month.

**My reading of it:** the two-week gap is the tell. Nobody chose to leave that brand without access —
the process had no way to notice. That points at coordination rather than execution. I would confirm
it against real step timings, but if it holds, coordination is what to automate first.

**My position: Relay should own the sequence, the state and the chasing — not the clicking.** A bot
that drives Shopify's invite screen is the expensive part and the part that breaks quietly. The thing
that knows an invite has sat unaccepted for 48 hours is cheap and never breaks.

## 1. Relay versus a person

| Step | Relay does | A person does |
|------|-----------|---------------|
| Shopify + analytics access | Creates the task, records the invite, chases, escalates when stale | Sends and accepts the invite in the vendor UI |
| Folder, project board, kickoff doc | Creates them from approved templates | Writes the strategy content |
| Billing setup, contract filing | Holds the checklist, due dates, evidence links | Enters terms, signs, files |
| Kickoff call | Issues the scheduling link, tracks booked/not booked | Resolves calendar conflicts |
| Welcome email | Drafts from template, releases once prerequisites are met | Approves the send |

The line is drawn on **reversibility and authority**, not technical difficulty. Relay automates what is
templated, idempotent and cheap to undo. Credentials, legal commitments, money and the client's inbox
stay with a named person — not because a machine could not do it, but because when it goes wrong you
want someone who already knew they owned it.

## 2. What Relay tracks

Per **client**: canonical name, trading names, Shopify domain, and a `client_id` issued on day zero.
Per **run**: owner, start and target dates, status (`active | blocked | complete | cancelled`).
Per **step**: status (`pending | in_progress | waiting_external | waiting_human | done | failed |
waived`), assignee, due and completed times, attempt count, evidence URL, failure and waiver reasons.
Per **automation**: an idempotency key, so a retry cannot create a second folder or board.

The `waived` state and its mandatory reason are the part I would not drop. Without it people work
around the system rather than inside it, and the audit trail stops being true.

## 3. When a step fails mid-run

The run is **resumable**, never restarted. Relay:

1. Marks the step `failed` and pauses only its dependents — independent lanes keep going.
2. Keeps completed work. No destructive rollback of a folder or board that already exists.
3. Separates **retryable** (API timeout, rate limit) from **needs-a-person** (invite declined, contract
   unsigned). Retryable failures retry under the idempotency key; the rest get an owner and an SLA clock.
4. Escalates on SLA breach — the two-week access gap, caught on day two.
5. Resumes from the blocked step once fixed, or once someone waives it **and says why**.

A required step never silently becomes "done". It is completed, or the run stays open against a person
with a clock running.

## 4. What I would need to understand before building

Which of the nine steps have a usable API or template today — that alone decides whether Relay is an
orchestrator or a very good checklist. Who genuinely owns each step. Which steps are required versus
optional. The real dependency graph. And the client identity fields, because billing, projects and
renewals all need to join on them later.

## 5. Assumptions that break the build if wrong

1. **One linear checklist per brand.** Breaks on multi-store clients and phased SOWs.
2. **Drive / board / email APIs exist.** If not, Relay is checklist-plus-reminders — still valuable,
   but a different product.
3. **One accountable owner per step.** Breaks if pods need a shared queue.
4. **Client name is a stable join key.** The Question 2 exports show it is not. See §8.
5. **The process is sequential.** It is mostly parallel; a sequential model would make onboarding
   *slower* than doing it by hand.

## 6. First three questions for Nadia

1. **Which of the nine steps can Relay actually write into today?** → Decides whether we ship
   orchestration plus automation or orchestration only. Changes scope by weeks.
2. **Which steps are genuinely required, and what blocks what?** → Defines "complete" and the
   dependency gate. Without it Relay either blocks on optional work or lets brands reach kickoff
   without a signed contract.
3. **Who gets paged when access is still open after 48 hours — and is 48 hours right?** → Sets
   ownership, SLA and escalation. Without an answer Relay tracks the problem beautifully and nobody acts.

## 7. Flow diagram

See `onboarding-flow.png` (embedded in the submitted document).

## 8. The thing you did not ask about

**Harbourline has no durable client identity, and onboarding is where you could create one.**

**Established, from the Question 2 brief:** the billing and project exports share no client ID, and the
same client is spelled differently in each. Two brands lapsed because nobody noticed the renewal date.

**My inference — stated as inference:** I am *not* claiming name-matching caused those lapses; the
stated cause is that nobody was watching. But the missing shared key is what made the two files hard to
join when I built the Renewal Radar, and it is why the tool must show a confidence score and ask a
human to confirm some matches rather than just reporting the answer. A system that cannot reliably say
"this billing row and this project row are the same client" is a weaker early-warning system than one
that can.

**Why it belongs in onboarding:** it is the moment a client first exists, so it is the cheapest moment
to assign identity. If the run issues a `client_id` and captures the Shopify domain and the legal and
trading names on day zero, every downstream system inherits a real key. Otherwise you fuzzy-match names
indefinitely. Small addition to scope, large reduction in future pain — first version, not second.

---

**The strongest argument against my position:** if most of the nine steps have clean APIs, a more
aggressively automated Relay would beat mine on time saved and my human-gated boundary would look
over-cautious. I would accept that — with the caveat that the access gap reads to me as a *visibility*
failure rather than an automation one, so I would still build the state machine first and hang
automations off it. Better timings change the order, not the architecture.
