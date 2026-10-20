const db = require('../db');

const nowSeconds = () => Math.floor(Date.now() / 1000);

const upsertStatement = db.prepare(`
  INSERT INTO athletes (id, firstname, lastname, profile, access_token, refresh_token, expires_at, updated_at)
  VALUES (@id, @firstname, @lastname, @profile, @access_token, @refresh_token, @expires_at, @updated_at)
  ON CONFLICT(id) DO UPDATE SET
    firstname=excluded.firstname,
    lastname=excluded.lastname,
    profile=excluded.profile,
    access_token=excluded.access_token,
    refresh_token=excluded.refresh_token,
    expires_at=excluded.expires_at,
    updated_at=excluded.updated_at
`);
const getStatement = db.prepare('SELECT * FROM athletes WHERE id = ?');
const updateTokensStatement = db.prepare(`
  UPDATE athletes SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = ? WHERE id = ?
`);

function save(athlete, tokens) {
  upsertStatement.run({
    id: athlete.id,
    firstname: athlete.firstname || '',
    lastname: athlete.lastname || '',
    profile: athlete.profile || athlete.profile_medium || '',
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
    updated_at: nowSeconds(),
  });
}

function get(id) {
  return getStatement.get(id);
}

function updateTokens(id, tokens) {
  updateTokensStatement.run(tokens.access_token, tokens.refresh_token, tokens.expires_at, nowSeconds(), id);
}

module.exports = { save, get, updateTokens };
