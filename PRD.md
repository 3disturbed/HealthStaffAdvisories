# Product Requirements Document

## Product

Healthcare Advisory Services portal.

## Primary user

NHS staff member seeking workplace support.

## Operational user

Kelly, initially the principal human advisor/representative.

## Problem

Workers often arrive with an unstructured story, scattered correspondence, unknown deadlines and anxiety about what management is doing.

The advisor spends substantial time:

- eliciting basic facts;
- reading repetitive documents;
- finding relevant policy;
- organising dates;
- explaining common processes;
- chasing missing information;
- rewriting similar communications.

This limits the number of people one experienced advisor can support.

## Product promise

> Tell us what happened. We'll help you understand it, organise it and work out what to do next — with human support available when it matters.

## Principles

### 1. Member language, not policy language

Members should describe the problem naturally.

### 2. Sources before confidence

The platform should prefer "I cannot support that from the available sources" to invented certainty.

### 3. Human escalation is a feature

Escalation is success, not AI failure.

### 4. Show the work product, not model internals

Expose sources, extracted facts, uncertainties and actions. Do not expose private model chain-of-thought.

### 5. Preserve originals

AI summaries never replace original messages/documents.

### 6. One case, one story

All relevant communication, documents, chronology and actions should live in the case.

## Core member journey

### Journey A — "I got this letter"

1. Member opens dashboard.
2. Selects `I've received a letter`.
3. Uploads letter.
4. AI extracts:
   - sender;
   - date;
   - meeting date;
   - topic;
   - requested actions.
5. Member confirms/corrects facts.
6. AI asks only necessary missing questions.
7. RAG retrieves national/local sources.
8. Member receives:
   - plain-English explanation;
   - important dates;
   - questions to consider;
   - source links;
   - human-review recommendation.
9. Member requests Kelly review.
10. Kelly receives prepared brief.

### Journey B — "Something has been going on for months"

1. Member narrates issue.
2. AI progressively structures people/events/dates.
3. Member uploads evidence.
4. Timeline is built.
5. Conflicts/missing evidence are shown.
6. Likely routes are explained.
7. Kelly reviews if requested/escalated.

### Journey C — Urgent case

1. Member states event.
2. Deterministic or AI detector identifies urgent trigger.
3. UI displays explicit urgency notice.
4. Case enters urgent queue.
5. Member is told not to rely on the portal alone where external urgent action may be required.
6. Kelly is notified.

## Member dashboard

Top area:

- `Start a case`.
- `Ask about an existing case`.

Cases:

- title;
- issue;
- status;
- last update;
- next date;
- action needed from member.

Status language should be human:

- Gathering information.
- Waiting for Kelly.
- Kelly reviewing.
- Need information from you.
- Action plan ready.
- Ongoing support.
- Closed.

## Kelly dashboard

Primary sort:

1. urgency;
2. next deadline;
3. awaiting Kelly;
4. age.

Kelly must be able to quickly answer:

- Why is this urgent?
- What does the member want?
- What happened?
- What evidence exists?
- What does the employer say?
- What policy appears relevant?
- What is still unknown?
- What should I do next?

## Case brief schema

### Header

- member;
- employer;
- employment type/group;
- case type;
- desired outcome;
- urgency;
- next important date.

### Summary

Maximum ~250 words by default.

### Timeline

Each event:

- date/time;
- event;
- evidence source;
- confidence;
- member-confirmed yes/no.

### Key issues

Issue + supporting evidence + source guidance.

### Missing information

Questions ordered by importance.

### Sources

Cited, versioned retrieval results.

### Suggested actions

Separated into:

- member can do now;
- Kelly review;
- potentially external/urgent.

## Knowledge-source management

Every source record should contain:

- title;
- publisher;
- jurisdiction;
- source type;
- URL or uploaded original;
- effective date;
- superseded date;
- version;
- ingestion date;
- review status;
- reviewer;
- text chunks;
- checksum.

A superseded source remains auditable but must not be preferred for new answers unless the question concerns the historical period.

## Access tiers

Build entitlements generically.

Example capabilities:

- `ai_questions_monthly`
- `active_cases`
- `document_analysis`
- `kelly_review_requests`
- `priority_review`
- `meeting_preparation`
- `representation_eligibility`

Do not hard-code pricing into business logic.

## Non-functional requirements

### Performance

- Normal portal page <2s target on typical UK mobile connection.
- AI workflows may stream progress/results.
- Case page should not reprocess all documents on every load.

### Accessibility

Aim for WCAG 2.2 AA.

### Availability

Pilot target can be modest, but case data must not depend on ephemeral application storage.

### Auditability

Sensitive changes must record actor, timestamp and relevant object.

### Portability

Members should be able to receive a usable case export.

## Product analytics

Track events without recording sensitive free text in analytics platforms.

Examples:

- case_created;
- document_uploaded;
- ai_intake_completed;
- escalation_triggered;
- kelly_review_requested;
- advisor_response_sent;
- case_closed.

Never put case narrative, diagnoses, allegations or document text into third-party product analytics.
