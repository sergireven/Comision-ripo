const { generateToken, randomString, parseSizes } = require('./util');

/** Estado de la tienda según los periodos de pedidos definidos por la comisión. */
function shopStatus(db, now = new Date()) {
  const iso = now.toISOString();
  const current = db.prepare(
    'SELECT * FROM periods WHERE starts_at <= ? AND ends_at > ? ORDER BY ends_at DESC LIMIT 1',
  ).get(iso, iso);
  const next = current ? null : db.prepare(
    'SELECT * FROM periods WHERE starts_at > ? ORDER BY starts_at ASC LIMIT 1',
  ).get(iso);
  return { open: Boolean(current), current, next };
}

const TRANSITIONS = {
  // estado actual -> estados permitidos (admin)
  pendiente_pago: ['pendiente_entrega', 'cancelado'],
  pendiente_entrega: ['entregado', 'pendiente_pago'],
  entregado: ['pendiente_entrega'],
  cancelado: ['pendiente_pago'],
};

function createOrderService(db) {
  const getCart = db.prepare(`
    SELECT c.*, p.name AS product_name, p.price_cents, p.image, p.personalization, p.sizes, p.active
    FROM cart_items c JOIN products p ON p.id = c.product_id
    WHERE c.user_id = ? ORDER BY c.id`);

  function cart(userId) {
    const items = getCart.all(userId);
    const total = items.reduce((sum, it) => sum + it.price_cents * it.quantity, 0);
    return { items, total };
  }

  /** Valida y normaliza una línea de carrito. Devuelve { error } o { value }. */
  function validateLine(product, input) {
    if (!product || !product.active) return { error: 'Este producto ya no está disponible.' };
    const quantity = Number.parseInt(input.quantity, 10);
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 50) return { error: 'Cantidad no válida (1-50).' };
    const sizes = parseSizes(product.sizes);
    let size = null;
    if (sizes.length) {
      size = String(input.size || '');
      if (!sizes.includes(size)) return { error: 'Elige una talla.' };
    }
    let customName = null;
    let customNumber = null;
    if (product.personalization) {
      customName = String(input.custom_name || '').trim().slice(0, 30);
      customNumber = String(input.custom_number || '').trim();
      if (!customName) return { error: 'Indica el nombre a personalizar.' };
      if (!/^\d{1,3}$/.test(customNumber)) return { error: 'Indica un dorsal válido (1-3 cifras).' };
    }
    return { value: { quantity, size, customName, customNumber } };
  }

  function addToCart(userId, product, input) {
    const res = validateLine(product, input);
    if (res.error) return res;
    const { quantity, size, customName, customNumber } = res.value;
    const existing = db.prepare(`
      SELECT id, quantity FROM cart_items WHERE user_id = ? AND product_id = ?
        AND size IS ? AND custom_name IS ? AND custom_number IS ?`)
      .get(userId, product.id, size, customName, customNumber);
    if (existing) {
      db.prepare('UPDATE cart_items SET quantity = MIN(50, quantity + ?) WHERE id = ?').run(quantity, existing.id);
    } else {
      db.prepare(`INSERT INTO cart_items (user_id, product_id, quantity, size, custom_name, custom_number)
        VALUES (?, ?, ?, ?, ?, ?)`).run(userId, product.id, quantity, size, customName, customNumber);
    }
    return {};
  }

  function uniqueValue(column, gen) {
    const stmt = db.prepare(`SELECT 1 FROM orders WHERE ${column} = ?`);
    for (;;) {
      const v = gen();
      if (!stmt.get(v)) return v;
    }
  }

  const placeOrder = db.transaction((userId, periodId) => {
    const { items, total } = cart(userId);
    if (!items.length) return { error: 'El carrito está vacío.' };
    const unavailable = items.find((it) => !it.active);
    if (unavailable) return { error: `"${unavailable.product_name}" ya no está disponible. Quítalo del carrito.` };

    const info = db.prepare(`INSERT INTO orders (user_id, status, total_cents, qr_token, delivery_code, period_id)
      VALUES (?, 'pendiente_pago', ?, ?, ?, ?)`)
      .run(userId, total, uniqueValue('qr_token', generateToken), uniqueValue('delivery_code', () => randomString(6)), periodId);
    const orderId = info.lastInsertRowid;
    const insertItem = db.prepare(`INSERT INTO order_items
      (order_id, product_id, product_name, unit_price_cents, quantity, size, custom_name, custom_number)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const it of items) {
      insertItem.run(orderId, it.product_id, it.product_name, it.price_cents, it.quantity, it.size, it.custom_name, it.custom_number);
    }
    db.prepare('DELETE FROM cart_items WHERE user_id = ?').run(userId);
    db.prepare("INSERT INTO order_events (order_id, status, actor_id) VALUES (?, 'pendiente_pago', ?)").run(orderId, userId);
    return { order: getOrder(orderId) };
  });

  function getOrder(id) {
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  }

  function orderItems(orderId) {
    return db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
  }

  function orderEvents(orderId) {
    return db.prepare(`SELECT e.*, u.username, u.dni, u.role FROM order_events e
      LEFT JOIN users u ON u.id = e.actor_id WHERE e.order_id = ? ORDER BY e.id`).all(orderId);
  }

  /** Cambia el estado si la transición es válida. Devuelve el pedido actualizado o { error }. */
  const changeStatus = db.transaction((orderId, newStatus, actorId, note = null) => {
    const order = getOrder(orderId);
    if (!order) return { error: 'Pedido no encontrado.' };
    if (!(TRANSITIONS[order.status] || []).includes(newStatus)) {
      return { error: 'Ese cambio de estado no está permitido.' };
    }
    const stamps = {
      pendiente_pago: 'paid_at = NULL, cancelled_at = NULL',
      pendiente_entrega: "paid_at = COALESCE(paid_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), delivered_at = NULL",
      entregado: "delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
      cancelado: "cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')",
    };
    db.prepare(`UPDATE orders SET status = ?, ${stamps[newStatus]} WHERE id = ?`).run(newStatus, orderId);
    db.prepare('INSERT INTO order_events (order_id, status, note, actor_id) VALUES (?, ?, ?, ?)')
      .run(orderId, newStatus, note, actorId);
    return { order: getOrder(orderId) };
  });

  return { cart, addToCart, validateLine, placeOrder, getOrder, orderItems, orderEvents, changeStatus };
}

module.exports = { shopStatus, createOrderService, TRANSITIONS };
