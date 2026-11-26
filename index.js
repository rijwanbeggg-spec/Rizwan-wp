const express = require("express");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");
const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  delay
} = require("@whiskeysockets/baileys");

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

const DATA_DIR = path.join(__dirname, "data");
const AUTH_DIR = path.join(DATA_DIR, "wa_auth");
const CONFIG_FILE = path.join(DATA_DIR, "config.json");
fs.mkdirSync(AUTH_DIR, { recursive: true });

function hashSecret(val) {
  return crypto.createHash("sha256").update(String(val || "")).digest("hex");
}

function loadConfig() {
  const defaultKey = process.env.ADMIN_KEY || process.env.ADMIN_PASSWORD || "admin123";
  if (!fs.existsSync(CONFIG_FILE)) {
    const initial = { adminKeyHash: hashSecret(defaultKey), updatedAt: Date.now() };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(initial, null, 2));
    return initial;
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8"));
    if (!parsed.adminKeyHash) {
      parsed.adminKeyHash = hashSecret(defaultKey);
      fs.writeFileSync(CONFIG_FILE, JSON.stringify(parsed, null, 2));
    }
    return parsed;
  } catch {
    const fallback = { adminKeyHash: hashSecret(defaultKey), updatedAt: Date.now() };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(fallback, null, 2));
    return fallback;
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

let cfg = loadConfig();
const tokens = new Map();

function verifyAdminToken(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice(7).trim()
    : (req.headers["x-admin-token"] || req.query.token || "");
  const exp = tokens.get(token);
  if (!token || !exp || exp < Date.now()) {
    return res.status(401).json({ ok: false, error: "Admin login zaroori hai ya session expire ho gaya." });
  }
  req.adminToken = token;
  next();
}

let sock = null;
let waStatus = "disconnected";
let latestQr = "";
let latestQrDataUrl = "";
let pairingCode = "";
let connectedUser = null;
let groupsCache = [];
const loaders = new Map();

async function refreshGroups() {
  if (!sock || waStatus !== "connected") return [];
  try {
    const fetched = await sock.groupFetchAllParticipating();
    groupsCache = Object.values(fetched).map((g) => ({
      id: g.id,
      subject: g.subject || g.id,
      participants: Array.isArray(g.participants) ? g.participants.length : 0
    }));
  } catch {}
  return groupsCache;
}

async function initWhatsApp(phoneForPair = "") {
  try {
    if (sock) {
      try { sock.ev.removeAllListeners(); } catch {}
      try { sock.end(undefined); } catch {}
      sock = null;
    }
    waStatus = "connecting";
    latestQr = "";
    latestQrDataUrl = "";
    if (!phoneForPair) pairingCode = "";

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version } = await fetchLatestBaileysVersion();

    sock = makeWASocket({
      version,
      auth: state,
      printQRInTerminal: false,
      browser: ["Rizwan-Panel", "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr) {
        latestQr = qr;
        try {
          latestQrDataUrl = await QRCode.toDataURL(qr);
        } catch {
          latestQrDataUrl = "";
        }
        waStatus = "qr_ready";
      }
      if (connection === "open") {
        waStatus = "connected";
        latestQr = "";
        latestQrDataUrl = "";
        pairingCode = "";
        connectedUser = sock.user ? { id: sock.user.id, name: sock.user.name || "" } : null;
        await refreshGroups();
      } else if (connection === "close") {
        waStatus = "disconnected";
        connectedUser = null;
        const statusCode = lastDisconnect?.error?.output?.statusCode;
        if (statusCode === DisconnectReason.loggedOut) {
          fs.rmSync(AUTH_DIR, { recursive: true, force: true });
          fs.mkdirSync(AUTH_DIR, { recursive: true });
        }
      }
    });

    if (phoneForPair) {
      const cleanNum = String(phoneForPair).replace(/[^0-9]/g, "");
      if (cleanNum.length >= 8) {
        await delay(1500);
        pairingCode = await sock.requestPairingCode(cleanNum);
        waStatus = "pairing_ready";
      }
    }
  } catch (err) {
    waStatus = "error";
    console.error("WA init error:", err.message);
  }
}

initWhatsApp().catch(() => {});

function normalizeTarget(targetType, rawTarget) {
  const clean = String(rawTarget || "").trim();
  if (targetType === "group") {
    return clean.endsWith("@g.us") ? clean : `${clean}@g.us`;
  }
  const digits = clean.replace(/[^0-9]/g, "");
  return `${digits}@s.whatsapp.net`;
}

function buildLines(hatersName, rawContent) {
  const lines = String(rawContent || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const baseLines = lines.length ? lines : ["Hello"];
  return baseLines.map((line) => (hatersName ? `${hatersName}: ${line}` : line));
}

async function runLoaderLoop(loaderId) {
  const item = loaders.get(loaderId);
  if (!item) return;
  let idx = 0;
  while (item.running) {
    if (!sock || waStatus !== "connected") {
      item.lastError = "WhatsApp connected nahi hai.";
      await delay(2000);
      continue;
    }
    try {
      const msgText = item.messages[idx % item.messages.length];
      await sock.sendMessage(item.jid, { text: msgText });
      item.sentCount += 1;
      item.lastSentAt = new Date().toISOString();
      item.lastError = "";
      idx += 1;
    } catch (err) {
      item.lastError = err.message;
    }
    const waitMs = Math.max(500, Number(item.delaySec || 2) * 1000);
    const step = 250;
    let waited = 0;
    while (item.running && waited < waitMs) {
      await delay(Math.min(step, waitMs - waited));
      waited += step;
    }
  }
}

app.post("/api/auth/login", (req, res) => {
  const providedKey = String(req.body?.key || req.body?.password || "").trim();
  if (!providedKey) {
    return res.status(400).json({ ok: false, error: "Admin key/password daalein." });
  }
  cfg = loadConfig();
  if (hashSecret(providedKey) !== cfg.adminKeyHash) {
    return res.status(401).json({ ok: false, error: "Galat Admin Key / Password." });
  }
  const token = crypto.randomBytes(24).toString("hex");
  tokens.set(token, Date.now() + 7 * 24 * 60 * 60 * 1000);
  return res.json({ ok: true, token, message: "Admin login successful." });
});

app.post("/api/auth/change-key", verifyAdminToken, (req, res) => {
  const newKey = String(req.body?.newKey || "").trim();
  if (newKey.length < 4) {
    return res.status(400).json({ ok: false, error: "New key kam se kam 4 characters ki rakhein." });
  }
  cfg = { adminKeyHash: hashSecret(newKey), updatedAt: Date.now() };
  saveConfig(cfg);
  return res.json({ ok: true, message: "Admin key save ho gayi hai." });
});

app.get("/api/status", verifyAdminToken, async (req, res) => {
  if (waStatus === "connected" && groupsCache.length === 0) {
    await refreshGroups();
  }
  const loaderList = Array.from(loaders.values()).map((l) => ({
    id: l.id,
    targetType: l.targetType,
    target: l.target,
    hatersName: l.hatersName,
    delaySec: l.delaySec,
    running: l.running,
    sentCount: l.sentCount,
    lastSentAt: l.lastSentAt,
    lastError: l.lastError
  }));
  return res.json({
    ok: true,
    waStatus,
    connectedUser,
    qr: latestQr,
    qrDataUrl: latestQrDataUrl,
    pairingCode,
    groups: groupsCache,
    loaders: loaderList
  });
});

app.post("/api/wa/qr", verifyAdminToken, async (req, res) => {
  pairingCode = "";
  await initWhatsApp("");
  await delay(1200);
  return res.json({
    ok: true,
    waStatus,
    qr: latestQr,
    qrDataUrl: latestQrDataUrl,
    message: "QR request bhej di gayi hai."
  });
});

app.post("/api/wa/pair", verifyAdminToken, async (req, res) => {
  const phone = String(req.body?.phone || "").trim();
  const digits = phone.replace(/[^0-9]/g, "");
  if (digits.length < 8) {
    return res.status(400).json({ ok: false, error: "Country code ke saath sahi number daalein (jaise 919876543210)." });
  }
  await initWhatsApp(digits);
  return res.json({ ok: true, waStatus, pairingCode, message: "Pairing code generate ho gaya hai." });
});

app.post("/api/wa/logout", verifyAdminToken, async (req, res) => {
  for (const l of loaders.values()) l.running = false;
  if (sock) {
    try { await sock.logout(); } catch {}
    try { sock.end(undefined); } catch {}
    sock = null;
  }
  waStatus = "disconnected";
  connectedUser = null;
  latestQr = "";
  latestQrDataUrl = "";
  pairingCode = "";
  fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  return res.json({ ok: true, message: "Session logout aur clear kar diya gaya." });
});

app.post("/api/loader/start", verifyAdminToken, (req, res) => {
  const targetType = req.body?.targetType === "group" ? "group" : "number";
  const target = String(req.body?.target || "").trim();
  const hatersName = String(req.body?.hatersName || "").trim();
  const fileContent = String(req.body?.fileContent || "").trim();
  const delaySec = Math.max(0.5, Number(req.body?.delaySec || 2));
  const taskPassword = String(req.body?.taskPassword || "").trim();

  if (!target) {
    return res.status(400).json({ ok: false, error: "Group ID ya Phone Number daalein." });
  }
  if (!taskPassword) {
    return res.status(400).json({ ok: false, error: "Start karne ke liye Password zaroori hai (isi se stop hoga)." });
  }

  const id = crypto.randomBytes(4).toString("hex");
  const jid = normalizeTarget(targetType, target);
  const messages = buildLines(hatersName, fileContent);

  const entry = {
    id,
    targetType,
    target,
    jid,
    hatersName,
    messages,
    delaySec,
    passwordHash: hashSecret(taskPassword),
    running: true,
    sentCount: 0,
    lastSentAt: null,
    lastError: ""
  };

  loaders.set(id, entry);
  runLoaderLoop(id).catch(() => {});
  return res.json({ ok: true, id, message: "Loader start ho gaya hai. Stop karne ke liye wahi password use karein." });
});

app.post("/api/loader/stop", verifyAdminToken, (req, res) => {
  const id = String(req.body?.id || "").trim();
  const password = String(req.body?.password || "").trim();
  const item = loaders.get(id);

  if (!item) {
    return res.status(404).json({ ok: false, error: "Loader task nahi mila." });
  }
  cfg = loadConfig();
  const matchesTaskPass = hashSecret(password) === item.passwordHash;
  const matchesAdminPass = hashSecret(password) === cfg.adminKeyHash;

  if (!matchesTaskPass && !matchesAdminPass) {
    return res.status(403).json({ ok: false, error: "Galat password! Wahi password daalein jisse start kiya tha." });
  }

  item.running = false;
  return res.json({ ok: true, message: "Loader stop ho gaya hai." });
});

app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>WA Session & Loader Panel</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: Arial, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 16px; }
    .box { max-width: 740px; margin: 0 auto 16px; background: #1e293b; padding: 18px; border-radius: 10px; border: 1px solid #334155; }
    h2, h3 { margin-top: 0; }
    input, select, textarea, button { width: 100%; padding: 10px; margin: 6px 0; border-radius: 6px; border: 1px solid #334155; background: #0f172a; color: #f8fafc; font-size: 14px; }
    button { background: #2563eb; border: none; font-weight: bold; cursor: pointer; }
    button:hover { opacity: 0.92; }
    button.stop { background: #dc2626; }
    button.sec { background: #475569; }
    button.ok { background: #16a34a; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; }
    .row > * { flex: 1 1 160px; }
    .hidden { display: none; }
    .msg { padding: 10px; border-radius: 6px; background: #334155; margin: 8px 0; font-size: 14px; word-break: break-word; }
    pre { background: #020617; padding: 10px; border-radius: 6px; overflow-x: auto; font-size: 12px; white-space: pre-wrap; word-break: break-all; }
    .task { border: 1px solid #334155; background: #0f172a; padding: 12px; border-radius: 8px; margin-top: 10px; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 12px; font-weight: bold; }
    .badge-run { background: #166534; color: #dcfce7; }
    .badge-stop { background: #7f1d1d; color: #fecaca; }
    img.qr-img { max-width: 230px; background: #ffffff; padding: 8px; border-radius: 8px; display: block; margin: 10px auto; }
  </style>
</head>
<body>
  <div class="box" id="loginBox">
    <h2>Admin Login</h2>
    <input id="loginKey" type="password" placeholder="Admin Key / Password daalein (default: admin123)" />
    <button onclick="login()">Login & Save Session</button>
    <div id="loginMsg" class="msg hidden"></div>
  </div>

  <div class="box hidden" id="panelBox">
    <div class="row">
      <div><strong>WA Status:</strong> <span id="waStatus">-</span></div>
      <div><strong>Connected User:</strong> <span id="waUser">-</span></div>
    </div>
    <div id="panelMsg" class="msg hidden"></div>

    <h3>1. Connect WhatsApp (QR Scan ya Pairing Code)</h3>
    <div class="row">
      <button onclick="getQr()">QR Code Generate Karein</button>
      <button class="sec" onclick="refreshAll()">Refresh Status</button>
      <button class="stop" onclick="logoutWa()">Logout</button>
    </div>

    <div id="qrBox" class="msg hidden">
      <div><strong>QR Scanner (WhatsApp &gt; Linked Devices &gt; Link a Device):</strong></div>
      <img id="qrImg" class="qr-img hidden" alt="WhatsApp QR Code" />
      <pre id="qrText"></pre>
    </div>

    <div class="row">
      <input id="pairPhone" type="text" placeholder="Number with country code (e.g. 919876543210)" />
      <button class="ok" onclick="getPair()">Pairing Code Lein</button>
    </div>
    <div id="pairBox" class="msg hidden">
      Pairing Code: <strong id="pairCodeText" style="font-size:18px; letter-spacing:2px;"></strong>
    </div>

    <h3>2. Loader Start (Group ya Number + Password Lock)</h3>
    <select id="targetType" onchange="onTargetTypeChange()">
      <option value="number">Phone Number</option>
      <option value="group">WhatsApp Group</option>
    </select>

    <input id="targetInput" type="text" placeholder="Phone Number (e.g. 919876543210) ya Group JID" />
    <select id="groupSelect" class="hidden" onchange="onGroupSelectChange()"></select>

    <input id="hatersName" type="text" placeholder="Haters Name (optional prefix)" />
    <input id="fileInput" type="file" accept=".txt,.csv,.log" onchange="readFileInput(event)" />
    <textarea id="fileContent" rows="4" placeholder="Messages / File lines (har line ek message hoga)"></textarea>

    <div class="row">
      <input id="delaySec" type="number" step="0.5" min="0.5" value="2" placeholder="Time delay (seconds)" />
      <input id="taskPassword" type="password" placeholder="Start/Stop Password (zaroori)" />
    </div>

    <button onclick="startLoader()">Start Loader</button>

    <h3>3. Active / Past Loaders (Stop With Same Password)</h3>
    <div id="loadersList"></div>

    <h3>4. Admin Key Badlein / Save Karein</h3>
    <div class="row">
      <input id="newAdminKey" type="password" placeholder="New Admin Key (min 4 chars)" />
      <button class="sec" onclick="changeKey()">Save New Admin Key</button>
    </div>
  </div>

  <script>
    let token = localStorage.getItem("wa_admin_token") || "";

    function showMsg(elId, text) {
      const el = document.getElementById(elId);
      el.textContent = text;
      el.classList.remove("hidden");
    }

    async function api(url, method = "GET", body = null) {
      const headers = { "Content-Type": "application/json" };
      if (token) headers["Authorization"] = "Bearer " + token;
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : null
      });
      return res.json();
    }

    async function login() {
      const key = document.getElementById("loginKey").value;
      const data = await api("/api/auth/login", "POST", { key });
      if (!data.ok) return showMsg("loginMsg", data.error || "Login fail");
      token = data.token;
      localStorage.setItem("wa_admin_token", token);
      document.getElementById("loginBox").classList.add("hidden");
      document.getElementById("panelBox").classList.remove("hidden");
      refreshAll();
    }

    async function changeKey() {
      const newKey = document.getElementById("newAdminKey").value;
      const data = await api("/api/auth/change-key", "POST", { newKey });
      showMsg("panelMsg", data.message || data.error || "");
      if (data.ok) document.getElementById("newAdminKey").value = "";
    }

    function onTargetTypeChange() {
      const t = document.getElementById("targetType").value;
      const gSel = document.getElementById("groupSelect");
      const inp = document.getElementById("targetInput");
      if (t === "group") {
        gSel.classList.remove("hidden");
        inp.placeholder = "Group JID (e.g. 1203630...@g.us) ya neeche se chunein";
      } else {
        gSel.classList.add("hidden");
        inp.placeholder = "Phone Number (e.g. 919876543210)";
      }
    }

    function onGroupSelectChange() {
      const val = document.getElementById("groupSelect").value;
      if (val) document.getElementById("targetInput").value = val;
    }

    function readFileInput(ev) {
      const file = ev.target.files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        document.getElementById("fileContent").value = String(reader.result || "");
      };
      reader.readAsText(file);
    }

    async function getQr() {
      const data = await api("/api/wa/qr", "POST");
      showMsg("panelMsg", data.message || data.error || "");
      refreshAll();
    }

    async function getPair() {
      const phone = document.getElementById("pairPhone").value;
      const data = await api("/api/wa/pair", "POST", { phone });
      if (!data.ok) return showMsg("panelMsg", data.error);
      document.getElementById("pairBox").classList.remove("hidden");
      document.getElementById("pairCodeText").textContent = data.pairingCode || "Generating...";
      refreshAll();
    }

    async function logoutWa() {
      const data = await api("/api/wa/logout", "POST");
      showMsg("panelMsg", data.message || data.error || "");
      refreshAll();
    }

    async function startLoader() {
      const body = {
        targetType: document.getElementById("targetType").value,
        target: document.getElementById("targetInput").value,
        hatersName: document.getElementById("hatersName").value,
        fileContent: document.getElementById("fileContent").value,
        delaySec: document.getElementById("delaySec").value,
        taskPassword: document.getElementById("taskPassword").value
      };
      const data = await api("/api/loader/start", "POST", body);
      showMsg("panelMsg", data.message || data.error || "");
      if (data.ok) document.getElementById("taskPassword").value = "";
      refreshAll();
    }

    async function stopLoader(id) {
      const pass = prompt("Is loader ko stop karne ke liye wahi password daalein:");
      if (pass === null) return;
      const data = await api("/api/loader/stop", "POST", { id, password: pass });
      showMsg("panelMsg", data.message || data.error || "");
      refreshAll();
    }

    async function refreshAll() 
