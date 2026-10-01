import express from 'express';
import cookieSession from 'cookie-session';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { createTelephony } from './telephony.js';
import { Service } from './service.js';
import { voiceRouter } from './voice.js';
import { webRouter } from './web.js';
import { devRouter } from './dev.js';
import { smsRouter } from './sms.js';

export function createApp({ config = loadConfig(), db, telephony, log = console, now } = {}) {
  db ??= openDb(config.dbPath);
  telephony ??= createTelephony(config, log);
  const service = new Service({ db, config, telephony, log, now });

  // Matching runs on a timer, and straight away when someone says they're free.
  let matching = false;
  const runMatchmaker = async () => {
    if (matching) return;
    matching = true;
    try {
      await service.runMatchmaker();
    } catch (err) {
      log.error?.('Matchmaker failed', err);
    } finally {
      matching = false;
    }
  };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((req, res, next) => {
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Referrer-Policy', 'same-origin');
    res.set('X-Frame-Options', 'DENY');
    next();
  });

  service.onAvailable = runMatchmaker;
  app.use('/voice', voiceRouter({ service, config, log, onAvailable: runMatchmaker }));
  app.use('/sms', smsRouter({ service, config, log }));

  app.use(cookieSession({
    name: 'lo_session',
    keys: [config.sessionSecret],
    maxAge: 30 * 24 * 60 * 60 * 1000,
    httpOnly: true,
    sameSite: 'lax',
    secure: config.baseUrl.startsWith('https://'),
  }));
  if (telephony.mode === 'mock') app.use('/dev', devRouter({ service, telephony, onAvailable: runMatchmaker }));
  app.use('/', webRouter({ service, config, log, onAvailable: runMatchmaker }));

  app.get('/healthz', (req, res) => res.json({ ok: true, telephony: telephony.mode }));

  return { app, service, telephony, runMatchmaker };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = loadConfig();
  const { app, runMatchmaker, telephony } = createApp({ config });
  app.listen(config.port, () => {
    console.log(`Lonely Oldies running on ${config.baseUrl} (port ${config.port})`);
    if (telephony.mode === 'mock') {
      console.log(`Test mode: no real calls or texts. Simulator: http://localhost:${config.port}/dev/simulator`);
    }
  });
  setInterval(runMatchmaker, config.matchIntervalSeconds * 1000);
}
