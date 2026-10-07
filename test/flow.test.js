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
  assert.ok(mails().some((m) => m.to_address === 'fam@example.com' && /activ|acc[eé]s/i.test(m.subject)));
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
  assert.match(res.text, /Comandes obertes|Pedidos abiertos/);
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

  // La familia ve el QR de PAGO mientras está pendiente de pago
  res = await fam.get(`/pedidos/${order.id}`);
  assert.match(res.text, /Pendiente de pago|Pendent de pagament/);
  assert.match(res.text, /data:image\/png/);
  assert.strictEqual(order.pickup_token, null, 'sin QR de recogida hasta pagar');

  // Una familia no puede usar la URL del QR
  res = await fam.get(`/admin/qr/${order.pay_token}`);
  assert.strictEqual(res.status, 403);

  // La comisión escanea el QR de pago: ve el botón de cobrar, no el de entregar
  res = await adm.get(`/admin/qr/${order.pay_token}`);
  assert.match(res.text, /\/cobrar/);
  assert.doesNotMatch(res.text, /\/entregar/);
  const admCsrf = await csrfOf(adm, `/admin/qr/${order.pay_token}`);

  // Con el QR de pago no se puede entregar
  await adm.post(`/admin/qr/${order.pay_token}/entregar`).type('form').send({ _csrf: admCsrf });
  assert.strictEqual(db.prepare('SELECT status FROM orders').get().status, 'pendiente_pago');

  // Cobro con el QR de pago -> se genera el QR de recogida
  await adm.post(`/admin/qr/${order.pay_token}/cobrar`).type('form').send({ _csrf: admCsrf });
  let paid = db.prepare('SELECT * FROM orders').get();
  assert.strictEqual(paid.status, 'pendiente_entrega');
  assert.match(paid.pickup_token, /^[0-9a-f]{64}$/);
  assert.match(paid.pickup_code, /^[A-Z2-9]{6}$/);
  assert.strictEqual(paid.paid_by, 1);

  // Cobrar dos veces no hace nada
  await adm.post(`/admin/qr/${order.pay_token}/cobrar`).type('form').send({ _csrf: admCsrf });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM order_events WHERE status = ?').get('pendiente_entrega').n, 1);

  // Al volver a escanear el QR de pago, avisa de que ya está pagado
  res = await adm.get(`/admin/qr/${order.pay_token}`);
  assert.doesNotMatch(res.text, /\/cobrar"/);

  // La familia ya no puede cancelar y ve el QR de recogida + código
  res = await fam.post(`/pedidos/${order.id}/cancelar`).type('form').send({ _csrf });
  assert.strictEqual(db.prepare('SELECT status FROM orders').get().status, 'pendiente_entrega');
  res = await fam.get(`/pedidos/${order.id}`);
  assert.match(res.text, new RegExp(paid.pickup_code));

  // Deshacer el cobro invalida el QR de recogida; al volver a cobrar se genera otro
  let c = await csrfOf(adm, `/admin/pedidos/${order.id}`);
  await adm.post(`/admin/pedidos/${order.id}/estado`).type('form').send({ _csrf: c, status: 'pendiente_pago' });
  assert.strictEqual((await adm.get(`/admin/qr/${paid.pickup_token}`)).status, 404);
  await adm.post(`/admin/pedidos/${order.id}/estado`).type('form').send({ _csrf: c, status: 'pendiente_entrega' });
  paid = db.prepare('SELECT * FROM orders').get();

  // Aviso de «listo para recoger»
  c = await csrfOf(adm, '/admin/pedidos?estado=pendiente_entrega');
  await adm.post('/admin/pedidos/avisar-recogida').type('form').send({ _csrf: c, message: 'Sábado en el pabellón' });
  assert.ok(db.prepare('SELECT ready_at FROM orders').get().ready_at);

  // Entregado sin código o con código incorrecto: rechazado
  await adm.post(`/admin/pedidos/${order.id}/estado`).type('form').send({ _csrf: c, status: 'entregado' });
  await adm.post(`/admin/pedidos/${order.id}/estado`).type('form').send({ _csrf: c, status: 'entregado', code: 'AAAAAA' });
  assert.strictEqual(db.prepare('SELECT status FROM orders').get().status, 'pendiente_entrega');

  // Búsqueda por código de recogida -> QR de recogida -> entrega
  res = await adm.get(`/admin/escanear?codigo=${paid.pickup_code.toLowerCase()}`);
  assert.strictEqual(res.headers.location, `/admin/qr/${paid.pickup_token}`);
  res = await adm.post(`/admin/qr/${paid.pickup_token}/entregar`).type('form').send({ _csrf: c });
  const done = db.prepare('SELECT * FROM orders').get();
  assert.strictEqual(done.status, 'entregado');
  assert.strictEqual(done.delivered_by, 1);

  await wait();
  const famMails = mails().filter((m) => m.to_address === 'fam@example.com');
  const subjects = famMails.map((m) => m.subject).join('\n');
  assert.match(subjects, /rebuda|recibido/);
  assert.match(subjects, /Pagada|Pagado/);
  assert.match(subjects, /recollir|recoger/);
  assert.match(subjects, /Lliurada|Entregado/);
  assert.ok(famMails.some((m) => /COMPROVANT|COMPROBANTE/.test(m.body)), 'comprobante de pago');

  // Panel: caja por miembro de la comisión
  res = await adm.get('/admin');
  assert.match(res.text, /comision/);

  // Resumen y CSV
  res = await adm.get('/admin/resumen');
  assert.match(res.text, /Sudadera/);
  assert.match(res.text, /Laia/);
  res = await adm.get('/admin/pedidos.csv');
  assert.match(res.text, /Botellero/);
});

test('idioma: selector, textos y correos en el idioma de la familia', async () => {
  const { db, app, mails } = setup();
  const agent = request.agent(app);
  let res = await agent.get('/login').set('Accept-Language', 'es-ES,es;q=0.9');
  assert.match(res.text, /Entrar a la botiga/);
  assert.match(res.text, /He olvidado mi contraseña/);
  res = await agent.get('/idioma/ca');
  assert.strictEqual(res.status, 302);
  res = await agent.get('/login');
  assert.match(res.text, /He oblidat la contrasenya/);
  assert.match(res.text, /<html lang="ca">/);

  // Primer acceso en catalán -> la cuenta guarda el idioma y los correos llegan en catalán
  const _csrf = await csrfOf(agent, '/primer-acceso');
  await agent.post('/primer-acceso').type('form').send({ _csrf, dni: '12345678Z', step: '2', email: 'ca@example.com', email2: 'ca@example.com' });
  assert.strictEqual(db.prepare("SELECT lang FROM users WHERE dni = '12345678Z'").get().lang, 'ca');
  await wait();
  assert.match(mails().find((m) => m.to_address === 'ca@example.com').subject, /El teu accés/);
});

test('ADMIN_USER crea el primer administrador una sola vez', () => {
  const { ensureAdmin } = require('../src/db');
  const db = openDb(':memory:');
  assert.ok(ensureAdmin(db, { ADMIN_USER: 'Comision', ADMIN_PASSWORD: 'una-clave-larga' }));
  assert.ok(!ensureAdmin(db, { ADMIN_USER: 'comision', ADMIN_PASSWORD: 'otra-clave-larga' }));
  const admin = db.prepare("SELECT * FROM users WHERE role = 'admin'").get();
  assert.strictEqual(admin.username, 'comision');
  assert.ok(bcrypt.compareSync('una-clave-larga', admin.password_hash));
  assert.ok(!ensureAdmin(openDb(':memory:'), { ADMIN_USER: 'x', ADMIN_PASSWORD: 'corta' }));
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
