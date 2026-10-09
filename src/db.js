const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  role          TEXT NOT NULL CHECK (role IN ('family', 'admin')),
  dni           TEXT UNIQUE,              -- DNI/NIE del jugador/a (familias)
  username      TEXT UNIQUE,              -- usuario (administradores)
  player_name   TEXT,
  player_number TEXT,                     -- dorsal
  team          TEXT,
  email         TEXT,
  lang          TEXT,                     -- idioma preferido ('ca' | 'es')
  password_hash TEXT,
  activated_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS reset_tokens (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  expires_at  TEXT NOT NULL,
  used_at     TEXT
);

CREATE TABLE IF NOT EXISTS categories (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL,
  name_ca    TEXT,
  slug       TEXT NOT NULL UNIQUE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id     INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  name_ca         TEXT,
  description     TEXT,
  description_ca  TEXT,
  price_cents     INTEGER NOT NULL CHECK (price_cents >= 0),
  image           TEXT,
  personalization INTEGER NOT NULL DEFAULT 0, -- 1 = requiere nombre + dorsal; 2 = opcional («Sin personalizar»)
  sizes           TEXT,                       -- tallas separadas por comas (opcional)
  active          INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS cart_items (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  product_id    INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  size          TEXT,
  custom_name   TEXT,
  custom_number TEXT
);

CREATE TABLE IF NOT EXISTS orders (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id       INTEGER NOT NULL REFERENCES users(id),
  status        TEXT NOT NULL CHECK (status IN ('pendiente_pago', 'pendiente_entrega', 'entregado', 'cancelado')),
  total_cents   INTEGER NOT NULL,
  pay_token     TEXT NOT NULL UNIQUE,     -- QR de pago (se envía al hacer el pedido)
  pickup_token  TEXT UNIQUE,              -- QR de recogida (se genera al pagar)
  pickup_code   TEXT UNIQUE,              -- código de recogida de 6 caracteres
  period_id     INTEGER REFERENCES periods(id) ON DELETE SET NULL,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  paid_at       TEXT,
  paid_by       INTEGER REFERENCES users(id) ON DELETE SET NULL,
  ready_at      TEXT,                     -- aviso «listo para recoger» enviado
  delivered_at  TEXT,
  delivered_by  INTEGER REFERENCES users(id) ON DELETE SET NULL,
  cancelled_at  TEXT
);

CREATE TABLE IF NOT EXISTS order_items (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id         INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id       INTEGER REFERENCES products(id) ON DELETE SET NULL,
  product_name     TEXT NOT NULL,
  product_name_ca  TEXT,
  unit_price_cents INTEGER NOT NULL,
  quantity         INTEGER NOT NULL,
  size             TEXT,
  custom_name      TEXT,
  custom_number    TEXT
);

CREATE TABLE IF NOT EXISTS order_events (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id   INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  status     TEXT NOT NULL,
  note       TEXT,
  actor_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS periods (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT NOT NULL,
  starts_at TEXT NOT NULL,
  ends_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS email_log (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  to_address TEXT NOT NULL,
  subject    TEXT NOT NULL,
  body       TEXT NOT NULL,
  status     TEXT NOT NULL,
  error      TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Packs: varios productos a un precio especial. Los productos con gift = 1 van de regalo.
CREATE TABLE IF NOT EXISTS packs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  name_ca        TEXT,
  description    TEXT,
  description_ca TEXT,
  price_cents    INTEGER NOT NULL CHECK (price_cents >= 0),
  image          TEXT,
  active         INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS pack_items (
  pack_id    INTEGER NOT NULL REFERENCES packs(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  gift       INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pack_id, product_id)
);

-- Textos editables de la web pública (portada, «Qui som», contacto).
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  sid     TEXT PRIMARY KEY,
  data    TEXT NOT NULL,
  expires INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_paid_by ON orders(paid_by);
CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id);
CREATE INDEX IF NOT EXISTS idx_cart_user ON cart_items(user_id);
`;

const DEFAULT_CATEGORIES = [
  ['Camisetas', 'Samarretes', 'camisetas'],
  ['Sudaderas', 'Dessuadores', 'sudaderas'],
  ['Accesorios', 'Accessoris', 'accesorios'],
  ['Bufandas', 'Bufandes', 'bufandas'],
  ['Mochilas', 'Motxilles', 'mochilas'],
];

function openDb(file) {
  const target = file || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'club.db');
  if (target !== ':memory:') fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new Database(target);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);

  const count = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (count === 0) {
    const insert = db.prepare('INSERT INTO categories (name, name_ca, slug, sort_order) VALUES (?, ?, ?, ?)');
    DEFAULT_CATEGORIES.forEach(([name, nameCa, slug], i) => insert.run(name, nameCa, slug, i));
  }
  ensureAdmin(db);
  return db;
}

/** Columnas añadidas después de la primera versión (las bases de datos existentes se actualizan solas). */
const COLUMNS = [
  ['products', 'colors', 'TEXT'],          // colores separados por comas (la familia elige uno)
  ['products', 'options', 'TEXT'],         // otras opciones separadas por comas (ej.: escudo, pollito)
  ['products', 'size_guide', 'TEXT'],      // imagen con la guía de tallas
  ['cart_items', 'color', 'TEXT'],
  ['cart_items', 'option_value', 'TEXT'],
  ['order_items', 'color', 'TEXT'],
  ['order_items', 'option_value', 'TEXT'],
  // 'product' = artículo; 'pack' = descuento de un pack (importe negativo); 'gift' = regalo de un pack (0 €)
  ['order_items', 'kind', "TEXT NOT NULL DEFAULT 'product'"],
  // 1 = la familia ha elegido expresamente «Sin personalizar» (productos con personalización opcional)
  ['cart_items', 'no_custom', 'INTEGER NOT NULL DEFAULT 0'],
  ['order_items', 'no_custom', 'INTEGER NOT NULL DEFAULT 0'],
];

function migrate(db) {
  for (const [table, column, type] of COLUMNS) {
    const exists = db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    if (!exists) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
  // Los clientes entran con su correo: no puede haber dos cuentas con el mismo.
  try {
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_users_customer_email ON users(email) WHERE role = 'family'");
  } catch (err) {
    console.error('Aviso: hay cuentas de cliente con el correo repetido; revísalas en Admin › Clientes.', err.message);
  }
}

/**
 * Crea el primer administrador a partir de ADMIN_USER / ADMIN_PASSWORD (útil en hostings sin consola).
 * Si el usuario ya existe no se toca su contraseña.
 */
function ensureAdmin(db, env = process.env) {
  const username = String(env.ADMIN_USER || '').trim().toLowerCase();
  if (!username || !env.ADMIN_PASSWORD) return false;
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) return false;
  if (String(env.ADMIN_PASSWORD).length < 10) {
    console.error('ADMIN_PASSWORD debe tener al menos 10 caracteres: no se ha creado el administrador.');
    return false;
  }
  const bcrypt = require('bcryptjs');
  db.prepare(`INSERT INTO users (role, username, email, password_hash, activated_at, player_name)
    VALUES ('admin', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)`)
    .run(username, env.ADMIN_EMAIL || null, bcrypt.hashSync(String(env.ADMIN_PASSWORD), 10), username);
  console.log(`Administrador «${username}» creado a partir de ADMIN_USER.`);
  return true;
}

module.exports = { openDb, ensureAdmin };
