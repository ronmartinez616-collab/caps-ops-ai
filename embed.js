export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { q } = req.body || {};
    if (!q) return res.status(400).json({ error: 'Missing q' });
    const key = process.env.OPENAI_API_KEY;
    if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
    const r = await fetch('https://api.openai.com/v1/embeddings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'text-embedding-3-small', input: q }),
    });
    const j = await r.json();
    const emb = j?.data?.[0]?.embedding || [];
    res.status(200).json({ embedding: emb });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}