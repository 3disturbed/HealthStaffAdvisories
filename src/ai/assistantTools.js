import { db } from '../db/connection.js';
import { rolesForUser, overridesForUser } from '../rbac/permissions.js';
import { setUserRole, setUserPermission, setUserStatus } from '../services/adminActions.js';
import { addKnowledgeSource, addKnowledgeVersion, SOURCE_TYPES } from '../services/knowledgeActions.js';

// Admin assistant toolbox. Each tool declares the permission it requires —
// enforced server-side per call regardless of what the model asks for.
// kind 'read'  → executes immediately during the chat loop.
// kind 'write' → NEVER executed by the model; stored as a proposed action
//                and run only after explicit human approval.
// Read results deliberately exclude case narrative, message content and
// private notes (AI-SAFETY-DATA §12 data minimisation).

function userRow(u) {
  return {
    id: u.id, email: u.email, displayName: u.display_name, status: u.status,
    isMainAdmin: !!u.is_main_admin,
    roles: rolesForUser(u.id),
    permissionOverrides: overridesForUser(u.id),
  };
}

function caseRow(c) {
  return {
    id: c.id, title: c.title, caseType: c.case_type, status: c.status,
    urgency: c.urgency, member: c.member_name,
    nextImportantAt: c.next_important_at, createdAt: c.created_at,
    updatedAt: c.updated_at, openEscalations: c.open_escalations,
  };
}

const CASE_LIST_SELECT = `
  SELECT c.*, u.display_name AS member_name,
    (SELECT COUNT(*) FROM escalations e WHERE e.case_id = c.id AND e.resolved_at IS NULL) AS open_escalations
  FROM cases c JOIN users u ON u.id = c.member_id`;

export const ASSISTANT_TOOLS = [
  // ── READ: users ────────────────────────────────────────────────────────
  {
    name: 'list_users',
    permission: 'users.manage',
    kind: 'read',
    definition: {
      description: 'List all accounts with roles, status and permission overrides.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    run: () => ({ users: db.prepare('SELECT * FROM users ORDER BY created_at').all().map(userRow) }),
  },
  {
    name: 'get_user',
    permission: 'users.manage',
    kind: 'read',
    definition: {
      description: 'Look up one account by numeric id or email address.',
      parameters: {
        type: 'object',
        properties: { userId: { type: 'integer' }, email: { type: 'string' } },
        additionalProperties: false,
      },
    },
    run: (actor, args) => {
      const u = args.userId
        ? db.prepare('SELECT * FROM users WHERE id = ?').get(Number(args.userId))
        : db.prepare('SELECT * FROM users WHERE email = ?').get(String(args.email || '').toLowerCase());
      return u ? { user: userRow(u) } : { error: 'No account matches.' };
    },
  },
  // ── READ: case queue insight ───────────────────────────────────────────
  {
    name: 'queue_overview',
    permission: 'cases.review',
    kind: 'read',
    definition: {
      description: 'Counts of cases per queue view (urgent, awaiting review, waiting for member, action sent, closed, all).',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    run: () => {
      const counts = {};
      for (const [key, clause] of Object.entries({
        urgent: `urgency IN ('critical','high') AND status != 'closed'`,
        awaiting_review: `status = 'waiting_for_kelly'`,
        waiting_for_member: `status = 'need_member_info'`,
        action_sent: `status IN ('action_plan_ready','ongoing')`,
        closed: `status = 'closed'`,
        all: '1=1',
      })) {
        counts[key] = db.prepare(`SELECT COUNT(*) AS n FROM cases WHERE ${clause}`).get().n;
      }
      return { counts };
    },
  },
  {
    name: 'urgent_cases',
    permission: 'cases.review',
    kind: 'read',
    definition: {
      description: 'Open cases with critical or high urgency, most urgent first (max 20). Metadata only.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    run: () => ({
      cases: db
        .prepare(`${CASE_LIST_SELECT} WHERE c.urgency IN ('critical','high') AND c.status != 'closed'
          ORDER BY CASE c.urgency WHEN 'critical' THEN 0 ELSE 1 END, c.next_important_at IS NULL, c.next_important_at LIMIT 20`)
        .all()
        .map(caseRow),
    }),
  },
  {
    name: 'oldest_unresolved',
    permission: 'cases.review',
    kind: 'read',
    definition: {
      description: 'Oldest cases that are not closed (max 20). Metadata only.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    run: () => ({
      cases: db
        .prepare(`${CASE_LIST_SELECT} WHERE c.status != 'closed' ORDER BY c.created_at LIMIT 20`)
        .all()
        .map(caseRow),
    }),
  },
  {
    name: 'top_priority_cases',
    permission: 'cases.review',
    kind: 'read',
    definition: {
      description: 'Open cases ranked by priority: urgency first, then soonest known deadline / next important date, then age (max 20). Each entry includes its next upcoming timeline event where one is known. Use this to find the highest-priority or shortest-deadline case. All dates are candidates extracted during intake and need human verification.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    run: () => ({
      cases: db
        .prepare(`${CASE_LIST_SELECT} WHERE c.status != 'closed'
          ORDER BY CASE c.urgency WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
          c.next_important_at IS NULL, c.next_important_at, c.created_at LIMIT 20`)
        .all()
        .map((c) => {
          const nextEvent = db
            .prepare(`SELECT event_date, description FROM case_timeline WHERE case_id = ? AND event_date >= date('now') ORDER BY event_date LIMIT 1`)
            .get(c.id);
          return {
            ...caseRow(c),
            nextTimelineEvent: nextEvent
              ? { date: nextEvent.event_date, description: String(nextEvent.description).slice(0, 200) }
              : null,
          };
        }),
      note: 'Dates are candidate extractions — verify before relying on them.',
    }),
  },
  {
    name: 'case_timeline',
    permission: 'cases.review',
    kind: 'read',
    definition: {
      description: 'Timeline events for one case: dates, short event descriptions, source and confirmation status. Dates are candidates and need human verification.',
      parameters: {
        type: 'object',
        properties: { caseId: { type: 'integer' } },
        required: ['caseId'],
        additionalProperties: false,
      },
    },
    run: (actor, args) => {
      const c = db.prepare('SELECT id FROM cases WHERE id = ?').get(Number(args.caseId));
      if (!c) return { error: 'Case not found.' };
      return {
        timeline: db
          .prepare('SELECT event_date, description, source, confidence, confirmed FROM case_timeline WHERE case_id = ? ORDER BY event_date IS NULL, event_date')
          .all(c.id)
          .map((t) => ({
            date: t.event_date,
            description: String(t.description).slice(0, 200),
            source: t.source,
            confirmed: !!t.confirmed,
          })),
      };
    },
  },
  {
    name: 'case_summary',
    permission: 'cases.review',
    kind: 'read',
    definition: {
      description: 'Metadata for one case: status, urgency, open escalation reasons, document and message counts. Does NOT include the case narrative, messages or private notes.',
      parameters: {
        type: 'object',
        properties: { caseId: { type: 'integer' } },
        required: ['caseId'],
        additionalProperties: false,
      },
    },
    run: (actor, args) => {
      const c = db.prepare(`${CASE_LIST_SELECT} WHERE c.id = ?`).get(Number(args.caseId));
      if (!c) return { error: 'Case not found.' };
      return {
        case: caseRow(c),
        employer: c.employer,
        openEscalationReasons: db
          .prepare('SELECT reason, severity, detected_by FROM escalations WHERE case_id = ? AND resolved_at IS NULL')
          .all(c.id),
        documentCount: db.prepare('SELECT COUNT(*) AS n FROM documents WHERE case_id = ?').get(c.id).n,
        messageCount: db.prepare(`SELECT COUNT(*) AS n FROM case_messages WHERE case_id = ? AND visibility = 'member'`).get(c.id).n,
      };
    },
  },
  // ── READ: knowledge ────────────────────────────────────────────────────
  {
    name: 'list_knowledge_sources',
    permission: 'knowledge.manage',
    kind: 'read',
    definition: {
      description: 'List knowledge sources with publisher, type, current version and chunk count.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
    run: () => ({
      sources: db
        .prepare(
          `SELECT s.id, s.title, s.publisher, s.source_type, s.canonical_url,
            (SELECT v.version_label FROM knowledge_versions v WHERE v.source_id = s.id AND v.review_status = 'approved' ORDER BY v.id DESC LIMIT 1) AS currentVersion,
            (SELECT COUNT(*) FROM knowledge_versions v WHERE v.source_id = s.id) AS versionCount
           FROM knowledge_sources s ORDER BY s.title`
        )
        .all(),
    }),
  },
  // ── WRITE: users & permissions (confirm-first) ─────────────────────────
  {
    name: 'grant_role',
    permission: 'users.manage',
    kind: 'write',
    definition: {
      description: 'Propose granting a role (member, advisor, admin) to an account. Requires human approval.',
      parameters: {
        type: 'object',
        properties: { userId: { type: 'integer' }, role: { type: 'string', enum: ['member', 'advisor', 'admin'] } },
        required: ['userId', 'role'],
        additionalProperties: false,
      },
    },
    summarize: (a) => `Grant the "${a.role}" role to user #${a.userId}`,
    run: (actor, args, opts) => setUserRole(actor, args.userId, { role: args.role, action: 'add' }, opts),
  },
  {
    name: 'remove_role',
    permission: 'users.manage',
    kind: 'write',
    definition: {
      description: 'Propose removing a role from an account. Requires human approval.',
      parameters: {
        type: 'object',
        properties: { userId: { type: 'integer' }, role: { type: 'string', enum: ['member', 'advisor', 'admin'] } },
        required: ['userId', 'role'],
        additionalProperties: false,
      },
    },
    summarize: (a) => `Remove the "${a.role}" role from user #${a.userId}`,
    run: (actor, args, opts) => setUserRole(actor, args.userId, { role: args.role, action: 'remove' }, opts),
  },
  {
    name: 'grant_permission',
    permission: 'users.manage',
    kind: 'write',
    definition: {
      description: 'Propose granting an individual permission override to an account. Requires human approval.',
      parameters: {
        type: 'object',
        properties: { userId: { type: 'integer' }, permission: { type: 'string' } },
        required: ['userId', 'permission'],
        additionalProperties: false,
      },
    },
    summarize: (a) => `Grant the "${a.permission}" permission to user #${a.userId}`,
    run: (actor, args, opts) => setUserPermission(actor, args.userId, { permission: args.permission, mode: 'grant' }, opts),
  },
  {
    name: 'revoke_permission',
    permission: 'users.manage',
    kind: 'write',
    definition: {
      description: 'Propose revoking a permission from an account (overrides its role default). Requires human approval.',
      parameters: {
        type: 'object',
        properties: { userId: { type: 'integer' }, permission: { type: 'string' } },
        required: ['userId', 'permission'],
        additionalProperties: false,
      },
    },
    summarize: (a) => `Revoke the "${a.permission}" permission from user #${a.userId}`,
    run: (actor, args, opts) => setUserPermission(actor, args.userId, { permission: args.permission, mode: 'revoke' }, opts),
  },
  {
    name: 'clear_permission',
    permission: 'users.manage',
    kind: 'write',
    definition: {
      description: 'Propose clearing a permission override so the role default applies again. Requires human approval.',
      parameters: {
        type: 'object',
        properties: { userId: { type: 'integer' }, permission: { type: 'string' } },
        required: ['userId', 'permission'],
        additionalProperties: false,
      },
    },
    summarize: (a) => `Clear the "${a.permission}" override on user #${a.userId}`,
    run: (actor, args, opts) => setUserPermission(actor, args.userId, { permission: args.permission, mode: 'clear' }, opts),
  },
  {
    name: 'enable_account',
    permission: 'users.manage',
    kind: 'write',
    definition: {
      description: 'Propose re-enabling a disabled account. Requires human approval.',
      parameters: {
        type: 'object',
        properties: { userId: { type: 'integer' } },
        required: ['userId'],
        additionalProperties: false,
      },
    },
    summarize: (a) => `Enable account #${a.userId}`,
    run: (actor, args, opts) => setUserStatus(actor, args.userId, 'active', opts),
  },
  {
    name: 'disable_account',
    permission: 'users.manage',
    kind: 'write',
    definition: {
      description: 'Propose disabling an account (signs it out everywhere). Requires human approval.',
      parameters: {
        type: 'object',
        properties: { userId: { type: 'integer' } },
        required: ['userId'],
        additionalProperties: false,
      },
    },
    summarize: (a) => `Disable account #${a.userId}`,
    run: (actor, args, opts) => setUserStatus(actor, args.userId, 'disabled', opts),
  },
  // ── WRITE: knowledge (confirm-first) ───────────────────────────────────
  {
    name: 'add_knowledge_source',
    permission: 'knowledge.manage',
    kind: 'write',
    definition: {
      description: 'Propose adding a new knowledge source with its first version. Requires human approval.',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          publisher: { type: 'string' },
          sourceType: { type: 'string', enum: SOURCE_TYPES },
          url: { type: 'string' },
          versionLabel: { type: 'string' },
          effectiveFrom: { type: 'string' },
          content: { type: 'string', description: 'The full source text (min 50 chars).' },
        },
        required: ['title', 'content'],
        additionalProperties: false,
      },
    },
    summarize: (a) => `Add knowledge source "${a.title}" (${a.publisher || 'unknown publisher'}, ${(a.content || '').length} chars)`,
    run: (actor, args, opts) => addKnowledgeSource(actor, args, opts),
  },
  {
    name: 'supersede_knowledge_version',
    permission: 'knowledge.manage',
    kind: 'write',
    definition: {
      description: 'Propose adding a new version to an existing source, superseding the current one. Requires human approval.',
      parameters: {
        type: 'object',
        properties: {
          sourceId: { type: 'integer' },
          versionLabel: { type: 'string' },
          effectiveFrom: { type: 'string' },
          content: { type: 'string', description: 'The full new source text (min 50 chars).' },
        },
        required: ['sourceId', 'versionLabel', 'content'],
        additionalProperties: false,
      },
    },
    summarize: (a) => `Supersede source #${a.sourceId} with version "${a.versionLabel}" (${(a.content || '').length} chars)`,
    run: (actor, args, opts) => addKnowledgeVersion(actor, args.sourceId, args, opts),
  },
];

export const toolByName = new Map(ASSISTANT_TOOLS.map((t) => [t.name, t]));

export function toolDefinitions(permissions) {
  return ASSISTANT_TOOLS.filter((t) => permissions.has(t.permission)).map((t) => ({
    type: 'function',
    function: { name: t.name, ...t.definition },
  }));
}
