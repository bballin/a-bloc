const session = require('express-session');
const db = require('./db');

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

class SQLiteSessionStore extends session.Store {
  constructor() {
    super();
    this.lastCleanup = 0;
    this.select = db.prepare('SELECT sess, expires FROM sessions WHERE sid = ?');
    this.upsert = db.prepare(`
      INSERT INTO sessions (sid, sess, expires) VALUES (?, ?, ?)
      ON CONFLICT(sid) DO UPDATE SET sess = excluded.sess, expires = excluded.expires
    `);
    this.updateExpiry = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
    this.remove = db.prepare('DELETE FROM sessions WHERE sid = ?');
    this.removeExpired = db.prepare('DELETE FROM sessions WHERE expires <= ?');
  }

  get(sid, callback) {
    try {
      const row = this.select.get(sid);
      if (!row) return callback(null, null);
      if (row.expires <= Date.now()) {
        this.remove.run(sid);
        return callback(null, null);
      }
      callback(null, JSON.parse(row.sess));
    } catch (error) {
      callback(error);
    }
  }

  set(sid, sess, callback = () => {}) {
    try {
      const expires = this.getExpiry(sess);
      this.upsert.run(sid, JSON.stringify(sess), expires);
      this.cleanupExpired();
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  touch(sid, sess, callback = () => {}) {
    try {
      this.updateExpiry.run(this.getExpiry(sess), sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  destroy(sid, callback = () => {}) {
    try {
      this.remove.run(sid);
      callback(null);
    } catch (error) {
      callback(error);
    }
  }

  getExpiry(sess) {
    const cookie = sess.cookie || {};
    if (cookie.expires) {
      const expires = new Date(cookie.expires).getTime();
      if (Number.isFinite(expires)) return expires;
    }
    const maxAge = Number(cookie.originalMaxAge);
    return Date.now() + (Number.isFinite(maxAge) && maxAge > 0 ? maxAge : DEFAULT_TTL_MS);
  }

  cleanupExpired() {
    const now = Date.now();
    if (now - this.lastCleanup < CLEANUP_INTERVAL_MS) return;
    this.removeExpired.run(now);
    this.lastCleanup = now;
  }
}

module.exports = new SQLiteSessionStore();
