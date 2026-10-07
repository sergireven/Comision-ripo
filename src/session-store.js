const session = require('express-session');

/** Almacén de sesiones en la misma base de datos SQLite (sobrevive a reinicios). */
class SqliteStore extends session.Store {
  constructor(db) {
    super();
    this.getStmt = db.prepare('SELECT data FROM sessions WHERE sid = ? AND expires > ?');
    this.setStmt = db.prepare('INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?, ?, ?)');
    this.delStmt = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.touchStmt = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.cleanStmt = db.prepare('DELETE FROM sessions WHERE expires <= ?');
    this.cleanStmt.run(Date.now());
  }

  expiry(sess) {
    const maxAge = sess?.cookie?.maxAge ?? 86400000;
    return Date.now() + maxAge;
  }

  get(sid, cb) {
    try {
      const row = this.getStmt.get(sid, Date.now());
      cb(null, row ? JSON.parse(row.data) : null);
    } catch (err) { cb(err); }
  }

  set(sid, sess, cb) {
    try { this.setStmt.run(sid, JSON.stringify(sess), this.expiry(sess)); cb?.(null); } catch (err) { cb?.(err); }
  }

  destroy(sid, cb) {
    try { this.delStmt.run(sid); cb?.(null); } catch (err) { cb?.(err); }
  }

  touch(sid, sess, cb) {
    try { this.touchStmt.run(this.expiry(sess), sid); cb?.(null); } catch (err) { cb?.(err); }
  }
}

module.exports = { SqliteStore };
