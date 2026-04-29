import express from 'express';
import fs from 'fs/promises';
import path from 'path';
import multer from 'multer';
import os from 'os';
import { fileURLToPath } from 'url';

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

const PORT = 3001;

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUBLIC_DIR = path.join(__dirname, 'public');

const CONFIG_DIR = 'C:/Users/User/Downloads/KNX_TO_OPC';
const CONFIG_PATH = path.join(CONFIG_DIR, 'knxGroupAddress.json');

const sseClients = new Set();

let latestStatus = {
  updated: null,
  points: []
};

function getLocalIp() {
  const nets = os.networkInterfaces();

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        return net.address;
      }
    }
  }

  return 'localhost';
}

function getLocalIps() {
  const nets = os.networkInterfaces();
  const addrs = [];

  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) {
        addrs.push({ iface: name, address: net.address });
      }
    }
  }

  return addrs;
}

app.use(express.json({ limit: '10mb' }));
app.use(express.static(PUBLIC_DIR, { index: false }));

function makePointKey(ip, ga) {
  return `${ip}__${ga}`;
}

function broadcast(eventName, payload) {
  const message =
    `event: ${eventName}\n` +
    `data: ${JSON.stringify(payload)}\n\n`;

  for (const client of [...sseClients]) {
    try {
      client.write(message);
    } catch {
      sseClients.delete(client);
    }
  }
}

// =========================
// HTML routes
// =========================
app.get('/', async (req, res) => {
  try {
    await fs.access(CONFIG_PATH);
    return res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
  } catch {
    return res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
});

app.get('/index.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

app.get('/dashboard.html', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'dashboard.html'));
});

// =========================
// SSE stream
// =========================
app.get('/api/status/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  res.write(`event: connected\n`);
  res.write(`data: ${JSON.stringify({ ok: true })}\n\n`);

  if (latestStatus.updated) {
    res.write(`event: status-full\n`);
    res.write(`data: ${JSON.stringify(latestStatus)}\n\n`);
  }

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
    res.end();
  });
});

// =========================
// Config helpers
// =========================
async function loadConfig() {
  try {
    const txt = await fs.readFile(CONFIG_PATH, 'utf8');
    return JSON.parse(txt);
  } catch {
    return { gateways: [] };
  }
}

async function saveConfig(cfg) {
  await fs.mkdir(CONFIG_DIR, { recursive: true });

  const tmp = CONFIG_PATH + '.tmp';

  await fs.writeFile(tmp, JSON.stringify(cfg, null, 4), 'utf8');
  await fs.rename(tmp, CONFIG_PATH);
}

// =========================
// Save full KNX config
// =========================
app.post('/api/save', async (req, res) => {
  try {
    const cfg = req.body;

    if (!cfg || !Array.isArray(cfg.gateways)) {
      return res.status(400).json({
        error: 'Invalid config payload, expected { gateways: [...] }'
      });
    }

    await saveConfig(cfg);

    return res.json({ ok: true });
  } catch (err) {
    console.error('Save error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

// =========================
// ETS parser
// =========================
function parseEtsFile(buffer) {
  const text = buffer.toString('utf8');

  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const points = [];

  for (const line of lines) {
    const parts = line.split(/[,;\t]+/).map(part => part.trim());

    let ga = null;
    let name = null;

    for (const part of parts) {
      if (/^\d+\/\d+\/\d+$/.test(part)) {
        ga = part;
        break;
      }
    }

    if (!ga && parts.length >= 1 && /^\d+[.,]\d+[.,]\d+$/.test(parts[0])) {
      ga = parts[0].replace(/[.,]/g, '/');
    }

    if (parts.length >= 2) {
      name = parts.slice(1).join(' - ');
    } else if (parts.length === 1) {
      const match = parts[0].match(/(\d+[\./]\d+[\./]\d+)\s+(.+)/);

      if (match) {
        ga = ga || match[1].replace(/[.,]/g, '/');
        name = match[2];
      }
    }

    if (ga) {
      points.push({
        ga,
        dst: name || ''
      });
    }
  }

  return points;
}

// =========================
// Upload ETS file
// =========================
app.post('/api/upload', upload.single('etsfile'), async (req, res) => {
  try {
    const { ip } = req.body;

    if (!ip) {
      return res.status(400).json({ error: 'Missing ip field' });
    }

    if (!req.file) {
      return res.status(400).json({ error: 'Missing file upload' });
    }

    const points = parseEtsFile(req.file.buffer);
    const config = await loadConfig();

    const gateway = {
      IPRS: ip,
      points
    };

    const index = config.gateways.findIndex(gateway => gateway.IPRS === ip);

    if (index >= 0) {
      config.gateways[index] = gateway;
    } else {
      config.gateways.push(gateway);
    }

    await saveConfig(config);

    return res.json({
      ok: true,
      added: points.length
    });
  } catch (err) {
    console.error('Upload error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

// =========================
// Get config
// =========================
app.get('/api/config', async (req, res) => {
  res.json(await loadConfig());
});

// =========================
// Debug
// =========================
app.get('/api/debug', (req, res) => {
  try {
    return res.json({
      pid: process.pid,
      cwd: process.cwd(),
      publicDir: PUBLIC_DIR,
      configPath: CONFIG_PATH,
      interfaces: getLocalIps()
    });
  } catch (err) {
    return res.status(500).json({ error: String(err) });
  }
});

// =========================
// Get latest online status
// =========================
app.get('/api/status', (req, res) => {
  res.json(latestStatus);
});

// =========================
// Full status update
// =========================
app.post('/api/status', (req, res) => {
  try {
    const status = req.body;

    if (!status || !Array.isArray(status.points)) {
      return res.status(400).json({
        error: 'Invalid status payload, expected { updated, points: [...] }'
      });
    }

    latestStatus = {
      updated: new Date().toISOString(),
      points: status.points
    };

    broadcast('status-full', latestStatus);

    return res.json({
      ok: true,
      updated: latestStatus.updated,
      count: latestStatus.points.length,
      clients: sseClients.size
    });
  } catch (err) {
    console.error('Status update error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

// =========================
// Single point update
// =========================
app.post('/api/status/point', (req, res) => {
  try {
    const point = req.body;

    if (!point || !point.ip || !point.ga || typeof point.status !== 'number') {
      return res.status(400).json({
        error: 'Invalid point payload, expected { ip, ga, dst, status }'
      });
    }

    const updatedPoint = {
      ip: point.ip,
      ga: point.ga,
      dst: point.dst || '',
      status: point.status,
      updated: new Date().toISOString()
    };

    const key = makePointKey(updatedPoint.ip, updatedPoint.ga);

    const index = latestStatus.points.findIndex(
      p => makePointKey(p.ip, p.ga) === key
    );

    if (index >= 0) {
      latestStatus.points[index] = updatedPoint;
    } else {
      latestStatus.points.push(updatedPoint);
    }

    latestStatus.updated = updatedPoint.updated;

    console.log(
      `[STATUS] ${updatedPoint.ip} | ${updatedPoint.ga} => ${updatedPoint.status}`
    );

    broadcast('status-point', updatedPoint);

    return res.json({
      ok: true,
      point: updatedPoint,
      clients: sseClients.size
    });
  } catch (err) {
    console.error('Point status update error:', err);
    return res.status(500).json({ error: String(err) });
  }
});

// =========================
// Favicon - prevent browser 404 noise
// =========================
app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

// =========================
// API 404 only
// =========================
app.use('/api', (req, res) => {
  res.status(404).json({
    error: 'API Not Found',
    path: req.originalUrl
  });
});

// =========================
// HTML fallback
// =========================
app.use((req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// =========================
// Start server
// =========================
const LOCAL_IP = getLocalIp();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Config server listening on:`);
  console.log(`→ Local:   http://localhost:${PORT}`);
  console.log(`→ Network: http://${LOCAL_IP}:${PORT}`);
});