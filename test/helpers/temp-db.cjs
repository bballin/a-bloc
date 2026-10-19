const fs = require('fs');
const os = require('os');
const path = require('path');

// Call before requiring any src module: points the app's SQLite database at a
// throwaway directory. Kept side-effect free because node --test also loads this file.
function useTempDatabase() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'a-bloc-test-'));
  process.env.APP_DATA_DIR = dataDir;
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-0123456789';
  return {
    dataDir,
    cleanup() {
      try { require('../../src/db').close(); } catch { /* already closed */ }
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

module.exports = { useTempDatabase };
