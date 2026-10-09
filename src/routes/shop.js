const express = require('express');
const QRCode = require('qrcode');
const { flash, requireFamily } = require('../middleware');
const { shopStatus } = require('../services');
const { localized } = require('../i18n');

module.exports = function shopRoutes({ db, mailer, orders }) {
  const router = express.Router();

  // El catálogo es público; para añadir al carrito hay que entrar como familia.
  router.get('/tienda', (req, res) => {
    if (!req.user) req.session.returnTo = req.originalUrl;
    const categories = db.prepare(`SELECT c.* FROM categories c
      WHERE EXISTS (SELECT 1 FROM products p WHERE p.category_id = c.id AND p.active = 1)
      ORDER BY c.sort_order, c.name`).all();
    const showPacks = !req.query.categoria || req.query.categoria === 'packs';
    const packs = showPacks ? orders.activePacks() : [];
    if (req.query.categoria === 'packs') {
      return res.render('shop/index', { title: 'Tienda', categories, selected: null, products: [], packs, onlyPacks: true });
    }
    const selected = categories.find((c) => c.slug === req.query.categoria) || null;
    const products = selected
      ? db.prepare('SELECT * FROM products WHERE active = 1 AND category_id = ? ORDER BY name').all(selected.id)
      : db.prepare(`SELECT p.* FROM products p LEFT JOIN categories c ON c.id = p.category_id
          WHERE p.active = 1 ORDER BY c.sort_order, p.name`).all();
    res.render('shop/index', { title: 'Tienda', categories, selected, products, packs, onlyPacks: false });
  });

  router.post('/carrito/pack', requireFamily, (req, res) => {
    let back = '/tienda';
    try {
      const ref = new URL(req.get('referer') || '');
      if (ref.pathname === '/tienda') back = ref.pathname + ref.search;
    } catch { /* sin referer válido */ }
    if (!shopStatus(db).open) {
      flash(req, 'error', 'Ahora mismo no hay ningún periodo de pedidos abierto.');
      return res.redirect(back);
    }
    const result = orders.addPackToCart(req.user.id, Number(req.body.pack_id), req.body);
    if (result.error && result.product) {
      flash(req, 'error', '«{name}»: {error}', { name: localized(req.lang, result.product, 'name'), error: req.t(result.error) });
    } else if (result.error) {
      flash(req, 'error', result.error);
    } else {
      flash(req, 'ok', 'Añadido al carrito: {name}.', { name: localized(req.lang, result.pack, 'name') });
    }
    res.redirect(back);
  });

  router.post('/carrito/anadir', requireFamily, (req, res) => {
    let back = '/tienda';
    try {
      const ref = new URL(req.get('referer') || '');
      if (ref.pathname === '/tienda') back = ref.pathname + ref.search;
    } catch { /* sin referer válido */ }
    if (!shopStatus(db).open) {
      flash(req, 'error', 'Ahora mismo no hay ningún periodo de pedidos abierto.');
      return res.redirect(back);
    }
    const product = db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.body.product_id));
    const result = orders.addToCart(req.user.id, product, req.body);
    if (result.error) flash(req, 'error', result.error);
    else flash(req, 'ok', 'Añadido al carrito: {name}.', { name: localized(req.lang, product, 'name') });
    res.redirect(back);
  });

  router.get('/carrito', requireFamily, (req, res) => {
    res.render('shop/cart', { title: 'Carrito', cart: orders.cart(req.user.id) });
  });

  router.post('/carrito/:id/cantidad', requireFamily, (req, res) => {
    const quantity = Number.parseInt(req.body.quantity, 10);
    if (Number.isInteger(quantity) && quantity >= 1 && quantity <= 50) {
      db.prepare('UPDATE cart_items SET quantity = ? WHERE id = ? AND user_id = ?').run(quantity, Number(req.params.id), req.user.id);
    } else {
      flash(req, 'error', 'Cantidad no válida (1-50).');
    }
    res.redirect('/carrito');
  });

  router.post('/carrito/:id/eliminar', requireFamily, (req, res) => {
    db.prepare('DELETE FROM cart_items WHERE id = ? AND user_id = ?').run(Number(req.params.id), req.user.id);
    res.redirect('/carrito');
  });

  router.post('/carrito/confirmar', requireFamily, (req, res) => {
    if (!req.user.player_name) {
      flash(req, 'error', 'Escribe tu nombre y apellidos antes de hacer el pedido.');
      return res.redirect('/carrito');
    }
    const status = shopStatus(db);
    if (!status.open) {
      flash(req, 'error', 'El periodo de pedidos está cerrado. No se pueden hacer pedidos ahora.');
      return res.redirect('/carrito');
    }
    const result = orders.placeOrder(req.user.id, status.current.id);
    if (result.error) {
      flash(req, 'error', result.error, result.params);
      return res.redirect('/carrito');
    }
    mailer.orderPlaced(req.user, result.order, orders.orderItems(result.order.id), req.appUrl);
    flash(req, 'ok', 'Pedido realizado. Enseña el QR de este pedido cuando pagues y cuando recojas el material (también te lo hemos enviado por correo).');
    res.redirect(`/pedidos/${result.order.id}`);
  });

  router.get('/pedidos', requireFamily, (req, res) => {
    const list = db.prepare(`SELECT o.*, (SELECT SUM(quantity) FROM order_items WHERE order_id = o.id AND kind != 'pack') AS units
      FROM orders o WHERE o.user_id = ? ORDER BY o.id DESC`).all(req.user.id);
    const pending = list.filter((o) => o.status === 'pendiente_pago').reduce((s, o) => s + o.total_cents, 0);
    res.render('shop/orders', { title: 'Mis pedidos', list, pending });
  });

  function ownOrder(req, res) {
    const order = orders.getOrder(Number(req.params.id));
    if (!order || order.user_id !== req.user.id) {
      res.status(404).render('error', { title: 'No encontrado', message: 'Ese pedido no existe.' });
      return null;
    }
    return order;
  }

  router.get('/pedidos/:id', requireFamily, async (req, res, next) => {
    try {
      const order = ownOrder(req, res);
      if (!order) return;
      // Un único QR: sirve para cobrar y, una vez pagado, para entregar.
      const token = ['pendiente_pago', 'pendiente_entrega'].includes(order.status) ? order.pay_token : null;
      const qr = token ? await QRCode.toDataURL(`${req.appUrl}/admin/qr/${token}`, { margin: 1, width: 280 }) : null;
      res.render('shop/order', {
        title: 'Pedido', order, items: orders.orderItems(order.id), events: orders.orderEvents(order.id), qr,
      });
    } catch (err) { next(err); }
  });

  router.post('/pedidos/:id/cancelar', requireFamily, (req, res) => {
    const order = ownOrder(req, res);
    if (!order) return;
    if (order.status !== 'pendiente_pago') {
      flash(req, 'error', 'Solo se pueden cancelar pedidos que aún no se han pagado.');
    } else {
      const result = orders.changeStatus(order.id, 'cancelado', req.user.id, 'Cancelado por la familia');
      if (result.error) flash(req, 'error', result.error);
      else {
        mailer.statusChanged(req.user, result.order, req.appUrl);
        flash(req, 'ok', 'Pedido cancelado.');
      }
    }
    res.redirect(`/pedidos/${order.id}`);
  });

  return router;
};
