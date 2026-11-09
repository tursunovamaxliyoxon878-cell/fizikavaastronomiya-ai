// Vercel serverless funksiya: Gemini API kaliti FAQAT shu yerda (muhit oʻzgaruvchisida) turadi.
const MODELS = [process.env.GEMINI_MODEL, 'gemini-3.5-flash', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'].filter(Boolean);
const LIMIT = 30; // bir foydalanuvchiga soatiga soʻrovlar soni
const hits = new Map();

async function verify(token) {
  const r = await fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + process.env.FIREBASE_API_KEY,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: token }) }
  );
  if (!r.ok) return null;
  const j = await r.json();
  return j.users && j.users[0] ? j.users[0].localId : null;
}

module.exports = async function (req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  const uid = token && (await verify(token));
  if (!uid) return res.status(401).send('Kirish talab qilinadi');

  const now = Date.now();
  const h = (hits.get(uid) || []).filter((t) => now - t < 36e5);
  if (h.length >= LIMIT) return res.status(429).send('Soatlik limit tugadi, keyinroq urinib koʻring');
  h.push(now);
  hits.set(uid, h);

  const b = req.body || {};
  const msgs = Array.isArray(b.messages) ? b.messages.slice(-12) : [];
  if (!msgs.length) return res.status(400).send('Xabar yoʻq');

  const body = {
    contents: msgs.map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: String(m.content).slice(0, 12000) }],
    })),
    generationConfig: { maxOutputTokens: 2500 },
  };
  if (b.web) body.tools = [{ google_search: {} }];

  let up, first = '', rest = [];
  for (const m of MODELS) {
    up = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + m + ':streamGenerateContent?alt=sse',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
        body: JSON.stringify(body),
      }
    );
    if (up.ok) break;
    const raw = await up.text();
    let msg = raw;
    try { msg = JSON.parse(raw).error.message; } catch (e) {}
    msg = String(msg).replace(/\s+/g, ' ');
    console.error('Gemini xato:', m, up.status, msg);
    if (!first) first = m + ' [' + up.status + '] ' + msg.slice(0, 90);
    else rest.push(m.replace('gemini-', '') + ':' + up.status);
    if (up.status !== 429 && up.status !== 404) break;
  }
  if (!up.ok) return res.status(up.status === 429 ? 429 : 502).send(first + ' | ' + rest.join(' '));

  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  const dec = new TextDecoder();
  let buf = '';
  for await (const c of up.body) {
    buf += dec.decode(c, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      if (!l.startsWith('data:')) continue;
      try {
        const j = JSON.parse(l.slice(5).trim());
        const parts = (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts) || [];
        for (const p of parts) {
          if (p.text && !p.thought) {
            res.write('data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: p.text } }) + '\n\n');
          }
        }
      } catch (e) {}
    }
  }
  res.end();
};
