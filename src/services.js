const { generateToken, parseSizes } = require('./util');
const { bestPacks } = require('./packs');

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
    SELECT c.*, p.name AS product_name, p.name_ca AS product_name_ca, p.price_cents, p.image,
      p.personalization, p.sizes, p.active
    FROM cart_items c JOIN products p ON p.id = c.product_id
    WHERE c.user_id = ? ORDER BY c.id`);

  /** Packs visibles con sus productos; solo los que tienen todos los productos disponibles. */
  function activePacks() {
    const packs = db.prepare('SELECT * FROM packs WHERE active = 1 ORDER BY price_cents, id').all();
    const items = db.prepare(`SELECT pi.*, p.name, p.name_ca, p.price_cents, p.image, p.active, p.sizes, p.colors,
        p.options, p.personalization, p.size_guide
      FROM pack_items pi JOIN products p ON p.id = pi.product_id WHERE pi.pack_id = ? ORDER BY pi.gift, p.id`);
    return packs.map((pack) => ({ ...pack, items: items.all(pack.id) }))
      .filter((pack) => pack.items.some((i) => !i.gift) && pack.items.every((i) => i.active));
  }

  /**
   * Carrito con los packs aplicados automáticamente (la combinación que más ahorra).
   * Devuelve las líneas, los packs aplicados (cada uno con sus unidades y regalos) y los importes.
   */
  function cart(userId) {
    const items = getCart.all(userId);
    const subtotal = items.reduce((sum, it) => sum + it.price_cents * it.quantity, 0);
    const counts = {};
    const prices = {};
    for (const it of items.filter((i) => i.active)) {
      counts[it.product_id] = (counts[it.product_id] || 0) + it.quantity;
      prices[it.product_id] = it.price_cents;
    }
    const picks = bestPacks(counts, prices, activePacks());

    // Asigna unidades concretas del carrito a cada pack (para mostrar qué talla/color va en cada uno).
    const left = new Map(items.map((it) => [it.id, it.active ? it.quantity : 0]));
    const applied = picks.map(({ pack, components, regular, saving }) => ({
      pack, regular, saving,
      units: components.map((productId) => {
        const line = items.find((it) => it.product_id === productId && left.get(it.id) > 0);
        left.set(line.id, left.get(line.id) - 1);
        return line;
      }),
      gifts: pack.items.filter((i) => i.gift),
    }));
    for (const it of items) it.inPack = it.active ? it.quantity - left.get(it.id) : 0;
    const discount = applied.reduce((sum, a) => sum + a.saving, 0);
    return { items, applied, subtotal, discount, total: subtotal - discount };
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
    // Si solo hay un color/opción se asigna sin preguntar.
    const pick = (list, value, error) => {
      if (!list.length) return { value: null };
      if (list.length === 1) return { value: list[0] };
      const v = String(value || '');
      return list.includes(v) ? { value: v } : { error };
    };
    const color = pick(parseSizes(product.colors), input.color, 'Elige un color.');
    if (color.error) return color;
    const option = pick(parseSizes(product.options), input.option_value, 'Elige un modelo.');
    if (option.error) return option;
    let customName = null;
    let customNumber = null;
    // Personalización opcional: hay que elegir expresamente «Sin personalizar» para no dejarlo vacío por error.
    if (product.personalization === 2 && input.no_custom === '1') {
      return { value: { quantity, size, customName, customNumber, color: color.value, option: option.value, noCustom: 1 } };
    }
    if (product.personalization) {
      customName = String(input.custom_name || '').trim().slice(0, 30);
      customNumber = String(input.custom_number || '').trim();
      if (!customName) {
        return { error: product.personalization === 2 ? 'Indica el nombre a personalizar o elige «Sin personalizar».' : 'Indica el nombre a personalizar.' };
      }
      if (!/^\d{1,3}$/.test(customNumber)) return { error: 'Indica un dorsal válido (1-3 cifras).' };
    }
    return { value: { quantity, size, customName, customNumber, color: color.value, option: option.value, noCustom: 0 } };
  }

  function insertLine(userId, productId, { quantity, size, customName, customNumber, color, option, noCustom }) {
    const existing = db.prepare(`
      SELECT id, quantity FROM cart_items WHERE user_id = ? AND product_id = ?
        AND size IS ? AND custom_name IS ? AND custom_number IS ? AND color IS ? AND option_value IS ? AND no_custom = ?`)
      .get(userId, productId, size, customName, customNumber, color, option, noCustom);
    if (existing) {
      db.prepare('UPDATE cart_items SET quantity = MIN(50, quantity + ?) WHERE id = ?').run(quantity, existing.id);
    } else {
      db.prepare(`INSERT INTO cart_items (user_id, product_id, quantity, size, custom_name, custom_number, color, option_value, no_custom)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, productId, quantity, size, customName, customNumber, color, option, noCustom);
    }
  }

  function addToCart(userId, product, input) {
    const res = validateLine(product, input);
    if (res.error) return res;
    insertLine(userId, product.id, res.value);
    return {};
  }

  /**
   * Añade un pack: una unidad de cada producto (los de regalo no: se añaden solos al aplicar el pack).
   * Los campos de cada producto llegan con su id: size_12, color_12, option_value_12, custom_name_12…
   */
  const addPackToCart = db.transaction((userId, packId, input) => {
    const pack = activePacks().find((p) => p.id === packId);
    if (!pack) return { error: 'Este pack ya no está disponible.' };
    const lines = [];
    for (const item of pack.items.filter((i) => !i.gift)) {
      const field = (name) => input[`${name}_${item.product_id}`];
      const res = validateLine({ ...item, id: item.product_id }, {
        quantity: input.quantity || 1, size: field('size'), color: field('color'), option_value: field('option_value'),
        custom_name: field('custom_name'), custom_number: field('custom_number'), no_custom: field('no_custom'),
      });
      if (res.error) return { ...res, product: item };
      lines.push([item.product_id, res.value]);
    }
    for (const [productId, value] of lines) insertLine(userId, productId, value);
    return { pack };
  });

  function uniqueValue(column, gen) {
    const stmt = db.prepare(`SELECT 1 FROM orders WHERE ${column} = ?`);
    for (;;) {
      const v = gen();
      if (!stmt.get(v)) return v;
    }
  }

  const placeOrder = db.transaction((userId, periodId) => {
    const { items, applied, total } = cart(userId);
    if (!items.length) return { error: 'El carrito está vacío.' };
    const unavailable = items.find((it) => !it.active);
    if (unavailable) return { error: '«{name}» ya no está disponible. Quítalo del carrito.', params: { name: unavailable.product_name } };

    const info = db.prepare(`INSERT INTO orders (user_id, status, total_cents, pay_token, period_id)
      VALUES (?, 'pendiente_pago', ?, ?, ?)`)
      .run(userId, total, uniqueValue('pay_token', generateToken), periodId);
    const orderId = info.lastInsertRowid;
    const insertItem = db.prepare(`INSERT INTO order_items
      (order_id, product_id, product_name, product_name_ca, unit_price_cents, quantity, size, custom_name, custom_number,
        color, option_value, kind, no_custom)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const it of items) {
      insertItem.run(orderId, it.product_id, it.product_name, it.product_name_ca, it.price_cents, it.quantity,
        it.size, it.custom_name, it.custom_number, it.color, it.option_value, 'product', it.no_custom ? 1 : 0);
    }
    // Packs aplicados: una línea de descuento (importe negativo) y los regalos a 0 €, agrupados por pack.
    const byPack = new Map();
    for (const a of applied) {
      const entry = byPack.get(a.pack.id) || { ...a, count: 0 };
      entry.count += 1;
      byPack.set(a.pack.id, entry);
    }
    for (const { pack, saving, gifts, count } of byPack.values()) {
      insertItem.run(orderId, null, pack.name, pack.name_ca, -saving, count, null, null, null, null, null, 'pack', 0);
      for (const g of gifts) {
        insertItem.run(orderId, g.product_id, g.name, g.name_ca, 0, count, null, null, null, null, null, 'gift', 0);
      }
    }
    db.prepare('DELETE FROM cart_items WHERE user_id = ?').run(userId);
    db.prepare("INSERT INTO order_events (order_id, status, actor_id) VALUES (?, 'pendiente_pago', ?)").run(orderId, userId);
    return { order: getOrder(orderId) };
  });

  function getOrder(id) {
    return db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
  }

  /**
   * Busca un pedido por su QR. Cada pedido tiene un único QR que sirve para cobrar y para entregar.
   * (Los pedidos antiguos tenían además un QR de recogida: también se acepta.) Devuelve { order } o null.
   */
  function findByToken(token) {
    const t = String(token || '');
    if (!/^[0-9a-f]{64}$/.test(t)) return null;
    const order = db.prepare('SELECT * FROM orders WHERE pay_token = ? OR pickup_token = ?').get(t, t);
    return order ? { order } : null;
  }

  function orderItems(orderId) {
    return db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(orderId);
  }

  function orderEvents(orderId) {
    return db.prepare(`SELECT e.*, u.username, u.dni, u.role FROM order_events e
      LEFT JOIN users u ON u.id = e.actor_id WHERE e.order_id = ? ORDER BY e.id`).all(orderId);
  }

  /**
   * Cambia el estado si la transición es válida. Devuelve { order } o { error }.
   */
  const changeStatus = db.transaction((orderId, newStatus, actorId, note = null) => {
    const order = getOrder(orderId);
    if (!order) return { error: 'Pedido no encontrado.' };
    if (!(TRANSITIONS[order.status] || []).includes(newStatus)) {
      return { error: 'Ese cambio de estado no está permitido.' };
    }
    const now = new Date().toISOString();
    if (newStatus === 'pendiente_entrega' && order.status === 'pendiente_pago') {
      db.prepare('UPDATE orders SET status = ?, paid_at = ?, paid_by = ? WHERE id = ?').run(newStatus, now, actorId, orderId);
    } else if (newStatus === 'pendiente_entrega') { // deshacer entrega
      db.prepare('UPDATE orders SET status = ?, delivered_at = NULL, delivered_by = NULL WHERE id = ?').run(newStatus, orderId);
    } else if (newStatus === 'pendiente_pago') { // deshacer cobro o reactivar cancelado
      db.prepare(`UPDATE orders SET status = ?, paid_at = NULL, paid_by = NULL, ready_at = NULL, cancelled_at = NULL
        WHERE id = ?`).run(newStatus, orderId);
    } else if (newStatus === 'entregado') {
      db.prepare('UPDATE orders SET status = ?, delivered_at = ?, delivered_by = ? WHERE id = ?').run(newStatus, now, actorId, orderId);
    } else if (newStatus === 'cancelado') {
      db.prepare('UPDATE orders SET status = ?, cancelled_at = ? WHERE id = ?').run(newStatus, now, orderId);
    }
    db.prepare('INSERT INTO order_events (order_id, status, note, actor_id) VALUES (?, ?, ?, ?)')
      .run(orderId, newStatus, note, actorId);
    return { order: getOrder(orderId) };
  });

  return { cart, activePacks, addToCart, addPackToCart, validateLine, placeOrder, getOrder, findByToken, orderItems, orderEvents, changeStatus };
}

module.exports = { shopStatus, createOrderService, TRANSITIONS };
