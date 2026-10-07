const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const { flash, requireAdmin } = require('../middleware');
const { TRANSITIONS } = require('../services');
const {
  normalizeDni, isValidDni, isValidEmail, parseMoney, fromLocalInput, slugify, orderCode, STATUS, formatDate,
} = require('../util');

const STATUSES = Object.keys(STATUS);

module.exports = function adminRoutes({ db, mailer, orders, uploadDir }) {
  const router = express.Router();
  router.use(requireAdmin);

  fs.mkdirSync(uploadDir, { recursive: true });
  const upload = multer({
    storage: multer.diskStorage({
      destination: uploadDir,
      filename: (req, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`),
    }),
    limits: { fileSize: 5 * 1024 * 1024 },
    fileFilter: (req, file, cb) => cb(null, /^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)
      && /\.(jpe?g|png|webp|gif)$/i.test(file.originalname)),
  });

  const userOf = (order) => db.prepare('SELECT * FROM users WHERE id = ?').get(order.user_id);
  const collectorName = (user) => user.player_name && user.player_name !== user.username
    ? `${user.player_name} (${user.username})` : user.username;

  function applyStatus(req, order, status, note) {
    const result = orders.changeStatus(order.id, status, req.user.id, note);
    if (result.error) {
      flash(req, 'error', result.error);
      return false;
    }
    mailer.statusChanged(userOf(order), result.order, req.appUrl, collectorName(req.user));
    flash(req, 'ok', 'Pedido {code}: {status}.', { code: orderCode(order.id), status: req.t(STATUS[status].label) });
    return true;
  }

  // ---------- Panel ----------
  router.get('/', (req, res) => {
    const stats = Object.fromEntries(STATUSES.map((s) => [s, { n: 0, total: 0 }]));
    db.prepare('SELECT status, COUNT(*) AS n, SUM(total_cents) AS total FROM orders GROUP BY status').all()
      .forEach((r) => { stats[r.status] = { n: r.n, total: r.total || 0 }; });
    const families = db.prepare(`SELECT COUNT(*) AS total, COUNT(activated_at) AS active
      FROM users WHERE role = 'family'`).get();
    const recent = db.prepare(`SELECT o.*, u.player_name, u.dni FROM orders o JOIN users u ON u.id = o.user_id
      ORDER BY o.id DESC LIMIT 8`).all();
    // Dinero cobrado por cada miembro de la comisión: sirve para cuadrar la caja.
    const cash = db.prepare(`SELECT u.username, u.player_name, COUNT(*) AS n, SUM(o.total_cents) AS total
      FROM orders o LEFT JOIN users u ON u.id = o.paid_by
      WHERE o.status IN ('pendiente_entrega', 'entregado') GROUP BY o.paid_by ORDER BY total DESC`).all();
    const awaitingNotice = db.prepare(`SELECT COUNT(*) AS n FROM orders
      WHERE status = 'pendiente_entrega' AND ready_at IS NULL`).get().n;
    res.render('admin/dashboard', { title: 'Panel de la comisión', stats, families, recent, cash, awaitingNotice });
  });

  // ---------- Pedidos ----------
  function orderFilters(query) {
    const where = [];
    const params = [];
    if (STATUSES.includes(query.estado)) { where.push('o.status = ?'); params.push(query.estado); }
    if (query.periodo) { where.push('o.period_id = ?'); params.push(Number(query.periodo)); }
    if (query.q) {
      const q = `%${String(query.q).trim()}%`;
      where.push('(u.player_name LIKE ? OR u.dni LIKE ? OR u.email LIKE ? OR o.pickup_code LIKE ? OR CAST(o.id AS TEXT) = ?)');
      params.push(q, q, q, q, String(query.q).replace(/^#?0*/, ''));
    }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
  }

  router.get('/pedidos', (req, res) => {
    const { sql, params } = orderFilters(req.query);
    const list = db.prepare(`SELECT o.*, u.player_name, u.dni, u.player_number, u.email,
        (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id) AS units
      FROM orders o JOIN users u ON u.id = o.user_id ${sql} ORDER BY o.id DESC`).all(...params);
    const total = list.reduce((s, o) => s + o.total_cents, 0);
    const periods = db.prepare('SELECT * FROM periods ORDER BY starts_at DESC').all();
    const toNotify = list.filter((o) => o.status === 'pendiente_entrega' && !o.ready_at).length;
    res.render('admin/orders', { title: 'Pedidos', list, total, periods, q: req.query, toNotify });
  });

  router.get('/pedidos.csv', (req, res) => {
    const { sql, params } = orderFilters(req.query);
    const rows = db.prepare(`SELECT o.id, o.status, o.created_at, o.paid_at, o.delivered_at, u.player_name, u.dni,
        u.email, i.product_name, i.size, i.custom_name, i.custom_number, i.quantity, i.unit_price_cents,
        c.username AS collector
      FROM orders o JOIN users u ON u.id = o.user_id JOIN order_items i ON i.order_id = o.id
      LEFT JOIN users c ON c.id = o.paid_by
      ${sql} ORDER BY o.id, i.id`).all(...params);
    const t = req.t;
    const fd = (iso) => formatDate(iso, true, req.lang);
    const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const header = ['Pedido', 'Estado', 'Fecha', 'Pagado', 'Cobrado por', 'Entregado', 'Jugador/a', 'DNI', 'Correo', 'Producto', 'Talla',
      'Nombre', 'Dorsal', 'Cantidad', 'Precio unidad', 'Importe'].map((h) => t(h));
    const lines = rows.map((r) => [orderCode(r.id), t(STATUS[r.status].label), fd(r.created_at), fd(r.paid_at), r.collector,
      fd(r.delivered_at), r.player_name, r.dni, r.email, r.product_name, r.size, r.custom_name, r.custom_number,
      r.quantity, (r.unit_price_cents / 100).toFixed(2).replace('.', ','),
      ((r.unit_price_cents * r.quantity) / 100).toFixed(2).replace('.', ',')].map(esc).join(';'));
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${req.lang === 'ca' ? 'comandes' : 'pedidos'}.csv"`);
    res.send(`\uFEFF${[header.map(esc).join(';'), ...lines].join('\r\n')}`);
  });

  // Aviso masivo «ya podéis recoger» a los pedidos pagados que aún no se han avisado.
  router.post('/pedidos/avisar-recogida', (req, res) => {
    const periodSql = req.body.periodo ? 'AND period_id = ?' : '';
    const pending = db.prepare(`SELECT * FROM orders WHERE status = 'pendiente_entrega' AND ready_at IS NULL ${periodSql}`)
      .all(...(req.body.periodo ? [Number(req.body.periodo)] : []));
    const message = String(req.body.message || '').trim().slice(0, 500);
    const mark = db.prepare('UPDATE orders SET ready_at = ? WHERE id = ?');
    const now = new Date().toISOString();
    for (const order of pending) {
      mark.run(now, order.id);
      mailer.readyForPickup(userOf(order), order, req.appUrl, message);
    }
    flash(req, 'ok', 'Aviso de recogida enviado a {n} familia(s).', { n: pending.length });
    res.redirect('/admin/pedidos?estado=pendiente_entrega');
  });

  router.get('/pedidos/:id', (req, res) => {
    const order = orders.getOrder(Number(req.params.id));
    if (!order) return res.status(404).render('error', { title: 'No encontrado', message: 'Ese pedido no existe.' });
    const people = db.prepare('SELECT id, username FROM users WHERE id IN (?, ?)').all(order.paid_by, order.delivered_by);
    const nameOf = (id) => people.find((p) => p.id === id)?.username;
    res.render('admin/order', {
      title: req.t('Pedido {code}', { code: orderCode(order.id) }), order, family: userOf(order), items: orders.orderItems(order.id),
      events: orders.orderEvents(order.id), transitions: TRANSITIONS[order.status],
      paidBy: nameOf(order.paid_by), deliveredBy: nameOf(order.delivered_by),
    });
  });

  router.post('/pedidos/:id/estado', (req, res) => {
    const order = orders.getOrder(Number(req.params.id));
    if (!order) return res.status(404).render('error', { title: 'No encontrado', message: 'Ese pedido no existe.' });
    const status = String(req.body.status || '');
    let note = String(req.body.note || '').trim().slice(0, 300) || null;
    if (status === 'pendiente_entrega' && order.status === 'pendiente_pago') note = 'Cobrado sin QR';
    if (status === 'entregado') {
      const code = String(req.body.code || '').trim().toUpperCase();
      if (code) {
        if (code !== order.pickup_code) {
          flash(req, 'error', 'El código de recogida no coincide con el de este pedido.');
          return res.redirect(`/admin/pedidos/${order.id}`);
        }
        note = 'Entregado con código de recogida';
      } else if (req.body.force === '1' && note) {
        note = `Entregado SIN QR/código: ${note}`;
      } else {
        flash(req, 'error', 'Para marcar como entregado escanea el QR de recogida o introduce su código.');
        return res.redirect(`/admin/pedidos/${order.id}`);
      }
    }
    applyStatus(req, order, status, note);
    res.redirect(req.body.back === 'list' ? '/admin/pedidos?estado=pendiente_pago' : `/admin/pedidos/${order.id}`);
  });

  // ---------- Escáner: QR de pago / QR de recogida ----------
  router.get('/escanear', (req, res) => {
    if (req.query.codigo) {
      const order = db.prepare('SELECT * FROM orders WHERE pickup_code = ?').get(String(req.query.codigo).trim().toUpperCase());
      if (order) return res.redirect(`/admin/qr/${order.pickup_token}`);
      return res.status(404).render('admin/scan', { title: 'Escanear', error: 'No hay ningún pedido con ese código de recogida.' });
    }
    res.render('admin/scan', { title: 'Escanear' });
  });

  function scanned(req, res) {
    const found = orders.findByToken(req.params.token);
    if (!found) {
      res.status(404).render('error', { title: 'QR no válido', message: 'Este QR no corresponde a ningún pedido. Puede ser un QR antiguo: pide a la familia que abra el pedido en la web.' });
      return null;
    }
    return found;
  }

  router.get('/qr/:token', (req, res) => {
    const found = scanned(req, res);
    if (!found) return;
    const { order, kind } = found;
    res.render('admin/scan-result', {
      title: req.t('Pedido {code}', { code: orderCode(order.id) }), order, kind, token: req.params.token,
      family: userOf(order), items: orders.orderItems(order.id),
    });
  });

  router.post('/qr/:token/cobrar', (req, res) => {
    const found = scanned(req, res);
    if (!found) return;
    if (found.kind !== 'pago' || found.order.status !== 'pendiente_pago') {
      flash(req, 'error', 'Este pedido ya no está pendiente de pago.');
    } else if (applyStatus(req, found.order, 'pendiente_entrega', 'Cobrado con QR de pago')) {
      flash(req, 'ok', 'Cobro registrado. La familia ha recibido el comprobante y el QR de recogida por correo.');
    }
    res.redirect(`/admin/qr/${req.params.token}`);
  });

  router.post('/qr/:token/entregar', (req, res) => {
    const found = scanned(req, res);
    if (!found) return;
    if (found.kind !== 'recogida') {
      flash(req, 'error', 'Este es el QR de pago. Para entregar hay que escanear el QR de recogida.');
    } else {
      applyStatus(req, found.order, 'entregado', 'Entregado con QR de recogida');
    }
    res.redirect(`/admin/qr/${req.params.token}`);
  });

  // ---------- Resumen para el proveedor ----------
  router.get('/resumen', (req, res) => {
    const statuses = (Array.isArray(req.query.estado) ? req.query.estado : [req.query.estado]).filter((s) => STATUSES.includes(s) && s !== 'cancelado');
    const chosen = statuses.length ? statuses : ['pendiente_pago', 'pendiente_entrega', 'entregado'];
    const marks = chosen.map(() => '?').join(',');
    const periodSql = req.query.periodo ? 'AND o.period_id = ?' : '';
    const params = [...chosen, ...(req.query.periodo ? [Number(req.query.periodo)] : [])];
    const lines = db.prepare(`SELECT i.product_name, MAX(i.product_name_ca) AS product_name_ca, i.size, SUM(i.quantity) AS qty, SUM(i.quantity * i.unit_price_cents) AS amount
      FROM order_items i JOIN orders o ON o.id = i.order_id
      WHERE o.status IN (${marks}) ${periodSql}
      GROUP BY i.product_name, i.size ORDER BY i.product_name, i.size`).all(...params);
    const custom = db.prepare(`SELECT i.product_name, i.product_name_ca, i.size, i.custom_name, i.custom_number, i.quantity, o.id AS order_id,
        o.status, u.player_name
      FROM order_items i JOIN orders o ON o.id = i.order_id JOIN users u ON u.id = o.user_id
      WHERE i.custom_name IS NOT NULL AND o.status IN (${marks}) ${periodSql}
      ORDER BY i.product_name, CAST(i.custom_number AS INTEGER)`).all(...params);
    const periods = db.prepare('SELECT * FROM periods ORDER BY starts_at DESC').all();
    res.render('admin/summary', { title: 'Resumen de pedidos', lines, custom, chosen, periods, periodo: req.query.periodo || '' });
  });

  // ---------- Productos ----------
  router.get('/productos', (req, res) => {
    const list = db.prepare(`SELECT p.*, c.name AS category, c.name_ca AS category_ca FROM products p LEFT JOIN categories c ON c.id = p.category_id
      ORDER BY p.active DESC, c.sort_order, p.name`).all();
    res.render('admin/products', { title: 'Productos', list });
  });

  const categories = () => db.prepare('SELECT * FROM categories ORDER BY sort_order, name').all();

  router.get('/productos/nuevo', (req, res) => {
    res.render('admin/product-form', { title: 'Nuevo producto', product: { active: 1 }, categories: categories() });
  });

  router.get('/productos/:id', (req, res) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (!product) return res.status(404).render('error', { title: 'No encontrado', message: 'Ese producto no existe.' });
    res.render('admin/product-form', { title: 'Editar producto', product, categories: categories() });
  });

  function readProduct(req) {
    const b = req.body;
    const data = {
      name: String(b.name || '').trim().slice(0, 100),
      name_ca: String(b.name_ca || '').trim().slice(0, 100) || null,
      description: String(b.description || '').trim().slice(0, 1000) || null,
      description_ca: String(b.description_ca || '').trim().slice(0, 1000) || null,
      category_id: Number(b.category_id) || null,
      price_cents: parseMoney(b.price),
      personalization: b.personalization ? 1 : 0,
      sizes: String(b.sizes || '').split(',').map((s) => s.trim()).filter(Boolean).join(', ') || null,
      active: b.active ? 1 : 0,
    };
    if (!data.name) return { error: 'El nombre es obligatorio.', data };
    if (data.price_cents === null) return { error: 'Precio no válido (ej.: 25 o 12,50).', data };
    return { data };
  }

  function removeUpload(filename) {
    if (filename) fs.promises.unlink(path.join(uploadDir, path.basename(filename))).catch(() => {});
  }

  router.post('/productos', upload.single('image'), (req, res) => {
    const { error, data } = readProduct(req);
    if (error) {
      removeUpload(req.file?.filename);
      return res.status(400).render('admin/product-form', { title: 'Nuevo producto', product: data, categories: categories(), error });
    }
    const info = db.prepare(`INSERT INTO products (name, name_ca, description, description_ca, category_id, price_cents,
        personalization, sizes, active, image)
      VALUES (@name, @name_ca, @description, @description_ca, @category_id, @price_cents, @personalization, @sizes, @active, @image)`)
      .run({ ...data, image: req.file?.filename || null });
    flash(req, 'ok', 'Producto creado.');
    res.redirect(`/admin/productos/${info.lastInsertRowid}`);
  });

  router.post('/productos/:id', upload.single('image'), (req, res) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (!product) return res.status(404).render('error', { title: 'No encontrado', message: 'Ese producto no existe.' });
    const { error, data } = readProduct(req);
    if (error) {
      removeUpload(req.file?.filename);
      return res.status(400).render('admin/product-form', {
        title: 'Editar producto', product: { ...product, ...data }, categories: categories(), error,
      });
    }
    let image = product.image;
    if (req.file) { removeUpload(product.image); image = req.file.filename; } else if (req.body.remove_image) { removeUpload(product.image); image = null; }
    db.prepare(`UPDATE products SET name = @name, name_ca = @name_ca, description = @description,
      description_ca = @description_ca, category_id = @category_id,
      price_cents = @price_cents, personalization = @personalization, sizes = @sizes, active = @active, image = @image
      WHERE id = @id`).run({ ...data, image, id: product.id });
    flash(req, 'ok', 'Producto guardado. Los pedidos ya hechos mantienen el precio con el que se pidieron.');
    res.redirect(`/admin/productos/${product.id}`);
  });

  router.post('/productos/:id/eliminar', (req, res) => {
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id));
    if (product) {
      db.prepare('DELETE FROM products WHERE id = ?').run(product.id);
      removeUpload(product.image);
      flash(req, 'ok', 'Producto «{name}» eliminado. Los pedidos existentes no se ven afectados.', { name: product.name });
    }
    res.redirect('/admin/productos');
  });

  // ---------- Categorías ----------
  router.get('/categorias', (req, res) => {
    const list = db.prepare(`SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id) AS products
      FROM categories c ORDER BY sort_order, name`).all();
    res.render('admin/categories', { title: 'Categorías', list });
  });

  router.post('/categorias', (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 50);
    const nameCa = String(req.body.name_ca || '').trim().slice(0, 50) || null;
    if (!name) {
      flash(req, 'error', 'Escribe un nombre.');
    } else {
      let slug = slugify(name);
      while (db.prepare('SELECT 1 FROM categories WHERE slug = ?').get(slug)) slug += '-2';
      const max = db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS m FROM categories').get().m;
      db.prepare('INSERT INTO categories (name, name_ca, slug, sort_order) VALUES (?, ?, ?, ?)').run(name, nameCa, slug, max + 1);
      flash(req, 'ok', 'Categoría creada.');
    }
    res.redirect('/admin/categorias');
  });

  router.post('/categorias/:id', (req, res) => {
    const name = String(req.body.name || '').trim().slice(0, 50);
    if (name) {
      db.prepare('UPDATE categories SET name = ?, name_ca = ?, sort_order = ? WHERE id = ?')
        .run(name, String(req.body.name_ca || '').trim().slice(0, 50) || null,
          Number.parseInt(req.body.sort_order, 10) || 0, Number(req.params.id));
      flash(req, 'ok', 'Categoría guardada.');
    }
    res.redirect('/admin/categorias');
  });

  router.post('/categorias/:id/eliminar', (req, res) => {
    db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
    flash(req, 'ok', 'Categoría eliminada (sus productos quedan sin categoría).');
    res.redirect('/admin/categorias');
  });

  // ---------- Periodos de pedidos ----------
  router.get('/periodos', (req, res) => {
    const list = db.prepare(`SELECT p.*, (SELECT COUNT(*) FROM orders o WHERE o.period_id = p.id AND o.status != 'cancelado') AS orders
      FROM periods p ORDER BY starts_at DESC`).all();
    res.render('admin/periods', { title: 'Periodos de pedidos', list, now: new Date().toISOString() });
  });

  function readPeriod(body) {
    const name = String(body.name || '').trim().slice(0, 80);
    const starts = fromLocalInput(body.starts_at);
    const ends = fromLocalInput(body.ends_at);
    if (!name || !starts || !ends) return { error: 'Rellena nombre, inicio y fin.' };
    if (ends <= starts) return { error: 'La fecha de cierre debe ser posterior a la de apertura.' };
    return { value: [name, starts, ends] };
  }

  router.post('/periodos', (req, res) => {
    const { error, value } = readPeriod(req.body);
    if (error) flash(req, 'error', error);
    else {
      db.prepare('INSERT INTO periods (name, starts_at, ends_at) VALUES (?, ?, ?)').run(...value);
      flash(req, 'ok', 'Periodo creado.');
    }
    res.redirect('/admin/periodos');
  });

  router.post('/periodos/:id', (req, res) => {
    const { error, value } = readPeriod(req.body);
    if (error) flash(req, 'error', error);
    else {
      db.prepare('UPDATE periods SET name = ?, starts_at = ?, ends_at = ? WHERE id = ?').run(...value, Number(req.params.id));
      flash(req, 'ok', 'Periodo guardado.');
    }
    res.redirect('/admin/periodos');
  });

  router.post('/periodos/:id/cerrar', (req, res) => {
    db.prepare('UPDATE periods SET ends_at = ? WHERE id = ? AND ends_at > ?')
      .run(new Date().toISOString(), Number(req.params.id), new Date().toISOString());
    flash(req, 'ok', 'Periodo cerrado ahora mismo.');
    res.redirect('/admin/periodos');
  });

  router.post('/periodos/:id/eliminar', (req, res) => {
    db.prepare('DELETE FROM periods WHERE id = ?').run(Number(req.params.id));
    flash(req, 'ok', 'Periodo eliminado.');
    res.redirect('/admin/periodos');
  });

  // ---------- Familias (jugadores/as) ----------
  router.get('/familias', (req, res) => {
    const q = `%${String(req.query.q || '').trim()}%`;
    const list = db.prepare(`SELECT u.*,
        (SELECT COUNT(*) FROM orders o WHERE o.user_id = u.id AND o.status != 'cancelado') AS orders,
        (SELECT COALESCE(SUM(total_cents), 0) FROM orders o WHERE o.user_id = u.id AND o.status = 'pendiente_pago') AS pending
      FROM users u WHERE role = 'family' AND (player_name LIKE ? OR dni LIKE ? OR COALESCE(email, '') LIKE ? OR COALESCE(team, '') LIKE ?)
      ORDER BY team, player_name`).all(q, q, q, q);
    res.render('admin/families', { title: 'Familias', list, q: req.query.q || '' });
  });

  function readFamily(body) {
    const dni = normalizeDni(body.dni);
    const value = {
      dni,
      player_name: String(body.player_name || '').trim().slice(0, 80),
      player_number: String(body.player_number || '').trim().slice(0, 3) || null,
      team: String(body.team || '').trim().slice(0, 40) || null,
    };
    if (!/^[A-Z0-9]{5,12}$/.test(dni)) return { error: { key: 'DNI no válido: «{dni}».', params: { dni: body.dni || '' } } };
    if (!value.player_name) return { error: { key: 'Falta el nombre del jugador/a ({dni}).', params: { dni } } };
    return { value, warning: isValidDni(dni) ? null : { key: 'Ojo: la letra del DNI {dni} no parece correcta.', params: { dni } } };
  }

  router.post('/familias', (req, res) => {
    const { error, value, warning } = readFamily(req.body);
    if (error) flash(req, 'error', error.key, error.params);
    else if (db.prepare('SELECT 1 FROM users WHERE dni = ?').get(value.dni)) flash(req, 'error', 'El DNI {dni} ya existe.', { dni: value.dni });
    else {
      db.prepare(`INSERT INTO users (role, dni, player_name, player_number, team)
        VALUES ('family', @dni, @player_name, @player_number, @team)`).run(value);
      flash(req, warning ? 'error' : 'ok', warning ? `${req.t('Jugador/a añadido/a.')} ${req.t(warning.key, warning.params)}` : 'Jugador/a añadido/a.');
    }
    res.redirect('/admin/familias');
  });

  router.post('/familias/importar', (req, res) => {
    const lines = String(req.body.csv || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    let added = 0;
    let updated = 0;
    const problems = [];
    const insert = db.prepare(`INSERT INTO users (role, dni, player_name, player_number, team)
      VALUES ('family', @dni, @player_name, @player_number, @team)
      ON CONFLICT(dni) DO UPDATE SET player_name = excluded.player_name,
        player_number = excluded.player_number, team = excluded.team`);
    db.transaction(() => {
      for (const line of lines) {
        const [dni, playerName, number, team] = line.split(/[;,\t]/).map((s) => s.trim());
        if (/^dni$/i.test(dni)) continue; // cabecera
        const { error, value, warning } = readFamily({ dni, player_name: playerName, player_number: number, team });
        if (error) { problems.push(req.t(error.key, error.params)); continue; }
        if (warning) problems.push(req.t(warning.key, warning.params));
        const exists = db.prepare('SELECT 1 FROM users WHERE dni = ?').get(value.dni);
        insert.run(value);
        if (exists) updated++; else added++;
      }
    })();
    const msg = req.t('Importación: {added} nuevos, {updated} actualizados.', { added, updated });
    flash(req, problems.length ? 'error' : 'ok', problems.length ? `${msg} ${req.t('Revisa:')} ${problems.join(' ')}` : msg);
    res.redirect('/admin/familias');
  });

  router.get('/familias/:id', (req, res) => {
    const family = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'family'").get(Number(req.params.id));
    if (!family) return res.status(404).render('error', { title: 'No encontrado', message: 'Esa familia no existe.' });
    const list = db.prepare('SELECT * FROM orders WHERE user_id = ? ORDER BY id DESC').all(family.id);
    res.render('admin/family', { title: family.player_name, family, list });
  });

  router.post('/familias/:id', (req, res) => {
    const family = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'family'").get(Number(req.params.id));
    if (!family) return res.redirect('/admin/familias');
    const { error, value } = readFamily(req.body);
    const email = String(req.body.email || '').trim().toLowerCase() || null;
    if (error) flash(req, 'error', error.key, error.params);
    else if (email && !isValidEmail(email)) flash(req, 'error', 'Correo no válido.');
    else if (value.dni !== family.dni && db.prepare('SELECT 1 FROM users WHERE dni = ?').get(value.dni)) flash(req, 'error', 'Ese DNI ya existe.');
    else {
      db.prepare(`UPDATE users SET dni = @dni, player_name = @player_name, player_number = @player_number, team = @team,
        email = @email WHERE id = @id`).run({ ...value, email, id: family.id });
      flash(req, 'ok', 'Datos guardados.');
    }
    res.redirect(`/admin/familias/${family.id}`);
  });

  router.post('/familias/:id/reiniciar', (req, res) => {
    db.transaction(() => {
      db.prepare("UPDATE users SET password_hash = NULL, activated_at = NULL, email = NULL WHERE id = ? AND role = 'family'")
        .run(Number(req.params.id));
      db.prepare("DELETE FROM sessions WHERE json_extract(data, '$.userId') = ?").run(Number(req.params.id));
    })();
    flash(req, 'ok', 'Acceso reiniciado: la familia deberá volver a hacer el «Primer acceso».');
    res.redirect(`/admin/familias/${req.params.id}`);
  });

  router.post('/familias/:id/eliminar', (req, res) => {
    const id = Number(req.params.id);
    if (db.prepare('SELECT 1 FROM orders WHERE user_id = ?').get(id)) {
      flash(req, 'error', 'No se puede eliminar: tiene pedidos. Puedes reiniciar su acceso.');
      return res.redirect(`/admin/familias/${id}`);
    }
    db.prepare("DELETE FROM users WHERE id = ? AND role = 'family'").run(id);
    flash(req, 'ok', 'Eliminado/a.');
    res.redirect('/admin/familias');
  });

  // ---------- Administradores ----------
  router.get('/admins', (req, res) => {
    const list = db.prepare("SELECT * FROM users WHERE role = 'admin' ORDER BY username").all();
    res.render('admin/admins', { title: 'Comisión (administradores)', list });
  });

  router.post('/admins', (req, res) => {
    const username = String(req.body.username || '').trim().toLowerCase();
    const email = String(req.body.email || '').trim().toLowerCase() || null;
    const password = String(req.body.password || '');
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) flash(req, 'error', 'Usuario no válido (3-30 letras, números, . _ -).');
    else if (password.length < 10) flash(req, 'error', 'La contraseña debe tener al menos 10 caracteres.');
    else if (email && !isValidEmail(email)) flash(req, 'error', 'Correo no válido.');
    else if (db.prepare('SELECT 1 FROM users WHERE username = ? OR dni = ?').get(username, normalizeDni(username))) flash(req, 'error', 'Ese usuario ya existe.');
    else {
      db.prepare(`INSERT INTO users (role, username, email, password_hash, activated_at, player_name)
        VALUES ('admin', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)`)
        .run(username, email, bcrypt.hashSync(password, 10), String(req.body.name || '').trim() || username);
      flash(req, 'ok', 'Administrador «{name}» creado.', { name: username });
    }
    res.redirect('/admin/admins');
  });

  router.post('/admins/:id/eliminar', (req, res) => {
    const id = Number(req.params.id);
    if (id === req.user.id) flash(req, 'error', 'No puedes eliminarte a ti mismo.');
    else {
      db.prepare("DELETE FROM users WHERE id = ? AND role = 'admin'").run(id);
      flash(req, 'ok', 'Administrador eliminado.');
    }
    res.redirect('/admin/admins');
  });

  // ---------- Registro de correos ----------
  router.get('/emails', (req, res) => {
    const list = db.prepare('SELECT * FROM email_log ORDER BY id DESC LIMIT 200').all();
    res.render('admin/emails', { title: 'Correos enviados', list, smtp: Boolean(process.env.SMTP_HOST) });
  });

  return router;
};
