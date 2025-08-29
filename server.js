require('dotenv').config();
const express = require('express');
const shodan = require('./shodanBrowser');

const PORT = Number(process.env.PORT || 3000);
const app = express();

app.use(express.json({ limit: '1mb' }));
app.use(express.static('public')); // UI estática sin gráficas

app.get('/health', (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

app.post('/search', async (req, res) => {
  try {
    const query = (req.body?.query || req.query?.q || '').toString().trim();
    if (!query) return res.status(400).json({ error: 'Missing "query" in JSON body or ?q=' });

    const pages = Math.max(1, Number(req.body?.pages || req.query?.pages || 2)); // 1+2 por defecto
    const result = await shodan.search(query, { pages });
    res.json(result);
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: 'Search failed', detail: String(err?.message || err) });
  }
});

// Start & login (mantiene el navegador abierto)
(async () => {
  try { await shodan.launch(); } catch (e) { console.error('Login/init warning:', e.message); }
  app.listen(PORT, () => console.log(`API en http://0.0.0.0:${PORT}`));

  const shutdown = async (sig) => {
    console.log(`${sig} recibido, cerrando…`);
    await shodan.close();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
})();
