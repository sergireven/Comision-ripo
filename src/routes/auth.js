const express = require('express');
const bcrypt = require('bcryptjs');
const { flash, requireLogin, rateLimit } = require('../middleware');
const { normalizeDni, isValidEmail, generatePassword, generateToken, sha256 } = require('../util');

const limiter = () => rateLimit({ max: process.env.NODE_ENV === 'test' ? 1000 : 10 });

module.exports = function authRoutes({ db, mailer }) {
  const router = express.Router();

  const findLogin = db.prepare('SELECT * FROM users WHERE dni = ? OR username = ?');
  const homeOf = (user) => (user.role === 'admin' ? '/admin' : '/tienda');

  function logIn(req, user, cb) {
    const returnTo = req.session.returnTo;
    req.session.regenerate((err) => {
      if (err) return cb(err);
      req.session.userId = user.id;
      cb(null, returnTo && returnTo.startsWith('/') && !returnTo.startsWith('//') ? returnTo : homeOf(user));
    });
  }

  router.get('/login', (req, res) => {
    if (req.user) return res.redirect(homeOf(req.user));
    res.render('auth/login', { title: 'Entrar', usuario: '' });
  });

  router.post('/login', limiter(), (req, res, next) => {
    const raw = String(req.body.usuario || '').trim();
    const user = findLogin.get(normalizeDni(raw), raw.toLowerCase());
    const ok = user && user.password_hash && bcrypt.compareSync(String(req.body.password || ''), user.password_hash);
    if (!ok) {
      if (user && user.role === 'family' && !user.activated_at) {
        return res.status(401).render('auth/login', {
          title: 'Entrar', usuario: raw,
          error: 'Esta cuenta todavía no está activada. Haz clic en «Primer acceso» para obtener tu contraseña.',
        });
      }
      return res.status(401).render('auth/login', { title: 'Entrar', usuario: raw, error: 'Usuario o contraseña incorrectos.' });
    }
    logIn(req, user, (err, to) => (err ? next(err) : res.redirect(to)));
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
  });

  // --- Primer acceso: DNI -> email -> se genera la contraseña ---
  router.get('/primer-acceso', (req, res) => res.render('auth/first-access', { title: 'Primer acceso', step: 1, dni: '' }));

  router.post('/primer-acceso', limiter(), (req, res, next) => {
    const dni = normalizeDni(req.body.dni);
    const user = db.prepare("SELECT * FROM users WHERE dni = ? AND role = 'family'").get(dni);
    const render = (status, extra) => res.status(status).render('auth/first-access', { title: 'Primer acceso', dni, ...extra });

    if (!user) {
      return render(404, {
        step: 1,
        error: 'No encontramos ese DNI en el listado del club. Revisa que esté bien escrito o contacta con la comisión.',
      });
    }
    if (user.activated_at) {
      return render(409, { step: 1, error: 'Esta cuenta ya está activada. Si no recuerdas la contraseña usa «He olvidado mi contraseña».' });
    }
    if (req.body.step !== '2') return render(200, { step: 2, playerName: user.player_name });

    const email = String(req.body.email || '').trim().toLowerCase();
    const email2 = String(req.body.email2 || '').trim().toLowerCase();
    if (!isValidEmail(email)) return render(400, { step: 2, playerName: user.player_name, email, error: 'Introduce un correo válido.' });
    if (email !== email2) return render(400, { step: 2, playerName: user.player_name, email, error: 'Los dos correos no coinciden.' });

    const password = generatePassword();
    const res2 = db.prepare(`UPDATE users SET email = ?, password_hash = ?, lang = ?, activated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ? AND activated_at IS NULL`).run(email, bcrypt.hashSync(password, 10), req.lang, user.id);
    if (!res2.changes) return render(409, { step: 1, error: 'Esta cuenta ya está activada.' });

    const updated = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    mailer.accountActivated(updated, password, req.appUrl);
    logIn(req, updated, (err) => {
      if (err) return next(err);
      res.render('auth/first-access-done', { title: 'Cuenta activada', password, user: updated, email });
    });
  });

  // --- Recuperar contraseña: enlace por correo -> nueva contraseña ---
  router.get('/recuperar', (req, res) => res.render('auth/recover', { title: 'Recuperar acceso' }));

  router.post('/recuperar', limiter(), (req, res) => {
    const raw = String(req.body.usuario || '').trim();
    const user = findLogin.get(normalizeDni(raw), raw.toLowerCase());
    if (user && user.role === 'family' && !user.activated_at) {
      return res.render('auth/recover', {
        title: 'Recuperar acceso',
        error: 'Esta cuenta aún no se ha activado: usa «Primer acceso» para obtener la contraseña.',
      });
    }
    if (user && user.email) {
      const token = generateToken();
      db.prepare('UPDATE reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(new Date().toISOString(), user.id);
      db.prepare('INSERT INTO reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
        .run(user.id, sha256(token), new Date(Date.now() + 3600 * 1000).toISOString());
      mailer.resetLink(user, `${req.appUrl}/recuperar/${token}`);
    }
    // Mismo mensaje exista o no la cuenta, para no revelar qué DNIs están registrados.
    res.render('auth/recover', { title: 'Recuperar acceso', sent: true });
  });

  const findToken = db.prepare(`SELECT t.*, u.dni, u.username, u.email, u.player_name FROM reset_tokens t
    JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND t.used_at IS NULL AND t.expires_at > ?`);

  router.get('/recuperar/:token', (req, res) => {
    const row = findToken.get(sha256(req.params.token), new Date().toISOString());
    if (!row) return res.status(400).render('error', { title: 'Enlace no válido', message: 'El enlace ha caducado o ya se ha usado. Pide uno nuevo.' });
    res.render('auth/reset', { title: 'Nueva contraseña', token: req.params.token, account: row });
  });

  router.post('/recuperar/:token', limiter(), (req, res, next) => {
    const row = findToken.get(sha256(req.params.token), new Date().toISOString());
    if (!row) return res.status(400).render('error', { title: 'Enlace no válido', message: 'El enlace ha caducado o ya se ha usado. Pide uno nuevo.' });
    const password = generatePassword();
    db.transaction(() => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), row.user_id);
      db.prepare('UPDATE reset_tokens SET used_at = ? WHERE id = ?').run(new Date().toISOString(), row.id);
      db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?").run(row.user_id);
    })();
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    mailer.newPassword(user, password);
    logIn(req, user, (err) => {
      if (err) return next(err);
      res.render('auth/first-access-done', { title: 'Contraseña nueva', password, user, email: user.email, reset: true });
    });
  });

  // --- Mi cuenta ---
  router.get('/cuenta', requireLogin, (req, res) => res.render('auth/account', { title: 'Mi cuenta' }));

  router.post('/cuenta/password', requireLogin, (req, res) => {
    const { current, password, password2 } = req.body;
    if (!bcrypt.compareSync(String(current || ''), req.user.password_hash || '')) {
      flash(req, 'error', 'La contraseña actual no es correcta.');
    } else if (String(password || '').length < 8) {
      flash(req, 'error', 'La nueva contraseña debe tener al menos 8 caracteres.');
    } else if (password !== password2) {
      flash(req, 'error', 'Las contraseñas nuevas no coinciden.');
    } else {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), req.user.id);
      flash(req, 'ok', 'Contraseña cambiada.');
    }
    res.redirect('/cuenta');
  });

  router.post('/cuenta/email', requireLogin, (req, res) => {
    const email = String(req.body.email || '').trim().toLowerCase();
    if (!isValidEmail(email)) {
      flash(req, 'error', 'Introduce un correo válido.');
    } else {
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.id);
      mailer.emailChanged(req.user, email);
      flash(req, 'ok', 'Correo actualizado.');
    }
    res.redirect('/cuenta');
  });

  return router;
};
