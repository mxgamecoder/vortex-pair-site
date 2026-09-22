/**
 * Vortex — Pair Code Generator Server
 * ---------------------------------------------------------------
 * A lightweight, standalone Express app that:
 *   • Serves the static pairing site (public/)
 *   • Generates WhatsApp pairing codes via Baileys
 *   • Returns a `Vortex!<base64-gzip-creds>...` session string
 *     that the Vortex bot can decode & auto-connect with
 *
 * Deploy on Render as a Web Service (free plan works).
 *   Build:  npm install
 *   Start:  node server.js
 * ---------------------------------------------------------------
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const zlib = require('zlib');
const crypto = require('crypto');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers,
  fetchLatestBaileysVersion,
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Middleware -------------------------------------------------------------
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h',
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
  },
}));

// --- In-memory pair-session registry ---------------------------------------
// Each entry: { id, phone, status, pairCode, sessionString, createdAt, sock }
const sessions = new Map();
const SESSION_TTL = 6 * 60 * 1000; // 6 min before auto-cleanup

setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessions.entries()) {
    if (now - entry.createdAt > SESSION_TTL) {
      try { entry.sock?.end?.(); } catch (_) {}
      sessions.delete(id);
      cleanupSessionFolder(id);
    }
  }
}, 60 * 1000);

// --- Helpers ----------------------------------------------------------------
const authDir = (id) => path.join(os.tmpdir(), `ntando_auth_${id}`);

function cleanupSessionFolder(id) {
  const dir = authDir(id);
  if (fs.existsSync(dir)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
  }
}

/**
 * Build the session string the Vortex bot expects.
 * Format:  Vortex!<base64(gzip(creds.json))>...
 * Decoded in index.js via:
 *   zlib.gunzipSync(Buffer.from(b64, 'base64')) → creds.json
 */
function buildSessionString(credsPath) {
  if (!fs.existsSync(credsPath)) return null;
  const raw = fs.readFileSync(credsPath);
  const gz = zlib.gzipSync(raw);
  const b64 = gz.toString('base64');
  return `Vortex!${b64}...`;
}

async function sendSessionStringToPhone(sock, phone, sessionString) {
  if (!sock || !phone || !sessionString) return false;

  const normalizedPhone = String(phone).replace(/\D/g, '');
  if (!normalizedPhone) return false;

  const jid = `${normalizedPhone}@s.whatsapp.net`;
  const welcomeMessage = 'Vortex 1.2 is back.';
  const infoMessage = 'For more info: https://lumorapp.app';
  const sessionMessage = ['Vortex session ID', sessionString].join('\n');

  try {
    await sock.sendMessage(jid, { text: welcomeMessage });
    await sock.sendMessage(jid, { text: infoMessage });
    await sock.sendMessage(jid, { text: sessionMessage });
    return true;
  } catch (err) {
    console.warn('Failed to send session ID via WhatsApp:', err.message || err);
    return false;
  }
}

/**
 * Create a Baileys socket for a pairing session.
 * If the phone number is supplied and the session isn't registered yet,
 * we request a pairing code (8-digit) the user types into WhatsApp.
 */
async function createSocket(id, phone) {
  const dir = authDir(id);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(dir);
  const { version } = await fetchLatestBaileysVersion();
  const logger = pino({ level: 'silent' });

  const sock = makeWASocket({
    version,
    logger,
    printQRInTerminal: false,
    browser: Browsers.macOS('Chrome'),
    auth: state,
    syncFullHistory: false,
    downloadHistory: false,
    markOnlineOnConnect: false,
  });

  const entry = sessions.get(id);
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect } = update;
    if (connection === 'open') {
      // give Baileys a moment to flush creds.json
      setTimeout(() => {
        const credsPath = path.join(dir, 'creds.json');
        const sessionString = buildSessionString(credsPath);
        if (entry) {
          entry.status = 'connected';
          entry.sessionString = sessionString;
          if (sessionString) {
            sendSessionStringToPhone(sock, phone, sessionString).catch(() => {});
          }
        }
      }, 800);
    } else if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      if (entry && code === DisconnectReason.loggedOut) {
        entry.status = 'logged_out';
        cleanupSessionFolder(id);
      } else if (shouldReconnect && entry && entry.status !== 'connected') {
        setTimeout(() => {
          if (sessions.has(id) && sessions.get(id).status !== 'connected') {
            createSocket(id, phone).catch(() => {});
          }
        }, 2000);
      }
    }
  });

  // Request pairing code (only if not already registered)
  if (phone && !state.creds.registered) {
    try {
      await new Promise((r) => setTimeout(r, 1200));
      const code = await sock.requestPairingCode(phone);
      if (entry) {
        entry.pairCode = code;
        entry.status = 'pairing';
      }
    } catch (err) {
      if (entry) entry.status = 'error';
    }
  }

  if (entry) entry.sock = sock;
  return sock;
}

/* ============================================================= */
/*  Routes                                                        */
/* ============================================================= */

// --- Health check (Render) --------------------------------------------------
app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    pairSessions: sessions.size,
    service: 'vortex-pair',
  });
});

// --- Start a pairing session ------------------------------------------------
app.post('/api/pair/request', async (req, res) => {
  try {
    let { phone } = req.body || {};
    if (!phone) return res.status(400).json({ error: 'Phone number is required.' });

    phone = String(phone).replace(/[^0-9]/g, '');
    if (phone.length < 8 || phone.length > 15) {
      return res.status(400).json({
        error: 'Please enter a valid phone number with country code (digits only).',
      });
    }

    const id = crypto.randomBytes(8).toString('hex');
    sessions.set(id, {
      id,
      phone,
      status: 'pending',
      pairCode: null,
      sessionString: null,
      createdAt: Date.now(),
      sock: null,
    });

    createSocket(id, phone).catch(() => {
      const entry = sessions.get(id);
      if (entry) entry.status = 'error';
    });

    res.json({
      sessionId: id,
      status: 'pending',
      message: 'Pairing session started. Poll /api/pair/status to get your code.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Failed to start pairing session.', detail: err.message });
  }
});

// --- Poll pairing status ----------------------------------------------------
app.get('/api/pair/status', (req, res) => {
  const { sessionId } = req.query;
  const entry = sessions.get(sessionId);
  if (!entry) return res.status(404).json({ error: 'Session not found or expired.' });

  const response = {
    sessionId: entry.id,
    phone: entry.phone,
    status: entry.status,
    pairCode: entry.pairCode,
    sessionString: entry.sessionString,
  };

  // Auto-cleanup 15s after the session string is delivered
  if (entry.status === 'connected' && entry.sessionString) {
    setTimeout(() => {
      try { entry.sock?.end?.(); } catch (_) {}
      sessions.delete(sessionId);
      cleanupSessionFolder(entry.id);
    }, 15_000);
  }

  res.json(response);
});

// --- Cancel a pairing session ----------------------------------------------
app.post('/api/pair/cancel', (req, res) => {
  const { sessionId } = (req.query.sessionId ? req.query : req.body) || {};
  const entry = sessions.get(sessionId);
  if (entry) {
    try { entry.sock?.end?.(); } catch (_) {}
    sessions.delete(sessionId);
    cleanupSessionFolder(entry.id);
  }
  res.json({ ok: true });
});

// --- Render deploy blueprint (handy YAML for the bot itself) ---------------
app.get('/api/deploy/render', (_req, res) => {
  const yaml = `services:
  - type: web
    name: vortex
    runtime: node
    plan: free
    region: oregon
    branch: main
    repo: https://github.com/mxgamecoder/vortex-pair-site
    buildCommand: npm install
    startCommand: node server.js
    healthCheckPath: /health
    autoDeploy: true
    envVars:
      - key: SESSION_ID
        sync: false
      - key: RENDER
        value: "true"
`;
  res.type('text/yaml').send(yaml);
});

// --- Fallback to index.html for any non-API route ---------------------------
app.get(/^\/(?!api|health).*/, (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// --- Start ------------------------------------------------------------------
app.listen(PORT, () => {
  console.log(`⚡ Vortex Pair Site running on port ${PORT}`);
  console.log(`   → http://localhost:${PORT}`);
});
