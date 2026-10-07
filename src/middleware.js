function flash(req, type, text) {
  req.session.flash = { type, text };
}

function requireLogin(req, res, next) {
  if (req.user) return next();
  req.session.returnTo = req.originalUrl;
  return res.redirect('/login');
}

function requireRole(role) {
  return [requireLogin, (req, res, next) => {
    if (req.user.role === role) return next();
    return res.status(403).render('error', { title: 'Sin permiso', message: 'No tienes acceso a esta sección.' });
  }];
}

/** Limitador sencillo en memoria contra fuerza bruta (por IP y acción). */
function rateLimit({ windowMs = 15 * 60 * 1000, max = 10 } = {}) {
  const hits = new Map();
  return (req, res, next) => {
    const now = Date.now();
    const key = `${req.ip}|${req.path}`;
    const entry = hits.get(key);
    if (!entry || entry.reset < now) {
      hits.set(key, { count: 1, reset: now + windowMs });
    } else if (++entry.count > max) {
      return res.status(429).render('error', { title: 'Demasiados intentos', message: 'Has hecho demasiados intentos. Espera unos minutos y vuelve a probar.' });
    }
    if (hits.size > 5000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
    next();
  };
}

module.exports = { flash, requireLogin, requireFamily: requireRole('family'), requireAdmin: requireRole('admin'), rateLimit };
