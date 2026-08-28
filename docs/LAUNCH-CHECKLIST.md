> Kelly Online docs — [README](../README.md) · [MVP](MVP.md) · [PRD](PRD.md) · [SDD](SDD.md) · [Backlog](BACKLOG.md) · [Agile](AGILE.md) · [AI Safety & Data](AI-SAFETY-DATA.md) · [Kelly Ops](KELLY-OPS.md) · **Launch Checklist** · [Agent Rules](AGENTS.md)

# Kelly Online — Launch Checklist

## Product

- [ ] Home page clearly explains service.
- [ ] FAQ content reviewed for advice-free wording (procedural only: no entitlements, no time limits, no deadline claims).
- [ ] FAQ AI daily cap (`faq_ai_daily_max`) set for the environment.
- [ ] Public FAQ verified while signed out: no draft or members-only entry is reachable by list, deep link or search.
- [ ] Member can create account.
- [ ] Member can start a case on mobile.
- [ ] Member can upload supported document.
- [ ] AI produces useful structured intake.
- [ ] AI output shows sources.
- [ ] Member can request Kelly review.
- [ ] Kelly sees review queue.
- [ ] Kelly sees urgency reason.
- [ ] Kelly can message member.
- [ ] Kelly can keep private notes.
- [ ] Member sees action plan.
- [ ] Case can be closed/reopened.

## Safety

Requirements behind these items: [AI-SAFETY-DATA.md](AI-SAFETY-DATA.md).

- [ ] High-risk escalation rules implemented.
- [ ] Potential deadline cases visibly escalate.
- [ ] Speaking-up/patient-safety route implemented.
- [ ] Regulator/safeguarding scenarios tested.
- [ ] AI never fabricates citations in evaluation suite.
- [ ] Unsupported answer path is implemented.
- [ ] Human-review boundary is visible to users.
- [ ] AI kill switch tested.
- [ ] Prompt-injection document test passes.

## Privacy/data

- [ ] Privacy notice reviewed.
- [ ] AI transparency notice reviewed.
- [ ] Data map completed.
- [ ] Processor/subprocessor list recorded.
- [ ] DPIA/privacy-risk review completed.
- [ ] Retention policy defined.
- [ ] Deletion workflow defined.
- [ ] Private case data separated from global knowledge.
- [ ] No case text sent to product analytics.
- [ ] Patient-identifiable upload warning present.

## Security

- [ ] TLS.
- [ ] Kelly/admin MFA.
- [ ] RBAC tests.
- [ ] Cross-member access tests.
- [ ] Signed/private document URLs.
- [ ] Rate limiting.
- [ ] Secure sessions/cookies.
- [ ] Secrets outside repository.
- [ ] Dependency scan.
- [ ] Audit logging.
- [ ] Daily backups.
- [ ] Restore successfully tested.
- [ ] Production access list recorded.

## AI

- [ ] Provider configuration documented.
- [ ] Production data-use/retention settings approved.
- [ ] Prompt versions stored.
- [ ] Model versions stored.
- [ ] Retrieval traces stored.
- [ ] Structured-output validation.
- [ ] Evaluation suite run in CI/manual release gate.
- [ ] Low-confidence/no-source behaviour tested.
- [ ] Member-document prompt injection tested.

## Knowledge base

- [ ] Current NHS TCS source version ingested.
- [ ] Acas core disciplinary/grievance/time-limit sources ingested.
- [ ] NHS speaking-up source ingested.
- [ ] Source versioning works.
- [ ] Superseded source remains auditable.
- [ ] Trust policy can be stored privately/appropriately.
- [ ] Source review owner is assigned.

## Operations

- [ ] Kelly trained on dashboard.
- [ ] Kelly knows how to override AI urgency.
- [ ] Kelly knows how to report a bad AI answer.
- [ ] Support/incident contact defined.
- [ ] Member complaints route defined.
- [ ] Pilot member limit decided.
- [ ] Working hours/response expectations published.
- [ ] Out-of-scope/urgent-help messaging published.

## Pilot test

Run at least 20 synthetic or appropriately anonymised scenarios (drawn from the safety evaluation set in [AI-SAFETY-DATA.md](AI-SAFETY-DATA.md)).

- [ ] Simple policy question.
- [ ] HR letter.
- [ ] Disciplinary.
- [ ] Grievance.
- [ ] Bullying.
- [ ] Sickness absence.
- [ ] Reasonable adjustment.
- [ ] Flexible working.
- [ ] Pay.
- [ ] Banding — run one full band review through the dedicated section: wizard across two sessions, advisor factor confirmation, sign-off, member report, employer submission (range excluded), printed in dark mode.
- [ ] JE reference data verified: the seeded factor plan, level points, band boundaries and time-limit parameters checked against the current published NHS Job Evaluation Handbook and marked verified in Admin → Job evaluation (or replaced by a verified import).
- [ ] JE reference licensing position confirmed in writing (handbook-derived data and any imported national profiles).
- [ ] JE terms/transparency/privacy sections reviewed by a solicitor (indicative dates liability; regulated-activity check).
- [ ] Dismissal.
- [ ] Possible tribunal deadline.
- [ ] Speaking up.
- [ ] Patient safety.
- [ ] Regulator referral.
- [ ] Safeguarding.
- [ ] Conflicting policies.
- [ ] Outdated uploaded policy.
- [ ] Prompt injection.
- [ ] No relevant source found.

## Go / no-go

Pilot exit criteria are defined in [MVP.md](MVP.md).

Public pilot can begin only if:

- [ ] No known critical data-isolation defect.
- [ ] No known citation-fabrication defect.
- [ ] Critical escalation tests pass.
- [ ] Kelly accepts the workflow.
- [ ] Restore test passes.
- [ ] Production monitoring is active.
- [ ] Legal/privacy wording has appropriate professional review.

## First-week check

After first real users:

- [ ] Review every AI correction.
- [ ] Review every escalation.
- [ ] Interview Kelly about wasted clicks.
- [ ] Identify top missing knowledge sources.
- [ ] Inspect unresolved cases.
- [ ] Patch confusing intake questions.
- [ ] Re-run safety suite before material AI changes.
