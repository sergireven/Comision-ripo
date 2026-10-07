process.env.NODE_ENV = 'test';
const test = require('node:test');
const assert = require('node:assert');
const os = require('os');
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { openDb } = require('../src/db');
const { createApp } = require('../src/app');
const { fromLocalInput, toLocalInput, isValidDni } = require('../src/util');

function setup() {
  const db = openDb(':memory:');
  const sent = [];
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripo-'));
  const server = createApp(db, { uploadDir }).listen(0);
  test.after(() => server.close());
  const app = server;
  // Captura los correos registrados en email_log.
  const mails = () => db.prepare('SELECT * FROM email_log ORDER BY id').all();
  db.prepare(`INSERT INTO users (role, username, password_hash, activated_at) VALUES ('admin', 'comision', ?, 'x')`)
    .run(bcrypt.hashSync('admin-password', 4));
  db.prepare(`INSERT INTO users (role, dni, player_name, player_number) VALUES ('family', '12345678Z', 'Laia Pérez', '7')`).run();
  return { db, app, sent, mails };
}

async function csrfOf(agent, url) {
  const res = await agent.get(url);
  const m = /name="_csrf" value="([0-9a-f]+)"/.exec(res.text);
  assert.ok(m, `sin token CSRF en ${url}`);
  return m[1];
}

async function login(agent, usuario, password) {
  const _csrf = await csrfOf(agent, '/login');
  return agent.post('/login').type('form').send({ _csrf, usuario, password });
}

const wait = () => new Promise((r) => setTimeout(r, 30));

test('utilidades de fechas y DNI', () => {
  assert.strictEqual(fromLocalInput('2026-07-01T10:00'), '2026-07-01T08:00:00.000Z'); // verano UTC+2
  assert.strictEqual(fromLocalInput('2026-12-01T10:00'), '2026-12-01T09:00:00.000Z'); // invierno UTC+1
  assert.strictEqual(toLocalInput('2026-12-01T09:00:00.000Z'), '2026-12-01T10:00');
  assert.ok(isValidDni('12345678Z'));
  assert.ok(isValidDni('x1234567l'));
  assert.ok(!isValidDni('12345678A'));
});

test('flujo completo: primer acceso, pedido, pago y entrega con QR', async () => {
  const { db, app, mails } = setup();
  const fam = request.agent(app);
  const adm = request.agent(app);

  // DNI desconocido
  let _csrf = await csrfOf(fam, '/primer-acceso');
  let res = await fam.post('/primer-acceso').type('form').send({ _csrf, dni: '00000000T' });
  assert.strictEqual(res.status, 404);

  // Primer acceso
  res = await fam.post('/primer-acceso').type('form').send({ _csrf, dni: '12345678-z' });
  assert.match(res.text, /Laia Pérez/);
  res = await fam.post('/primer-acceso').type('form').send({ _csrf, dni: '12345678Z', step: '2', email: 'fam@example.com', email2: 'fam@example.com' });
  assert.strictEqual(res.status, 200);
  const password = /class="secret">([^<]+)</.exec(res.text)[1];
  assert.match(password, /^RIPO-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  await wait();
  assert.ok(mails().some((m) => m.to_address === 'fam@example.com' && /activ|acceso/i.test(m.subject)));
  assert.ok(!mails().some((m) => m.body.includes(password)), 'la contraseña no se guarda en el registro');

  // Segundo intento de activar: rechazado
  const other = request.agent(app);
  _csrf = await csrfOf(other, '/primer-acceso');
  res = await other.post('/primer-acceso').type('form').send({ _csrf, dni: '12345678Z', step: '2', email: 'x@x.com', email2: 'x@x.com' });
  assert.strictEqual(res.status, 409);

  // Login con la contraseña generada
  res = await login(request.agent(app), '12345678z', password);
  assert.strictEqual(res.status, 302);

  // Admin: producto personalizado y otro con tallas
  res = await login(adm, 'comision', 'admin-password');
  assert.strictEqual(res.headers.location, '/');
  _csrf = await csrfOf(adm, '/admin/productos/nuevo');
  res = await adm.post(`/admin/productos?_csrf=${_csrf}`)
    .field('name', 'Botellero').field('price', '12,50').field('personalization', '1').field('active', '1')
    .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'b.png', contentType: 'image/png' });
  assert.strictEqual(res.status, 302);
  res = await adm.post(`/admin/productos?_csrf=${_csrf}`)
    .field('name', 'Sudadera').field('price', '30').field('sizes', 'S, M').field('active', '1');
  assert.strictEqual(res.status, 302);
  const [botella, sudadera] = db.prepare('SELECT * FROM products ORDER BY id').all();
  assert.strictEqual(botella.price_cents, 1250);
  assert.ok(botella.image);

  // Sin periodo abierto no se puede añadir
  _csrf = await csrfOf(fam, '/tienda');
  res = await fam.post('/carrito/anadir').type('form').send({ _csrf, product_id: sudadera.id, quantity: 1, size: 'M' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM cart_items').get().n, 0);

  // Admin abre periodo
  const local = (ms) => toLocalInput(new Date(Date.now() + ms).toISOString());
  res = await adm.post('/admin/periodos').type('form').send({ _csrf: await csrfOf(adm, '/admin/periodos'), name: 'Navidad', starts_at: local(-3600e3), ends_at: local(86400e3) });
  res = await fam.get('/tienda');
  assert.match(res.text, /Pedidos abiertos/);
  assert.match(res.text, /data-countdown/);

  // Validaciones de carrito
  res = await fam.post('/carrito/anadir').type('form').send({ _csrf, product_id: sudadera.id, quantity: 1 });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM cart_items').get().n, 0, 'talla obligatoria');
  res = await fam.post('/carrito/anadir').type('form').send({ _csrf, product_id: botella.id, quantity: 1, custom_name: 'Laia' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM cart_items').get().n, 0, 'dorsal obligatorio');

  await fam.post('/carrito/anadir').type('form').send({ _csrf, product_id: sudadera.id, quantity: 2, size: 'M' });
  await fam.post('/carrito/anadir').type('form').send({ _csrf, product_id: botella.id, quantity: 1, custom_name: 'Laia', custom_number: '7' });
  res = await fam.get('/carrito');
  assert.match(res.text, /72,50/);

  // Confirmar pedido
  res = await fam.post('/carrito/confirmar').type('form').send({ _csrf });
  assert.strictEqual(res.status, 302);
  const order = db.prepare('SELECT * FROM orders').get();
  assert.strictEqual(order.status, 'pendiente_pago');
  assert.strictEqual(order.total_cents, 7250);
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM cart_items').get().n, 0);

  // Otra familia no puede ver el pedido; el admin sí
  res = await fam.get(`/pedidos/${order.id}`);
  assert.match(res.text, /Pendiente de pago/);
  assert.doesNotMatch(res.text, /data:image\/png/, 'sin QR hasta pagar');

  // El admin no puede entregar sin pagar
  res = await adm.get(`/admin/entrega/${order.qr_token}`);
  assert.match(res.text, /todavía no está pagado/);

  // Admin marca pagado
  const admCsrf = await csrfOf(adm, `/admin/pedidos/${order.id}`);
  await adm.post(`/admin/pedidos/${order.id}/estado`).type('form').send({ _csrf: admCsrf, status: 'pendiente_entrega' });
  assert.strictEqual(db.prepare('SELECT status FROM orders').get().status, 'pendiente_entrega');

  // La familia ya no puede cancelar y ve el QR
  res = await fam.post(`/pedidos/${order.id}/cancelar`).type('form').send({ _csrf });
  assert.strictEqual(db.prepare('SELECT status FROM orders').get().status, 'pendiente_entrega');
  res = await fam.get(`/pedidos/${order.id}`);
  assert.match(res.text, /data:image\/png/);
  assert.match(res.text, new RegExp(order.delivery_code));

  // Entregado sin código: rechazado; con código incorrecto: rechazado
  await adm.post(`/admin/pedidos/${order.id}/estado`).type('form').send({ _csrf: admCsrf, status: 'entregado' });
  await adm.post(`/admin/pedidos/${order.id}/estado`).type('form').send({ _csrf: admCsrf, status: 'entregado', code: 'AAAAAA' });
  assert.strictEqual(db.prepare('SELECT status FROM orders').get().status, 'pendiente_entrega');

  // Una familia no puede usar la URL del QR
  res = await fam.get(`/admin/entrega/${order.qr_token}`);
  assert.strictEqual(res.status, 403);

  // Escaneo del QR por la comisión
  res = await adm.post(`/admin/entrega/${order.qr_token}`).type('form').send({ _csrf: admCsrf });
  assert.strictEqual(db.prepare('SELECT status FROM orders').get().status, 'entregado');

  await wait();
  const subjects = mails().filter((m) => m.to_address === 'fam@example.com').map((m) => m.subject).join('\n');
  assert.match(subjects, /recibido/);
  assert.match(subjects, /Pagado/);
  assert.match(subjects, /Entregado/);

  // Resumen y CSV
  res = await adm.get('/admin/resumen');
  assert.match(res.text, /Sudadera/);
  assert.match(res.text, /Laia/);
  res = await adm.get('/admin/pedidos.csv');
  assert.match(res.text, /Botellero/);
  res = await adm.get('/admin');
  assert.strictEqual(res.status, 200);
});

test('cancelación por la familia y recuperación de contraseña', async () => {
  const { db, app } = setup();
  db.prepare("UPDATE users SET email = 'f@example.com', password_hash = ?, activated_at = 'x' WHERE dni = '12345678Z'").run(bcrypt.hashSync('vieja-clave', 4));
  db.prepare("INSERT INTO products (name, price_cents) VALUES ('Bufanda', 1000)").run();
  db.prepare('INSERT INTO periods (name, starts_at, ends_at) VALUES (?, ?, ?)')
    .run('P', new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 1e6).toISOString());
  const fam = request.agent(app);
  await login(fam, '12345678Z', 'vieja-clave');
  const _csrf = await csrfOf(fam, '/tienda');
  await fam.post('/carrito/anadir').type('form').send({ _csrf, product_id: 1, quantity: 3 });
  await fam.post('/carrito/confirmar').type('form').send({ _csrf });
  await fam.post('/pedidos/1/cancelar').type('form').send({ _csrf });
  assert.strictEqual(db.prepare('SELECT status FROM orders').get().status, 'cancelado');

  // Petición sin CSRF rechazada
  const res403 = await fam.post('/carrito/confirmar').type('form').send({});
  assert.strictEqual(res403.status, 403);

  // Recuperar: se crea un token; con él se genera nueva contraseña
  const anon = request.agent(app);
  const c2 = await csrfOf(anon, '/recuperar');
  await anon.post('/recuperar').type('form').send({ _csrf: c2, usuario: '12345678Z' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM reset_tokens').get().n, 1);
  // Simula el enlace: se sustituye el hash por uno conocido
  const { sha256 } = require('../src/util');
  db.prepare('UPDATE reset_tokens SET token_hash = ?').run(sha256('tok'));
  const c3 = await csrfOf(anon, '/recuperar/tok');
  const res = await anon.post('/recuperar/tok').type('form').send({ _csrf: c3 });
  const newPassword = /class="secret">([^<]+)</.exec(res.text)[1];
  assert.strictEqual((await login(request.agent(app), '12345678Z', newPassword)).status, 302);
  assert.strictEqual((await login(request.agent(app), '12345678Z', 'vieja-clave')).status, 401);
  // Token de un solo uso
  assert.strictEqual((await anon.get('/recuperar/tok')).status, 400);
});
