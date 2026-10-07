// Carga datos de ejemplo para probar la web: npm run seed-demo
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const { openDb } = require('../src/db');

const db = openDb();
const cat = (slug) => db.prepare('SELECT id FROM categories WHERE slug = ?').get(slug)?.id ?? null;

db.transaction(() => {
  if (!db.prepare("SELECT 1 FROM users WHERE username = 'comision'").get()) {
    db.prepare(`INSERT INTO users (role, username, password_hash, activated_at, player_name)
      VALUES ('admin', 'comision', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), 'Comisión')`)
      .run(bcrypt.hashSync('comision-demo', 10));
  }
  const fam = db.prepare(`INSERT OR IGNORE INTO users (role, dni, player_name, player_number, team)
    VALUES ('family', ?, ?, ?, ?)`);
  fam.run('12345678Z', 'Laia Pérez Gómez', '7', 'Alevín A');
  fam.run('87654321X', 'Marc Soler Ruiz', '12', 'Benjamín B');
  fam.run('X1234567L', 'Nil Garcia Vidal', '3', 'Infantil');

  if (!db.prepare('SELECT 1 FROM products').get()) {
    const p = db.prepare(`INSERT INTO products (category_id, name, name_ca, description, description_ca, price_cents, personalization, sizes)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const sizes = '6, 8, 10, 12, 14, S, M, L, XL';
    p.run(cat('camisetas'), 'Camiseta de paseo', 'Samarreta de passeig', 'Algodón, con escudo del club.', 'Cotó, amb l\'escut del club.', 1500, 0, sizes);
    p.run(cat('sudaderas'), 'Sudadera con capucha', 'Dessuadora amb caputxa', 'Sudadera azul con escudo bordado.', 'Dessuadora blava amb l\'escut brodat.', 3200, 0, sizes);
    p.run(cat('accesorios'), 'Botellero personalizado', 'Ampolla personalitzada', 'Botella de agua con nombre y dorsal del jugador/a.', 'Ampolla d\'aigua amb el nom i el dorsal del jugador/a.', 1200, 1, null);
    p.run(cat('bufandas'), 'Bufanda del club', 'Bufanda del club', 'Bufanda de punto con los colores del club.', 'Bufanda de punt amb els colors del club.', 1000, 0, null);
    p.run(cat('mochilas'), 'Mochila deportiva', 'Motxilla esportiva', 'Mochila con compartimento para patines.', 'Motxilla amb compartiment per als patins.', 2800, 0, null);
  }

  if (!db.prepare('SELECT 1 FROM periods').get()) {
    const now = Date.now();
    db.prepare('INSERT INTO periods (name, starts_at, ends_at) VALUES (?, ?, ?)')
      .run('Pedido de prueba', new Date(now - 3600e3).toISOString(), new Date(now + 14 * 86400e3).toISOString());
  }
})();

console.log('Datos de ejemplo cargados.');
console.log('  Comisión: usuario "comision", contraseña "comision-demo"');
console.log('  Familias (hacer «Primer acceso»): 12345678Z, 87654321X, X1234567L');
