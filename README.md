# Lonely Oldies

_Making old lonely peoples lives better._

A phone-first service that puts older people through to each other for a friendly chat, without either person ever seeing the other's phone number.

- **Join** on a large-print website, or by ringing the service number and following the spoken menu.
- **Say you're free**, choosing a **phone call** or a **text message chat** each time: one button on the website, ring in and press 1 (call) or 5 (text), or text `FREE` to the service number.
- **Get matched at random** with someone else who's free for the same kind of chat. For calls, the service rings you both from its own number and joins you in a private conference room. For text chats, you both text the service number and it passes each message on, so numbers stay private either way.
- **Every text message is screened** before it's passed on. Phone numbers, email addresses, links, addresses, talk of money or bank details, and abusive words are stopped.
- **Talk again** only if you *both* press 1 (or tap "Yes please") after the chat. You then appear as friends and can ring each other through the service, still without seeing numbers.
- **Stay safe**: press `*` to end a chat at any time; report someone afterwards (by phone or website) and they're blocked from you forever; two reports from different people pause their account; the team can ban a number for good.

## How the number masking works

```
 Margaret's phone ◀── rung from SERVICE NUMBER ──┐
                                                  ├── private conference "lonely-oldies-call-42"
 Arthur's phone   ◀── rung from SERVICE NUMBER ──┘
```

Both calls are placed *by the service* (Twilio REST API) from its own number, then joined in a Twilio `<Conference>`. Real numbers live only in the server's database; nothing the callers hear, see or get texted contains them (the tests check this).

Each person must press 1 before they're joined, so an answering machine or the wrong person picking up never gets put through. If one person says "not now", the other is told politely and goes back in the queue.

## Run it on your computer (test mode, no Twilio needed)

Needs Node.js 22.13 or newer.

```bash
npm install
npm start
```

Open http://localhost:3000. With no Twilio credentials set, the app runs in **test mode**: no real calls or texts are made. Open http://localhost:3000/dev/simulator to:

1. Press **Add two demo people who are free for a phone chat** (or **…for a text chat**), then **Run matching now**.
2. Play both people. For a phone chat: hear the greeting, press 1 to join, hang up, then press 1 to say you'd like to talk again. For a text chat: use **Send a text to the service** to send messages as either person, then `END`, then `YES`.
3. See the text messages that would have been sent (including sign-up codes for the website, and relayed chat messages).

Run the automated tests with `npm test`.

## Going live with Twilio

What you need to supply:

| Setting | Where from |
|---|---|
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` | Twilio console home page |
| `TWILIO_PHONE_NUMBER` | Buy a number with **Voice and SMS** (UK numbers need a regulatory bundle with your address) |
| `BASE_URL` | The public `https://` address where this app runs |
| `SESSION_SECRET` | Any long random string |
| `ADMIN_PASSWORD` | Password for the team page at `/admin` |

Steps:

1. Copy `.env.example` to `.env` and fill in the settings above.
2. Host the app somewhere with a public https address (Render, Railway, Fly.io, a VPS…), with a persistent disk for the SQLite database. For trying it from your own computer, `ngrok http 3000` gives you a temporary public address to put in `BASE_URL`.
3. In the Twilio console, open your phone number and set:
   - **A call comes in** → Webhook, `https://YOUR-APP/voice/incoming`, HTTP POST
   - **Call status changes** → `https://YOUR-APP/voice/incoming-status`, HTTP POST
   - **A message comes in** (Messaging section) → Webhook, `https://YOUR-APP/sms/incoming`, HTTP POST
4. `npm start`. The log will no longer say "Test mode".

Every webhook is checked against Twilio's signature, so nobody else can fake calls into the app. `BASE_URL` must exactly match the address Twilio uses, or every call will be refused.

**Costs** (check current Twilio pricing): each chat is two outbound call legs plus conference minutes, so roughly twice the per-minute rate for the length of the chat, plus a text each for sign-up codes and "talk again" news. `MAX_CALL_MINUTES` (default 60) caps any one chat, and `MAX_CALLS_PER_DAY` caps how many chats anyone has a day. A text chat costs one inbound and one outbound text per message (both are charged).

**Texting in the UK and US**: Twilio handles `STOP` itself and stops all texts to that person, which is why text chats use `END` instead. In the US, sending texts from a local number needs A2P 10DLC registration (or use a toll-free number).

## The phone menu

Ring the service number:

- **Not registered**: press 1 to join, say your first name, choose a 4 number PIN, type it again.
- **Registered**: type your PIN, then:
  - 1: put me through to someone new (we ring you back when someone's free)
  - 2: ring one of my friends (people who also said yes to talking again)
  - 3: I don't want calls for now
  - 4: tell us if you'd like to talk to your last chat partner again
  - 9: report someone from your last chat

  - 5: put me in touch with someone new for a text message chat

After every phone chat: 1 = talk again, 2 = no thanks, 9 = report (blocks them, then lets you leave a spoken message for the team).

## Text messages

Members text the service number:

| Text | What happens |
|---|---|
| `FREE` | Put me on the list for a text chat (`BUSY` takes you off) |
| anything, during a chat | Screened, then passed on as "Margaret: …" |
| `END` | Finish the chat; both are asked "chat again? Reply YES or NO" |
| `YES` / `NO` | After a chat: would you like to chat again? When a friend asks for a text chat: start it or not |
| `REPORT` | Ends the chat (or reports your last chat), blocks them, and sends it to the team |
| anything else | A short help message |

Friends can also be texted from the website ("Text Arthur"). The friend gets a text asking them to reply YES first. Text chats close on their own after `SMS_CHAT_IDLE_HOURS` (12) without messages.

## Safeguards

- Numbers never shared; only first names are (names are stripped of digits and symbols).
- Phone ownership is confirmed by a texted code (website) or by ringing in from that phone.
- 4 number PIN, easy PINs (1234, 1111…) refused, and 15 minute lock after 5 wrong tries. Forgotten PINs are reset with a texted code.
- Spoken safety reminder at the start of every phone chat; `*` ends the chat instantly. Text chats start with a written reminder and can be ended with `END`.
- Every text message is checked by `src/screening.js` before it's passed on. A stopped message is never delivered, and the sender is told why. After 3 stopped messages (`SCREEN_STRIKES_BEFORE_REPORT`) the chat ends and is reported to the team automatically.
- Text-chat messages are kept for 30 days (`MESSAGE_RETENTION_DAYS`) so the team can read a reported chat on the team page, together with every stopped message. Phone calls are not recorded.
- Block: never matched or connected with that person again (either direction).
- Report: blocks immediately, records what happened (typed, or a voice message by phone), and a second report from a different person pauses the account at once and ends any live call.
- Team page (`/admin`): see open reports, read reported text chats and stopped messages, ban (number can never re-register or use the service) or reinstate.
- People aren't re-paired with someone they spoke to in the last 7 days unless nobody else is free; "free for a chat" expires after 2 hours so nobody's rung late at night; a daily call cap.
- Withheld numbers can't use the phone line.

## Project layout

```
src/server.js     app setup and the matching timer
src/service.js    all the rules: accounts, matching, calls, talk-again, blocking, reports
src/voice.js      Twilio webhooks: phone menu and both sides of each call
src/sms.js        Twilio webhook for incoming text messages
src/textchat.js   text chats: matching, relaying, END/YES/NO/REPORT
src/screening.js  the rules every text message is checked against
src/web.js        website pages and team page
src/telephony.js  Twilio provider and the test-mode stand-in
src/dev.js        test-mode simulator
src/db.js         SQLite schema (uses Node's built-in SQLite, nothing to install)
test/             automated tests (npm test)
```

## Before a public launch

These are deliberately left for you to decide:

- **Legal and safeguarding**: privacy notice (GDPR), terms of use, a safeguarding policy, and how quickly the team reviews reports. Calls are not recorded; only a reporter's own voice message is. Text chats are stored for 30 days, which your privacy notice needs to say.
- **Quiet hours**: availability expires after 2 hours, but you may want to stop matching overnight entirely.
- **Screening**: the built-in checks are simple word and pattern rules, so they will sometimes stop an innocent message ("my bank holiday weekend") and can miss a cleverly worded one. You can tune them in `src/screening.js`, or add a moderation service (for example an AI model) in `TextChats.relay()`.
- **Scale**: SQLite on one server is fine for thousands of members. For more, move to Postgres and run the matcher in one place.
- **Text messages**: sign-up codes and PIN resets need an SMS-capable number. Landline-only members can join by ringing in, but would need the team to reset a forgotten PIN.
