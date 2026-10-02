// Page layout for the website. Written for people who don't use computers
// much: large text, big buttons, plain words, calm colours, and no
// JavaScript needed, so pages work on old phones, tablets and screen readers.

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const STYLE = `
:root {
  --bg: #f7f5ef; --surface: #ffffff; --ink: #1f2a2e; --muted: #48585c;
  --brand: #2f6f6a; --brand-dark: #24524e; --brand-ink: #ffffff;
  --sage: #e3efe9; --sky: #e6eef5; --peach: #f6e9e1; --line: #cdd8d2;
  --warn: #9b2c2c; --warn-soft: #fbeaea; --focus: #f2b705;
}
* { box-sizing: border-box; }
html { font-size: 125%; }
html.bigger { font-size: 150%; }
body { margin: 0; background: var(--bg); color: var(--ink); line-height: 1.55;
  font-family: Verdana, Tahoma, "Segoe UI", system-ui, sans-serif; font-size: 1.05rem; }
a { color: var(--brand-dark); text-underline-offset: .18em; }
img { max-width: 100%; height: auto; }
.skip { position: absolute; left: -999px; } .skip:focus { left: 16px; top: 8px; background: var(--surface); padding: .5rem; z-index: 2; }

.top { background: var(--brand); color: var(--brand-ink); }
.top-inner { max-width: 46rem; margin: 0 auto; padding: .7rem 16px; display: flex; flex-wrap: wrap; align-items: center; gap: .4rem 1rem; }
.logo { display: flex; align-items: center; gap: .55rem; color: inherit; text-decoration: none; font-weight: bold; font-size: 1.3rem; margin-right: auto; }
.logo img { width: 2.2rem; height: 2.2rem; }
.textsize { color: inherit; font-size: .85rem; white-space: nowrap; }
nav.menu { background: var(--brand-dark); }
nav.menu ul { max-width: 46rem; margin: 0 auto; padding: .2rem 10px; list-style: none; display: flex; flex-wrap: wrap; }
nav.menu a { display: block; color: var(--brand-ink); padding: .55rem .6rem; font-size: .9rem; text-decoration: none; }
nav.menu a[aria-current] { text-decoration: underline; text-underline-offset: .3em; text-decoration-thickness: 3px; }

main { max-width: 46rem; margin: 0 auto; padding: 1rem 16px 2rem; }
h1 { font-size: 1.85rem; line-height: 1.2; margin: 1.2rem 0 .6rem; }
h2 { font-size: 1.4rem; line-height: 1.25; margin: 2.2rem 0 .6rem; }
h3 { font-size: 1.15rem; margin: 1.2rem 0 .3rem; }
p, li { max-width: 36em; }
p { margin: .7rem 0; }
.lead { font-size: 1.15rem; }
.muted { color: var(--muted); }

.hero { text-align: center; }
.hero img { width: 100%; max-width: 34rem; display: block; margin: .5rem auto 0; }

.button, button { display: block; width: 100%; text-align: center; font: inherit; font-weight: bold; font-size: 1.1rem;
  padding: 1rem 1.1rem; margin: .9rem 0; border-radius: 14px; border: 3px solid var(--brand);
  background: var(--brand); color: var(--brand-ink); cursor: pointer; text-decoration: none; line-height: 1.3; }
.button:hover, button:hover { background: var(--brand-dark); border-color: var(--brand-dark); }
.button.secondary, button.secondary { background: var(--surface); color: var(--brand-dark); }
.button.secondary:hover, button.secondary:hover { background: var(--sage); }
button.danger { background: var(--surface); color: var(--warn); border-color: var(--warn); }
button.small { display: inline-block; width: auto; font-size: .8rem; padding: .4rem .8rem; margin: .2rem .4rem .2rem 0; }
button.link { display: inline; width: auto; background: none; border: none; padding: 0; margin: 0; color: var(--brand-dark);
  text-decoration: underline; font-weight: normal; font-size: inherit; }
button.link:hover { background: none; }
.choice { display: flex; align-items: center; gap: 1rem; text-align: left; }
.choice img { width: 3.6rem; height: 3.6rem; flex: none; }
.choice span { display: block; }
.choice small { display: block; font-weight: normal; font-size: .85rem; }

.card { background: var(--surface); border: 2px solid var(--line); border-radius: 18px; padding: 1rem 1.2rem; margin: 1.2rem 0; }
.card.sage { background: var(--sage); border-color: #b9d3c4; }
.card.sky { background: var(--sky); border-color: #c4d6e6; }
.card.peach { background: var(--peach); border-color: #ecd2c2; }
.card > h1:first-child, .card > h2:first-child, .card > h3:first-child { margin-top: .2rem; }
.with-pic { display: flex; gap: 1rem; align-items: flex-start; }
.with-pic > img { width: 4.5rem; height: 4.5rem; flex: none; }
.with-pic > div { flex: 1; min-width: 0; }
.with-pic h2 { margin-top: .4rem; }
@media (max-width: 560px) {
  .with-pic { flex-direction: column; gap: .2rem; }
  .with-pic > img { width: 3.5rem; height: 3.5rem; }
}

.steps { list-style: none; padding: 0; margin: 1rem 0; }
.steps li { display: flex; gap: 1rem; align-items: flex-start; margin: 0 0 1.3rem; }
.steps img { width: 4.5rem; height: 4.5rem; flex: none; }
.steps h3 { margin: .2rem 0 .2rem; }
.steps p { margin: .2rem 0; }

label { display: block; font-weight: bold; margin: 1.3rem 0 .35rem; }
.hint { display: block; font-weight: normal; color: var(--muted); font-size: .9rem; }
input[type=text], input[type=tel], input[type=password], textarea, select {
  width: 100%; font: inherit; font-size: 1.15rem; padding: .7rem .8rem; border: 3px solid #9fb3ab; border-radius: 12px;
  background: var(--surface); color: var(--ink); }
input.short { max-width: 9em; letter-spacing: .3em; }
label.tick { display: flex; gap: .8rem; align-items: flex-start; font-weight: normal; }
label.tick input { width: 1.6rem; height: 1.6rem; margin-top: .15rem; flex: none; }
:focus-visible { outline: 4px solid var(--focus); outline-offset: 3px; }

.message { border-radius: 14px; padding: .9rem 1.1rem; margin: 1rem 0; font-size: 1.05rem; }
.message.good { background: var(--sage); border: 3px solid var(--brand); }
.message.bad { background: var(--warn-soft); border: 3px solid var(--warn); }
.phone { font-size: 1.6rem; font-weight: bold; letter-spacing: .04em; white-space: nowrap; }
.row { display: flex; gap: .8rem; flex-wrap: wrap; } .row > * { flex: 1 1 11rem; }
details summary { cursor: pointer; padding: .4rem 0; color: var(--brand-dark); }
.faq details { background: var(--surface); border: 2px solid var(--line); border-radius: 14px; padding: .4rem 1rem; margin: .7rem 0; }
.faq summary { font-weight: bold; color: var(--ink); padding: .6rem 0; }
.tips li { margin-bottom: .7rem; }

footer { background: var(--sage); margin-top: 2rem; }
footer .inner { max-width: 46rem; margin: 0 auto; padding: 1.2rem 16px 2rem; }
footer p { margin: .4rem 0; }
table { border-collapse: collapse; width: 100%; font-size: .75rem; background: var(--surface); }
td, th { border: 1px solid var(--line); padding: .35rem; text-align: left; vertical-align: top; }
pre { white-space: pre-wrap; font-size: .7rem; background: var(--sage); padding: .5rem; border-radius: 8px; }
`;

const MENU = [
  ['/', 'Home'],
  ['/groups', 'Group chats'],
  ['/how-it-works', 'How it works'],
  ['/safety', 'Staying safe'],
  ['/questions', 'Questions'],
];

// `path` marks the current menu item; `big` is the visitor's "bigger text" choice.
export function page({ title, body, user, csrf, refresh, path = '', big = false, phone = '' }) {
  const menu = (user ? [['/me', 'Your page'], ...MENU.slice(1)] : MENU)
    .map(([href, label]) => `<li><a href="${href}"${href === path ? ' aria-current="page"' : ''}>${label}</a></li>`).join('');
  return `<!doctype html>
<html lang="en-GB"${big ? ' class="bigger"' : ''}>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${esc(title)} · Lonely Oldies</title>
<link rel="icon" href="/images/logo.svg">
<style>${STYLE}</style>
</head>
<body>
<a class="skip" href="#main">Skip to the main part of the page</a>
<header class="top"><div class="top-inner">
<a class="logo" href="${user ? '/me' : '/'}"><img src="/images/logo.svg" alt="">Lonely Oldies</a>
<a class="textsize" href="/text-size?big=${big ? 0 : 1}&amp;back=${encodeURIComponent(path || '/')}">${big ? 'Smaller text' : 'Make the text bigger'}</a>
</div></header>
<nav class="menu" aria-label="Main"><ul>${menu}</ul></nav>
<main id="main">
${body}
</main>
<footer><div class="inner">
<p><strong>Need a hand?</strong> Ring us on <span class="phone" style="font-size:1.1rem">${esc(phone)}</span> and we'll help you.</p>
${user ? `<form method="post" action="/signout"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="link">Sign out</button></form>` : '<p><a href="/signin">Sign in</a> · <a href="/join">Join</a></p>'}
</div></footer>
</body>
</html>`;
}

export const field = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
export const errorBox = (msg) => (msg ? `<p class="message bad" role="alert">${esc(msg)}</p>` : '');
export const noticeBox = (msg) => (msg ? `<p class="message good" role="status">${esc(msg)}</p>` : '');

export function when(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
}

export const timeOfDay = (ms) => new Date(ms).toLocaleTimeString('en-GB', { hour: 'numeric', minute: '2-digit', hour12: true });
