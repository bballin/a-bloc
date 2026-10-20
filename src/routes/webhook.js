const express = require('express');
const config = require('../config');
const strava = require('../strava');
const settings = require('../settings');

function createWebhookRouter({ queue }) {
  const router = express.Router();

  router.get('/api/webhook/strava', (req, res) => {
    if (req.query['hub.mode'] !== 'subscribe' || req.query['hub.verify_token'] !== config.webhookVerifyToken) {
      return res.status(403).json({ error: 'webhook_verification_failed' });
    }
    res.json({ 'hub.challenge': req.query['hub.challenge'] });
  });

  router.post('/api/webhook/strava', (req, res) => {
    const event = req.body || {};
    if (event.object_type === 'activity' && event.aspect_type === 'create'
      && /^\d+$/.test(String(event.owner_id)) && /^\d+$/.test(String(event.object_id))
      && strava.getAthlete(event.owner_id)) {
      // Persist before acknowledging; Strava will not redeliver after a 200.
      if (settings.isGearWebhookEnabled(event.owner_id)) {
        queue.enqueue('gear', event.owner_id, event.object_id);
      }
      queue.enqueue('segment_counts', event.owner_id, event.object_id);
    }
    res.status(200).json({ received: true });
  });

  return router;
}

module.exports = { createWebhookRouter };
