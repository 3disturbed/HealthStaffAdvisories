# AGENTS.md — Coding Agent Rules

## Mission

Build the smallest safe vertical slice that helps a real NHS staff member get useful support from Kelly.

Do not optimise for impressive architecture at the expense of shipping the case loop.

## Read first

Before implementation, read:

1. `README.md`
2. `MVP.md`
3. `AI-SAFETY-DATA.md`
4. `SDD.md`
5. relevant backlog story.

## Non-negotiable rules

### Privacy

- Never log case free text or document content.
- Never expose one member's case to another.
- Never place private case content into global knowledge.
- Never commit secrets.
- Never use production data in tests.

### AI

- Model output is untrusted.
- Validate structured outputs.
- Store prompt/model version.
- Preserve retrieval trace.
- Do not generate unsupported citations.
- Do not allow uploaded text to override system instructions.
- High-risk deadlines/escalations cannot rely only on the LLM.

### Architecture

- Prefer modular monolith.
- No microservice unless issue explicitly requires it.
- Business rules must be testable outside UI.
- Permissions must be checked server-side.
- Keep provider integrations behind adapters.

### UX

- Mobile first.
- Plain English.
- A member should not need to understand union/legal jargon to start.
- Kelly should see the important issue and date without scrolling through the entire chat.

## Change workflow

For every ticket:

1. State the acceptance criteria.
2. Identify data/safety impact.
3. Write/adjust tests.
4. Implement smallest change.
5. Run lint/typecheck/tests.
6. Verify permission boundary.
7. Update docs if behaviour changed.
8. Provide a short PR summary and test evidence.

## AI-change workflow

Every prompt/model/retrieval change requires:

- affected task name;
- reason;
- before/after evaluation;
- regressions noted;
- prompt version bump;
- safety scenario results.

## Database changes

Every migration must:

- be reviewed;
- avoid destructive production operations without plan;
- include rollback/forward-fix notes;
- consider derived embeddings/search records.

## Forbidden shortcuts

Do not:

- turn off tests to merge;
- store uploads in public buckets;
- use client-supplied role/organisation as authorization;
- return raw stack traces to users;
- use broad `SELECT *` case queries without permission scope;
- send full cases to the LLM by default;
- build billing before the core support loop works unless specifically prioritised;
- silently change a knowledge source already used in historical cases.

## Definition of a good agent PR

A reviewer can answer:

- What member/Kelly problem does this solve?
- How is access controlled?
- What sensitive data is touched?
- How was it tested?
- What happens on failure?
- If AI is involved, what evidence supports the output?
