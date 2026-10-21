const path = require('path');
const express = require('express');
const session = require('express-session');
const config = require('./config');
const sessionStore = require('./session-store');
const { noStore } = require('./routes/middleware');
const { createWebhookRouter } = require('./routes/webhook');

function createApp({ queue, isShuttingDown = () => false }) {
  const app = express();

  if (config.isProduction) {
    // Production runs behind a TLS-terminating proxy; keep the Node port private.
    app.set('trust proxy', 1);
    app.use((req, res, next) => {
      if (!req.secure) {
        res.set('Cache-Control', 'no-store');
        if (req.method === 'GET' || req.method === 'HEAD') {
          return res.redirect(302, `${config.appBaseUrl}${req.originalUrl}`);
        }
        return res.status(400).json({ error: 'HTTPS is required. Open the app using its HTTPS address before submitting credentials.' });
      }
      res.set('Strict-Transport-Security', 'max-age=31536000');
      next();
    });
  }

  app.use((req, res, next) => {
    // Release keep-alive sockets so server.close() can finish during shutdown.
    if (isShuttingDown()) res.set('Connection', 'close');
    next();
  });
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.use(session({
    secret: config.sessionSecret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    cookie: { httpOnly: true, secure: config.isProduction, sameSite: 'lax', maxAge: config.sessionMaxAgeMs },
  }));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use('/api', noStore);

  app.use(createWebhookRouter({ queue }));
  app.use(require('./routes/auth'));
  app.use(require('./routes/gear'));
  app.use(require('./routes/settings'));
  app.use(require('./routes/segments'));
  app.use(require('./routes/segment-counts'));

  return app;
}

module.exports = { createApp };
