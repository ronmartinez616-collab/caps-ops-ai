export default async function handler(req, res) {
  try {
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
    const { question, segments } = req.body || {};
    const key = process.env.OPENAI_API_KEY;
    if (!key) return res.status(500).json({ error: 'OPENAI_API_KEY not set' });
    const context = (segments || []).map((s,i)=>`[${i+1}] ${s.docName} p.${s.page}\n${s.text}`).join('\n\n');
    const prompt = `You are CAPS Ops AI for a QSR. Use the reference context to answer succinctly. Always add a Sources section with file and page numbers.\n\nQUESTION:\n${question}\n\nREFERENCE:\n${context}`;
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({ model: 'gpt-4o-mini', temperature: 0.2, messages: [{ role:'user', content: prompt }] }),
    });
    const j = await r.json();
    const answer = j?.choices?.[0]?.message?.content || 'No answer';
    res.status(200).json({ answer });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}