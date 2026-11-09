// Vercel serverless funksiya: OpenRouter API kaliti FAQAT shu yerda (muhit oʻzgaruvchisida) turadi.
const MODELS = [process.env.OPENROUTER_MODEL, 'openrouter/free', 'meta-llama/llama-3.3-70b-instruct:free', 'openai/gpt-oss-120b:free'].filter(Boolean);
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
  const messages = msgs.map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content).slice(0, 12000),
  }));

  let up, first = '', rest = [];
  for (const m of MODELS) {
    up = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + process.env.OPENROUTER_API_KEY, 'X-Title': 'AstroFizika AI' },
      body: JSON.stringify({ model: m, messages, max_tokens: 2000, temperature: 0.6, stream: true }),
    });
    if (up.ok) break;
    const raw = await up.text();
    let msg = raw;
    try { msg = JSON.parse(raw).error.message; } catch (e) {}
    msg = String(msg).replace(/\s+/g, ' ');
    console.error('OpenRouter xato:', m, up.status, msg);
    if (!first) first = m + ' [' + up.status + '] ' + msg.slice(0, 90);
    else rest.push(m + ':' + up.status);
    if (![400, 402, 404, 429, 502, 503].includes(up.status)) break;
  }
  if (!up.ok) return res.status(up.status === 429 ? 429 : 502).send(first + (rest.length ? ' | ' + rest.join(' ') : ''));

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
      const d = l.slice(5).trim();
      if (!d || d === '[DONE]') continue;
      try {
        const t = JSON.parse(d).choices[0].delta.content;
        if (t) res.write('data: ' + JSON.stringify({ type: 'content_block_delta', delta: { type: 'text_delta', text: t } }) + '\n\n');
      } catch (e) {}
    }
  }
  res.end();
};
