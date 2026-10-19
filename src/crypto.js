const crypto = require('crypto');
const config = require('./config');

// AES-256-GCM with key derived from SESSION_SECRET via scrypt.
// Format on disk: base64( salt(16) || iv(12) || tag(16) || ciphertext )

function getSecret() {
  if (!config.credentialsSecret) {
    throw new Error('SESSION_SECRET must be set to a long random string (>=16 chars) before storing credentials.');
  }
  return config.credentialsSecret;
}

function deriveKey(secret, salt) {
  return crypto.scryptSync(secret, salt, 32, { N: 16384, r: 8, p: 1 });
}

function encrypt(plaintext) {
  if (plaintext == null) return null;
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const key = deriveKey(getSecret(), salt);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([salt, iv, tag, ct]).toString('base64');
}

function decrypt(blob) {
  if (blob == null) return null;
  const buf = Buffer.from(blob, 'base64');
  const salt = buf.subarray(0, 16);
  const iv = buf.subarray(16, 28);
  const tag = buf.subarray(28, 44);
  const ct = buf.subarray(44);
  const key = deriveKey(getSecret(), salt);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString('utf8');
}

module.exports = { encrypt, decrypt };
