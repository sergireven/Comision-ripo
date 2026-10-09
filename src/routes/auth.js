const express = require('express');
const bcrypt = require('bcryptjs');
const { flash, requireLogin, rateLimit } = require('../middleware');
const { isValidEmail, generatePassword, generateToken, sha256, readFullName } = require('../util');

const limiter = () => rateLimit({ max: process.env.NODE_ENV === 'test' ? 1000 : 10 });
const readEmail = (value) => String(value || '').trim().toLowerCase();

module.exports = function authRoutes({ db, mailer }) {
  const router = express.Router();

  // Clientes: entran con su correo. Comisión: con su nombre de usuario.
  const findLogin = db.prepare(`SELECT * FROM users
    WHERE (role = 'family' AND email = @login) OR (role = 'admin' AND username = @login) ORDER BY role DESC LIMIT 1`);
  const findCustomer = db.prepare("SELECT * FROM users WHERE role = 'family' AND email = ?");
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
    const user = findLogin.get({ login: raw.toLowerCase() });
    const ok = user && user.password_hash && bcrypt.compareSync(String(req.body.password || ''), user.password_hash);
    if (!ok) return res.status(401).render('auth/login', { title: 'Entrar', usuario: raw, error: 'Correo o contraseña incorrectos.' });
    logIn(req, user, (err, to) => (err ? next(err) : res.redirect(to)));
  });

  router.post('/logout', (req, res) => {
    req.session.destroy(() => res.redirect('/'));
  });

  // --- Crear cuenta: solo el correo; la contraseña se genera, se muestra en pantalla y se envía por correo ---
  router.get('/registro', (req, res) => {
    if (req.user) return res.redirect(homeOf(req.user));
    res.render('auth/register', { title: 'Crear cuenta', email: '', name: '' });
  });
  router.get('/primer-acceso', (req, res) => res.redirect(301, '/registro'));

  router.post('/registro', limiter(), (req, res, next) => {
    const email = readEmail(req.body.email);
    const name = readFullName(req.body.name);
    const render = (status, error) => res.status(status)
      .render('auth/register', { title: 'Crear cuenta', email, name: String(req.body.name || '').slice(0, 80), error });
    if (!name) return render(400, 'Escribe tu nombre y apellidos.');
    if (!isValidEmail(email)) return render(400, 'Introduce un correo válido.');
    if (email !== readEmail(req.body.email2)) return render(400, 'Los dos correos no coinciden.');
    if (findCustomer.get(email)) return render(409, 'Ya hay una cuenta con este correo. Entra con tu contraseña o usa «He olvidado mi contraseña».');

    const password = generatePassword();
    let user;
    try {
      const info = db.prepare(`INSERT INTO users (role, player_name, email, password_hash, lang, activated_at)
        VALUES ('family', ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`).run(name, email, bcrypt.hashSync(password, 10), req.lang);
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    } catch (err) {
      if (/UNIQUE/.test(err.message)) return render(409, 'Ya hay una cuenta con este correo. Entra con tu contraseña o usa «He olvidado mi contraseña».');
      return next(err);
    }
    mailer.accountActivated(user, password, req.appUrl);
    logIn(req, user, (err) => {
      if (err) return next(err);
      res.render('auth/first-access-done', { title: 'Cuenta creada', password, user, email, mailEnabled: mailer.enabled });
    });
  });

  // --- Recuperar contraseña: enlace por correo -> nueva contraseña ---
  router.get('/recuperar', (req, res) => res.render('auth/recover', { title: 'Recuperar acceso' }));

  router.post('/recuperar', limiter(), (req, res) => {
    const user = findLogin.get({ login: readEmail(req.body.usuario) });
    if (user && user.email) {
      const token = generateToken();
      db.prepare('UPDATE reset_tokens SET used_at = ? WHERE user_id = ? AND used_at IS NULL').run(new Date().toISOString(), user.id);
      db.prepare('INSERT INTO reset_tokens (user_id, token_hash, expires_at) VALUES (?, ?, ?)')
        .run(user.id, sha256(token), new Date(Date.now() + 3600 * 1000).toISOString());
      mailer.resetLink(user, `${req.appUrl}/recuperar/${token}`);
    }
    // Mismo mensaje exista o no la cuenta, para no revelar qué correos están registrados.
    res.render('auth/recover', { title: 'Recuperar acceso', sent: true });
  });

  const findToken = db.prepare(`SELECT t.*, u.username, u.email FROM reset_tokens t
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
      res.render('auth/first-access-done', { title: 'Contraseña nueva', password, user, email: user.email, reset: true, mailEnabled: mailer.enabled });
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

  router.post('/cuenta/nombre', requireLogin, (req, res) => {
    const name = readFullName(req.body.name);
    if (!name) {
      flash(req, 'error', 'Escribe tu nombre y apellidos.');
    } else {
      db.prepare('UPDATE users SET player_name = ? WHERE id = ?').run(name, req.user.id);
      flash(req, 'ok', 'Nombre guardado.');
    }
    res.redirect(req.body.back === 'carrito' ? '/carrito' : '/cuenta');
  });

  router.post('/cuenta/email', requireLogin, (req, res) => {
    const email = readEmail(req.body.email);
    if (!isValidEmail(email)) {
      flash(req, 'error', 'Introduce un correo válido.');
    } else if (req.user.role === 'family' && email !== req.user.email && findCustomer.get(email)) {
      flash(req, 'error', 'Ya hay una cuenta con este correo.');
    } else {
      db.prepare('UPDATE users SET email = ? WHERE id = ?').run(email, req.user.id);
      mailer.emailChanged(req.user, email);
      flash(req, 'ok', req.user.role === 'family' ? 'Correo actualizado. A partir de ahora entra con el correo nuevo.' : 'Correo actualizado.');
    }
    res.redirect('/cuenta');
  });

  return router;
};
