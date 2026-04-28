import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = 3000;
const CONFIG_DIR = 'C:/Users/User/Downloads/KNX_TO_OPC';
const CONFIG_PATH = path.join(CONFIG_DIR, 'knxGroupAddress.json');
const STATUS_PATH = path.join(CONFIG_DIR, 'knxStatus.json');

app.use(express.json());
// don't let express.static automatically serve index.html for '/'
// we want our GET '/' route to decide whether to return the editor or the dashboard
app.use(express.static('public', { index: false }));

// fallback for other static files (404 will be handled by express automatically)

// API to save full config (writes knxGroupAddress.json in project root)
app.post('/api/save', async (req, res) => {
  try {
    const cfg = req.body;
    if (!cfg || !Array.isArray(cfg.gateways)) {
      return res.status(400).json({ error: 'Invalid config payload, expected { gateways: [...] }' });
    }

    await saveConfig(cfg);
    return res.json({ ok: true });
  } catch (err) {
    console.error('Save error', err);
    return res.status(500).json({ error: String(err) });
  }
});

// Serve index or dashboard depending on whether config exists
app.get('/', async (req, res) => {
  try {
    await fs.access(CONFIG_PATH);
    // config exists -> serve dashboard
    return res.sendFile(path.resolve('public/dashboard.html'));
  } catch (err) {
    // config missing -> serve main editor
    return res.sendFile(path.resolve('public/index.html'));
  }
});

async function loadConfig() {
  try {
    const txt = await fs.readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(txt);
  } catch (err) {
    return { gateways: [] };
  }
}

async function saveConfig(cfg) {
  const tmp = CONFIG_PATH + '.tmp';
  await fs.writeFile(tmp, JSON.stringify(cfg, null, 4), 'utf8');
  await fs.rename(tmp, CONFIG_PATH);
}

// Simple ETS-like parser: accept CSV or plain text with GA and name columns.
function parseEtsFile(buffer) {
  const text = buffer.toString('utf8');
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const points = [];

  for (const line of lines) {
    // Try to split by comma or semicolon or tab
    const parts = line.split(/[,;\t]+/).map(p => p.trim());
    // heuristics: find first token that looks like a GA (e.g., 1/2/3 or 0/0/1)
    let ga = null;
    let name = null;

    for (const p of parts) {
      if (/^\d+\/\d+\/\d+$/.test(p)) {
        ga = p;
        break;
      }
    }

    if (!ga && parts.length >= 1 && /^\d+[.,]\d+[.,]\d+$/.test(parts[0])) {
      // sometimes dots or commas used
      ga = parts[0].replace(/[.,]/g, '/');
    }

    if (!ga && parts.length >= 2 && /^\d+$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
      // fallback impossible, skip
    }

    // Name heuristics: last column or second column
    if (parts.length >= 2) {
      name = parts.slice(1).join(' - ');
    } else if (parts.length === 1) {
      // if single column contains "GA name"
      const m = parts[0].match(/(\d+[\./]\d+[\./]\d+)\s+(.+)/);
      if (m) {
        ga = ga || m[1].replace(/[.,]/g, '/');
        name = m[2];
      }
    }

    if (ga) {
      points.push({ ga, dst: name || '' });
    }
  }

  return points;
}

app.post('/api/upload', upload.single('etsfile'), async (req, res) => {
  try {
    const { ip } = req.body;
    if (!ip) return res.status(400).json({ error: 'Missing ip field' });
    if (!req.file) return res.status(400).json({ error: 'Missing file upload' });

    const points = parseEtsFile(req.file.buffer);

    const config = await loadConfig();

    // replace or add gateway with this IPRS
    const idx = config.gateways.findIndex(g => g.IPRS === ip);
    const gateway = { IPRS: ip, points };

    if (idx >= 0) {
      config.gateways[idx] = gateway;
    } else {
      config.gateways.push(gateway);
    }

    await saveConfig(config);

    return res.json({ ok: true, added: points.length });
  } catch (err) {
    console.error('Upload error', err);
    return res.status(500).json({ error: String(err) });
  }
});

app.get('/api/config', async (req, res) => {
  res.json(await loadConfig());
});

// Return latest runtime statuses written by knxClient (if available)
app.get('/api/status', async (req, res) => {
  try {
    const txt = await fs.readFile(STATUS_PATH, 'utf8');
    return res.json(JSON.parse(txt));
  } catch (err) {
    // if file missing, return empty structure
    return res.json({ updated: null, points: [] });
  }
});

app.listen(PORT, () => {
  console.log(`Config server listening on http://localhost:${PORT}`);
});
