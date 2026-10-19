// Helpers shared by every page. Loaded as a classic script before page scripts.

async function api(path, options = {}) {
  const res = await fetch(path, { credentials: 'same-origin', ...options });
  const contentType = res.headers.get('content-type') || '';
  const body = contentType.includes('application/json')
    ? await res.json().catch(() => ({}))
    : await res.text();
  if (!res.ok) {
    const message = typeof body === 'string' ? body : body.error;
    const error = new Error(message || `Request failed (HTTP ${res.status})`);
    error.status = res.status;
    error.body = body;
    throw error;
  }
  return body;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
