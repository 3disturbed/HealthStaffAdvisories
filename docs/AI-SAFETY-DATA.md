> Kelly Online docs — [README](../README.md) · [MVP](MVP.md) · [PRD](PRD.md) · [SDD](SDD.md) · [Backlog](BACKLOG.md) · [Agile](AGILE.md) · **AI Safety & Data** · [Kelly Ops](KELLY-OPS.md) · [Launch Checklist](LAUNCH-CHECKLIST.md) · [Agent Rules](AGENTS.md)

# AI, Safety, Privacy & Data Requirements

## Purpose

This document is an engineering specification, not a substitute for formal legal/privacy review.

The platform will handle highly sensitive employment case material. AI features therefore require stronger controls than an ordinary marketing chatbot.

## 1. AI product boundary

### AI may

- organise user-provided facts;
- summarise documents;
- explain retrieved guidance;
- suggest questions;
- build draft timelines;
- identify possible issues;
- draft communications for review;
- prepare a human advisor brief;
- re-rank existing human-approved FAQ answers by relevance, returning entry ids only.

### AI must not autonomously

- write, rewrite, summarise or correct a FAQ answer — FAQ search reorders adviser-written entries and never generates the prose a reader sees;
- decide whether a person has a valid legal claim;
- guarantee an outcome;
- decide representation eligibility in disputed/high-risk cases;
- close high-risk cases;
- send a formal response as Kelly without configured approval;
- fabricate a citation;
- replace urgent external assistance;
- infer missing sensitive facts as true.

## 2. Human-in-the-loop states

Every AI output should be tagged as one of:

- `informational_member_output`
- `candidate_extraction`
- `advisor_draft`
- `advisor_approved`
- `system_warning`

High-risk outputs should require advisor review before being represented as a case strategy.

## 3. Citation policy

A material factual/policy proposition produced from the knowledge base must be traceable.

If retrieval cannot support it:

- omit;
- ask for more information; or
- explicitly label as an unverified possibility.

Never generate fake section numbers.

## 4. Source hierarchy

Source authority is contextual, but UI should expose source classes:

1. legislation / official government source;
2. Acas / authoritative employment guidance;
3. NHS national terms/guidance;
4. regulator guidance;
5. employer/Trust policy;
6. member's contract;
7. member's evidence/account.

Local policy may describe procedure but cannot be treated as overriding higher authority merely because it is more specific.

## 5. Source freshness

Each knowledge version requires:

- fetched/added date;
- effective date where known;
- checksum;
- status;
- superseded link;
- reviewer.

Scheduled review should later detect changes.

Never silently overwrite a source version already cited in a historical case.

## 6. Deadline policy

Potential legal/employment deadlines are high risk. The implementing architecture is [SDD.md](SDD.md), "Deadline safety".

Rules:

- extract candidate dates;
- preserve quoted/source event;
- calculate only via tested deterministic functions where possible;
- label as potential and requiring verification;
- escalate where approaching/uncertain;
- never tell a member a deadline has definitely passed solely from probabilistic model output.

## 7. Prompt injection

Uploaded documents and retrieved web/source text are **untrusted data**.

The model must be instructed that document text cannot override system/application instructions.

Do not allow document content to:

- request secrets;
- alter permissions;
- alter tool access;
- instruct the system to contact another user;
- reclassify itself as authoritative.

## 8. Data minimisation

Do not collect:

- patient names/details unless genuinely required;
- unrelated family data;
- extensive demographic data "for analytics";
- documents unrelated to the case.

Provide member guidance to redact unnecessary patient-identifiable information before upload.

Consider an automated warning/redaction assistant as a later feature.

### FAQ search text

A member may type case free text into the FAQ search box ("my manager suspended
me after I raised..."). That text is sent to the provider for re-ranking and is
**never stored** — not in `ai_outputs`, not in a search log, not in audit
metadata. The cost is that there is no content-gap report; adding one would need
an explicit privacy decision and consent copy, not just a schema change. Search
is POST rather than GET for the same reason: a query string would reach proxy
access logs.

## 9. Special category / sensitive information

Cases can contain health, union-related and other highly sensitive personal data.

Engineering implications:

- strict access control;
- encryption;
- limited staff access;
- no case content in general analytics;
- careful vendor/subprocessor assessment;
- clear retention;
- data-processing records;
- DPIA/privacy risk assessment before public launch.

## 10. LLM provider rules

Provider integration must be isolated behind an adapter.

For each provider/model configuration record:

- data-use terms;
- retention setting;
- region if relevant;
- model;
- date approved;
- permitted data classes.

Production should use configurations where customer case material is not used for general model training.

Never send an entire case to an LLM when only two relevant paragraphs are needed.

## 11. Embeddings

Embeddings derived from private case content remain private case data.

Deletion/retention must cover:

- source object;
- extracted text;
- chunks;
- embeddings;
- caches.

No private case embedding may enter a shared cross-member index.

## 12. Permissions

`faq.manage` — write and publish FAQ answers and categories. Held by advisor and
admin by default. FAQ reads need no permission at all: the public questions page
is unauthenticated by design, and `faqScope()` decides what each caller sees
(anonymous -> published public only; signed in -> plus members-only; holders of
`faq.manage` -> plus drafts).


Member:

- own cases;
- own member-visible messages;
- own documents;
- own exports.

Advisor:

- assigned/authorised organisation cases;
- private notes;
- review functions.

Admin:

- minimum operational access;
- knowledge administration;
- no default expectation of browsing case contents.

Support access should be exceptional and audited.

## 13. Audit events

FAQ actions: `faq.category_created`, `faq.category_updated`,
`faq.category_deleted`, `faq.categories_reordered`, `faq.question_created`,
`faq.question_updated`, `faq.question_deleted`, `faq.question_published`,
`faq.question_unpublished`, `faq.questions_reordered`, `faq.index_rebuilt`,
`faq.seeded`. Their metadata carries ids, counts and changed field NAMES only —
never question or answer text, and not the derived slug either, since a slug
reproduces the author's wording. Reader interactions (view and helpful counters)
are not audited: one row per anonymous click is unbounded growth.

Log at minimum:

- login/security changes;
- case created;
- permission changes;
- document uploaded/deleted;
- advisor opened case where required by policy;
- private note created;
- AI analysis generated;
- advisor approved/sent AI-assisted text;
- escalation triggered/resolved;
- export;
- deletion request;
- admin action.

Audit logs should describe actions without duplicating sensitive narrative.

## 14. Safety evaluation set

These scenarios back the pilot test section of [LAUNCH-CHECKLIST.md](LAUNCH-CHECKLIST.md).

Before launch create synthetic scenarios covering:

- disciplinary invitation tomorrow;
- dismissal two months ago;
- long-running grievance;
- disability-related absence;
- pregnancy/family leave issue;
- bullying;
- alleged gross misconduct;
- patient safety speaking-up concern;
- regulator referral;
- safeguarding allegation;
- pay underpayment;
- banding dispute;
- band review (dedicated JE section): factor levels proposed only with verbatim evidence quotes; fabricated quotes dropped; no band/points in model prose (guard-validated); anti-anchoring (claimed band never reaches the level-proposal stage); paired fluent/plain and full-time/job-share fixtures produce identical levels;
- flexible working refusal;
- redundancy;
- conflicting Trust and national documents;
- outdated policy supplied by member;
- malicious prompt inside uploaded PDF;
- member asks AI to invent evidence;
- member uploads another person's records;
- no useful source found.

For every scenario score:

- classification;
- escalation;
- factual extraction;
- citation support;
- uncertainty;
- member wording;
- advisor brief quality.

## 15. AI incident response

Admin must be able to:

- disable one AI task;
- disable all generation;
- preserve case messaging;
- inspect affected prompt/model/version;
- identify outputs generated during time window;
- mark source/version invalid;
- notify users if required by incident procedure.

## 16. Current regulatory/source maintenance note

As of the initial 2026 development baseline:

- NHS Terms and Conditions sources change over time and must be versioned.
- Acas employment tribunal guidance warns of strict time limits, commonly three months minus one day for many claims.
- NHS Freedom to Speak Up responsibilities changed from 1 July 2026.
- ICO AI/data-protection guidance and risk resources should be included in the project's privacy governance review.

The engineering team should re-check these sources before each public release that changes relevant advice logic.
