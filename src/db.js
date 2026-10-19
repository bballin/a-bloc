const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const config = require('./config');
const { migrate } = require('./migrations');

fs.mkdirSync(config.dataDir, { recursive: true });

const db = new Database(path.join(config.dataDir, 'app.db'));
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');

for (const migration of migrate(db)) {
  console.log(`[info] Applied database migration ${migration.version}: ${migration.name}`);
}

module.exports = db;
