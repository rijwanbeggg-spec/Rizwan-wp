const express = require('express');
const fs = require('fs');
const path = require('path');
const pino = require('pino');
const QRCode = require('qrcode');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  Browsers,
  DisconnectReason,
  delay
} = require('@whiskeysockets/baileys');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'ChangeThisAdminKey123';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const AUTH_ROOT = path.join(__dirname, 'auth_sessions');
if (!fs.existsSync(AUTH_ROOT)) {
  fs.mkdirSync(AUTH_ROOT, { recursive: true });
}

// Active sessions map: sessionKey -> { sock, authFolder, status, qrDataUrl, pairingCode, phoneNumber, ownerLabel, startedAt, error }
const sessions = new Map();

function sanitizeKey(raw) {
  return String(raw || '')
    .replace(/[^0-9a-zA-Z_-]/g, '')
    .slice(0, 40);
}

function cleanupAuth(folderPath) {
  try {
    if (folderPath && fs.existsSync(folderPath)) {
      fs.rmSync(folderPath, { recursive: true, force: true });
    }
  } catch (e) {
    console.error('Auth cleanup error:', e.message);
  }
}

async function stopAndRemoveSession(sessionKey, deleteAuth = false) {
  const entry = sessions.get(sessionKey);
  if (!entry) return false;

  try {
    if (entry.sock) {
      entry.sock.ev.removeAllListeners();
      await entry.sock.end(new Error('Stopped by admin')).catch(() => {});
    }
  } catch (e) {
    console.error('Socket stop error:', e.message);
  }

  if (deleteAuth && entry.authFolder) {
    cleanupAuth(entry.authFolder);
  }

  sessions.delete(sessionKey);
  return true;
}

// Admin middleware: sirf valid admin key wale hi list/stop kar sakte hain
function requireAdmin(req, res, next) {
  const token =
    req.headers['x-admin-key'] ||
    req.body?.adminKey ||
    req.query?.adminKey ||
    '';

  if (!token || token !== ADMIN_SECRET) {
    return res.status(401).json({
      error: 'Unauthorized: Sirf admin hi yeh action kar sakta hai.'
    });
  }
  next();
}

function attachConnectionHandlers(sock, saveCreds, sessionKey, authFolder, sessionState) {
  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      sessionState.status = 'qr_ready';
      try {
        sessionState.qrDataUrl = await QRCode.toDataURL(qr, { width: 260, margin: 1 });
      } catch (e) {
        sessionState.error = 'QR render error: ' + e.message;
      }
    }

    if (connection === 'open') {
      sessionState.status = 'connected';
      sessionState.qrDataUrl = null;
      sessionState.pairingCode = null;
      sessionState.error = null;
      const waUser = sock.user?.id ? sock.user.id.split(':')[0] : sessionState.phoneNumber;
      if (waUser) {
        sessionState.phoneNumber = waUser;
      }
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const loggedOut = statusCode === DisconnectReason.loggedOut;

      if (loggedOut) {
        sessionState.status = 'logged_out';
        cleanupAuth(authFolder);
        sessions.delete(sessionKey);
      } else {
        // Agar session abhi map me hai to reconnect ya mark closed
        if (sessions.has(sessionKey)) {
          sessionState.status = 'disconnected';
        }
      }
    }
  });
}

// 1. Start Session (QR aur/ya WhatsApp Number Pairing Code dono support)
app.post('/connect', async (req, res) => {
  const rawPhone = String(req.body?.phoneNumber || '').replace(/\D/g, '');
  const label = String(req.body?.label || '').trim().slice(0, 40);
  const mode = req.body?.mode === 'code' ? 'code' : 'qr';

  const sessionKey = sanitizeKey(
    rawPhone ? `${rawPhone}_${Date.now().toString().slice(-4)}` : `sess_${Date.now()}`
  );
  const authFolder = path.join(AUTH_ROOT, sessionKey);

  // Agar purana same key ho to clean karein
  await stopAndRemoveSession(sessionKey, true);

  const sessionState = {
    id: sessionKey,
    sock: null,
    authFolder,
    status: 'starting',
    qrDataUrl: null,
    pairingCode: null,
    phoneNumber: rawPhone || null,
    ownerLabel: label || (rawPhone ? `+${rawPhone}` : 'QR User'),
    startedAt: new Date().toISOString(),
    error: null
  };

  sessions.set(sessionKey, sessionState);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(authFolder);

    const sock = makeWASocket({
      logger: pino({ level: 'silent' }),
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, pino({ level: 'silent' }))
      }
    });

    sessionState.sock = sock;
    attachConnectionHandlers(sock, saveCreds, sessionKey, authFolder, sessionState);

    // Agar user ne WhatsApp number + pairing code mode chuna hai
    if (mode === 'code') {
      if (!rawPhone || rawPhone.length < 8) {
        await stopAndRemoveSession(sessionKey, true);
        return res.status(400).json({
          error: 'Country code ke saath sahi WhatsApp number daalein (jaise 919876543210).'
        });
      }

      // Thoda wait taaki socket init ho jaye
      await delay(1200);
      if (!sock.authState.creds.registered) {
        const code = await sock.requestPairingCode(rawPhone);
        sessionState.pairingCode = code;
        sessionState.status = 'pairing_code_ready';
      }
    } else {
      // QR mode: pehla QR dataUrl banne ka wait (max ~6 sec)
      for (let i = 0; i < 20; i++) {
        if (sessionState.qrDataUrl || sessionState.status === 'connected' || sessionState.status === 'error') {
          break;
        }
        await delay(300);
      }
    }

    return res.json({
      id: sessionKey,
      status: sessionState.status,
      qrDataUrl: sessionState.qrDataUrl,
      pairingCode: sessionState.pairingCode,
      phoneNumber: sessionState.phoneNumber
    });
  } catch (err) {
    sessionState.status = 'error';
    sessionState.error = err.message;
    await stopAndRemoveSession(sessionKey, true);
    return res.status(500).json({
      error: 'Connect karte waqt error aaya.',
      details: err.message
    });
  }
});

// 2. Session Status Polling (sirf us session ka status)
app.get('/status', (req, res) => {
  const id = sanitizeKey(req.query.id || req.query.number || '');
  if (!id || !sessions.has(id)) {
    return res.status(404).json({ status: 'not_found' });
  }
  const { sock, authFolder, ...publicState } = sessions.get(id);
  return res.json(publicState);
});

// 3. ADMIN ONLY: Sabhi chalte hue servers/sessions ki list dekhna
app.get('/api/admin/sessions', requireAdmin, (req, res) => {
  const list = [];
  for (const [, entry] of sessions.entries()) {
    list.push({
      id: entry.id,
      ownerLabel: entry.ownerLabel,
      phoneNumber: entry.phoneNumber,
      status: entry.status,
      startedAt: entry.startedAt,
      error: entry.error
    });
  }
  return res.json({
    totalRunning: list.length,
    sessions: list
  });
});

// 4. ADMIN ONLY: Kisi bhi session/server ko stop karna
app.post('/api/admin/stop', requireAdmin, async (req, res) => {
  const targetId = sanitizeKey(req.body?.id || '');
  const removeAuth = Boolean(req.body?.removeAuth);

  if (!targetId || !sessions.has(targetId)) {
    return res.status(404).json({ error: 'Session nahi mila ya pehle hi stop ho chuka hai.' });
  }

  await stopAndRemoveSession(targetId, removeAuth);
  return res.json({
    ok: true,
    message: `Session ${targetId} stop kar diya gaya.`
  });
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
