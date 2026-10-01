// Checks every text-chat message before it is passed on. Messages that could
// break someone's anonymity, set up a scam, or are abusive are not delivered.
//
// These are simple, predictable rules. For more nuanced screening you could
// also send each message to a moderation service from TextChats.relay().

const RULES = [
  {
    reason: 'a phone number',
    category: 'contact',
    test: (t) => /(?:\+?\d[\s\-.()]*){7,}/.test(t),
  },
  { reason: 'an email address', category: 'contact', test: (t) => /[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(t) },
  {
    reason: 'a web link',
    category: 'contact',
    test: (t) => /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|co\.uk|org\.uk|uk|net|org|io|me|ly|info|biz)\b)/i.test(t),
  },
  {
    reason: 'an address',
    category: 'contact',
    test: (t) => /\b[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}\b/i.test(t) // UK postcode
      || /\b\d+[a-z]?\s+[a-z']+(\s+[a-z']+)?\s+(street|st|road|rd|avenue|ave|lane|ln|close|drive|dr|crescent|court|grove|gardens|terrace|place|way)\b/i.test(t),
  },
  {
    reason: 'a way to talk outside Lonely Oldies',
    category: 'contact',
    test: (t) => /\b(whats\s?app|telegram|signal app|snapchat|instagram|facebook|messenger|skype|zoom|my number|your number|home number|mobile number|where do you live|your address|meet (up|me|in person))\b/i.test(t),
  },
  {
    reason: 'something about money or bank details',
    category: 'money',
    test: (t) => /\b(bank|account number|sort code|pin number|password|card number|credit card|debit card|cvv|send (me )?money|lend me|borrow|transfer|wire|western union|moneygram|gift ?cards?|itunes|amazon voucher|bitcoin|crypto|paypal|cash ?app|invest(ment)?|inheritance|lottery|loan)\b/i.test(t)
      || /[£$€]\s?\d/.test(t),
  },
  {
    reason: 'unkind or threatening language',
    category: 'abuse',
    test: (t) => /\b(f+u+c+k+\w*|c+u+n+t+s?|bitch\w*|bastard\w*|whore|slut|twat|wanker|retard\w*|kill (you|yourself)|hurt you|shut up)\b/i.test(t),
  },
];

export const MAX_MESSAGE_LENGTH = 600;

export function screenMessage(text) {
  const body = String(text ?? '').trim();
  if (!body) return { ok: false, reason: 'an empty message', category: 'empty' };
  if (body.length > MAX_MESSAGE_LENGTH) return { ok: false, reason: 'too much writing in one go', category: 'length' };
  for (const rule of RULES) {
    if (rule.test(body)) return { ok: false, reason: rule.reason, category: rule.category };
  }
  return { ok: true };
}
