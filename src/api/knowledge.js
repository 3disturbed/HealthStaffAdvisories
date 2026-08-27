import { Router } from 'express';
import { db } from '../db/connection.js';
import { requirePermission } from '../auth/middleware.js';
import { addKnowledgeSource, addKnowledgeVersion, SOURCE_TYPES } from '../services/knowledgeActions.js';

export const knowledgeRouter = Router();

function respond(res, result) {
  if (result.error) return res.status(result.status || 400).json({ error: result.error });
  return res.json(result);
}

knowledgeRouter.get('/sources', requirePermission('knowledge.manage'), (req, res) => {
  const sources = db
    .prepare(
      `SELECT s.*,
        (SELECT COUNT(*) FROM knowledge_versions v WHERE v.source_id = s.id) AS version_count,
        (SELECT v.version_label FROM knowledge_versions v WHERE v.source_id = s.id AND v.review_status = 'approved' ORDER BY v.id DESC LIMIT 1) AS current_version,
        (SELECT COUNT(*) FROM knowledge_chunks c JOIN knowledge_versions v ON v.id = c.version_id WHERE v.source_id = s.id AND v.review_status = 'approved') AS chunk_count
       FROM knowledge_sources s ORDER BY s.title`
    )
    .all();
  res.json({ sources, sourceTypes: SOURCE_TYPES });
});

knowledgeRouter.post('/sources', requirePermission('knowledge.manage'), (req, res) => {
  respond(res, addKnowledgeSource(req.user, req.body));
});

knowledgeRouter.post('/sources/:id/versions', requirePermission('knowledge.manage'), (req, res) => {
  respond(res, addKnowledgeVersion(req.user, req.params.id, req.body));
});
