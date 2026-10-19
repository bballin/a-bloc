const path = require('path');
const express = require('express');
const session = require('express-session');
const config = require('./config');
const sessionStore = require('./session-store');
const { noStore } = require('./routes/middleware');
const { createWebhookRouter } = require('./routes/webhook');

function createApp({ queue, isShuttingDown = () => false }) {
  const app = express();

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
    cookie: { httpOnly: true, sameSite: 'lax', maxAge: config.sessionMaxAgeMs },
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
