# Kelly Online — Healthcare Advisory Services

Kelly Online is a **human-led employment-support platform for NHS staff, enhanced by AI**. Members explain a workplace issue in ordinary language, upload their documents, and receive a sourced, plain-English explanation prepared by AI — then Kelly, the human advisor, reviews the prepared case and responds with an action plan. AI exists to increase Kelly's capacity: it must not pretend to be Kelly, invent rights, silently make high-risk decisions, or become a barrier between a member and urgent human help.

## Mission

Get Kelly online quickly with a safe, useful service that helps NHS staff understand workplace issues, organise evidence and obtain human support when it matters.

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

Full scope and acceptance criteria: [docs/MVP.md](docs/MVP.md).

## Tech stack (as built)

- **Runtime:** Node.js 22.13+ with Express.
- **Database:** SQLite via the built-in `node:sqlite` module (no native build step), with full-text search (FTS5) for retrieval.
- **Frontend:** vanilla HTML5/CSS/JS, mobile-first, served from `public/`.
- **Provider adapters:**
  - **LLM:** OpenAI, configured entirely from the Admin area (API key and model are stored in application settings — no key in code or `.env`). Until a key is saved, AI intake is off and the case loop still works.
  - **Email:** dev mailbox in development; SMTP-ready.
  - **File storage:** private local directory; S3-ready.

This deviates from the original Next.js + PostgreSQL recommendation as a **deliberate MVP decision** for speed and zero-config local development. The module boundaries in [docs/SDD.md](docs/SDD.md) are preserved, so a later PostgreSQL/managed-auth migration stays possible.

## Getting started

```bash
npm install
npm run dev     # app at http://localhost:3000
npm test        # run the test suite
```

- The main administration account is **mapadocrew@gmail.com** (seeded on first run). It can grant and remove roles/permissions for all other accounts from the Admin area.
- Secrets and configuration live in `.env` (never committed).
- The OpenAI API key is entered by an administrator in **Admin → Settings** after first sign-in; AI intake stays off until then, and the member ↔ Kelly case loop works either way.

## Documentation

| Document | Description |
| --- | --- |
| [docs/MVP.md](docs/MVP.md) | Exact first-release scope: pilot must-haves, acceptance criteria, later releases and pilot exit criteria. |
| [docs/PRD.md](docs/PRD.md) | Product behaviour: member journeys, dashboards, case brief schema, knowledge-source management, non-functional requirements. |
| [docs/SDD.md](docs/SDD.md) | Technical architecture: modular monolith modules, domain model, document pipeline, RAG, AI orchestration, security and deployment. |
| [docs/BACKLOG.md](docs/BACKLOG.md) | Prioritised epics and stories (P0–P3) plus the first 20 engineering tickets. |
| [docs/AGILE.md](docs/AGILE.md) | Sprint workflow, roles, ceremonies, Definition of Ready/Done and the suggested launch sprints. |
| [docs/AI-SAFETY-DATA.md](docs/AI-SAFETY-DATA.md) | AI boundaries, citation and deadline policy, prompt-injection defence, privacy, data minimisation and the safety evaluation set. |
| [docs/KELLY-OPS.md](docs/KELLY-OPS.md) | How Kelly actually works inside the system: daily triage order, statuses, urgency levels, response structure, corrections. |
| [docs/LAUNCH-CHECKLIST.md](docs/LAUNCH-CHECKLIST.md) | Production/pilot readiness checklist: product, safety, privacy, security, AI, knowledge base, operations and go/no-go. |
| [docs/AGENTS.md](docs/AGENTS.md) | Rules for coding agents and contributors: non-negotiables, change workflows, forbidden shortcuts. |

## Explicitly NOT required for first launch

Mobile apps; multiple unions/organisations; white labelling; automated representation booking; complex CRM; voice calls inside the platform; fully automated grievance/appeal generation; custom model training; autonomous legal decisions; large analytics dashboards; Trust-wide policy crawling.

Those are later iterations.

## First measurable success

Do not measure success by number of AI messages. Measure:

- % of submitted cases that Kelly can understand without asking the member to retell the story.
- Median Kelly review time.
- % of AI claims with visible source support.
- Number of urgent cases correctly escalated.
- Member satisfaction after receiving an action plan.
- Cases resolved without requiring a live meeting.
- Kelly's weekly number of people meaningfully supported.

## Current authoritative source families

The knowledge library should be able to store, version and cite sources including: NHS Employers / NHS Terms and Conditions of Service Handbook; NHS England; Acas; GOV.UK legislation/guidance; individual NHS Trust policies; relevant professional regulator guidance; member-provided contract and case documents.

Never treat source freshness as permanent. Every source should retain version/effective-date metadata where available.

## Contributing / ways of working

Work runs in weekly vertical slices — see [docs/AGILE.md](docs/AGILE.md) for the sprint workflow, roles and Definition of Done. All contributors and coding agents must follow the non-negotiable rules in [docs/AGENTS.md](docs/AGENTS.md) before writing any code.
