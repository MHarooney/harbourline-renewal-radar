# What Relay should do about client onboarding

**For:** Nadia · Harbourline Operations  ·  **From:** the Relay build  ·  **Length:** 2 pages

**What you told me:** nine manual steps across three people, about half a day per brand, the process
varies by person, things get missed, one brand went two weeks without store access, and six more
brands arrive next month.

**My reading of it:** the two-week gap is the tell. Nobody chose to leave that brand without access —
the process simply had no way to notice. That points at coordination, not execution: who has done
what, what is waiting on what, and who finds out when nothing has moved. I would want to confirm that
against the real step timings, but if it holds, coordination is what to automate first.

My position: **Relay should own the sequence, the state and the chasing — not the clicking.** Building
a bot that drives Shopify's invite screen is the expensive part and the part that breaks quietly;
building the thing that knows a Shopify invite has been sitting unaccepted for 48 hours is cheap and
never breaks.

## 1. Relay versus a person

| Step | Relay does | A person does |
|------|-----------|---------------|
| Shopify + analytics access | Creates the task, records the invite, chases it, escalates when stale | Sends and accepts the invite in the vendor UI |
| Folder structure, project board, kickoff doc | Creates them from approved templates | Writes the strategy content |
| Billing setup, contract filing | Holds the checklist, due dates and evidence links | Enters terms, signs, files |
| Kickoff call | Issues the scheduling link, tracks booked/not booked | Resolves the awkward calendar conflicts |
| Welcome email | Drafts from template, releases only once prerequisites are met | Approves the send |

The line is drawn on **reversibility and authority**, not on technical difficulty. Relay automates work
that is templated, idempotent and cheap to undo. Anything touching credentials, legal commitments,
money, or a client's inbox stays with a named person — not because a machine could not do it, but
because when it goes wrong at 6pm on a Friday you want a person who already knew they owned it.

## 2. What Relay tracks

Per **client**: canonical name, trading names, Shopify domain, and a `client_id` issued on day zero.
Per **run**: owner, start and target dates, status (`active | blocked | complete | cancelled`).
Per **step**: status (`pending | in_progress | waiting_external | waiting_human | done | failed | waived`),
assignee, due and completed times, attempt count, evidence URL, failure reason, waiver reason.
Per **automation**: an idempotency key, so a retry cannot create a second folder or a second board.

The step-level `waived` state and its mandatory reason are the part I would not drop. Without it, people
work around the system instead of inside it, and the audit trail stops being true.

## 3. When a step fails mid-run

The run is **resumable**, never restarted. On failure Relay:

1. Marks the step `failed` and pauses only the steps that depend on it — independent lanes keep going.
2. Keeps completed work. No destructive rollback of a folder or board that already exists.
3. Separates **retryable** (API timeout, rate limit) from **needs-a-person** (invite declined, contract
   unsigned). Retryable failures retry automatically under the idempotency key; the rest get an owner
   and an SLA clock.
4. Escalates on SLA breach. This is the two-week access gap, caught on day two.
5. Resumes from the blocked step once it is fixed — or once someone waives it **and says why**.

A required step never silently becomes "done". It is completed, or the run stays open against a person
with a clock running.

## 4. What I would need to understand before building

Which of the nine steps have a usable API or template today (that alone decides whether Relay is an
orchestrator or a very good checklist); who genuinely owns each step; which steps are required versus
nice-to-have; the real dependency graph; and the client identity fields, because billing, projects and
renewals will all need to join on them later.

## 5. Assumptions that break the build if they are wrong

1. **One linear checklist per brand.** Breaks on multi-store clients and phased SOWs.
2. **Drive / board / email APIs are available.** If not, Relay is checklist-plus-reminders — still
   valuable, but a different product.
3. **One accountable owner per step.** Breaks if pods need a shared queue instead.
4. **The client name is a stable join key.** The Question 2 exports show it is not. See §8.
5. **The process is sequential.** It is mostly parallel; a sequential model would make onboarding
   *slower* than the manual version.

## 6. First three questions for Nadia

1. **Which of the nine steps can Relay actually write into today?** → Decides whether we ship
   orchestration plus automation, or orchestration only. It changes the scope by weeks.
2. **Which steps are genuinely required, and what blocks what?** → Defines "complete" and the
   dependency gate. Without it, Relay either blocks on optional work or lets brands reach kickoff
   without a signed contract.
3. **Who gets paged when Shopify access is still open after 48 hours — and is 48 hours the right
   number?** → Sets ownership, the SLA and the escalation path. Without an answer, Relay tracks the
   problem beautifully and still nobody acts.

## 7. Flow diagram

See `onboarding-flow.png`.

## 8. The thing you did not ask about

**Harbourline has no durable client identity, and onboarding is where you could create one.**

This is the one place I would push back on the scope you set, so I want to be precise about what is
established and what is my inference.

**Established, from the Question 2 brief:** the billing export and the project export share no client
ID, and the same client is spelled differently in each. Two brands lapsed because nobody noticed the
renewal date.

**My inference:** those are two symptoms of the same gap. The stated cause of the lapses is that
nobody was watching — I am not claiming name-matching caused them. But building the Renewal Radar, the
absence of a shared key is what made the two files hard to join at all, and it is why the tool has to
show a confidence score and ask a human to confirm some matches instead of simply reporting the
answer. A system that cannot reliably say "this billing row and this project row are the same client"
is a weaker early-warning system than one that can, whatever the immediate cause of any given miss.

**Why it belongs in onboarding:** it is the moment a client first exists, so it is the cheapest moment
to assign identity. If the onboarding run issues a `client_id` and captures the Shopify domain and the
legal and trading names on day zero, every downstream system inherits a real key. If it does not, you
will be fuzzy-matching names indefinitely and accepting whatever error rate comes with that.

Small addition to the onboarding scope, large reduction in future pain. I would put it in the first
version rather than the second.

---

**The strongest argument against my position:** if most of the nine steps turn out to have clean APIs,
then a more aggressively automated Relay would beat mine on raw time saved, and my human-gated
boundary would look overly cautious. I would accept that — with the caveat that the two-week access
gap reads to me as a *visibility* failure rather than an automation one, so I would still build the
state machine first and add automations onto it, rather than the other way round. If the step timings
say otherwise, that changes the order, not the architecture.
