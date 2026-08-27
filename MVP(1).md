# MVP — Kelly Online

## Objective

Ship the smallest safe system that allows Kelly to support substantially more NHS staff than she can through ad-hoc messages, email and manually organised documents.

## Release 0 — Private pilot

### Must have

#### 1. Public website

Pages:

- Home.
- How it works.
- What we can help with.
- Pricing / pilot access.
- Sign in / create account.
- Privacy notice.
- Terms of service.
- AI transparency statement.
- Emergency / out-of-scope notice.
- Contact.

Acceptance:

- Site works on phone first.
- Visitors can understand within 10 seconds that this is NHS workplace support.
- Site clearly distinguishes AI assistance from human review.
- No claim is made that AI output is guaranteed legal advice.

#### 2. Member accounts

Member can:

- Register.
- Verify email.
- Sign in/out.
- Reset access.
- View own cases only.
- Export or request deletion of account/case data subject to lawful retention obligations.

Acceptance:

- Cross-account case access is impossible in automated tests.
- Session expiry and revocation work.
- Sensitive actions are auditable.

#### 3. Create a case

Required first-step fields should stay small:

- What happened?
- Employer / NHS organisation.
- Employment group / role type.
- Has anything already happened formally?
- Is there a meeting/hearing/deadline?
- Optional document upload.

Then conversational intake collects more detail.

Case types can initially be broad:

- Disciplinary/investigation.
- Grievance/bullying/harassment.
- Sickness/absence/adjustments.
- Pay/banding/hours/leave.
- Flexible working/family leave.
- Speaking up/patient safety.
- Contract/employment status.
- Dismissal/redundancy.
- Other.

#### 4. Document upload

MVP formats:

- PDF.
- DOCX.
- TXT.
- Common images only if text extraction is reliable.

Requirements:

- Private storage.
- Malware/file-type validation.
- Size limits.
- Original retained.
- Extracted text stored separately.
- Document ownership enforced.
- Member warned not to upload unnecessary patient-identifiable information.
- AI must identify which document a statement came from.

#### 5. AI case intake

AI should:

- Summarise the member's issue.
- Ask focused missing questions.
- Extract dates/events.
- Identify likely topic classifications.
- Identify potentially urgent dates.
- Retrieve relevant approved sources.
- Produce a member-facing explanation.
- Produce a Kelly-facing case brief.

AI should NOT:

- claim certainty where sources conflict;
- invent legislation, policy clauses or citations;
- hide uncertainty;
- tell a member that human help is unnecessary in a high-risk case;
- silently close a case;
- make a binding eligibility/representation decision.

#### 6. Source-backed answers

Every material policy/right statement should have:

- source title;
- source publisher/owner;
- relevant section/chunk;
- source date/version where known;
- link or stored source reference;
- retrieval timestamp.

The UI should visually distinguish:

- member evidence;
- Trust/local policy;
- national NHS guidance;
- Acas/GOV.UK/other authoritative guidance;
- AI interpretation.

#### 7. Urgency engine

The system must support deterministic rules in addition to LLM classification.

Initial high-priority triggers:

- dismissal already happened;
- hearing/disciplinary/grievance meeting imminent;
- possible employment tribunal deadline;
- suspension;
- discrimination/reasonable-adjustment issue;
- whistleblowing/patient safety;
- professional regulator referral;
- safeguarding allegation;
- criminal allegation;
- violence/threats/serious harassment;
- right-to-work/immigration employment issue;
- user says they are in immediate danger.

For urgent cases:

- show a prominent warning to member;
- place case in Kelly's urgent queue;
- record why it was escalated;
- do not rely solely on model confidence.

#### 8. Kelly dashboard

Views:

- Urgent.
- Awaiting review.
- Waiting for member.
- Action sent.
- Closed.
- All cases.

Case card:

- member;
- employer;
- case type;
- next known important date;
- age of case;
- urgency;
- current status.

Case detail:

- one-screen brief;
- chronological timeline;
- member account;
- documents;
- AI analysis;
- retrieved sources;
- private Kelly notes;
- conversation;
- actions/status history.

#### 9. Kelly response workflow

Kelly can:

- approve/edit AI-prepared wording;
- write her own response;
- ask member a question;
- attach a document;
- create an action item;
- change priority;
- change status;
- add private notes.

All member-visible AI-assisted responses sent as Kelly-reviewed content should record who approved them.

#### 10. Notifications

MVP:

- member receives email when Kelly replies;
- Kelly receives notification for a new urgent case;
- member receives reminder when Kelly asks for missing information.

Do not put sensitive case details in email subject lines or notification previews.

## Release 1 — Immediately after pilot

- Subscription billing.
- Tier entitlements.
- Saved reusable response templates.
- Better policy ingestion.
- Automated deadline reminders.
- Calendar integration.
- Meeting preparation tool.
- Grievance/appeal document builder.
- Case exports.
- Basic operational analytics.

## Release 2 — SaaS foundation

- Multi-organisation tenancy.
- Multiple advisors.
- Role/permission editor.
- Organisation-specific knowledge bases.
- White label.
- Usage quotas.
- Organisation billing.
- Advisor performance/capacity analytics.
- Knowledge-source review workflow.

## Pilot exit criteria

Pilot becomes public beta when:

- no critical tenant/data isolation defects remain;
- all high-risk test scenarios escalate correctly;
- AI citation fabrication rate is effectively zero in the test suite;
- Kelly can complete the core workflow without developer assistance;
- backups and restore have been tested;
- privacy/AI notices are published;
- audit logs cover sensitive actions;
- at least 20 realistic test cases have been evaluated;
- Kelly signs off the workflow as materially faster than her current process.
