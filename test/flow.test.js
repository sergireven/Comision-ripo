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
const { createMailer } = require('../src/mailer');
const { fromLocalInput, toLocalInput, sha256 } = require('../src/util');

/**
 * Base de datos en memoria con un administrador («comision») y una clienta (laia@example.com / clave-familia).
 * Con { brevo: true } los correos «salen» por una API de Brevo simulada; `sent` guarda lo que se le envía.
 */
function setup({ brevo = false } = {}) {
  const db = openDb(':memory:');
  const sent = [];
  const uploadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ripo-'));
  let mailer;
  if (brevo) {
    const saved = { key: process.env.BREVO_API_KEY, from: process.env.MAIL_FROM };
    process.env.BREVO_API_KEY = 'clave-de-prueba';
    process.env.MAIL_FROM = 'Comissió HC Ripollet <comissio@example.com>';
    mailer = createMailer(db, {
      fetchImpl: async (url, init) => { sent.push({ url, headers: init.headers, body: JSON.parse(init.body) }); return { ok: true }; },
    });
    if (saved.key === undefined) delete process.env.BREVO_API_KEY; else process.env.BREVO_API_KEY = saved.key;
    if (saved.from === undefined) delete process.env.MAIL_FROM; else process.env.MAIL_FROM = saved.from;
  }
  const server = createApp(db, { uploadDir, mailer }).listen(0);
  test.after(() => server.close());
  const app = server;
  // Correos registrados en email_log.
  const mails = () => db.prepare('SELECT * FROM email_log ORDER BY id').all();
  db.prepare(`INSERT INTO users (role, username, password_hash, activated_at) VALUES ('admin', 'comision', ?, 'x')`)
    .run(bcrypt.hashSync('admin-password', 4));
  db.prepare(`INSERT INTO users (role, email, password_hash, activated_at) VALUES ('family', 'laia@example.com', ?, 'x')`)
    .run(bcrypt.hashSync('clave-familia', 4));
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

const openPeriod = (db) => db.prepare('INSERT INTO periods (name, starts_at, ends_at) VALUES (?, ?, ?)')
  .run('P', new Date(Date.now() - 1000).toISOString(), new Date(Date.now() + 1e6).toISOString());

const wait = () => new Promise((r) => setTimeout(r, 30));

test('utilidades de fechas', () => {
  assert.strictEqual(fromLocalInput('2026-07-01T10:00'), '2026-07-01T08:00:00.000Z'); // verano UTC+2
  assert.strictEqual(fromLocalInput('2026-12-01T10:00'), '2026-12-01T09:00:00.000Z'); // invierno UTC+1
  assert.strictEqual(toLocalInput('2026-12-01T09:00:00.000Z'), '2026-12-01T10:00');
});

test('alta con el correo: contraseña en pantalla y por correo; un correo = una cuenta', async () => {
  const { db, app, mails } = setup();
  const anon = request.agent(app);
  let _csrf = await csrfOf(anon, '/registro');

  // Validaciones
  let res = await anon.post('/registro').type('form').send({ _csrf, email: 'no-es-correo', email2: 'no-es-correo' });
  assert.strictEqual(res.status, 400);
  res = await anon.post('/registro').type('form').send({ _csrf, email: 'marc@example.com', email2: 'otro@example.com' });
  assert.strictEqual(res.status, 400);
  res = await anon.post('/registro').type('form').send({ _csrf, email: 'Laia@Example.com', email2: 'laia@example.com' });
  assert.strictEqual(res.status, 409, 'ya existe');

  // Alta correcta: la contraseña sale en pantalla y queda la sesión iniciada
  res = await anon.post('/registro').type('form').send({ _csrf, email: ' Marc@Example.com ', email2: 'marc@example.com' });
  assert.strictEqual(res.status, 200);
  const password = /class="secret">([^<]+)</.exec(res.text)[1];
  assert.match(password, /^RIPO-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.match(res.text, /marc@example\.com/);
  assert.strictEqual((await anon.get('/carrito')).status, 200, 'sesión iniciada');
  await wait();
  assert.ok(mails().some((m) => m.to_address === 'marc@example.com'));
  assert.ok(!mails().some((m) => m.body.includes(password)), 'la contraseña no se guarda en el registro');

  // Entrar con el correo (sin distinguir mayúsculas)
  assert.strictEqual((await login(request.agent(app), 'MARC@example.com', password)).status, 302);
  assert.strictEqual((await login(request.agent(app), 'marc@example.com', 'mala')).status, 401);
  // La comisión entra con su usuario
  res = await login(request.agent(app), 'comision', 'admin-password');
  assert.strictEqual(res.headers.location, '/admin');

  // El enlace antiguo de «Primer acceso» lleva al alta
  res = await anon.get('/primer-acceso');
  assert.strictEqual(res.headers.location, '/registro');

  // La comisión ve las cuentas en «Clientes» pero no puede crearlas
  const adm = request.agent(app);
  await login(adm, 'comision', 'admin-password');
  res = await adm.get('/admin/clientes?q=marc');
  assert.match(res.text, /marc@example\.com/);
  assert.doesNotMatch(res.text, /laia@example\.com/);
  const marc = db.prepare("SELECT * FROM users WHERE email = 'marc@example.com'").get();
  // Sin servicio de correo, la contraseña nueva se muestra a la comisión para dársela a la persona
  _csrf = await csrfOf(adm, `/admin/clientes/${marc.id}`);
  await adm.post(`/admin/clientes/${marc.id}/nueva-contrasena`).type('form').send({ _csrf });
  res = await adm.get(`/admin/clientes/${marc.id}`);
  assert.match(res.text, /RIPO-[A-Z2-9]{4}-[A-Z2-9]{4}/);
  assert.strictEqual((await login(request.agent(app), 'marc@example.com', password)).status, 401, 'la anterior ya no sirve');
  // Una clienta no puede entrar en el panel
  const fam = request.agent(app);
  await login(fam, 'laia@example.com', 'clave-familia');
  assert.strictEqual((await fam.get('/admin/clientes')).status, 403);
});

test('flujo completo con un único QR: pedido, cobro y entrega', async () => {
  const { db, app, mails } = setup();
  const fam = request.agent(app);
  const adm = request.agent(app);
  await login(fam, 'laia@example.com', 'clave-familia');

  // Admin: producto personalizado y otro con tallas
  let res = await login(adm, 'comision', 'admin-password');
  let _csrf = await csrfOf(adm, '/admin/productos/nuevo');
  res = await adm.post(`/admin/productos?_csrf=${_csrf}`)
    .field('name', 'Botellero').field('price', '12,50').field('personalization', '1').field('active', '1')
    .attach('image', Buffer.from([0x89, 0x50, 0x4e, 0x47]), { filename: 'b.png', contentType: 'image/png' });
  assert.strictEqual(res.status, 302);
  res = await adm.post(`/admin/productos?_csrf=${_csrf}`)
    .field('name', 'Sudadera').field('price', '30').field('sizes', 'S, M').field('active', '1');
  const [botella, sudadera] = db.prepare('SELECT * FROM products ORDER BY id').all();
  assert.strictEqual(botella.price_cents, 1250);
  assert.ok(botella.image);

  // Sin periodo abierto no se puede añadir
  _csrf = await csrfOf(fam, '/tienda');
  await fam.post('/carrito/anadir').type('form').send({ _csrf, product_id: sudadera.id, quantity: 1, size: 'M' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM cart_items').get().n, 0);

  // Admin abre periodo
  const local = (ms) => toLocalInput(new Date(Date.now() + ms).toISOString());
  await adm.post('/admin/periodos').type('form').send({ _csrf: await csrfOf(adm, '/admin/periodos'), name: 'Navidad', starts_at: local(-3600e3), ends_at: local(86400e3) });
  res = await fam.get('/tienda');
  assert.match(res.text, /Comandes obertes|Pedidos abiertos/);

  // Validaciones de carrito
  await fam.post('/carrito/anadir').type('form').send({ _csrf, product_id: sudadera.id, quantity: 1 });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM cart_items').get().n, 0, 'talla obligatoria');
  await fam.post('/carrito/anadir').type('form').send({ _csrf, product_id: botella.id, quantity: 1, custom_name: 'Laia' });
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

  // La clienta ve el QR del pedido
  res = await fam.get(`/pedidos/${order.id}`);
  assert.match(res.text, /data:image\/png/);

  // Una clienta no puede usar la URL del QR
  assert.strictEqual((await fam.get(`/admin/qr/${order.pay_token}`)).status, 403);

  // La comisión escanea el QR: como está pendiente de pago, solo puede cobrar
  res = await adm.get(`/admin/qr/${order.pay_token}`);
  assert.match(res.text, /\/cobrar/);
  assert.doesNotMatch(res.text, /\/entregar/);
  const c = await csrfOf(adm, `/admin/qr/${order.pay_token}`);
  await adm.post(`/admin/qr/${order.pay_token}/entregar`).type('form').send({ _csrf: c });
  assert.strictEqual(db.prepare('SELECT status FROM orders').get().status, 'pendiente_pago', 'no se entrega sin pagar');

  // Cobro con el QR
  await adm.post(`/admin/qr/${order.pay_token}/cobrar`).type('form').send({ _csrf: c });
  let paid = db.prepare('SELECT * FROM orders').get();
  assert.strictEqual(paid.status, 'pendiente_entrega');
  assert.strictEqual(paid.paid_by, 1);
  assert.strictEqual(paid.pickup_token, null, 'no hay segundo QR');
  await adm.post(`/admin/qr/${order.pay_token}/cobrar`).type('form').send({ _csrf: c });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM order_events WHERE status = ?').get('pendiente_entrega').n, 1, 'cobrar dos veces no hace nada');

  // La clienta ya no puede cancelar y sigue viendo el mismo QR
  await fam.post(`/pedidos/${order.id}/cancelar`).type('form').send({ _csrf });
  assert.strictEqual(db.prepare('SELECT status FROM orders').get().status, 'pendiente_entrega');
  res = await fam.get(`/pedidos/${order.id}`);
  assert.match(res.text, /data:image\/png/);

  // Aviso de «listo para recoger»
  const cl = await csrfOf(adm, '/admin/pedidos?estado=pendiente_entrega');
  await adm.post('/admin/pedidos/avisar-recogida').type('form').send({ _csrf: cl, message: 'Sábado en el pabellón' });
  assert.ok(db.prepare('SELECT ready_at FROM orders').get().ready_at);

  // Al volver a escanear el MISMO QR, ofrece confirmar la entrega
  res = await adm.get(`/admin/qr/${order.pay_token}`);
  assert.match(res.text, /\/entregar/);
  assert.doesNotMatch(res.text, /\/cobrar"/);
  await adm.post(`/admin/qr/${order.pay_token}/entregar`).type('form').send({ _csrf: c });
  const done = db.prepare('SELECT * FROM orders').get();
  assert.strictEqual(done.status, 'entregado');
  assert.strictEqual(done.delivered_by, 1);

  await wait();
  const famMails = mails().filter((m) => m.to_address === 'laia@example.com');
  const subjects = famMails.map((m) => m.subject).join('\n');
  assert.match(subjects, /rebuda|recibido/);
  assert.match(subjects, /Pagada|Pagado/);
  assert.match(subjects, /recollir|recoger/);
  assert.match(subjects, /Lliurada|Entregado/);
  assert.ok(famMails.some((m) => /COMPROVANT|COMPROBANTE/.test(m.body)), 'comprobante de pago');

  // Resumen y CSV
  res = await adm.get('/admin/resumen');
  assert.match(res.text, /Sudadera/);
  assert.match(res.text, /laia@example\.com/);
  res = await adm.get('/admin/pedidos.csv');
  assert.match(res.text, /Botellero/);
  assert.match(res.text, /laia@example\.com/);
});

test('entrega a mano desde la lista de pedidos, sin QR', async () => {
  const { db, app } = setup();
  db.prepare("INSERT INTO products (name, price_cents) VALUES ('Bufanda', 1000)").run();
  openPeriod(db);
  const fam = request.agent(app);
  await login(fam, 'laia@example.com', 'clave-familia');
  const _csrf = await csrfOf(fam, '/tienda');
  await fam.post('/carrito/anadir').type('form').send({ _csrf, product_id: 1, quantity: 1 });
  await fam.post('/carrito/confirmar').type('form').send({ _csrf });

  const adm = request.agent(app);
  await login(adm, 'comision', 'admin-password');
  const c = await csrfOf(adm, '/admin/pedidos');
  let res = await adm.post('/admin/pedidos/1/estado').type('form').set('Referer', 'http://x/admin/pedidos?estado=pendiente_pago')
    .send({ _csrf: c, status: 'pendiente_entrega', back: 'list' });
  assert.strictEqual(db.prepare('SELECT status FROM orders').get().status, 'pendiente_entrega');
  res = await adm.get('/admin/pedidos?estado=pendiente_entrega');
  assert.match(res.text, /value="entregado"/, 'botón «Marcar entregado» en la lista');
  await adm.post('/admin/pedidos/1/estado').type('form').send({ _csrf: c, status: 'entregado', back: 'list' });
  assert.strictEqual(db.prepare('SELECT status FROM orders').get().status, 'entregado');
  assert.strictEqual(db.prepare("SELECT note FROM order_events WHERE status = 'entregado'").get().note, 'Entregado sin QR');
});

test('idioma: selector, textos y correos en el idioma de la persona', async () => {
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

  // Alta en catalán -> la cuenta guarda el idioma y los correos llegan en catalán
  const _csrf = await csrfOf(agent, '/registro');
  await agent.post('/registro').type('form').send({ _csrf, email: 'ca@example.com', email2: 'ca@example.com' });
  assert.strictEqual(db.prepare("SELECT lang FROM users WHERE email = 'ca@example.com'").get().lang, 'ca');
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

test('cancelación por la clienta y recuperación de contraseña', async () => {
  const { db, app } = setup();
  db.prepare("INSERT INTO products (name, price_cents) VALUES ('Bufanda', 1000)").run();
  openPeriod(db);
  const fam = request.agent(app);
  await login(fam, 'laia@example.com', 'clave-familia');
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
  await anon.post('/recuperar').type('form').send({ _csrf: c2, usuario: 'Laia@Example.com' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM reset_tokens').get().n, 1);
  // Correo inexistente: misma respuesta, sin token
  await anon.post('/recuperar').type('form').send({ _csrf: c2, usuario: 'nadie@example.com' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM reset_tokens').get().n, 1);
  // Simula el enlace: se sustituye el hash por uno conocido
  db.prepare('UPDATE reset_tokens SET token_hash = ?').run(sha256('tok'));
  const c3 = await csrfOf(anon, '/recuperar/tok');
  const res = await anon.post('/recuperar/tok').type('form').send({ _csrf: c3 });
  const newPassword = /class="secret">([^<]+)</.exec(res.text)[1];
  assert.strictEqual((await login(request.agent(app), 'laia@example.com', newPassword)).status, 302);
  assert.strictEqual((await login(request.agent(app), 'laia@example.com', 'clave-familia')).status, 401);
  // Token de un solo uso
  assert.strictEqual((await anon.get('/recuperar/tok')).status, 400);
});

test('cambiar el correo de la cuenta: pasa a ser el usuario y no puede repetirse', async () => {
  const { db, app } = setup();
  db.prepare(`INSERT INTO users (role, email, password_hash, activated_at) VALUES ('family', 'otra@example.com', 'x', 'x')`).run();
  const fam = request.agent(app);
  await login(fam, 'laia@example.com', 'clave-familia');
  const _csrf = await csrfOf(fam, '/cuenta');
  await fam.post('/cuenta/email').type('form').send({ _csrf, email: 'otra@example.com' });
  assert.ok(db.prepare("SELECT 1 FROM users WHERE email = 'laia@example.com'").get(), 'correo ya usado: no cambia');
  await fam.post('/cuenta/email').type('form').send({ _csrf, email: 'laia.nueva@example.com' });
  assert.strictEqual((await login(request.agent(app), 'laia.nueva@example.com', 'clave-familia')).status, 302);
});

test('web pública: portada, qui som y catálogo sin iniciar sesión; textos editables', async () => {
  const { db, app } = setup();
  db.prepare("INSERT INTO products (name, name_ca, price_cents, sizes) VALUES ('Sudadera', 'Dessuadora', 3000, 'S,M')").run();
  const anon = request.agent(app);

  let res = await anon.get('/').set('Cookie', 'lang=ca');
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /Comissió d&#39;esdeveniments/);
  assert.match(res.text, /Dessuadora/);

  res = await anon.get('/qui-som');
  assert.strictEqual(res.status, 200);

  res = await anon.get('/tienda');
  assert.strictEqual(res.status, 200);
  assert.match(res.text, /href="\/registro"/);
  assert.doesNotMatch(res.text, /action="\/carrito\/anadir"/, 'sin sesión no se puede añadir al carrito');
  res = await anon.get('/carrito');
  assert.strictEqual(res.headers.location, '/login');

  // La comisión cambia los textos; se escapan al mostrarlos.
  const adm = request.agent(app);
  await login(adm, 'comision', 'admin-password');
  const _csrf = await csrfOf(adm, '/admin/web');
  res = await adm.post('/admin/web').type('form').send({
    _csrf, home_intro: 'Hola <b>familias</b>', home_intro_ca: '', about: 'Somos la comisión.\n\nSegundo párrafo.', about_ca: '',
    contact_email: 'mal', contact_instagram: '',
  });
  assert.strictEqual(res.status, 400);
  assert.match(res.text, /no és vàlid/);
  assert.match(res.text, /Hola &lt;b&gt;familias/, 'conserva lo escrito');
  res = await adm.post('/admin/web').type('form').send({
    _csrf, home_intro: 'Hola <b>familias</b>', home_intro_ca: '', about: 'Somos la comisión.\n\nSegundo párrafo.', about_ca: '',
    contact_email: 'comissio@example.com', contact_instagram: '@hcripollet',
  });
  assert.strictEqual(res.status, 302);
  res = await anon.get('/').set('Cookie', 'lang=ca');
  assert.match(res.text, /Hola &lt;b&gt;familias&lt;\/b&gt;/, 'sin texto en catalán se muestra el castellano, escapado');
  res = await anon.get('/qui-som');
  assert.match(res.text, /<p>Segundo párrafo\.<\/p>/);
  assert.match(res.text, /mailto:comissio@example\.com/);
  assert.match(res.text, /https:\/\/www\.instagram\.com\/hcripollet\//);
});

test('packs: se aplican solos en el carrito, se pueden añadir enteros y quedan en el pedido', async () => {
  const { db, app } = setup();
  openPeriod(db);
  const product = db.prepare('INSERT INTO products (name, name_ca, price_cents, sizes, colors) VALUES (?, ?, ?, ?, ?)');
  const bufanda = product.run('Bufanda', 'Bufanda', 1000, null, 'Amarillo').lastInsertRowid;
  const camiseta = product.run('Camiseta afició', 'Samarreta afició', 1500, 'S, M', 'Azul claro, Amarillo').lastInsertRowid;
  const sudadera = product.run('Sudadera', 'Dessuadora', 2500, 'S, M', null).lastInsertRowid;
  const adhesivo = product.run('Adhesivo escudo', 'Adhesiu escut', 300, null, null).lastInsertRowid;

  // La comisión crea los packs desde el panel.
  const adm = request.agent(app);
  await login(adm, 'comision', 'admin-password');
  let _csrf = await csrfOf(adm, '/admin/packs/nuevo');
  let res = await adm.post(`/admin/packs?_csrf=${_csrf}`).field('name', 'Pack AFICIÓ 1').field('price', '22').field('active', '1')
    .field(`item_${camiseta}`, 'in').field(`item_${bufanda}`, 'in');
  assert.strictEqual(res.status, 302);
  res = await adm.post(`/admin/packs?_csrf=${_csrf}`).field('name', 'Sin productos').field('price', '5').field('active', '1');
  assert.strictEqual(res.status, 400, 'un pack necesita productos');
  await adm.post(`/admin/packs?_csrf=${_csrf}`).field('name', 'Pack AFICIÓ 3').field('price', '45').field('active', '1')
    .field(`item_${camiseta}`, 'in').field(`item_${bufanda}`, 'in').field(`item_${sudadera}`, 'in').field(`item_${adhesivo}`, 'gift');
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM packs').get().n, 2);
  assert.match((await adm.get('/admin/packs')).text, /−3,00/);

  // Tienda pública: los packs se ven sin entrar.
  res = await request(app).get('/tienda?categoria=packs');
  assert.match(res.text, /Pack AFICIÓ 1/);

  const fam = request.agent(app);
  await login(fam, 'laia@example.com', 'clave-familia');
  _csrf = await csrfOf(fam, '/tienda');

  // Color obligatorio cuando hay varios; con un solo color se asigna solo.
  await fam.post('/carrito/anadir').type('form').send({ _csrf, product_id: camiseta, quantity: 1, size: 'M' });
  assert.strictEqual(db.prepare('SELECT COUNT(*) n FROM cart_items').get().n, 0, 'color obligatorio');
  await fam.post('/carrito/anadir').type('form').send({ _csrf, product_id: camiseta, quantity: 1, size: 'M', color: 'Amarillo' });
  await fam.post('/carrito/anadir').type('form').send({ _csrf, product_id: bufanda, quantity: 1 });
  assert.strictEqual(db.prepare('SELECT color FROM cart_items WHERE product_id = ?').get(bufanda).color, 'Amarillo');

  // Camiseta + bufanda por separado: se aplica el Pack AFICIÓ 1.
  res = await fam.get('/carrito');
  assert.match(res.text, /Packs aplicats|Packs aplicados/);
  assert.match(res.text, /Pack AFICIÓ 1/);
  assert.match(res.text, /22,00/);

  // Añadir una sudadera: sale más a cuenta el Pack AFICIÓ 3, con el adhesivo de regalo.
  await fam.post('/carrito/anadir').type('form').send({ _csrf, product_id: sudadera, quantity: 1, size: 'S' });
  res = await fam.get('/carrito');
  assert.match(res.text, /Pack AFICIÓ 3/);
  assert.match(res.text, /Adhesiu escut|Adhesivo escudo/);
  assert.match(res.text, /45,00/);

  // Añadir el Pack AFICIÓ 1 entero, con sus elecciones.
  await fam.post('/carrito/pack').type('form').send({ _csrf, pack_id: 1, [`size_${camiseta}`]: 'S' });
  assert.strictEqual(db.prepare('SELECT SUM(quantity) n FROM cart_items').get().n, 3, 'sin color no se añade nada');
  await fam.post('/carrito/pack').type('form').send({ _csrf, pack_id: 1, [`size_${camiseta}`]: 'S', [`color_${camiseta}`]: 'Azul claro' });
  assert.strictEqual(db.prepare('SELECT SUM(quantity) n FROM cart_items').get().n, 5);

  // Pedido: 2 camisetas + 2 bufandas + 1 sudadera = 75 € -> AFICIÓ 3 (−5) + AFICIÓ 1 (−3) = 67 €.
  await fam.post('/carrito/confirmar').type('form').send({ _csrf });
  const order = db.prepare('SELECT * FROM orders').get();
  assert.strictEqual(order.total_cents, 6700);
  const items = db.prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id').all(order.id);
  assert.strictEqual(items.reduce((s, i) => s + i.unit_price_cents * i.quantity, 0), 6700, 'las líneas cuadran con el total');
  assert.deepStrictEqual(items.filter((i) => i.kind === 'pack').map((i) => [i.product_name, i.unit_price_cents]).sort(),
    [['Pack AFICIÓ 1', -300], ['Pack AFICIÓ 3', -500]]);
  assert.ok(items.some((i) => i.kind === 'gift' && i.product_name === 'Adhesivo escudo' && i.unit_price_cents === 0));
  assert.ok(items.some((i) => i.color === 'Azul claro' && i.size === 'S'));

  // El resumen para el proveedor cuenta el regalo como unidad y no cuenta los descuentos.
  res = await adm.get('/admin/resumen');
  assert.match(res.text, /Adhesivo escudo|Adhesiu escut/);
  assert.match(res.text, /Azul claro/);
  assert.match(res.text, /67,00/);
});

test('correos por Brevo: remitente, contraseña y QR enlazado (imagen de la web) y adjunto', async () => {
  const { db, app, sent, mails } = setup({ brevo: true });

  // Alta: el correo con la contraseña sale por la API de Brevo
  const anon = request.agent(app);
  let _csrf = await csrfOf(anon, '/registro');
  let res = await anon.post('/registro').type('form').send({ _csrf, email: 'marc@example.com', email2: 'marc@example.com' });
  assert.doesNotMatch(res.text, /No se ha podido|no està configurat/);
  await wait();
  assert.ok(mails().some((m) => m.to_address === 'marc@example.com' && m.status === 'enviado'));
  const call = sent.find((c) => c.body.to[0].email === 'marc@example.com');
  assert.strictEqual(call.url, 'https://api.brevo.com/v3/smtp/email');
  assert.strictEqual(call.headers['api-key'], 'clave-de-prueba');
  assert.deepStrictEqual(call.body.sender, { name: 'Comissió HC Ripollet', email: 'comissio@example.com' });
  assert.match(call.body.textContent, /RIPO-/);

  // Pedido: el QR va como imagen de la web y además adjunto
  db.prepare("INSERT INTO products (name, price_cents) VALUES ('Bufanda', 1000)").run();
  openPeriod(db);
  const fam = request.agent(app);
  await login(fam, 'laia@example.com', 'clave-familia');
  _csrf = await csrfOf(fam, '/tienda');
  await fam.post('/carrito/anadir').type('form').send({ _csrf, product_id: 1, quantity: 1 });
  await fam.post('/carrito/confirmar').type('form').send({ _csrf });
  await wait();
  const order = db.prepare('SELECT * FROM orders').get();
  const mail = sent.find((c) => c.body.to[0].email === 'laia@example.com');
  assert.ok(mail.body.htmlContent.includes(`/qr-img/${order.pay_token}.png`));
  assert.ok(!mail.body.htmlContent.includes('cid:'));
  assert.strictEqual(mail.body.attachment[0].name, 'qr.png');
  assert.ok(Buffer.from(mail.body.attachment[0].content, 'base64').subarray(1, 4).toString() === 'PNG');

  // La imagen solo existe para pedidos reales
  res = await request(app).get(`/qr-img/${order.pay_token}.png`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(res.headers['content-type'], 'image/png');
  res = await request(app).get(`/qr-img/${'0'.repeat(64)}.png`);
  assert.strictEqual(res.status, 404);

  // Comprobante de pago: sin QR
  const adm = request.agent(app);
  await login(adm, 'comision', 'admin-password');
  const c = await csrfOf(adm, `/admin/qr/${order.pay_token}`);
  await adm.post(`/admin/qr/${order.pay_token}/cobrar`).type('form').send({ _csrf: c });
  await wait();
  const receipt = sent.filter((s) => s.body.to[0].email === 'laia@example.com').pop();
  assert.match(receipt.body.textContent, /COMPROVANT|COMPROBANTE/);
  assert.strictEqual(receipt.body.attachment, undefined, 'el comprobante no lleva QR');
});
