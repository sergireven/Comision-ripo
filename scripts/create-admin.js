// Uso: npm run create-admin -- <usuario> <contraseña> [email]
require('dotenv').config({ quiet: true });
const bcrypt = require('bcryptjs');
const { openDb } = require('../src/db');

const [username, password, email] = process.argv.slice(2);
if (!username || !password || password.length < 10) {
  console.error('Uso: npm run create-admin -- <usuario> <contraseña (mín. 10 caracteres)> [email]');
  process.exit(1);
}
const db = openDb();
const user = username.trim().toLowerCase();
const hash = bcrypt.hashSync(password, 10);
const existing = db.prepare("SELECT id FROM users WHERE username = ? AND role = 'admin'").get(user);
if (existing) {
  db.prepare('UPDATE users SET password_hash = ?, email = COALESCE(?, email) WHERE id = ?').run(hash, email || null, existing.id);
  console.log(`Contraseña actualizada para «${user}».`);
} else {
  db.prepare(`INSERT INTO users (role, username, email, password_hash, activated_at, player_name)
    VALUES ('admin', ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?)`).run(user, email || null, hash, user);
  console.log(`Administrador «${user}» creado.`);
}
