function requireAuth(req, res, next) {
  if (!req.session.athleteId) return res.status(401).json({ error: 'not_authenticated' });
  next();
}

function noStore(req, res, next) {
  res.set('Cache-Control', 'no-store');
  delete req.headers['if-none-match'];
  delete req.headers['if-modified-since'];
  next();
}

module.exports = { requireAuth, noStore };
