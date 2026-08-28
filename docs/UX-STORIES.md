> Kelly Online docs — [README](../README.md) · [MVP](MVP.md) · [PRD](PRD.md) · [SDD](SDD.md) · [Backlog](BACKLOG.md) · [Agile](AGILE.md) · [AI Safety & Data](AI-SAFETY-DATA.md) · [Kelly Ops](KELLY-OPS.md) · [Launch Checklist](LAUNCH-CHECKLIST.md) · [Agent Rules](AGENTS.md) · **UX Stories**

# UX Stories — the mobile-app experience

How Kelly Online should feel: futuristic and effortless, unmistakably NHS, and above all trustworthy. Each role gets a custom-crafted experience; every story below is written against the shipped implementation.

## Design principles

1. **Faster beats flashier.** Motion exists to explain (what changed, where things went), never to delay. Every decorative animation is disabled under `prefers-reduced-motion`.
2. **Glanceable status.** A member should know *what happens next* without reading; Kelly should know *what's first* without deciding.
3. **Zero dead ends.** Every screen offers the obvious next action; empty states teach instead of apologising.
4. **One case, one story.** A case is a journey (Received → Understanding → With Kelly → Action plan), not a status code.
5. **Escalation is a feature.** Urgency renders as reassurance to members ("being treated as a priority") and as triage order to Kelly — never as alarm.
6. **NHS at heart.** NHS blue anchors both themes, plain English everywhere, AI always labelled, safety notices never shrink.

## Personas

- **Priya — Visitor.** Band 5 nurse, 11pm, on her phone, just received an investigation letter.
- **Priya — Member.** One week later: has an open case, checks it between shifts.
- **Kelly — Advisor.** Works the daily order in [Kelly Ops](KELLY-OPS.md); phone during the day, laptop at night.
- **Dark — Admin.** Steward of accounts, AI settings and the knowledge base.

## Visitor stories

**V1 — Land and trust in seconds.** *As a worried NHS worker landing at 11pm, I want to know immediately that this service is for people like me and is safe, so that I don't close the tab.*
AC: headline, one-line reassurance and primary CTA visible without scrolling at 375px; urgent-help notice within the first screen-and-a-half; no jargon above the fold. *(Static landing page.)*

**V2 — See the path before signing up.** *As a visitor, I want to see what happens after I tell my story before creating an account, so that signing up feels safe.*
AC: three-step "How it works" as scannable cards; AI assistance vs Kelly's human review explicitly distinguished; "takes about 2 minutes" beside the CTA.

**V3 — Minimum friction to a started case.** *As a visitor mid-crisis, I want the minimum steps between "I need help" and "my case is started".*
AC: registration stays at three fields; sticky bottom CTA bar on public pages (mobile); the landing CTA carries `?next=` so sign-in after verification lands straight in Start-a-case. *(Client-side `?next=` whitelist in `auth.js`.)*

**V4 — Recognise my situation.** *As a visitor unsure whether my problem "counts", I want to recognise my situation in a list.*
AC: "Is this for me?" chips use the exact case-type labels from the wizard, confirming continuity.

**V5 — Urgent help is unmissable.** *As a visitor with a deadline tonight, I want an unmissable route to urgent help.*
AC: urgent-help notice on the landing page **and** both auth pages; `emergency.html` one tap away from each.

**V6 — Forgiving sign-in.** *As a returning visitor, I want sign-in to be quick and forgiving.*
AC: plain-English errors; reset one tap away; after sign-in I land on my role home.

## Member stories

**M1 — Home tells me what happens next.** *As a member, I want my home screen to tell me what happens next on my most important case, so that I never hunt through a list.*
AC: greeting + one hero card for the highest-priority open case (urgency → earliest date → recency); hero shows the journey stepper, a plain "what happens next" sentence and a countdown chip; `need_member_info` renders a direct reply CTA. *(Fully served by `GET /api/cases`.)*

**M2 — One question at a time.** *As a member starting a case at a stressful moment, I want one question at a time, so that a long form doesn't overwhelm me.*
AC: 7-step wizard with progress and Back that never loses answers (sessionStorage); only "What happened?" is required — everything else has Skip for now; a review step allows per-item edits before one submit; exactly one `POST /api/cases` with the unchanged body shape.

**M3 — My case is a journey.** *As a member, I want my case shown as a simple journey, so that I stop wondering whether anything is happening.*
AC: 4-step stepper (Received → Understanding → With Kelly → Action plan) with the current step highlighted and a plain sentence for what's happening; urgency renders as reassurance (existing escalation wording verbatim); closed cases show the journey complete with the reopen note.

**M4 — Answer Kelly in seconds.** *As a member Kelly has asked a question, I want the question and the reply box together.*
AC: `question` messages are visually distinct ("Kelly asked you"); the composer sits beneath the conversation with a context-aware label; "Ask Kelly to review" appears only in `gathering`/`need_member_info`.

**M5 — Evidence with context, from the case.** *As a member who just received a letter, I want to upload it and say what it shows in one flow.*
AC: "Add evidence" on the case screen (and home quick action) opens one sheet — files + "what does this show?" — landing in the conversation as a labelled Evidence entry with attachments; PII-redaction warning retained verbatim. *(Reuses the documents + evidence endpoints.)*

**M6 — Alerts in one badged place.** *As a member, I want alerts in one place with a badge, so that I never miss a Kelly reply.*
AC: Alerts tab and header bell share an unread badge; opening the sheet lists notifications newest-first, marks them read, and deep-links to the case. Unread state is no longer cleared by merely loading the dashboard.

**M7 — An app I trust on my home screen.** *As a member, I want the app installed and my settings tidy.*
AC: install guidance from Home and Account (per-browser instructions, real prompt where offered); theme (Auto/Light/Dark) in Account → Appearance applies without flash on next load.

## Kelly stories

**K1 — Start my day without deciding.** *As Kelly, I want a "Today" view ordered exactly per my operations manual, so the portal decides what's first.*
AC: five buckets in [Kelly Ops](KELLY-OPS.md) order — Urgent → Important date within 7 days → Awaiting review → Member replied → Oldest open — with counts; empty buckets collapse with a tick; the first card is styled "Next up"; open-app to first case = 1 tap. *(Member-replied is powered by the queue's `lastMessageBy` field.)*

**K2 — Deadline risk at a glance.** *As Kelly, I want countdown chips on queue cards.*
AC: Overdue / Today / Tomorrow / N-days chips computed from `nextImportantAt`, colour-coded; member, employer, age and escalation count readable on one card at 375px.

**K3 — Brief first, actions pinned.** *As Kelly on my phone, I want the case brief first and my actions always reachable.*
AC: case reading order matches Kelly Ops (why urgent → member wants → AI brief → timeline → documents → member → conversation); a sticky action bar (Reply · Status · 🔒 Note) opens bottom sheets — no scrolling required to act.

**K4 — One-tap transitions.** *As Kelly, I want the most likely next status as a single tap.*
AC: contextual primary action in the Status sheet ("Take this case", "Close case", "Reopen case"); reply kinds still set status automatically server-side; the full status/urgency/date controls remain.

**K5 — The response structure on tap.** *As Kelly, I want my six-heading response structure inserted for me.*
AC: "Use structure" inserts What I understand / What matters / What to do now / What I need from you / Important dates / Sources at the cursor.

**K6 — Urgent cases interrupt appropriately.** *As Kelly, I want new urgent cases in my alerts.*
AC: `urgent_case` notifications appear in the shared Alerts sheet with a badge and deep-link into the advisor case view.

## Admin stories

**A1 — System health in five seconds.** *As an admin, I want an overview before the management tabs.*
AC: Overview is the default admin tab: tiles for accounts, open/urgent casework, AI status (kill-switch state visible), knowledge sources, plus latest audit activity; tiles the user lacks permission for are hidden, and one failed fetch never blanks the page.

**A2 — User management without sideways scrolling.** *As an admin on a phone, I want role and permission changes to be safe and quick.*
AC: no horizontal scroll at 375px; permissions render as a stacked list with a Grant/Revoke/Default segmented control and the catalog description; role removal and account disabling require a confirm step; main-admin protections unchanged.

**A3 — Kill switch two taps away.** *As an admin during an incident, I want to stop AI generation fast.*
AC: kill-switch state on the Overview AI tile; one tap to settings, one tap to toggle.

**A4 — Delegation stays gated.** *As an admin, I want the assistant's approve-before-send flow untouched while staying easy to reach.*
AC: proposed actions remain editable-then-approve cards; the assistant is reachable from the tab bar and the floating widget with identical thread state.

**A5 — Audit on the move.** *As an auditor, I want the log scannable on mobile.*
AC: audit rows render as stacked cards under 700px with a client-side actor/action filter; full table on desktop.

**A6 — Supersede in place.** *As a knowledge manager, I want new source versions added without losing my place.*
AC: "Supersede…" expands inline under the source row; current version and counts stay visible.

## Member — band reviews (M8–M13)

**M8 — A band review I can do in pieces.** *As a member whose job has grown, I want to build my case over days or weeks without losing anything, so that gathering a job description or asking a colleague does not cost me my progress.*
AC: `#/banding/new` creates a server-side review before the first question, so nothing is ever unsaved; every answer autosaves to `PATCH /api/je/reviews/:id/answers` on step change, on an 800ms input debounce, and on `pagehide` via `fetch(keepalive)` (never `sendBeacon` — it cannot carry the CSRF header); the save state is always visible ("Saving…" / "All answers saved" / "Not saved — check your connection"); a concurrent edit returns 409 with the server state and a Keep-mine/Use-theirs choice, never a silent overwrite; a sessionStorage crash buffer is offered back, never auto-applied; drafts are never auto-deleted.

**M9 — Questions about my job, not about job evaluation.** *As a member with no HR background, I want to be asked what I actually do, so that I never have to learn what a "factor" is.*
AC: 12 steps in 4 named groups with a grouped segment bar; the evidence steps use everyday language covering all 16 scheme factors without naming any of them; cues surface commonly under-claimed work (supervising students, ordering stock, the emotional load) with the instruction "Write it how you'd say it — short answers are fine"; only the risk acknowledgement and job title are required; every evidence step offers Skip for now and Save and finish later; a review step allows per-item edits before one submit; the wording is versioned (`question_set_version`) on the review.

**M10 — Naming a colleague is my choice, not the default.** *As a member citing a better-paid colleague, I want their information protected unless they have agreed, so that making my case does not expose someone else.*
AC: comparators default to anonymised ("A colleague in my team, Band 6") with a plain explanation of why; naming requires an explicit "they know and are happy to be named" tick stored as `named_consent`; the employer submission renders anonymised unless consent was recorded; banding/equal-pay signals in case text fire deterministic rules (`src/safety/jeUrgency.js`), never AI.

**M11 — A result that tells me what to do.** *As a member who has waited, I want a report that ends in things I can actually do, so that I am not left holding an analysis.*
AC: the report is released only after Kelly's sign-off and approval (share gate in `src/je/guard.js`); "What to do next" is at most five actions each with an owner; the indicative band appears in a dashed chip with the standard sentence ("…does not decide your band…") in the opening and the footer; the footer names the reference ruleset, its checksum and whether it has been human-verified; no points totals or factor jargon appear.

**M12 — Something I can actually send.** *As a member ready to act, I want the formal request already written, so that I do not have to translate my own report into HR language.*
AC: the employer submission has six fixed sections plus annexes, built from the duty log and confirmed factor levels; it excludes the indicative band range unless Kelly explicitly opts in with a recorded reason; both documents print to A4 via the print stylesheet (palette reset applies in dark mode) and the submission downloads as Markdown (`GET /api/je/reviews/:id/submission.md`).

**M13 — Band reviews live in my portal.** *As a member, I want my band review where my cases are, so that I have one place to look.*
AC: the section lives at `#/banding/*` inside the member shell (lazy-loaded `banding-member.js`); the Cases tab stays lit throughout `#/banding/*` and Start during `#/banding/new` via `also` prefix matching; a "Pay / banding" case whose text mentions banding offers the band review route after submission; the tab bar stays at five tabs for every role.

## Kelly — band reviews (K7–K11)

**K7 — Every factor reviewed, or explicitly not.** *As Kelly, I want to work through the assessment factor by factor, so that nothing reaches a member on the strength of an unreviewed suggestion.*
AC: 16 factor rows with four visible states (unreviewed / confirmed / changed / not enough information), each an icon + text label, never colour alone; an AI proposal shows its confidence, rationale, descriptor and verbatim evidence quotes with provenance; a proposal with no evidence item cannot be confirmed (server-enforced); changing a proposed level requires a reason code; manually setting a level where no proposal exists is a plain confirm; on blind-sampled reviews the proposal is hidden until Kelly records her own decision.

**K8 — Arithmetic I can trust while it is incomplete.** *As Kelly mid-assessment, I want the running total honest about what is unresolved, so that I never read a provisional number as a result.*
AC: the band meter shows confirmed points as a solid fill and the unresolved range as a hatched extension with band boundary ticks from the pinned ruleset; a single band is asserted only when every factor is resolved AND the sensitivity range collapses to one band; unknown factors widen the range from the factor's minimum to its maximum — absence of evidence never scores low; every outcome is append-only with the ruleset checksum and full computation snapshot.

**K9 — Nothing reaches the member until I release it.** *As Kelly, I want a sign-off gate, so that release is a deliberate act.*
AC: sign-off requires every factor resolved, every high/critical flag acknowledged, all ten fairness checklist items actively ticked (no default state), an outcome recommendation, and the personal attestation; the disabled button is `aria-describedby` an itemised outstanding list; second opinions are required on wide ranges, downbanding risk, equal pay, appeals, high disagreement or collective matters — waivable only with a recorded reason; report approval is claim-then-execute (a lost race returns 410) and issues exactly one member message with `approved_by` set.

**K10 — The record of what actually happened.** *As Kelly, I want employer decisions recorded, so that the only real bands in the system are the ones a panel actually awarded.*
AC: `je_decisions` is the sole entry point for an awarded band; recording an outcome advances the stage machine and fires the appeal-window check; every date carries a confirmed/unconfirmed flag; time-limit wording is always "may have passed — verify", never "has passed".

**K11 — Fairness checked, not assumed.** *As Kelly, I want the fairness questions asked of me every time, so that consistency does not depend on my memory.*
AC: deterministic checks cover missing/stale JD, unevidenced factors, boundary-sensitive totals, claim gaps, downbanding exposure, equal-pay comparators and cross-review variance; each high/critical check must be acknowledged before sign-off; acknowledgements and every amend reason are audited as codes, never narrative.

## Admin — band reviews (A7–A9)

**A7 — Reference data is loaded, never remembered.** *As an admin, I want the factor plan, points, band boundaries and profiles held as versioned data, so that no scheme constant ever lives in code or comes from an AI's memory.*
AC: rulesets are checksummed bundles with all-or-nothing validation (contiguous bands, strictly increasing points, real factor/level references); one approved ruleset per scheme (DB-enforced); approving supersedes and flags open reviews without touching their outcomes; the bundled seed ships `origin='seed'` and every report footer says "not yet verified" until an admin marks it verified against the published handbook; scoring is unavailable (503) with no approved ruleset — there is no fallback to model memory.

**A8 — Fairness visible in aggregate, never in narrative.** *As an admin, I want to see whether the AI and Kelly agree, without reading anyone's case.*
AC: the oversight dashboard shows AI-vs-confirmed agreement per factor with blind and sighted rates separated, amend-reason breakdowns, waiver and pipeline health counts, and reference status; no member name, quote or narrative appears; the JE audit trail records ids, codes and counts only (tested by allowlist).

**A9 — The offer is configurable.** *As an admin, I want the paid offer editable, so that pricing changes don't need a deploy.*
AC: `settings.je_offer` seeds at £395 + VAT per role with six inclusions; the admin Job evaluation tab edits price, VAT, unit, headline, inclusions and enablement; members see the offer card on the banding hub; the audit event records field names only, never values.

## Navigation spec

Bottom tab bar on mobile (<768px), built from the same permission checks as the header nav — never a superset. Desktop keeps the header nav; the bar hides.

| Role | Tabs |
| --- | --- |
| Member (`cases.own`) | Home · Cases · **Start** (accent) · Alerts (badge) · Account |
| Advisor (`cases.review`) | Today · Queue · Assistant (opens the chat overlay) · Alerts · Account |
| Admin (non-advisor) | Overview · Users* · Assistant* · Alerts · Account *(permission-gated)* |
| Signed-out visitor | Sticky CTA bar: Create free account · Sign in |

Multi-role accounts get the highest workspace's tabs (advisor > admin > member); everything else stays reachable via Account quick links and the header. The band review section lives at `#/banding/*` inside the member and advisor shells; tab definitions carry an optional `also` list of hash prefixes matched longest-first, so `#/banding/new` lights Start and `#/banding/*` lights Cases (member) or Queue (advisor). No role gains a sixth tab. Alerts is one shared notifications sheet for every role; opening it marks notifications read and deep-links per role (advisors → advisor case view, members → portal case view).

## Status → journey mapping (member)

| Case status | Journey step | Member reads |
| --- | --- | --- |
| `gathering` (no AI intake yet) | 1 Received | "We are gathering the details…" |
| `gathering` (intake ready) | 2 Understanding | same |
| `waiting_for_kelly` / `kelly_reviewing` | 3 With Kelly | "in Kelly's queue" / "Kelly is looking now" |
| `need_member_info` | 3 With Kelly + action badge | "Kelly has asked you a question" |
| `action_plan_ready` / `ongoing` | 4 Action plan | "Your action plan is ready" / "Kelly is checking in" |
| `closed` | journey complete | "Closed — Kelly can reopen it" |

## Band review stage → journey mapping (member)

| Review stage | Journey step | Member reads |
| --- | --- | --- |
| `draft` | 1 Your job | "Getting started" |
| `member_submitted` | 2 With Kelly | "Sent to Kelly" |
| `analysing` / `advisor_review` | 3 Being assessed | "Kelly is working through it" |
| `report_ready` | 4 Your report | "Report ready" |
| `submitted_to_employer` / `employer_review` | 5 With your employer | "With your employer" |
| `outcome_received` / appeal / `closed` | journey complete | outcome / appeal wording |

## API deltas shipped for this work

- `GET /api/advisor/queue`: additive `lastMessageBy` / `lastMessageAt` per card (powers K1's "Member replied" bucket).
- Everything else is client-only: theme (localStorage + pre-paint boot script), tab bar, sheets, wizard, journey mapping, overview tiles composed from existing endpoints.
- Band reviews: the whole `/api/je/*` surface is new and additive (reviews, answers, documents, comparators, messages, factors, sign-off, reports, decisions, queue, oversight, reference, offer); `notifications` gains nullable `je_review_id`; `ai_outputs` gains nullable `je_review_id`/`je_stage` (case_id now nullable via rebuild migration v3); `POST /api/cases` adds `jeInterest` to its response.

## Must not regress

Permission gating (tab bar from the same `can()` checks); AI labelling and safety notices verbatim; assistant approve-before-send; urgent-help banners (may move earlier, never later or smaller); PII-redaction warnings; request-review gating; private-note visibility; API contracts (additive only); strict CSP (no inline styles/scripts); the cache-versioning self-heal. Band reviews add: the case wizard's 7 steps and single `POST /api/cases` body shape survive the wizard-engine extraction (M2); nothing from a band assessment reaches a member before sign-off + approval; comparator anonymity by default; the reference ruleset label/checksum/verification status on every assessment screen and report footer; the print palette reset applying in dark mode; no scheme constant (factor, points, band boundary) in application code — reference data only.

## Out of scope (for now)

Billing/tiers (Release 1 per [MVP](MVP.md)); server-synced theme preference; per-item notification read state; camera capture for evidence (formats stay PDF/DOCX/TXT).
