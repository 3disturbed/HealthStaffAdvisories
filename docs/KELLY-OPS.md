> Kelly Online docs — [README](../README.md) · [MVP](MVP.md) · [PRD](PRD.md) · [SDD](SDD.md) · [Backlog](BACKLOG.md) · [Agile](AGILE.md) · [AI Safety & Data](AI-SAFETY-DATA.md) · **Kelly Ops** · [Launch Checklist](LAUNCH-CHECKLIST.md) · [Agent Rules](AGENTS.md)

# Kelly Operations Manual — MVP

## Goal

Kelly should begin each work session knowing exactly which people need her attention first.

The portal exists to remove triage/admin work, not create another inbox.

## Daily start

Open `Advisor Dashboard`.

Work in this order:

1. Urgent.
2. Important date within 7 days.
3. Awaiting Kelly review.
4. Member replied.
5. Oldest unresolved cases.

## Opening a case

Kelly should read in this order:

1. `Why this is urgent`.
2. `Member wants`.
3. AI case brief.
4. Timeline.
5. Source panel.
6. Important original evidence.
7. Full conversation only if necessary.

If Kelly routinely needs to start at step 7, the AI brief is failing and should be improved.

## Case statuses

Member-facing status language is defined in [PRD.md](PRD.md) (member dashboard).

### Gathering information

AI/member intake underway.

### Waiting for Kelly

Member believes enough information has been provided.

### Kelly reviewing

Kelly has taken ownership.

### Need information from member

Specific questions outstanding.

### Action plan ready

Kelly has provided advice/next steps.

### Ongoing support

Issue remains active and needs follow-up.

### Closed

No active action.

Closed is reversible.

## Urgency levels

### Critical

Immediate or very near-term action; high-risk matter.

### High

Important formal process/date or serious issue.

### Normal

Requires review but no known immediate date.

### Self-service

Information can presently be handled without human intervention, but member can request review subject to tier/eligibility.

AI can propose urgency.

Deterministic rules can create urgency.

Kelly has final operational control.

## Kelly response structure

The portal editor should encourage:

### What I understand

Short factual summary.

### What matters

Most important policy/process concerns.

### What to do now

Concrete actions.

### What I need from you

Missing documents/questions.

### Important dates

Clearly separated.

### Sources

Links/references where useful.

## Private notes

Private notes are for:

- strategy;
- internal concerns;
- eligibility;
- follow-up reminders;
- representation preparation.

Never assume a private note is disposable gossip. Write as though it may later need to be audited/disclosed according to applicable obligations.

## AI correction

Kelly should be able to mark:

- wrong fact;
- wrong date;
- wrong case classification;
- bad source;
- missing issue;
- unsafe wording;
- poor question.

Corrections go into an evaluation queue.

They must not automatically train or alter production behaviour.

## Escalation

The product should allow Kelly to create custom escalation reasons.

Examples:

- urgent deadline;
- formal hearing;
- member at risk of dismissal;
- possible discrimination;
- speaking up;
- regulator;
- safeguarding;
- external specialist advice needed.

## Capacity protection

Do not make Kelly personally answer every AI chat.

Member AI conversations should enter Kelly's workload only when:

- member requests review;
- entitlement requires review;
- escalation rule triggers;
- AI cannot safely answer;
- a configured case milestone requires human review.

## Templates

After pilot, capture the responses Kelly writes repeatedly.

Templates should be:

- editable;
- versioned;
- optionally case-type specific;
- never automatically sent merely because a case matches.

## Weekly review

Once per week review:

- number of new cases;
- number resolved;
- median first review time;
- urgent cases;
- cases older than target;
- most common case types;
- AI corrections;
- sources Kelly had to find manually;
- questions members repeatedly misunderstood.

Those observations become the next sprint's product evidence (see [AGILE.md](AGILE.md), sprint review questions).
