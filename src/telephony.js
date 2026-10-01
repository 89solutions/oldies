// Two interchangeable providers:
//  - TwilioTelephony places real calls and texts through the Twilio REST API.
//  - MockTelephony records what would have happened, for development and tests.
// Every outbound call is placed FROM the service's own Twilio number, so neither
// person ever sees or hears the other's real number.

import twilio from 'twilio';

export function createTelephony(config, log = console) {
  return config.telephony === 'twilio' ? new TwilioTelephony(config) : new MockTelephony(log);
}

class TwilioTelephony {
  constructor(config) {
    this.mode = 'twilio';
    this.client = twilio(config.twilio.accountSid, config.twilio.authToken);
    this.from = config.twilio.phoneNumber;
  }

  async placeCall({ to, url, statusCallback }) {
    const call = await this.client.calls.create({
      to,
      from: this.from,
      url,
      method: 'POST',
      statusCallback,
      statusCallbackMethod: 'POST',
      statusCallbackEvent: ['completed'],
      timeout: 30,
    });
    return call.sid;
  }

  // Sends a live call to new TwiML (used to tell a waiting person their partner can't come).
  async redirectCall(sid, url) {
    try {
      await this.client.calls(sid).update({ url, method: 'POST' });
    } catch (err) {
      if (err.status !== 404 && err.code !== 21220) throw err; // call already over
    }
  }

  async hangUp(sid) {
    try {
      await this.client.calls(sid).update({ status: 'completed' });
    } catch (err) {
      if (err.status !== 404 && err.code !== 21220) throw err;
    }
  }

  async sendSms(to, body) {
    await this.client.messages.create({ to, from: this.from, body });
  }
}

export class MockTelephony {
  constructor(log = console) {
    this.mode = 'mock';
    this.log = log;
    this.calls = [];
    this.sms = [];
    this.events = [];
    this.counter = 0;
  }

  async placeCall({ to, url, statusCallback }) {
    const sid = `CAmock${String(++this.counter).padStart(6, '0')}`;
    this.calls.push({ sid, to, url, statusCallback, live: true, createdAt: Date.now() });
    this.log.info?.(`[mock] would ring ${to} (${sid})`);
    return sid;
  }

  async redirectCall(sid, url) {
    this.events.push({ type: 'redirect', sid, url });
    this.log.info?.(`[mock] redirect ${sid} -> ${url}`);
  }

  async hangUp(sid) {
    this.events.push({ type: 'hangup', sid });
    const call = this.calls.find((c) => c.sid === sid);
    if (call) call.live = false;
    this.log.info?.(`[mock] hang up ${sid}`);
  }

  async sendSms(to, body) {
    this.sms.push({ to, body, at: Date.now() });
    this.log.info?.(`[mock] text to ${to}: ${body}`);
  }
}
