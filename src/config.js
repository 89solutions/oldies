// All settings come from environment variables (see .env.example).
// With no Twilio credentials the app runs in "mock" mode: no real calls or texts
// are made, and a simulator page at /dev/simulator lets you play both callers.

const env = process.env;

const int = (name, fallback) => {
  const v = env[name];
  return v === undefined || v === '' ? fallback : Number.parseInt(v, 10);
};

export function loadConfig(overrides = {}) {
  const twilioConfigured = Boolean(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_PHONE_NUMBER);
  const port = int('PORT', 3000);
  const config = {
    port,
    baseUrl: (env.BASE_URL || `http://localhost:${port}`).replace(/\/$/, ''),
    dbPath: env.DATABASE_PATH || 'lonely-oldies.db',
    sessionSecret: env.SESSION_SECRET || 'dev-only-change-me',
    adminPassword: env.ADMIN_PASSWORD || '',

    telephony: twilioConfigured && env.TELEPHONY_MODE !== 'mock' ? 'twilio' : 'mock',
    twilio: {
      accountSid: env.TWILIO_ACCOUNT_SID || '',
      authToken: env.TWILIO_AUTH_TOKEN || '',
      phoneNumber: env.TWILIO_PHONE_NUMBER || '',
      validateWebhooks: env.TWILIO_VALIDATE_WEBHOOKS !== 'false',
    },
    // Number shown on the website for people who prefer to phone in.
    publicPhoneNumber: env.PUBLIC_PHONE_NUMBER || env.TWILIO_PHONE_NUMBER || '(not set up yet)',
    defaultCountryCode: env.DEFAULT_COUNTRY_CODE || '44',
    voice: env.TTS_VOICE || 'Polly.Amy',
    voiceLanguage: env.TTS_LANGUAGE || 'en-GB',

    // Matching and safety rules.
    matchIntervalSeconds: int('MATCH_INTERVAL_SECONDS', 20),
    availableForMinutes: int('AVAILABLE_FOR_MINUTES', 120),
    maxCallMinutes: int('MAX_CALL_MINUTES', 60),
    maxCallsPerDay: int('MAX_CALLS_PER_DAY', 6),
    avoidRepeatDays: int('AVOID_REPEAT_DAYS', 7),
    reportSuspendThreshold: int('REPORT_SUSPEND_THRESHOLD', 2),
    // Text chats end after this many hours with no messages.
    smsChatIdleHours: int('SMS_CHAT_IDLE_HOURS', 12),
    // Stopped messages before a text chat is ended and sent to the team.
    screenStrikesBeforeReport: int('SCREEN_STRIKES_BEFORE_REPORT', 3),
    // Text-chat messages are kept this long for the team to review reports.
    messageRetentionDays: int('MESSAGE_RETENTION_DAYS', 30),
    // Group chats start once this many people are waiting, and hold at most this many.
    groupMinSize: int('GROUP_MIN_SIZE', 3),
    groupMaxSize: int('GROUP_MAX_SIZE', 6),
    maxPinAttempts: int('MAX_PIN_ATTEMPTS', 5),
    pinLockMinutes: int('PIN_LOCK_MINUTES', 15),
    ...overrides,
  };
  if (config.telephony === 'twilio' && config.sessionSecret === 'dev-only-change-me') {
    throw new Error('Set SESSION_SECRET before running with real Twilio credentials.');
  }
  return config;
}
