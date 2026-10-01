// Server-rendered pages: large text, big buttons, plain words, and no
// JavaScript needed, so they work on old phones, tablets and screen readers.

export const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[c]));

const STYLE = `
:root { --bg:#fffdf8; --ink:#1b1b1b; --muted:#4a4a4a; --brand:#0b5d4b; --brand-ink:#fff;
  --soft:#eef6f3; --line:#c9c4b8; --warn:#9b1c1c; --warn-soft:#fdecec; --ok-soft:#e6f4ea; }
@media (prefers-color-scheme: dark) { :root { --bg:#141414; --ink:#f4f1ea; --muted:#c9c4b8; --brand:#3fbf9b;
  --brand-ink:#08221b; --soft:#1e2a26; --line:#444; --warn:#ff9b9b; --warn-soft:#3a1c1c; --ok-soft:#1c3324; } }
* { box-sizing: border-box; }
html { font-size: 22px; }
body { margin:0; background:var(--bg); color:var(--ink); font-family: Verdana, Tahoma, system-ui, sans-serif; line-height:1.5; }
main { max-width: 40rem; margin: 0 auto; padding: 1rem 16px 3rem; }
header { background: var(--brand); color: var(--brand-ink); padding: .8rem 16px; }
header a { color: inherit; text-decoration: none; font-weight: bold; font-size: 1.2rem; }
h1 { font-size: 1.6rem; line-height: 1.25; margin: 1rem 0 .5rem; }
h2 { font-size: 1.25rem; margin: 2rem 0 .5rem; }
p { margin: .6rem 0; }
.muted { color: var(--muted); }
label { display:block; font-weight:bold; margin: 1rem 0 .3rem; }
input[type=text], input[type=tel], input[type=password], textarea {
  width:100%; font-size:1.1rem; padding:.6rem .7rem; border:3px solid var(--line); border-radius:10px;
  background: var(--bg); color: var(--ink); }
input:focus, textarea:focus, button:focus, a:focus { outline: 4px solid #f2b705; outline-offset: 2px; }
.hint { font-weight: normal; color: var(--muted); font-size: .9rem; }
button, .button { display:block; width:100%; text-align:center; font-size:1.1rem; font-weight:bold;
  padding: .9rem 1rem; margin: .8rem 0; border-radius: 12px; border: 3px solid var(--brand);
  background: var(--brand); color: var(--brand-ink); cursor: pointer; text-decoration:none; font-family: inherit; }
button.secondary, .button.secondary { background: transparent; color: var(--brand); }
button.danger { background: transparent; color: var(--warn); border-color: var(--warn); }
button.small { display:inline-block; width:auto; font-size:.85rem; padding:.4rem .8rem; margin:.2rem .4rem .2rem 0; }
.card { border:3px solid var(--line); border-radius:14px; padding: .8rem 1rem; margin: 1rem 0; }
.status { background: var(--soft); border-color: var(--brand); }
.error { background: var(--warn-soft); border:3px solid var(--warn); color: var(--ink); border-radius:12px; padding:.7rem 1rem; }
.notice { background: var(--ok-soft); border:3px solid var(--brand); border-radius:12px; padding:.7rem 1rem; }
.phone { font-size: 1.5rem; font-weight: bold; letter-spacing: .03em; }
.row { display:flex; gap:.6rem; flex-wrap: wrap; } .row > * { flex: 1 1 10rem; }
table { border-collapse: collapse; width:100%; font-size: .8rem; } td, th { border:1px solid var(--line); padding:.3rem; text-align:left; vertical-align: top; }
pre { white-space: pre-wrap; font-size:.7rem; background: var(--soft); padding:.5rem; border-radius: 8px; }
ul.tips li { margin-bottom: .5rem; }
`;

export function page({ title, body, user, csrf, refresh }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${refresh ? `<meta http-equiv="refresh" content="${refresh}">` : ''}
<title>${esc(title)} · Lonely Oldies</title>
<style>${STYLE}</style>
</head>
<body>
<header><a href="/">☎ Lonely Oldies</a>${user ? `<span style="float:right">${esc(user.name)}</span>` : ''}</header>
<main>
${body}
${user ? `<form method="post" action="/signout"><input type="hidden" name="_csrf" value="${esc(csrf)}"><button class="secondary">Sign out</button></form>` : ''}
<p class="muted" style="margin-top:2rem"><a href="/safety">Staying safe</a></p>
</main>
</body>
</html>`;
}

export const field = (csrf) => `<input type="hidden" name="_csrf" value="${esc(csrf)}">`;
export const errorBox = (msg) => (msg ? `<p class="error" role="alert">${esc(msg)}</p>` : '');
export const noticeBox = (msg) => (msg ? `<p class="notice" role="status">${esc(msg)}</p>` : '');

export function when(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' });
}
