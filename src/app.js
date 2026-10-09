const path = require('path');
const crypto = require('crypto');
const express = require('express');
const QRCode = require('qrcode');
const session = require('express-session');
const { SqliteStore } = require('./session-store');
const { createMailer } = require('./mailer');
const { shopStatus, createOrderService } = require('./services');
const util = require('./util');
const { getSettings } = require('./settings');
const { LANGS, translate, detectLang, localized } = require('./i18n');

// Cambia en cada arranque: tras publicar, los navegadores cargan el CSS y el JS nuevos aunque tengan los viejos guardados.
const ASSET_VERSION = Date.now().toString(36);

function setLocale(req, res, lang) {
  req.lang = lang;
  req.t = (key, params) => translate(lang, key, params);
  Object.assign(res.locals, {
    lang,
    t: req.t,
    loc: (obj, field) => localized(lang, obj, field),
    formatDate: (iso, withTime) => util.formatDate(iso, withTime, lang),
    statusLabel: (status) => req.t(util.STATUS[status].label),
  });
}

function createApp(db, options = {}) {
  const app = express();
  const mailer = options.mailer || createMailer(db);
  const orders = createOrderService(db);
  const uploadDir = options.uploadDir || process.env.UPLOAD_DIR || path.join(__dirname, '..', 'uploads');
  const ctx = { db, mailer, orders, uploadDir };

  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '..', 'views'));
  if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Frame-Options', 'DENY');
    res.set('Referrer-Policy', 'same-origin');
    next();
  });
  app.use((req, res, next) => {
    // Valores por defecto para poder pintar páginas de error aunque falle algo antes de cargar la sesión.
    Object.assign(res.locals, util, {
      user: null, csrf: '', path: req.path, flash: null, cartCount: 0, shop: { open: false }, site: {},
      clubName: process.env.CLUB_NAME || 'Club Hoquei Ripollet', assetVersion: ASSET_VERSION,
    });
    setLocale(req, res, detectLang(req));
    next();
  });
  app.use('/static', express.static(path.join(__dirname, '..', 'public'), { maxAge: '1h' }));
  app.get('/static/vendor/jsQR.js', (req, res) => res.sendFile(require.resolve('jsqr/dist/jsQR.js')));
  app.use('/uploads', express.static(uploadDir, { maxAge: '1d' }));
  app.use(express.urlencoded({ extended: false, limit: '200kb' }));

  app.use(session({
    store: new SqliteStore(db),
    name: 'ripo.sid',
    secret: process.env.SESSION_SECRET || 'cambia-este-secreto-en-produccion',
    resave: false,
    saveUninitialized: false,
    rolling: true,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE === 'true',
      maxAge: 1000 * 60 * 60 * 24 * 14,
    },
  }));

  // Usuario actual + variables comunes para las vistas.
  const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
  const cartCount = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS n FROM cart_items WHERE user_id = ?');
  app.use((req, res, next) => {
    if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
    req.user = req.session.userId ? getUser.get(req.session.userId) : null;
    if (req.session.userId && !req.user) delete req.session.userId;
    req.appUrl = (process.env.APP_URL || `${req.protocol}://${req.get('host')}`).replace(/\/$/, '');

    setLocale(req, res, detectLang(req, req.user));
    Object.assign(res.locals, {
      user: req.user,
      csrf: req.session.csrf,
      path: req.path,
      shop: shopStatus(db),
      site: getSettings(db),
      cartCount: req.user?.role === 'family' ? cartCount.get(req.user.id).n : 0,
      flash: req.session.flash || null,
      clubName: process.env.CLUB_NAME || 'Club Hoquei Ripollet',
    });
    delete req.session.flash;
    next();
  });

  // Protección CSRF para todos los formularios (los multipart llevan el token en la URL).
  app.use((req, res, next) => {
    if (req.method !== 'POST') return next();
    const token = req.body?._csrf || req.query._csrf;
    const expected = req.session.csrf;
    if (!token || token.length !== expected.length
      || !crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))) {
      return res.status(403).render('error', { title: 'Sesión caducada', message: 'El formulario ha caducado. Vuelve atrás, recarga la página e inténtalo de nuevo.' });
    }
    next();
  });

  // Cambio de idioma (se recuerda en una cookie y en la cuenta, para que los correos lleguen en ese idioma).
  const setUserLang = db.prepare('UPDATE users SET lang = ? WHERE id = ?');
  app.get('/idioma/:lang', (req, res) => {
    const lang = LANGS.includes(req.params.lang) ? req.params.lang : 'ca';
    res.cookie('lang', lang, { maxAge: 365 * 86400000, sameSite: 'lax', httpOnly: true });
    if (req.user) setUserLang.run(lang, req.user.id);
    let back = '/';
    try {
      const ref = new URL(req.get('referer') || '');
      if (ref.host === req.get('host')) back = ref.pathname + ref.search;
    } catch { /* sin referer válido */ }
    res.redirect(back);
  });

  // Imagen del QR para los correos (Brevo no permite incrustarla). Solo para tokens de pedidos que existen;
  // el token (64 hex, imposible de adivinar) ya va en el propio correo, así que no expone nada nuevo.
  app.get('/qr-img/:token.png', async (req, res, next) => {
    try {
      if (!orders.findByToken(req.params.token)) return res.status(404).end();
      const png = await QRCode.toBuffer(`${req.appUrl}/admin/qr/${req.params.token}`, { width: 320, margin: 2 });
      res.set('Cache-Control', 'private, max-age=86400').type('png').send(png);
    } catch (err) { next(err); }
  });

  app.use(require('./routes/site')(ctx));
  app.use(require('./routes/auth')(ctx));
  app.use(require('./routes/shop')(ctx));
  app.use('/admin', require('./routes/admin')(ctx));

  app.use((req, res) => res.status(404).render('error', { title: 'No encontrado', message: 'La página que buscas no existe.' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    const message = err.code === 'LIMIT_FILE_SIZE' ? 'La imagen es demasiado grande (máx. 5 MB).' : 'Ha ocurrido un error inesperado.';
    res.status(err.status || 500).render('error', { title: 'Error', message });
  });

  return app;
}

module.exports = { createApp };
