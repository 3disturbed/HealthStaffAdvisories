# Healthcare Advisory Services — Development Pack

## Mission

Get Kelly online quickly with a safe, useful service that helps NHS staff understand workplace issues, organise evidence and obtain human support when it matters.

The product is a **human-led employment-support platform enhanced by AI**.

AI should increase Kelly's capacity. It must not pretend to be Kelly, invent rights, silently make high-risk decisions, or become a barrier between a member and urgent human help.

## Product principle

> Ask → Understand → Prepare → Review → Act

The first production release only needs to make this loop excellent.

## MVP outcome

A member can:

1. Create an account.
2. Start a workplace case.
3. Explain what happened in ordinary language.
4. Upload relevant documents.
5. Receive a sourced, plain-English AI explanation.
6. See questions that still need answering.
7. See important dates and escalation warnings.
8. Request Kelly's review.
9. Receive Kelly's response/action plan in the portal.

Kelly can:

1. Sign in to a private advisor dashboard.
2. See urgent and recently updated cases.
3. Open a concise AI-prepared case brief.
4. Inspect the member's original words and documents.
5. See the sources used by the AI.
6. Correct the AI.
7. Request more information.
8. Send a reviewed response/action plan.
9. Change case status and priority.
10. Record private advisor notes.

## Explicitly NOT required for first launch

- Mobile apps.
- Multiple unions/organisations.
- White labelling.
- Automated representation booking.
- Complex CRM.
- Voice calls inside the platform.
- Fully automated grievance/appeal generation.
- Custom model training.
- Autonomous legal decisions.
- Large analytics dashboards.
- Trust-wide policy crawling.

Those are later iterations.

## Recommended launch stack

A deliberately conventional stack is recommended so a small team and coding agents can work quickly:

- **Frontend:** Next.js + TypeScript.
- **Backend:** Node.js + TypeScript.
- **Database:** PostgreSQL.
- **ORM:** Prisma or Drizzle.
- **Authentication:** mature managed auth or audited session-based auth.
- **File storage:** private S3-compatible object storage.
- **LLM:** provider adapter with retrieval-augmented generation (RAG); do not hard-wire business logic to one model.
- **Search/RAG:** PostgreSQL + pgvector is sufficient for MVP.
- **Background jobs:** simple database-backed queue initially.
- **Payments:** abstract behind a billing service; payments do not block pilot launch.
- **Hosting:** UK/EU-capable infrastructure with encrypted storage and backups.

## Documents in this pack

- `MVP.md` — exact first-release scope and acceptance criteria.
- `AGILE.md` — sprint workflow, roles, ceremonies and Definition of Done.
- `PRD.md` — product behaviour and user journeys.
- `SDD.md` — technical architecture and domain model.
- `BACKLOG.md` — prioritised epics and stories.
- `AI-SAFETY-DATA.md` — AI, privacy, security and escalation requirements.
- `KELLY-OPS.md` — how Kelly actually works inside the system.
- `LAUNCH-CHECKLIST.md` — production/pilot readiness checklist.
- `AGENTS.md` — rules for coding agents and contributors.

## First measurable success

Do not measure success by number of AI messages.

Measure:

- % of submitted cases that Kelly can understand without asking the member to retell the story.
- Median Kelly review time.
- % of AI claims with visible source support.
- Number of urgent cases correctly escalated.
- Member satisfaction after receiving an action plan.
- Cases resolved without requiring a live meeting.
- Kelly's weekly number of people meaningfully supported.

## Current authoritative source families

The knowledge library should be able to store, version and cite sources including:

- NHS Employers / NHS Terms and Conditions of Service Handbook.
- NHS England.
- Acas.
- GOV.UK legislation/guidance.
- Individual NHS Trust policies.
- Relevant professional regulator guidance.
- Member-provided contract and case documents.

Never treat source freshness as permanent. Every source should retain version/effective-date metadata where available.
