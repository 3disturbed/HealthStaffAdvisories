# Agile Delivery Workflow

## Delivery philosophy

The project is urgent, but urgency is not permission to ship unsafe case handling.

Optimise for **vertical slices** that Kelly can actually use.

Avoid building all infrastructure first and integrating it at the end.

Each sprint should end with a demonstrable member-to-Kelly workflow.

## Cadence

Recommended during launch:

- One-week sprints.
- Daily asynchronous stand-up.
- 15-minute live blocker call only when needed.
- Weekly demo with Kelly.
- Weekly backlog refinement immediately after the demo.
- Production releases whenever a completed vertical slice passes the release gate.

## Roles

### Product Owner — Kelly

Kelly decides:

- what members actually need;
- what wording feels safe/useful;
- which cases should escalate;
- whether a workflow saves her time;
- release acceptance from the advisor perspective.

Kelly should not be expected to translate needs into technical tickets.

### Product/Delivery Lead

Owns:

- backlog;
- acceptance criteria;
- scope control;
- sprint goal;
- converting Kelly's feedback into tickets;
- stopping non-MVP work from entering the sprint.

### Technical Lead

Owns:

- architecture;
- security boundaries;
- review standards;
- migrations;
- deployment;
- technical risk.

### Developers / coding agents

Own:

- implementation;
- automated tests;
- documentation changes;
- small reviewable pull requests.

### Privacy/Safety reviewer

May initially be a named responsibility rather than a full-time person.

Must approve changes involving:

- sensitive data;
- AI prompts/policies;
- source retrieval;
- account permissions;
- high-risk escalation;
- retention/deletion;
- third-party processors.

## Board columns

1. Inbox.
2. Ready for refinement.
3. Ready.
4. In progress.
5. Code review.
6. Kelly review.
7. Release ready.
8. Done.
9. Blocked.

Limit `In progress` aggressively.

A two-developer team should normally have no more than 2–3 development stories in progress.

## Ticket format

Every story must contain:

### User story

As a [user], I want [capability], so that [outcome].

### Why now?

Why this is necessary for the launch loop.

### Acceptance criteria

Observable pass/fail behaviour.

### Safety/data impact

- None.
- Low.
- Sensitive.
- High-risk.

### Test cases

Happy path + failure/abuse/permission cases.

### Telemetry

What event or metric proves the feature is being used successfully.

## Definition of Ready

A ticket may enter a sprint only if:

- user outcome is clear;
- acceptance criteria exist;
- required design is available;
- dependencies are known;
- privacy/safety impact is labelled;
- ticket is small enough to complete in the sprint.

## Definition of Done

A story is Done only when:

- code merged;
- automated tests pass;
- permissions tested;
- mobile UX checked where relevant;
- error state exists;
- audit logging added where required;
- analytics event added where useful;
- documentation updated;
- no secrets in code/logs;
- AI changes have evaluation cases;
- deployed to staging;
- Kelly has accepted user-facing workflow when applicable.

## Pull request rules

- Prefer <500 changed lines when practical.
- One user outcome per PR.
- No drive-by refactors in launch-critical PRs.
- Database migration and rollback notes required.
- Security-sensitive PRs require human review.
- AI prompt changes require before/after evaluation results.
- Do not merge failing tests because "it works locally."

## Suggested launch sprints

### Sprint 0 — Foundation

Goal: deploy a secure skeleton.

Deliver:

- repo/CI;
- environments;
- database;
- auth;
- member/advisor roles;
- base design system;
- monitoring/logging;
- privacy-safe config;
- staging deployment.

Demo:

Member registers and Kelly sees the account exist without seeing another user's private data.

### Sprint 1 — Case loop

Goal: member creates a case; Kelly can review it.

Deliver:

- create case;
- case statuses;
- Kelly queue;
- case detail;
- member/advisor messaging;
- audit events.

Demo:

Member submits issue → Kelly opens case → asks question → member responds.

### Sprint 2 — Documents + AI intake

Goal: AI saves Kelly reading/triage time.

Deliver:

- document upload;
- extraction;
- timeline;
- structured AI summary;
- missing questions;
- basic RAG;
- citations/source panel.

Demo:

Upload a realistic HR letter and policy → Kelly receives useful sourced brief.

### Sprint 3 — Safety + pilot

Goal: safely support real pilot members.

Deliver:

- deterministic urgency rules;
- urgent queue;
- AI confidence/uncertainty;
- notifications;
- privacy/AI transparency UI;
- retention controls;
- backup/restore test;
- red-team/evaluation pack.

Demo:

Run 10 risky scenarios and show correct escalation.

### Sprint 4 — Monetisation

Goal: make continued operation financially sustainable.

Deliver:

- membership tiers;
- billing;
- entitlements;
- usage limits;
- account billing portal;
- operational dashboard.

Do not make Sprint 4 a precondition of a small controlled pilot if access can be managed manually.

## Sprint review questions for Kelly

Ask these every week:

1. Would this have saved you time on a real case?
2. What would make you distrust this screen?
3. What information is missing before you would contact the member?
4. What part is unnecessary?
5. Which case would be dangerous if the software got it wrong?
6. What did the AI phrase badly?
7. What should automatically become urgent?

## Product rule

If Kelly has to copy information from the platform into a separate notebook to do her job, the platform is missing a workflow.
