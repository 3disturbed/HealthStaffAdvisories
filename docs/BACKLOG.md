> Kelly Online docs — [README](../README.md) · [MVP](MVP.md) · [PRD](PRD.md) · [SDD](SDD.md) · **Backlog** · [Agile](AGILE.md) · [AI Safety & Data](AI-SAFETY-DATA.md) · [Kelly Ops](KELLY-OPS.md) · [Launch Checklist](LAUNCH-CHECKLIST.md) · [Agent Rules](AGENTS.md)

# Prioritised Product Backlog

Epics feed the suggested launch sprints in [AGILE.md](AGILE.md); pilot scope is defined in [MVP.md](MVP.md).

Priority:

- **P0** required for private pilot.
- **P1** required soon after pilot.
- **P2** scale/optimisation.
- **P3** future.

## EPIC A — Identity & trust

### A1 — Member registration — P0

As an NHS worker, I can create a secure account so my cases are private.

Acceptance:

- verified email;
- secure session;
- logout;
- recovery;
- rate limits.

### A2 — Advisor MFA — P0

As Kelly, I can protect advisor access with MFA.

### A3 — Role permissions — P0

Member cannot access advisor-only routes/notes or another member's records.

Automated permission tests mandatory.

## EPIC B — Casework

### B1 — Start case — P0

Member can submit free-text problem and minimal context.

### B2 — Case status — P0

Member and Kelly see appropriate status.

### B3 — Case conversation — P0

Member and Kelly can exchange messages within case.

### B4 — Private advisor notes — P0

Kelly can record notes never visible to member.

### B5 — Desired outcome — P0

Capture what the member wants to happen.

### B6 — Case export — P1

Member/authorized advisor can generate an export.

## EPIC C — Advisor workflow

### C1 — Kelly queue — P0

Sort urgent first, then deadlines, then age.

### C2 — One-screen brief — P0

Kelly sees concise summary, timeline, issues, missing facts, sources.

### C3 — Request information — P0

Kelly sends question and case becomes `waiting_for_member`.

### C4 — Reviewed answer — P0

Kelly edits/approves response and sends.

### C5 — Response templates — P1

Kelly can create reusable snippets/templates.

## EPIC D — Documents

### D1 — Secure upload — P0

PDF/DOCX/TXT supported.

### D2 — Text extraction — P0

Extracted content visible to authorised users.

### D3 — Case attachment — P0

Uploaded document linked only to intended case.

### D4 — AI document explanation — P0

AI produces plain-English explanation with document references.

### D5 — Image/OCR support — P1

Only after reliability evaluation.

## EPIC E — AI intake

### E1 — Topic classification — P0

Structured case categories.

### E2 — Missing questions — P0

AI asks short, relevant follow-ups.

### E3 — Timeline extraction — P0

Candidate dates/events with evidence references.

### E4 — Advisor brief — P0

AI generates standard schema.

### E5 — Member explanation — P0

Plain English + sources + uncertainty.

### E6 — Correct AI — P0

Kelly can correct key extracted facts.

### E7 — Learn from corrections operationally — P1

Corrections become evaluation cases, not automatic model training.

## EPIC F — Knowledge

### F1 — Global source ingestion — P0

Admin can ingest approved source.

### F2 — Source versioning — P0

Superseded versions retained/auditable.

### F3 — Citations — P0

Material AI claims can link to retrieved chunks.

### F4 — Trust policy upload — P0/P1

Kelly can add an approved local policy.

### F5 — Source freshness queue — P1

Sources become due for review.

### F6 — Automated source-change monitor — P2

Detect likely external revisions for human review.

## EPIC G — Safety

Requirements for this epic are specified in [AI-SAFETY-DATA.md](AI-SAFETY-DATA.md).

### G1 — Urgency rules engine — P0

Deterministic high-risk rules.

### G2 — Tribunal/date warning — P0

Potential time-sensitive employment events are escalated and labelled for verification.

### G3 — Speaking-up pathway — P0

Patient safety/whistleblowing issues receive distinct handling.

### G4 — Regulator/safeguarding pathway — P0

Clear escalation, no autonomous advice.

### G5 — AI uncertainty — P0

Low source coverage is visible.

### G6 — Incident kill switch — P0

Admin can disable AI generation while keeping case portal available.

## EPIC H — Privacy/security

### H1 — Audit log — P0
### H2 — Signed file access — P0
### H3 — Sensitive log filtering — P0
### H4 — Backup/restore — P0
### H5 — Data export/deletion workflow — P0/P1
### H6 — Retention scheduler — P1
### H7 — Admin security events — P1

## EPIC I — Notifications

### I1 — Kelly urgent-case notification — P0
### I2 — Member reply notification — P0
### I3 — Missing-information reminder — P0/P1
### I4 — Deadline reminders — P1

## EPIC J — Commercial

### J1 — Configurable tiers — P1
### J2 — Subscription billing — P1
### J3 — Entitlements — P1
### J4 — Usage dashboard — P1
### J5 — Qualifying-period rules — P1
### J6 — Discount/coupon/admin comp access — P1

## EPIC K — SaaS

### K1 — Multi-tenant isolation — P2
### K2 — Additional advisor seats — P2
### K3 — Organisation knowledge space — P2
### K4 — White label — P3
### K5 — Organisation analytics — P3

## First 20 engineering tickets

1. Repository, CI and environment bootstrapping.
2. PostgreSQL schema + migration workflow.
3. User auth.
4. Member/advisor RBAC.
5. Case create/read/update.
6. Advisor queue.
7. Case messaging.
8. Private advisor notes.
9. Audit event framework.
10. Secure file upload.
11. Text extraction pipeline.
12. Knowledge source/version tables.
13. Source ingestion.
14. pgvector retrieval.
15. AI provider adapter.
16. Structured case-intake job.
17. Citation/retrieval trace.
18. Urgency rules engine.
19. Email notifications.
20. Pilot evaluation suite.

## Backlog rule

Anything that does not improve the end-to-end member → Kelly → action loop must justify why it is being built before the pilot.
