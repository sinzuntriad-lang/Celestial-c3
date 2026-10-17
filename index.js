"use strict";
/*
 * SINZU TOOLS + CELESTIAL (Banat bot) - one Render web service.
 *   /                  Sinzu Tools site (page.html)
 *   /celestial         CELESTIAL bot dashboard (paste FB cookie, start/stop)
 *   /health, /healthz  health checks
 */
const express = require('express');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 1024 * 1024, files: 5 } });
const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawn } = require('child_process');
const app = express();

const SECRET = process.env.INBOUND_SECRET;
const REDIS_URL = process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const TTL = 60 * 60; // 1 hour
const MAX_MSGS = 30;

// CELESTIAL bot + dashboard. Mounted FIRST so the dashboard can read its own request bodies.
const bot = require('./bot');
app.use(require('./dashboard-api')(bot.getStatus, bot.controls));

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Storage: Upstash Redis if configured, otherwise in-memory (resets on restart)
const mem = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of mem) if (v.exp < now) mem.delete(k);
}, 60000).unref();

async function redis(commands) {
  const r = await fetch(`${REDIS_URL}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${REDIS_TOKEN}` },
    body: JSON.stringify(commands),
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return r.json();
}

async function getMsgs(addr) {
  if (REDIS_URL && REDIS_TOKEN) {
    const out = await redis([['LRANGE', `mb:${addr}`, 0, MAX_MSGS - 1]]);
    return (out[0].result || []).map((m) => JSON.parse(m));
  }
  const e = mem.get(addr);
  return e && e.exp > Date.now() ? e.msgs : [];
}

async function addMsg(addr, msg) {
  if (REDIS_URL && REDIS_TOKEN) {
    const key = `mb:${addr}`;
    await redis([['LPUSH', key, JSON.stringify(msg)], ['LTRIM', key, 0, MAX_MSGS - 1], ['EXPIRE', key, TTL]]);
    return;
  }
  const e = mem.get(addr) || { msgs: [] };
  e.msgs.unshift(msg);
  e.msgs = e.msgs.slice(0, MAX_MSGS);
  e.exp = Date.now() + TTL * 1000;
  mem.set(addr, e);
}

const validAddress = (a) =>
  typeof a === 'string' && /^[a-z0-9._-]{1,30}@svmail\.com$/.test(a.toLowerCase());

app.get('/api/messages', async (req, res) => {
  const address = String(req.query.address || '').toLowerCase();
  if (!validAddress(address)) return res.status(400).json({ error: 'Invalid address' });
  try {
    res.set('Cache-Control', 'no-store');
    res.json(await getMsgs(address));
  } catch (e) {
    res.status(500).json({ error: 'Inbox unavailable' });
  }
});

app.post('/api/inbound', async (req, res) => {
  if (!SECRET || req.get('x-inbound-secret') !== SECRET) return res.sendStatus(401);
  const { to, from, subject, text, date } = req.body || {};
  const address = String(to || '').toLowerCase();
  if (!validAddress(address)) return res.sendStatus(204);
  try {
    await addMsg(address, {
      from: String(from || '').slice(0, 200),
      subject: String(subject || '').slice(0, 300),
      text: String(text || '').slice(0, 5000),
      date: date || new Date().toISOString(),
    });
    res.sendStatus(200);
  } catch (e) {
    res.sendStatus(500);
  }
});


// Mailgun inbound route -> forward to /api/inbound/mailgun?key=INBOUND_SECRET
app.post('/api/inbound/mailgun', upload.any(), async (req, res) => {
  if (!SECRET || req.query.key !== SECRET) return res.sendStatus(401);
  const b = req.body || {};
  const address = String(b.recipient || '').toLowerCase();
  if (!validAddress(address)) return res.sendStatus(200);
  try {
    await addMsg(address, {
      from: String(b.from || b.sender || '').slice(0, 200),
      subject: String(b.subject || '').slice(0, 300),
      text: String(b['body-plain'] || '').slice(0, 5000),
      date: new Date().toISOString(),
    });
    res.sendStatus(200);
  } catch (e) {
    res.sendStatus(500);
  }
});

// Public media downloader powered by yt-dlp. Requires yt-dlp + ffmpeg on the host.
const DOWNLOAD_FORMATS = new Set(['mp3', 'mp4', 'pic']);
function isPublicHttpUrl(value) {
  try {
    const u = new URL(value);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password) return false;
    const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host === '::1' || host === '::') return false;
    if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return false;
    return true;
  } catch { return false; }
}
app.post('/api/download', async (req, res) => {
  const url = String(req.body?.url || '').trim();
  const format = String(req.body?.format || 'mp4').toLowerCase();
  if (!isPublicHttpUrl(url)) return res.status(400).json({ error: 'Enter a valid public http/https link.' });
  if (!DOWNLOAD_FORMATS.has(format)) return res.status(400).json({ error: 'Choose MP3, MP4, or PIC.' });
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'sinzu-dl-'));
  const output = path.join(dir, '%(title).100B [%(id)s].%(ext)s');
  const args = ['--no-playlist', '--no-warnings', '--restrict-filenames', '--max-filesize', '250M', '-o', output];
  if (format === 'mp3') args.push('-x', '--audio-format', 'mp3', '--audio-quality', '5');
  else if (format === 'mp4') args.push('-f', 'bestvideo[height<=1080]+bestaudio/best[height<=1080]/best', '--merge-output-format', 'mp4');
  else args.push('--skip-download', '--write-thumbnail', '--convert-thumbnails', 'jpg');
  args.push('--', url);
  const child = spawn('yt-dlp', args, { stdio: ['ignore', 'ignore', 'pipe'], timeout: 240000 });
  let stderr = '';
  child.stderr.on('data', b => { stderr = (stderr + b.toString()).slice(-4000); });
  let finished = false;
  const timer = setTimeout(() => { if (!finished) child.kill('SIGKILL'); }, 240000);
  child.on('error', async () => {
    finished = true; clearTimeout(timer); await fs.promises.rm(dir, { recursive: true, force: true });
    if (!res.headersSent) res.status(503).json({ error: 'Downloader is not installed on this host. See README deployment steps.' });
  });
  child.on('close', async code => {
    finished = true; clearTimeout(timer);
    if (res.headersSent || res.writableEnded) { await fs.promises.rm(dir, { recursive: true, force: true }); return; }
    try {
      const files = (await fs.promises.readdir(dir)).filter(f => !f.endsWith('.part') && !f.endsWith('.ytdl'));
      const candidates = files.filter(f => format === 'pic' ? /\.(jpg|jpeg|png|webp)$/i.test(f) : format === 'mp3' ? /\.mp3$/i.test(f) : /\.mp4$/i.test(f));
      if (code !== 0 || !candidates.length) {
        await fs.promises.rm(dir, { recursive: true, force: true });
        return res.status(422).json({ error: 'Could not fetch this media. Check the URL, source restrictions, and host downloader setup.' });
      }
      const file = path.join(dir, candidates[0]);
      res.set('Content-Type', format === 'mp3' ? 'audio/mpeg' : format === 'pic' ? 'image/jpeg' : 'video/mp4');
      res.set('Content-Disposition', `attachment; filename="${path.basename(candidates[0]).replace(/["\r\n]/g, '_')}"`);
      res.set('Cache-Control', 'no-store');
      res.sendFile(file, async err => { await fs.promises.rm(dir, { recursive: true, force: true }); if (err && !res.headersSent) res.status(500).end(); });
    } catch { await fs.promises.rm(dir, { recursive: true, force: true }); if (!res.headersSent) res.status(500).json({ error: 'Unable to prepare the downloaded file.' }); }
  });
});


// Sinzu page lives in page.html (same folder) so it is easy to edit.
const HTML = fs.readFileSync(path.join(__dirname, 'page.html'), 'utf8');
app.get('/', (req, res) => res.type('html').send(HTML));
// Shared inbox (same backend the original TEMP-GMAIL-TEST used), proxied to avoid CORS
app.get('/api/ext/messages', async (req, res) => {
  const address = String(req.query.address || '').toLowerCase();
  if (!/^[a-z0-9._-]{1,30}@timpmeyl\.indevs\.in$/.test(address)) return res.status(400).json({ error: 'Invalid address' });
  try {
    const r = await fetch('https://temporary-emaill.netlify.app/api/messages?address=' + address + '&nocache=' + Date.now());
    if (!r.ok) throw new Error('upstream ' + r.status);
    res.set('Cache-Control', 'no-store');
    res.json(await r.json());
  } catch (e) {
    res.status(502).json({ error: 'Shared inbox unavailable' });
  }
});

app.get('/healthz', (req, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`[SERVER] Sinzu Tools + CELESTIAL on :${PORT}`);
  bot.boot();
});

// Render free instances sleep after ~15 min without web traffic, which would also
// stop the bot. Ping our own public URL to stay awake (set KEEP_ALIVE=false to disable).
const SELF_URL = process.env.RENDER_EXTERNAL_URL || process.env.KEEP_ALIVE_URL;
if (SELF_URL && !/^(0|false|no|off)$/i.test(process.env.KEEP_ALIVE || 'true')) {
  setInterval(() => { fetch(SELF_URL.replace(/\/+$/, '') + '/healthz').catch(() => {}); }, 4 * 60 * 1000).unref();
}

module.exports = app;
