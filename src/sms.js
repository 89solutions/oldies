// Twilio messaging webhook: every text sent to the service number arrives here.
// Replies are sent through the REST API, so the webhook itself answers with nothing.

import express from 'express';
import { validateTwilio } from './voice.js';

export function smsRouter({ service, config, log = console }) {
  const router = express.Router();
  router.use(express.urlencoded({ extended: false }));
  if (config.telephony === 'twilio' && config.twilio.validateWebhooks) router.use(validateTwilio(config));

  router.post('/incoming', async (req, res) => {
    try {
      await service.texts.incoming(req.body.From, req.body.Body);
    } catch (err) {
      log.error?.('Text message webhook failed', err);
    }
    res.type('text/xml').send('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  return router;
}
