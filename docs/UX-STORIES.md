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

## Navigation spec

Bottom tab bar on mobile (<768px), built from the same permission checks as the header nav — never a superset. Desktop keeps the header nav; the bar hides.

| Role | Tabs |
| --- | --- |
| Member (`cases.own`) | Home · Cases · **Start** (accent) · Alerts (badge) · Account |
| Advisor (`cases.review`) | Today · Queue · Assistant (opens the chat overlay) · Alerts · Account |
| Admin (non-advisor) | Overview · Users* · Assistant* · Alerts · Account *(permission-gated)* |
| Signed-out visitor | Sticky CTA bar: Create free account · Sign in |

Multi-role accounts get the highest workspace's tabs (advisor > admin > member); everything else stays reachable via Account quick links and the header. Alerts is one shared notifications sheet for every role; opening it marks notifications read and deep-links per role (advisors → advisor case view, members → portal case view).

## Status → journey mapping (member)

| Case status | Journey step | Member reads |
| --- | --- | --- |
| `gathering` (no AI intake yet) | 1 Received | "We are gathering the details…" |
| `gathering` (intake ready) | 2 Understanding | same |
| `waiting_for_kelly` / `kelly_reviewing` | 3 With Kelly | "in Kelly's queue" / "Kelly is looking now" |
| `need_member_info` | 3 With Kelly + action badge | "Kelly has asked you a question" |
| `action_plan_ready` / `ongoing` | 4 Action plan | "Your action plan is ready" / "Kelly is checking in" |
| `closed` | journey complete | "Closed — Kelly can reopen it" |

## API deltas shipped for this work

- `GET /api/advisor/queue`: additive `lastMessageBy` / `lastMessageAt` per card (powers K1's "Member replied" bucket).
- Everything else is client-only: theme (localStorage + pre-paint boot script), tab bar, sheets, wizard, journey mapping, overview tiles composed from existing endpoints.

## Must not regress

Permission gating (tab bar from the same `can()` checks); AI labelling and safety notices verbatim; assistant approve-before-send; urgent-help banners (may move earlier, never later or smaller); PII-redaction warnings; request-review gating; private-note visibility; API contracts (additive only); strict CSP (no inline styles/scripts); the cache-versioning self-heal.

## Out of scope (for now)

Billing/tiers (Release 1 per [MVP](MVP.md)); server-synced theme preference; per-item notification read state; camera capture for evidence (formats stay PDF/DOCX/TXT).
