// Vercel serverless funksiya: Anthropic API kaliti FAQAT shu yerda (muhit oʻzgaruvchisida) turadi.
const MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5'];
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
  const messages = Array.isArray(b.messages)
    ? b.messages.slice(-12).map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: String(m.content).slice(0, 12000),
      }))
    : [];
  if (!messages.length) return res.status(400).send('Xabar yoʻq');

  const body = {
    model: MODELS.includes(b.model) ? b.model : MODELS[1],
    max_tokens: 2500,
    stream: true,
    messages,
  };
  if (b.web) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];

  const up = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  if (!up.ok) return res.status(502).send('AI xatosi: ' + (await up.text()).slice(0, 200));

  res.setHeader('content-type', 'text/event-stream');
  res.setHeader('cache-control', 'no-cache');
  for await (const c of up.body) res.write(c);
  res.end();
};
