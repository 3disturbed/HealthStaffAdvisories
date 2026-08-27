import { sessionUser } from './sessions.js';
import { userHas } from '../rbac/permissions.js';

export function attachUser(req, res, next) {
  const raw = req.headers.cookie || '';
  const match = raw.match(/(?:^|;\s*)kelly_session=([^;]+)/);
  req.sessionToken = match ? decodeURIComponent(match[1]) : null;
  req.user = sessionUser(req.sessionToken);
  next();
}

export function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
  next();
}

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
    if (!userHas(req.user, permission)) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    next();
  };
}

export function requireAnyPermission(...permissions) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not signed in.' });
    if (!permissions.some((p) => userHas(req.user, p))) {
      return res.status(403).json({ error: 'You do not have permission to do that.' });
    }
    next();
  };
}

// CSRF guard for state-changing requests: SameSite=Lax cookies plus a
// mandatory custom header that cross-site forms cannot set.
export function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.headers['x-requested-with'] !== 'fetch') {
    return res.status(403).json({ error: 'Missing request header.' });
  }
  next();
}

// Minimal fixed-window rate limiter for authentication endpoints.
const buckets = new Map();
export function rateLimit({ windowMs = 15 * 60 * 1000, max = 30, keyPrefix = '' } = {}) {
  return (req, res, next) => {
    const key = `${keyPrefix}:${req.ip}`;
    const now = Date.now();
    let bucket = buckets.get(key);
    if (!bucket || now > bucket.reset) {
      bucket = { count: 0, reset: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > max) {
      return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }
    next();
  };
}
