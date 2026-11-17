const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const moment = require('moment');
const bodyParser = require('body-parser');
const axios = require('axios');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const xlsx = require('xlsx');
const https = require('https');
const xlsxPopulate = require('xlsx-populate');
const app = express();
app.set('trust proxy', 1); // Trust first proxy so req.ip reflects real client IP
const nodemailer = require("nodemailer");
const XLSX = require('xlsx');
const cron = require('node-cron');
const { fetchLhoStatusSnapshot } = require('./serv/lho.service');
const { http2Get } = require('./serv/http2-get');
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;

require('dotenv').config();

const secretKey = process.env.JWT_SECRET;
if (!secretKey || secretKey === 'mysecretkey' || Buffer.byteLength(secretKey, 'utf8') < 32) {
  throw new Error('JWT_SECRET must be configured with at least 32 bytes of unique random data.');
}

// ── #11 Banner Disclosure: remove Express version header ────────────────────
app.disable('x-powered-by');

// ── CORS: strict allowlist (configure via CORS_ORIGINS env, comma-separated) ─
const allowedCorsOrigins = (process.env.CORS_ORIGINS || 'https://sbi-dashboard.ifiber.in:7668')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const allowedHosts = new Set(
  (process.env.ALLOWED_HOSTS || 'sbi-dashboard.ifiber.in:7668,sbi-dashboard.ifiber.in')
    .split(',')
    .map((host) => host.trim().toLowerCase())
    .filter(Boolean)
);

// Reject untrusted Host/X-Forwarded-Host values before any redirect or API
// response can be constructed from attacker-controlled headers.
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  const host = String(req.get('host') || '').trim().toLowerCase();
  const forwardedHost = String(req.get('x-forwarded-host') || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  if (!allowedHosts.has(host) || (forwardedHost && !allowedHosts.has(forwardedHost))) {
    return res.status(400).json({ error: 'Invalid host header' });
  }
  next();
});

const corsOptions = {
  origin: (origin, callback) => {
    // Allow non-browser clients (no Origin header).
    if (!origin) return callback(null, true);
    if (allowedCorsOrigins.includes(origin)) return callback(null, true);
    return callback(new Error('CORS origin not allowed'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Security headers: banner disclosure, clickjacking, cache, HSTS ──────────
app.use((req, res, next) => {
  // Apply the same baseline headers to normal responses as to rejected hosts.
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  // Legacy compatibility for scanners/older user agents; CSP remains the
  // primary XSS mitigation in modern browsers.
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  // Remove any upstream/server-identifying header if present.
  res.removeHeader('Server');
  // Keep the policy strict while allowing the Angular bundle, API calls,
  // vendor HLS streams, images, fonts, and inline styles used by the UI.
  res.setHeader(
    'Content-Security-Policy',
    "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; " +
    "script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; " +
    "connect-src 'self' https:; media-src 'self' blob: https:"
  );
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  next();
});

// ── Clickjacking hardening: reject iframe navigations at app layer ──────────
app.use((req, res, next) => {
  const fetchDest = String(req.get('Sec-Fetch-Dest') || '').toLowerCase();
  if (fetchDest === 'iframe') {
    return res.status(403).json({ error: 'Embedding in frames is not allowed.' });
  }
  next();
});

// ── HTTP verb tampering protection ───────────────────────────────────────────
const ALLOWED_HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
app.use((req, res, next) => {
  const methodOverrideHeader =
    req.get('X-HTTP-Method-Override') ||
    req.get('X-Method-Override') ||
    req.get('X-HTTP-Method');
  const methodOverrideQuery = req.query && req.query._method;
  const methodOverrideBody = req.body && req.body._method;

  // Block method-override vectors to prevent verb tunneling and bypasses.
  if (methodOverrideHeader || methodOverrideQuery || methodOverrideBody) {
    return res.status(400).json({ error: 'HTTP method override is not allowed.' });
  }

  const normalizedMethod = String(req.method || '').toUpperCase();

  if (!ALLOWED_HTTP_METHODS.has(normalizedMethod)) {
    res.setHeader('Allow', Array.from(ALLOWED_HTTP_METHODS).join(', '));
    return res.status(405).json({ error: `Method ${normalizedMethod || req.method} not allowed.` });
  }

  next();
});

function allowOnlyMethods(...methods) {
  const allowed = new Set(methods.map((m) => String(m).toUpperCase()));
  return (req, res, next) => {
    const method = String(req.method || '').toUpperCase();
    if (!allowed.has(method)) {
      res.setHeader('Allow', Array.from(allowed).join(', '));
      return res.status(405).json({ error: `Method ${method || req.method} not allowed for this endpoint.` });
    }
    next();
  };
}

// ── #14 Spamming: simple in-memory rate limiter (no external package needed) ─
const _rlBuckets = new Map();
function createRateLimiter(windowMs, max) {
  return (req, res, next) => {
    const key = `${req.ip}:${req.path}`;
    const now = Date.now();
    let b = _rlBuckets.get(key);
    if (!b || now - b.start >= windowMs) b = { count: 1, start: now };
    else b.count++;
    _rlBuckets.set(key, b);
    if (b.count > max) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}
const authRateLimit   = createRateLimiter(15 * 60 * 1000, 3); // 3 OTP/login requests / 15 min / IP
const otpRateLimit    = createRateLimiter(15 * 60 * 1000, 3); // 3 OTP verification attempts / 15 min / IP

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function createOtpDigest(userId, otp) {
  return crypto.createHmac('sha256', secretKey)
    .update(`${userId}:${otp}`)
    .digest('hex');
}

function otpDigestMatches(userId, otp, storedDigest) {
  if (typeof storedDigest !== 'string' || !/^[a-f0-9]{64}$/i.test(storedDigest)) return false;
  const submitted = Buffer.from(createOtpDigest(userId, otp), 'hex');
  const stored = Buffer.from(storedDigest, 'hex');
  return submitted.length === stored.length && crypto.timingSafeEqual(submitted, stored);
}

function createEmailRateLimiter(windowMs, max) {
  return (req, res, next) => {
    const email = normalizeEmail((req.body && (req.body.email || req.body.userEmail || req.body.EmailId)));
    if (!email) return next();

    const key = `${email}:${req.path}`;
    const now = Date.now();
    let b = _rlBuckets.get(key);
    if (!b || now - b.start >= windowMs) b = { count: 1, start: now };
    else b.count++;
    _rlBuckets.set(key, b);

    if (b.count > max) {
      return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }
    next();
  };
}

// Email-based rate limiter for forgot routes — each email gets its own independent bucket.
const forgotEmailRateLimit = createEmailRateLimiter(60 * 60 * 1000, 3); // 3 / 60 min / email

const issuedPasswordResetTokens = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [jti, expiresAt] of issuedPasswordResetTokens) {
    if (expiresAt <= now) issuedPasswordResetTokens.delete(jti);
  }
}, 10 * 60 * 1000).unref();

function isValidAtmId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{2,49}$/.test(value.trim());
}

function hasUnsafeMarkup(value) {
  return typeof value === 'string' && (/[<>]/.test(value) || /[\u0000-\u001F\u007F]/.test(value));
}

// ── #7 Weak Password Policy: server-side complexity check ────────────────────
function isStrongPassword(pw) {
  return (
    typeof pw === 'string' &&
    pw.length >= 15 &&
    /[A-Z]/.test(pw) &&
    /[a-z]/.test(pw) &&
    /[0-9]/.test(pw) &&
    /[!@#$%^&*(),.?":{}|<>]/.test(pw)
  );
}

// ── Password history: check last 5 hashes, save new one ─────────────────────
// Returns a promise — resolves if new password is not reused, rejects with message if it is.
function checkAndSavePasswordHistory(usersId, newPlaintextPassword) {
  return new Promise((resolve, reject) => {
    connection.query(
      'SELECT password_hash FROM password_history WHERE users_id = ? ORDER BY changed_at DESC LIMIT 5',
      [usersId],
      async (err, rows) => {
        if (err) return reject(new Error('Internal server error'));
        // Also fetch current password from users table
        connection.query(
          'SELECT password FROM users WHERE users_id = ?',
          [usersId],
          async (err2, userRows) => {
            if (err2) return reject(new Error('Internal server error'));
            const hashes = rows.map(r => r.password_hash);
            if (userRows.length > 0 && userRows[0].password) {
              hashes.unshift(userRows[0].password);
            }
            for (const hash of hashes) {
              const matches = await bcrypt.compare(newPlaintextPassword, hash);
              if (matches) return reject(new Error('New password must not match any of your last 5 passwords'));
            }
            // Save new password to history
            connection.query(
              'INSERT INTO password_history (users_id, password_hash) VALUES (?, ?)',
              [usersId, hashes[0] || ''],
              () => resolve()
            );
          }
        );
      }
    );
  });
}

// ── #1/#2/#5 Functional-level access control: role helper ────────────────────
// req.user is populated by verifyToken after OTP-verified login
function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Not authenticated' });
    if (!roles.includes(Number(req.user.role))) {
      return res.status(403).json({ error: 'Insufficient permissions' });
    }
    next();
  };
}


const dbConfig = {
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  connectTimeout: 10000,
  enableKeepAlive: true,
  keepAliveInitialDelay: 30000, // send keepalive ping every 30s to prevent idle drop
};

const connection = mysql.createPool(dbConfig);

// Dedicated pool for heavy LHO cron work to avoid starving auth/login queries.
const cronConnection = mysql.createPool({
  ...dbConfig,
  connectionLimit: 4,
  queueLimit: 100,
  connectTimeout: 20000,   // give cron queries more time to connect
  acquireTimeout: 20000,   // don't let pool queue hang forever
});

// Swallow pool-level connection errors (e.g. ECONNRESET on idle connections)
// so they don't crash the process — the pool will create a fresh connection automatically
connection.on('connection', (conn) => {
  conn.on('error', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'PROTOCOL_CONNECTION_LOST' || err.fatal) {
      console.warn('DB connection lost, will be removed from pool:', err.code);
    }
  });
});

cronConnection.on('connection', (conn) => {
  conn.on('error', (err) => {
    if (err.code === 'ECONNRESET' || err.code === 'PROTOCOL_CONNECTION_LOST' || err.fatal) {
      console.warn('Cron DB connection lost, will be removed from pool:', err.code);
    }
  });
});

const port = process.env.PORT || 3000;

// ── DB migration: widen `otp` column to VARCHAR(64) for HMAC-SHA256 hashes ──
// Runs once on startup — safe to re-run (MySQL ignores it if already correct).
connection.query(
  "ALTER TABLE users MODIFY COLUMN otp VARCHAR(64)",
  (err) => {
    if (err && err.code !== 'ER_DUP_FIELDNAME') {
      // Warn but don't crash — column may already be the right type
      console.warn('[migration] Could not widen otp column:', err.message);
    }
  }
);


// ── Global error handler: never expose stack traces or internals to clients ───
app.use((err, _req, res, next) => {
  console.error('[unhandled error]', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
let ffmpegProcess;

// Directory to store HLS streams
const streamDir = path.join(__dirname, 'assets', 'streams');
if (!fs.existsSync(streamDir)) {
  fs.mkdirSync(streamDir, { recursive: true });
}

// Function to hash the password
const hashPassword = async (password) => {
  const saltRounds = 10;
  return await bcrypt.hash(password, saltRounds);
};

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const { atmId, cameraId } = req.body;
    const streamDir = path.join(__dirname, 'assets', 'streams', atmId, cameraId);
    console.log('Storing Buildint live view in:', streamDir);
    if (!fs.existsSync(streamDir)) {
      fs.mkdirSync(streamDir, { recursive: true });
    }
    cb(null, streamDir);
  },
  filename: (req, file, cb) => {
    cb(null, file.originalname);
  }
});

const upload = multer({ storage: storage });

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 5000;

// Track active FFmpeg processes
const activeStreams = new Map();

// Function to properly encode RTSP URL credentials
function encodeRtspUrl(rtspUrl) {
  try {
    // Match rtsp://username:password@host pattern
    // Use a more robust regex that finds the LAST @ before the host
    const match = rtspUrl.match(/^(rtsp:\/\/)(.+)@([^@]+)$/);
    
    if (match) {
      const [, protocol, credentialsPart, hostAndPath] = match;
      
      // Split credentials into username and password
      const colonIndex = credentialsPart.indexOf(':');
      if (colonIndex > 0) {
        const username = credentialsPart.substring(0, colonIndex);
        const password = credentialsPart.substring(colonIndex + 1);
        
        // Vendor APIs sometimes return credentials that are already percent
        // encoded (for example %40 for @). Decode once before encoding so `%`
        // is not changed to `%25` and the DVR receives the correct password.
        const decodeCredential = (value) => {
          try { return decodeURIComponent(value); } catch (_) { return value; }
        };
        const encodedUsername = encodeURIComponent(decodeCredential(username));
        const encodedPassword = encodeURIComponent(decodeCredential(password));
        
        const encoded = `${protocol}${encodedUsername}:${encodedPassword}@${hostAndPath}`;
        return encoded;
      }
    }
    
    // If no credentials found, return as-is
    return rtspUrl;
  } catch (error) {
    console.error('Error encoding RTSP URL:', error);
    return rtspUrl;
  }
}

function redactRtspUrl(rtspUrl) {
  return String(rtspUrl || '').replace(/^(rtsp:\/\/)(.+)@([^@]+)$/i, '$1***:***@$3');
}

function startRtspToHls(rtspUrl, cameraId, atmId, retries = 0) {
  const streamKey = `${atmId}_${cameraId}`;
  
  // Encode RTSP URL to handle special characters in credentials
  const encodedRtspUrl = encodeRtspUrl(rtspUrl);
  
  console.log(`[${atmId}][${cameraId}] Starting RTSP to HLS conversion (attempt ${retries + 1})`);
  console.log(`[${atmId}][${cameraId}] Original URL: ${redactRtspUrl(rtspUrl)}`);
  console.log(`[${atmId}][${cameraId}] Encoded URL: ${redactRtspUrl(encodedRtspUrl)}`);
  
  // Stop existing stream if running
  if (activeStreams.has(streamKey)) {
    console.log(`[${atmId}][${cameraId}] Stopping existing stream`);
    const existingProcess = activeStreams.get(streamKey);
    existingProcess.intentionalStop = true;
    existingProcess.kill('SIGKILL');
    activeStreams.delete(streamKey);
  }
  
  const outputDir = path.join(streamDir, atmId, cameraId);

  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  } else {
    const files = fs.readdirSync(outputDir);
    files.forEach((file) => {
      const filePath = path.join(outputDir, file);
      if (fs.lstatSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
      }
    });
  }

  const ffmpegArgs = [
    '-loglevel',
    'verbose',
    '-rtsp_transport',
    'tcp',
    // Socket I/O timeout for an RTSP client. `-timeout` is the deprecated
    // listen timeout in this FFmpeg build and incorrectly enables server mode.
    '-stimeout',
    '10000000',
    '-i',
    encodedRtspUrl,
    // DVRs frequently supply H.265/HEVC, which HLS.js cannot reliably decode
    // in Chrome/Edge. Transcode to broadly supported H.264 for browser video.
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-tune',
    'zerolatency',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '50',
    '-keyint_min',
    '50',
    '-sc_threshold',
    '0',
    '-c:a',
    'aac',
    '-ar',
    '44100',
    '-f',
    'hls',
    '-hls_time',
    '4',
    '-hls_list_size',
    '5',
    '-hls_flags',
    'delete_segments+append_list',
    '-hls_segment_filename',
    path.join(outputDir, 'segment%03d.ts'),
    path.join(outputDir, 'output.m3u8')
  ];

  const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);
  
  // Store the process
  activeStreams.set(streamKey, ffmpegProcess);
  
  let streamStarted = false;

  ffmpegProcess.stdout.on('data', (data) => {
    const output = data.toString();
    if (!streamStarted && output.includes('Opening')) {
      console.log(`[${atmId}][${cameraId}] Stream connection started`);
      streamStarted = true;
    }
  });

  ffmpegProcess.stderr.on('data', (data) => {
    const output = data.toString();
    // Log everything for debugging
    console.log(`[${atmId}][${cameraId}] FFmpeg: ${output.substring(0, 200)}`);
    
    if (output.includes('Opening') || output.includes('Stream #') || output.includes('Input #')) {
      streamStarted = true;
      console.log(`[${atmId}][${cameraId}] ✓ Stream processing started successfully`);
    }
    if (output.includes('error') || output.includes('failed') || output.includes('Invalid')) {
      console.error(`[${atmId}][${cameraId}] ✗ Error detected: ${output}`);
    }
    if (output.includes('Connection') && output.includes('refused')) {
      console.error(`[${atmId}][${cameraId}] ✗ Connection refused - check RTSP URL and network`);
    }
    if (output.includes('Unable to open RTSP') || output.includes('Unknown error')) {
      console.error(`[${atmId}][${cameraId}] ✗ Network/Connection issue - Camera may be unreachable or credentials invalid`);
    }
  });

  ffmpegProcess.on('error', (error) => {
    console.error(`[${atmId}][${cameraId}] FFmpeg process error:`, error);
    // A replaced process must not delete/restart the newer process registered
    // under the same ATM/camera key.
    if (ffmpegProcess.intentionalStop || activeStreams.get(streamKey) !== ffmpegProcess) return;
    activeStreams.delete(streamKey);
    
    if (retries < MAX_RETRIES) {
      console.log(`[${atmId}][${cameraId}] Retry attempt ${retries + 1} after error...`);
      setTimeout(() => {
        startRtspToHls(rtspUrl, cameraId, atmId, retries + 1);
      }, RETRY_DELAY_MS);
    }
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`[${atmId}][${cameraId}] FFmpeg process exited with code ${code}`);
    if (ffmpegProcess.intentionalStop || activeStreams.get(streamKey) !== ffmpegProcess) return;
    activeStreams.delete(streamKey);

    if (code !== 0 && retries < MAX_RETRIES) {
      console.log(`[${atmId}][${cameraId}] Retry attempt ${retries + 1} after failure...`);
      setTimeout(() => {
        startRtspToHls(rtspUrl, cameraId, atmId, retries + 1);
      }, RETRY_DELAY_MS);
    } else if (retries >= MAX_RETRIES) {
      console.error(`[${atmId}][${cameraId}] Max retries reached. Unable to process the stream.`);
    }
  });
  
  return ffmpegProcess;
}

function startMpdToMp4(mpdUrl, cameraId, atmId) {
  // Create a directory for each atmId and organize camera streams inside
  const outputDir = path.join(streamDir, atmId, cameraId);

  // Create directory for this atmId and camera's stream
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  } else {
    // Clear existing files in the output directory before creating new ones
    const files = fs.readdirSync(outputDir);
    files.forEach((file) => {
      const filePath = path.join(outputDir, file);
      if (fs.lstatSync(filePath).isFile()) {
        fs.unlinkSync(filePath);
      }
    });
  }

  const ffmpegArgs = [
    '-v',
    'debug',
    '-i',
    mpdUrl, // Input MPD stream URL
    '-c',
    'copy', // Copy codec (to avoid re-encoding)
    path.join(outputDir, 'output.mp4') // Output MP4 file path
  ];

  // Start the FFmpeg process
  const ffmpegProcess = spawn(ffmpegPath, ffmpegArgs);

  // Log FFmpeg stdout and stderr for debugging
  ffmpegProcess.stdout.on('data', (data) => {
    console.log(`[${atmId}][${cameraId}] stdout: ${data}`);
  });

  ffmpegProcess.stderr.on('data', (data) => {
    console.error(`[${atmId}][${cameraId}] stderr: ${data}`);
  });

  ffmpegProcess.on('close', (code) => {
    console.log(`[${atmId}][${cameraId}] FFmpeg process exited with code ${code}`);
  });
}

// Function to stop the ffmpeg process
function stopFfmpeg() {
  if (ffmpegProcess) {
    ffmpegProcess.kill('SIGINT');
    console.log('ffmpeg process terminated');
  }
}

function isDbConnectivityError(err) {
  if (!err) return false;
  return [
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'ENOTFOUND',
    'PROTOCOL_CONNECTION_LOST',
    'PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR',
    'PROTOCOL_SEQUENCE_TIMEOUT',
  ].includes(err.code);
}

let dbAvailable = true;
let lastDbError = null;

function setDbUnavailable(err) {
  if (!dbAvailable) return;
  dbAvailable = false;
  lastDbError = err?.code || err?.message || 'unknown';
  console.warn(`⚠️ DB marked unavailable: ${lastDbError}`);
}

function setDbAvailable() {
  if (dbAvailable) return;
  dbAvailable = true;
  lastDbError = null;
  console.log('✅ DB connectivity restored');
}

function startDbHealthMonitor() {
  const check = () => {
    connection.query({ sql: 'SELECT 1', timeout: 5000 }, (err) => {
      if (err && isDbConnectivityError(err)) {
        setDbUnavailable(err);
        return;
      }
      if (!err) setDbAvailable();
    });
  };

  check();
  setInterval(check, 30000);
}

startDbHealthMonitor();

// In-memory token blacklist for invalidated sessions on logout
const tokenBlacklist = new Set();

// Concurrent session control: only one active final token per user
// userId (number) -> token (string)
const activeSessionMap = new Map();

// Idle timeout: track last activity time per token (token -> timestamp ms)
const IDLE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes
const tokenLastActive = new Map();

// Periodically clean up expired idle entries to prevent memory growth
setInterval(() => {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  for (const [token, lastActive] of tokenLastActive.entries()) {
    if (lastActive < cutoff) tokenLastActive.delete(token);
  }
}, 5 * 60 * 1000); // run every 5 minutes

const verifyToken = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader) {
    return res.status(401).json({ error: 'Token not provided' });
  }

  // Strip "Bearer " prefix sent by the Angular HttpClient
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  // Reject blacklisted (logged-out) tokens
  if (tokenBlacklist.has(token)) {
    return res.status(401).json({ error: 'Token has been invalidated. Please login again.' });
  }

  // Reject tokens that have been idle for more than 10 minutes
  const lastActive = tokenLastActive.get(token);
  if (lastActive !== undefined && Date.now() - lastActive > IDLE_TIMEOUT_MS) {
    tokenLastActive.delete(token);
    return res.status(401).json({ error: 'Session expired due to inactivity. Please login again.' });
  }

  jwt.verify(token, secretKey, (err, decoded) => {
    if (err) {
      return res.status(403).json({ error: 'Invalid token' });
    }

    // Only tokens issued after successful OTP verification are allowed
    if (!decoded.verified) {
      return res.status(403).json({ error: 'OTP verification required' });
    }

    // Reject if this token was displaced by a newer login on another device
    const activeToken = activeSessionMap.get(decoded.userId);
    if (activeToken === undefined) {
      // No entry (e.g. server restart) — re-register this token as the active session
      activeSessionMap.set(decoded.userId, token);
    } else if (activeToken !== token) {
      return res.status(401).json({ error: 'SESSION_DISPLACED', message: 'You have been logged in from another device. Please login again.' });
    }

    // Refresh the idle timer on every valid request
    tokenLastActive.set(token, Date.now());

    req.user = decoded;
    next();
  });
};

// Public routes that do not require authentication
const PUBLIC_ROUTES = new Set([
  '/login',
  '/verify-otp',
  '/forgot/check-email',
  '/forgot/send-otp',
  '/forgot/verify-otp',
  '/forgot/reset-password',
  '/register',
]);

// Apply token verification to every route except the public whitelist
app.use((req, res, next) => {
  if (PUBLIC_ROUTES.has(req.path)) return next();
  return verifyToken(req, res, next);
});

// Logout: blacklist the current token so it cannot be reused
app.post('/logout', (req, res) => {
  const authHeader = req.headers.authorization;
  if (authHeader) {
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
    tokenBlacklist.add(token);
    tokenLastActive.delete(token);
    // Remove from active session map so the userId slot is freed
    try {
      const decoded = jwt.verify(token, secretKey);
      if (decoded && activeSessionMap.get(decoded.userId) === token) {
        activeSessionMap.delete(decoded.userId);
      }
    } catch (_) { /* token may be expired — that's fine, just clean up */ }
  }
  return res.status(200).json({ message: 'Logged out successfully' });
});

app.get('/stop-ffmpeg', function (req, res) {
  console.log('Checking and stopping ffmpeg');
  stopFfmpeg();
  return res.status(200).send('success');
});

// Cache for live-health-check endpoint
let liveHealthCache = null;
let liveHealthCacheTimestamp = null;
const CACHE_DURATION_MS = 120 * 60 * 1000; // 1 minute

// Retry helper: retries the given async fn up to maxRetries times with exponential backoff
async function retryAxios(fn, { maxRetries = 3, baseDelayMs = 1000, vendorName = '' } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      const isLast = attempt === maxRetries;
      console.warn(`[${vendorName}] API attempt ${attempt}/${maxRetries} failed: ${err.message}${isLast ? ' — giving up' : ' — retrying...'}`);
      if (!isLast) {
        await new Promise(r => setTimeout(r, baseDelayMs * attempt)); // 1s, 2s, 3s
      }
    }
  }
  throw lastError;
}

app.get('/live-health-check', async (req, res) => {
  try {
    // Check if cache is valid
    const now = Date.now();
    const forceRefresh = req.query.refresh === 'true';
    
    if (!forceRefresh && liveHealthCache && liveHealthCacheTimestamp) {
      const cacheAge = now - liveHealthCacheTimestamp;
      if (cacheAge < CACHE_DURATION_MS) {
        console.log(`Returning cached data (age: ${Math.round(cacheAge / 1000 / 60)} minutes)`);
        return res.json({
          ...liveHealthCache,
          cached: true,
          cache_age_minutes: Math.round(cacheAge / 1000 / 60),
          cache_expires_in_minutes: Math.round((CACHE_DURATION_MS - cacheAge) / 1000 / 60)
        });
      }
    }

    console.log('Fetching fresh data from APIs and database...');

    const vendors = [
      { id: 4, name: 'BUILDINT',  url: process.env.BUILDINT_ALL_SITES },
      { id: 1, name: 'ANIKET',    url: process.env.ANIKET_ALL_SITES },
      { id: 3, name: 'SECURENS',  url: process.env.SECURENS_ALL_SITES },
      { id: 6, name: 'GLOBAL',    url: process.env.GLOBAL_ALL_SITES },
      { id: 7, name: 'CTS',       url: process.env.CTS_ALL_SITES },
      { id: 2, name: 'ITL',       url: process.env.ITL_ALL_SITES },
      { id: 5, name: 'DFS',       url: process.env.DFS_ALL_SITES },
    ];

    // Process all vendors in parallel
    async function processVendor(vendor) {
      // Kick off DB query and API call simultaneously
      const dbDataPromise = new Promise((resolve, reject) => {
        connection.query(
          'SELECT * FROM H_surveillance.atm_list_new3 WHERE vendor = ?',
          [vendor.id],
          (err, dbResults) => err ? reject(err) : resolve(dbResults || [])
        );
      });

      let apiData = [];
      let apiError = null;

      if (vendor.url) {
        try {
          console.log(`[${vendor.name}] Fetching from API: ${vendor.url}`);
          let apiResponse;

          if (vendor.name === 'BUILDINT') {
            apiResponse = await retryAxios(() => axios.get(vendor.url, {
              headers: {
                'Accept': 'application/json, text/javascript, */*; q=0.01',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
              },
              timeout: 30000
            }), { vendorName: vendor.name });

            if (apiResponse.data.Data && Array.isArray(apiResponse.data.Data)) {
              apiData = apiResponse.data.Data.map(site => ({
                ATM_ID: site.ATM_ID,
                unitname: site.unitName || 'N/A',
                city: site.city || 'N/A',
                state: site.state || 'N/A',
                SiteStatus: site.siteStatus || 'OFFLINE'
              }));
            } else {
              throw new Error('No BUILDINT data received');
            }
          } else if (vendor.name === 'ANIKET' || vendor.name === 'GLOBAL') {
            apiResponse = await retryAxios(() => axios.get(vendor.url, {
              timeout: 30000,
              httpsAgent: new https.Agent({ rejectUnauthorized: false })
            }), { vendorName: vendor.name });

            if (typeof apiResponse.data === 'string') {
              try {
                const parsed = JSON.parse(apiResponse.data);
                apiData = Array.isArray(parsed) ? parsed : [];
              } catch {
                apiData = [];
              }
            } else if (Array.isArray(apiResponse.data)) {
              apiData = apiResponse.data;
            }
          } else if (vendor.name === 'SECURENS') {
            apiResponse = await retryAxios(
              () => http2Get(vendor.url, { timeoutMs: 30000 }),
              { vendorName: vendor.name }
            );

            if (apiResponse.data?.Data && Array.isArray(apiResponse.data.Data)) {
              apiData = apiResponse.data.Data;
            }
          } else if (vendor.name === 'CTS') {
            apiResponse = await retryAxios(() => axios.get(vendor.url, {
              auth: { username: process.env.CTS_USERNAME, password: process.env.CTS_PASSWORD },
              timeout: 30000,
              httpsAgent: new https.Agent({ rejectUnauthorized: false })
            }), { vendorName: vendor.name });

            if (apiResponse.data?.Data && Array.isArray(apiResponse.data.Data)) {
              apiData = apiResponse.data.Data;
            }
          } else {
            apiResponse = await retryAxios(() => axios.get(vendor.url, {
              timeout: 30000,
              httpsAgent: new https.Agent({ rejectUnauthorized: false })
            }), { vendorName: vendor.name });

            if (apiResponse.data) {
              if (Array.isArray(apiResponse.data)) {
                apiData = apiResponse.data;
              } else if (apiResponse.data.Data && Array.isArray(apiResponse.data.Data)) {
                apiData = apiResponse.data.Data;
              } else if (typeof apiResponse.data === 'string') {
                try { apiData = JSON.parse(apiResponse.data); } catch { apiData = []; }
              }
            }
          }

          console.log(`[${vendor.name}] API fetched: ${apiData.length} records`);
        } catch (apiErr) {
          console.error(`[${vendor.name}] API error after retries:`, apiErr.message);
          apiError = apiErr.message;
          apiData = [];
        }
      } else {
        apiError = 'No URL configured';
      }

      // Await DB result (was already running while API was fetched)
      const dbData = await dbDataPromise;
      console.log(`[${vendor.name}] DB fetched: ${dbData.length} records`);

      // A failed/misconfigured vendor API is unknown data, not proof that every
      // ATM is missing from the API. Keep the DB row count for diagnostics, but
      // exclude this vendor from health totals until its API responds again.
      if (apiError) {
        return {
          vendor_id: vendor.id, vendor_name: vendor.name,
          api_configured: Boolean(vendor.url), api_available: false,
          api_error: vendor.url ? 'Vendor API unavailable' : 'Vendor API not configured',
          total_api_records: 0, total_db_records: dbData.length, total_count: 0,
          online_count: 0, offline_count: 0, health_percentage: 0,
          missing_in_api_count: 0, missing_in_db_count: 0,
          online_data: [], offline_data: [], missing_in_api: [], missing_in_db: [],
          summary: {
            total_matched: 0, total_online: 0, total_offline: 0,
            health_percentage: 0, total_missing_in_api: 0,
            total_missing_in_db: 0, data_sync_percentage: 0
          }
        };
      }

      // Build a lookup from every ATM ID field (atm_latest + atm_1..5) to its DB record
      const ATM_FIELDS = ['atm_latest', 'atm_1', 'atm_2', 'atm_3', 'atm_4', 'atm_5'];
      const dbAtmIds = new Set();
      const dbItemByAnyId = new Map(); // any ATM ID → dbItem
      for (const dbItem of dbData) {
        for (const field of ATM_FIELDS) {
          const id = dbItem[field];
          if (id) {
            dbAtmIds.add(id);
            if (!dbItemByAnyId.has(id)) dbItemByAnyId.set(id, dbItem);
          }
        }
      }

      const apiAtmIds = new Set();
      const apiAtmMap = new Map();
      apiData.forEach(item => {
        const atmId = item.ATM_ID || item.atm_id || item.atmId || item.id || null;
        if (atmId) { apiAtmIds.add(atmId); apiAtmMap.set(atmId, item); }
      });

      if (vendor.name === 'GLOBAL') {
        let matchCount = 0;
        apiAtmIds.forEach(id => { if (dbAtmIds.has(id)) matchCount++; });
        console.log(`GLOBAL DEBUG: API=${apiAtmIds.size}, DB=${dbAtmIds.size}, matches=${matchCount}`);
      }

      const onlineData = [], offlineData = [], missingInApi = [], missingInDb = [];

      // API ATMs not found in ANY of the DB's 6 ATM ID columns → truly missing from DB
      Array.from(apiAtmIds).forEach(atmId => {
        if (!dbAtmIds.has(atmId)) {
          const apiItem = apiAtmMap.get(atmId);
          missingInDb.push({
            atm_id: atmId, vendor_name: vendor.name,
            site_status: apiItem.SiteStatus || apiItem.siteStatus || apiItem.Status || 'UNKNOWN',
            unit_name: apiItem.unitname || apiItem.unitName || apiItem.ATM_Address || '',
            city: apiItem.city || '', state: apiItem.state || apiItem.STATE || '',
            address: apiItem.address || apiItem.ATM_Address || '', in_database: false
          });
        }
      });

      // DB ATMs matched against all 6 ID fields — avoids false "Missing in API"
      const processedDbItems = new Set();
      dbData.forEach(dbItem => {
        if (processedDbItems.has(dbItem)) return;
        processedDbItems.add(dbItem);

        // Find the first ATM ID field that appears in the current API response
        const matchedApiId = ATM_FIELDS.map(f => dbItem[f]).find(id => id && apiAtmIds.has(id));
        const atmId = dbItem.atm_latest || dbItem.atm_1 || '-';

        if (matchedApiId) {
          const apiItem = apiAtmMap.get(matchedApiId);
          const isOnline = (apiItem.SiteStatus || apiItem.siteStatus || apiItem.Status || '').toUpperCase() === 'ONLINE';
          const itemData = {
            atm_id: atmId, vendor_name: vendor.name,
            site_status: apiItem.SiteStatus || apiItem.siteStatus || apiItem.Status || 'UNKNOWN',
            unit_name: apiItem.unitname || apiItem.unitName || apiItem.name || apiItem.ATM_Address || dbItem.site_address || '',
            city: apiItem.city || dbItem.city || '',
            state: apiItem.state || apiItem.STATE || dbItem.state || '',
            address: apiItem.address || apiItem.ATM_Address || dbItem.site_address || '',
            lat: apiItem.lat || apiItem.latitude || '',
            long: apiItem.long || apiItem.longitude || '',
            last_communication: apiItem.lastDataReceived || apiItem.last_Heartbeat || apiItem.lastCommunication || (apiItem.p && apiItem.p[0] && apiItem.p[0].LastOnlineDateTime) || '',
            in_database: true, in_api: true
          };
          if (isOnline) onlineData.push(itemData); else offlineData.push(itemData);
        } else {
          missingInApi.push({
            atm_id: atmId, vendor_name: vendor.name, site_status: 'NOT_IN_API',
            unit_name: dbItem.site_address || '', city: dbItem.city || '',
            state: dbItem.state || '', address: dbItem.site_address || '',
            in_database: true, in_api: false
          });
        }
      });

      const totalMatched = onlineData.length + offlineData.length;
      const healthPercentage = totalMatched > 0 ? Math.round((onlineData.length / totalMatched) * 100) : 0;
      const totalCount = onlineData.length + offlineData.length + missingInApi.length;

      return {
        vendor_id: vendor.id, vendor_name: vendor.name,
        api_configured: Boolean(vendor.url), api_available: true, api_error: null,
        total_api_records: apiData.length, total_db_records: dbData.length,
        total_count: totalCount, online_count: onlineData.length, offline_count: offlineData.length,
        health_percentage: healthPercentage,
        missing_in_api_count: missingInApi.length, missing_in_db_count: missingInDb.length,
        online_data: onlineData, offline_data: offlineData,
        missing_in_api: missingInApi, missing_in_db: missingInDb,
        summary: {
          total_matched: totalMatched, total_online: onlineData.length,
          total_offline: offlineData.length, health_percentage: healthPercentage,
          total_missing_in_api: missingInApi.length, total_missing_in_db: missingInDb.length,
          data_sync_percentage: dbData.length > 0 ? Math.round((totalMatched / dbData.length) * 100) : 0
        }
      };
    }

    // Run all vendors in parallel
    const settled = await Promise.allSettled(vendors.map(v => processVendor(v)));

    const results = settled.map((outcome, i) => {
      if (outcome.status === 'fulfilled') return outcome.value;
      const vendor = vendors[i];
      console.error(`Error processing vendor ${vendor.name}:`, outcome.reason);
      return {
        vendor_id: vendor.id, vendor_name: vendor.name, api_configured: Boolean(vendor.url),
        api_available: false, api_error: 'Vendor API unavailable', error: 'Vendor API unavailable',
        total_api_records: 0, total_db_records: 0, total_count: 0,
        online_count: 0, offline_count: 0, health_percentage: 0,
        missing_in_api_count: 0, missing_in_db_count: 0,
        online_data: [], offline_data: [], missing_in_api: [], missing_in_db: [],
        summary: { total_matched: 0, total_online: 0, total_offline: 0, health_percentage: 0, total_missing_in_api: 0, total_missing_in_db: 0, data_sync_percentage: 0 }
      };
    });

    // Apply buffer: for ATMs still "missing from API", use last known status
    try {
      const allMissingIds = results.flatMap(r => r.missing_in_api.map(m => m.atm_id)).filter(Boolean);
      if (allMissingIds.length > 0) {
        const placeholders = allMissingIds.map(() => '?').join(',');
        const bufferRows = await new Promise((resolve) => {
          connection.query(
            `SELECT atm_id, status FROM atm_last_known_status WHERE atm_id IN (${placeholders})`,
            allMissingIds,
            (err, rows) => resolve(err ? [] : (rows || []))
          );
        });
        const bufferMap = new Map(bufferRows.map(r => [r.atm_id, r.status]));

        for (const r of results) {
          const stillMissing = [];
          for (const m of r.missing_in_api) {
            const bufferedStatus = bufferMap.get(m.atm_id);
            if (bufferedStatus) {
              // Reclassify using buffered status
              const entry = { ...m, site_status: bufferedStatus, buffered: true, in_api: false };
              if (bufferedStatus === 'ONLINE') r.online_data.push(entry);
              else r.offline_data.push(entry);
              r.online_count  = r.online_data.length;
              r.offline_count = r.offline_data.length;
            } else {
              stillMissing.push(m);
            }
          }
          r.missing_in_api = stillMissing;
          r.missing_in_api_count = stillMissing.length;
          const totalMatched = r.online_count + r.offline_count;
          r.health_percentage = totalMatched > 0 ? Math.round((r.online_count / totalMatched) * 100) : 0;
          r.total_count = totalMatched + r.missing_in_api_count;
          r.summary = {
            ...r.summary,
            total_online: r.online_count, total_offline: r.offline_count,
            health_percentage: r.health_percentage,
            total_missing_in_api: r.missing_in_api_count,
            total_matched: totalMatched
          };
        }
      }
    } catch (bufferErr) {
      console.warn('[live-health] Buffer lookup failed:', bufferErr.message);
    }

    // Calculate overall summary
    const totalOnline = results.reduce((sum, r) => sum + r.online_count, 0);
    const totalOffline = results.reduce((sum, r) => sum + r.offline_count, 0);
    const totalMissingInApi = results.reduce((sum, r) => sum + r.missing_in_api_count, 0);
    const totalMissingInDb = results.reduce((sum, r) => sum + r.missing_in_db_count, 0);

    const totalAtms = totalOnline + totalOffline + totalMissingInApi;
    const totalMatched = totalOnline + totalOffline;
    const overallHealthPercentage = totalMatched > 0 ? 
      Math.round((totalOnline / totalMatched) * 100) : 0;

    const overallSummary = {
      total_vendors: vendors.length,
      total_atms: totalAtms,
      total_matched: totalMatched,
      total_online: totalOnline,
      total_offline: totalOffline,
      overall_health_percentage: overallHealthPercentage,
      total_missing_in_api: totalMissingInApi,
      total_missing_in_db: totalMissingInDb,
      total_api_records: results.reduce((sum, r) => sum + r.total_api_records, 0),
      total_db_records: results.reduce((sum, r) => sum + r.total_db_records, 0),
      successful_vendors: results.filter(r => r.api_available === true).length,
      failed_vendors: results.filter(r => r.api_available !== true).length
    };

    const responseData = {
      success: true,
      timestamp: new Date().toISOString(),
      overall_summary: overallSummary,
      vendor_results: results
    };

    // Update cache
    liveHealthCache = responseData;
    liveHealthCacheTimestamp = Date.now();
    console.log('Cache updated with fresh data');

    res.json({
      ...responseData,
      cached: false
    });

  } catch (error) {
    console.error('Error in live-health-check:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error',
      timestamp: new Date().toISOString()
    });
  }
});








app.get('/check-file-exists', (req, res) => {
  const relativePath = req.query.filename || req.query.path;

  if (!relativePath) {
    return res.status(400).json({ error: 'filename query parameter is required' });
  }

  // Resolve against the streams directory and block path traversal
  const resolved = path.resolve(streamDir, relativePath.replace(/^\//, ''));
  if (!resolved.startsWith(streamDir)) {
    return res.status(400).json({ error: 'Invalid path' });
  }

  fs.access(resolved, fs.constants.F_OK, (err) => {
    res.json({ exists: !err });
  });
});

app.post('/convert-rtsp', (req, res) => {
  const { rtspUrl, cameraId, atmId } = req.body;

  console.log('Converting rtsp:', rtspUrl, cameraId, atmId);

  if (!rtspUrl || !cameraId || !atmId) {
    return res.status(400).json({ error: 'RTSP URL, Camera ID, and ATM ID are required' });
  }
  
  // Start the conversion
  try {
    startRtspToHls(rtspUrl, cameraId, atmId);
    return res.status(200).json({ 
      success: true, 
      message: 'Stream conversion started',
      streamPath: `/streams/${atmId}/${cameraId}/output.m3u8`
    });
  } catch (error) {
    console.error('Error starting stream conversion:', error);
    return res.status(500).json({ error: 'Failed to start stream conversion' });
  }
});

// Check if stream is ready
app.get('/stream-status/:atmId/:cameraId', (req, res) => {
  const { atmId, cameraId } = req.params;
  const outputPath = path.join(streamDir, atmId, cameraId, 'output.m3u8');
  const streamKey = `${atmId}_${cameraId}`;
  
  const exists = fs.existsSync(outputPath);
  const isProcessing = activeStreams.has(streamKey);
  
  if (exists) {
    // Check if file has content
    const stats = fs.statSync(outputPath);
    const ready = stats.size > 0;
    
    return res.json({ 
      ready, 
      exists: true,
      processing: isProcessing,
      path: `/streams/${atmId}/${cameraId}/output.m3u8`
    });
  }
  
  return res.json({ 
    ready: false, 
    exists: false,
    processing: isProcessing,
    message: isProcessing ? 'Stream is being processed' : 'Stream not started'
  });
});

app.use('/streams', express.static(streamDir));

// Proxy endpoint for HLS/DASH streams that can't be fetched directly by the browser (CORS).
// Used by vendors whose streams live on external servers (CTS, Securens, ITL, etc.)
// Requires JWT auth (handled by global middleware). Blocks private/loopback IPs.
const PRIVATE_IP_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|127\.|::1|localhost)/i;

// Public-facing base URL for this API, as the browser sees it.
// Nginx sits in front and adds /api/ before forwarding to Express, so we reconstruct
// the correct prefix using CORS_ORIGINS (already the public host).
// Dev fallback: no nginx, backend is directly on localhost with no /api prefix.
const PUBLIC_API_BASE = (() => {
  const explicitBase = String(process.env.PUBLIC_API_BASE || '').trim().replace(/\/$/, '');
  if (explicitBase) return explicitBase;

  // Use the same production-safe default as the CORS allowlist. Returning
  // localhost here makes browsers request their own computer instead of the
  // dashboard server when CORS_ORIGINS is not explicitly present in .env.
  const corsOrigin = (process.env.CORS_ORIGINS || 'https://sbi-dashboard.ifiber.in:7668')
    .split(',')[0].trim().replace(/\/$/, '');
  return `${corsOrigin}/api`;
})();

function isSafeProxyUrl(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return false;
    if (PRIVATE_IP_RE.test(parsed.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

app.get('/proxy-hls', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) return res.status(400).json({ error: 'url query param required' });

  if (!isSafeProxyUrl(targetUrl)) {
    return res.status(403).json({ error: 'URL not allowed: must be HTTP/HTTPS and not a private address' });
  }

  try {
    const parsedUrl = new URL(targetUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const httpsAgent = isHttps ? new https.Agent({ rejectUnauthorized: false }) : undefined;

    const axiosConfig = {
      responseType: 'arraybuffer',
      ...(httpsAgent ? { httpsAgent } : {}),
      timeout: 20000,
      maxRedirects: 5,
      // Don't throw on 4xx/5xx — surface the real status instead
      validateStatus: () => true,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': '*/*',
        'Accept-Encoding': 'identity', // avoid gzip so arraybuffer is raw
      }
    };

    // CTS requires HTTP Basic auth on their DVR stream server
    if (parsedUrl.hostname.includes('cts') || parsedUrl.hostname.includes('closyss')) {
      if (process.env.CTS_USERNAME && process.env.CTS_PASSWORD) {
        axiosConfig.auth = { username: process.env.CTS_USERNAME, password: process.env.CTS_PASSWORD };
      }
    }

    const upstream = await axios.get(targetUrl, axiosConfig);

    // Surface upstream errors so the client (and logs) see the real cause
    if (upstream.status >= 400) {
      const body = Buffer.from(upstream.data).toString('utf-8').substring(0, 200);
      console.error(`[proxy-hls] Upstream ${upstream.status} for ${targetUrl}: ${body}`);
      return res.status(upstream.status).json({
        error: `Upstream returned HTTP ${upstream.status}`,
        detail: body
      });
    }

    const isM3u8 = targetUrl.toLowerCase().includes('.m3u8') ||
      (upstream.headers['content-type'] || '').toLowerCase().includes('mpegurl');

    if (isM3u8) {
      const baseUrl = targetUrl.substring(0, targetUrl.lastIndexOf('/') + 1);
      let content = Buffer.from(upstream.data).toString('utf-8');

      // Rewrite every non-comment line (segment/playlist URI) to go through this proxy.
      // Keep the URL relative (without a leading slash) so a manifest served from
      // /api/proxy-hls resolves its segments back to /api/proxy-hls on the same
      // public host and port. This also avoids leaking an internal localhost URL.
      content = content.split('\n').map(line => {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) return line;
        const absUrl = trimmed.startsWith('http') ? trimmed : baseUrl + trimmed;
        return `proxy-hls?url=${encodeURIComponent(absUrl)}`;
      }).join('\n');

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Cache-Control', 'no-cache');
      return res.send(content);
    }

    // .ts segments — pass through as-is
    res.setHeader('Content-Type', upstream.headers['content-type'] || 'video/mp2t');
    res.setHeader('Cache-Control', 'no-cache');
    return res.send(Buffer.from(upstream.data));
  } catch (err) {
    console.error('[proxy-hls] Network error fetching:', targetUrl, err.code || err.message);
    return res.status(502).json({ error: `Proxy network error: ${err.code || err.message}` });
  }
});

// Lightweight readiness check for proxied streams — returns { ready: bool }.
// Used by the frontend to poll until a vendor's external stream file is available (e.g. CTS).
app.get('/proxy-stream-ready', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl || !isSafeProxyUrl(targetUrl)) return res.json({ ready: false });

  try {
    const parsedUrl = new URL(targetUrl);
    const isHttps = parsedUrl.protocol === 'https:';
    const config = {
      ...(isHttps ? { httpsAgent: new https.Agent({ rejectUnauthorized: false }) } : {}),
      timeout: 6000,
      validateStatus: () => true,
    };
    if (parsedUrl.hostname.includes('cts') || parsedUrl.hostname.includes('closyss')) {
      if (process.env.CTS_USERNAME && process.env.CTS_PASSWORD) {
        config.auth = { username: process.env.CTS_USERNAME, password: process.env.CTS_PASSWORD };
      }
    }
    // HEAD is enough — we just need the status code, not the body
    const response = await axios.head(targetUrl, config);
    return res.json({ ready: response.status >= 200 && response.status < 300 });
  } catch {
    return res.json({ ready: false });
  }
});

app.post('/get-hls-streams', upload.single('hlsFile'), (req, res) => {
  const { atmId, cameraId } = req.body;

  const streamDir = path.join(__dirname, 'assets', 'streams', atmId, cameraId);
  const file = req.file;

  if (!file) {
    return res.status(400).send('No file uploaded');
  }

  res.status(200).send({
    message: 'HLS stream file saved successfully',
    filePath: file.path,
    atmId: atmId,
    cameraId: cameraId
  });
});

// --- FORGOT PASSWORD ROUTES ---

// 1️⃣ Check if email exists
app.post('/forgot/check-email', forgotEmailRateLimit, (req, res) => {
  const { email } = req.body;

  if (!email) return res.status(400).json({ error: 'Email is required' });

  connection.query(
    'SELECT users_id FROM users WHERE email_id = ?',
    [email],
    (err) => {
      if (err) {
        console.error('DB Error in /forgot/check-email:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      // Always return exists:true to prevent user enumeration (#3 Sensitive Data Exposure)
      res.json({ exists: true });
    }
  );
});



// Store OTP with expiry and attempts
const otps = {};
// { email: { otp: 123456, expiresAt: Date, attempts: 0 } }

// 2️⃣ Send OTP

// app.post('/forgot/send-otp', async (req, res) => {
//   const { email } = req.body;
//   const otp = Math.floor(100000 + Math.random() * 900000);
//   const expiry = new Date(Date.now() + 2 * 60 * 1000); // 2 min from now

//   try {
//     // Check if user exists
//     connection.query(
//       `SELECT users_id FROM users WHERE email_id = ?`,
//       [email],
//       (err, results) => {
//         if (err) {
//           console.error('Error fetching user:', err);
//           return res.status(500).json({ error: 'Internal server error' });
//         }
//         if (results.length === 0) {
//           return res.status(404).json({ error: 'User not found' });
//         }

//         const user = results[0];

//         // Save OTP in DB
//         connection.query(
//           `UPDATE users 
//            SET otp = ?, otp_expire = ?, otp_attempts = 0 
//            WHERE users_id = ?`,
//           [otp, expiry, user.users_id],
//           async (err2) => {
//             if (err2) {
//               console.error('Error saving OTP:', err2);
//               return res.status(500).json({ error: 'Internal server error' });
//             }

//             try {
//               await sendMail(
//                 email,
//                 "software@buildint.co",
//                 "SBI Password Reset - OTP Verification",
//                 `
//                 <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
//                   <p>Dear user,</p>
//                   <p>Thank you for logging in to <b style ="color: #0046ad;">SBI Surveillance Dashboard</b>.</p>
//                   <p>Your OTP code is: <h3 style="color: #0046ad;">${otp}</h3></p>
//                   <p><b>Important:</b> This OTP will expire in <b>2 minutes</b>. Do not share this OTP with anyone.</p>
//                   <br>
//                   <p>If you did not request this, please ignore this email.</p>
//                   <br>
//                   <p>Best Regards,<br/>Team BuildINT</p>
//                 </div>
//                 `
//               );

//               return res.json({ success: true, message: "OTP sent successfully" });

//             } catch (mailErr) {
//               console.error("Error sending mail:", mailErr);
//               return res.status(500).json({ error: "Failed to send OTP" });
//             }
//           }
//         );
//       }
//     );
//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Unexpected error" });
//   }
// });

app.post('/forgot/send-otp', forgotEmailRateLimit, async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const otp = crypto.randomInt(100000, 1000000).toString();
  // Keep one OTP active for its full two-minute validity period.
  const expiry = new Date(Date.now() + 2 * 60 * 1000);

  try {
    // First check if the user exists and is not permanently blocked.
    connection.query(
      `SELECT users_id, otp_attempts FROM users WHERE email_id = ?`,
      [email],
      (err, results) => {
        if (err) {
          console.error('Error fetching user:', err);
          return res.status(500).json({ error: 'Internal server error' });
        }

        // Always return generic success for unknown emails to prevent enumeration.
        if (results.length === 0) {
          return res.json({ success: true, message: 'If the account exists, OTP has been sent.' });
        }

        const user = results[0];
        const otpDigest = createOtpDigest(user.users_id, otp);

        // Block forgot password if user already exceeded OTP verify attempts.
        if (user.otp_attempts >= 3) {
          return res.json({
            success: false,
            blocked: true,
            message: "Too many failed OTP attempts. Please contact administrator."
          });
        }

        // Atomic UPDATE: only succeeds if no active OTP exists (otp_expire is NULL
        // or expired). This prevents the race condition where two concurrent requests
        // both read otp_expire=NULL and both proceed to send an OTP.
        connection.query(
          `UPDATE users
           SET otp = ?, otp_expire = ?
           WHERE users_id = ? AND (otp_expire IS NULL OR otp_expire < NOW())`,
          [otpDigest, expiry, user.users_id],
          async (err2, result2) => {
            if (err2) {
              console.error('Error saving OTP:', err2);
              return res.status(500).json({ error: 'Internal server error' });
            }

            // affectedRows = 0 means an active OTP is still valid — block resend.
            if (result2.affectedRows === 0) {
              return res.status(429).json({
                error: 'OTP already sent recently. Please wait before requesting again.'
              });
            }

            try {
              await sendMail(
                email,
                "software@buildint.co",
                "SBI Password Reset - OTP Verification",
                `
                <div style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
                  <p>Dear user,</p>
                  <p>Thank you for logging in to <b style ="color: #0046ad;">SBI Surveillance Dashboard</b>.</p>
                  <p>Your OTP code is: <h3 style="color: #0046ad;">${otp}</h3></p>
                  <p><b>Important:</b> This OTP will expire in <b>2 minutes</b>. Do not share this OTP with anyone.</p>
                  <br>
                  <p>If you did not request this, please ignore this email.</p>
                  <br>
                  <p>Best Regards,<br/>Team BuildINT</p>
                </div>
                `
              );

              return res.json({ success: true, message: "OTP sent successfully" });

            } catch (mailErr) {
              console.error("Error sending mail:", mailErr);
              return res.status(500).json({ error: "Failed to send OTP" });
            }
          }
        );
      }
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Unexpected error" });
  }
});


// 2️⃣ Verify OTP
app.post('/forgot/verify-otp', forgotEmailRateLimit, async (req, res) => {
  const { userEmail, otp } = req.body;

  if (!userEmail || (typeof otp !== 'string' && typeof otp !== 'number')) {
    return res.status(400).json({ verified: false, message: 'Email and OTP are required' });
  }
  const submittedOtp = String(otp);
  if (!/^\d{6}$/.test(submittedOtp)) {
    return res.json({ verified: false, message: 'Invalid OTP format' });
  }

  try {
    const users = await queryPromise(
      `SELECT users_id, otp, otp_expire, otp_attempts FROM users WHERE email_id = ?`,
      [normalizeEmail(userEmail)]
    );
    if (!users.length) return res.json({ verified: false, message: 'Invalid OTP' });
    const user = users[0];
    if (!user.otp || !user.otp_expire || new Date(user.otp_expire).getTime() <= Date.now()) {
      return res.json({ verified: false, message: 'OTP expired or unavailable' });
    }
    if (Number(user.otp_attempts) >= 3) {
      return res.json({ verified: false, attemptsExceeded: true, message: 'Maximum attempts exceeded' });
    }

    if (!otpDigestMatches(user.users_id, submittedOtp, user.otp)) {
      await queryPromise(
        `UPDATE users SET otp_attempts = otp_attempts + 1
         WHERE users_id = ? AND otp = ? AND otp_expire > NOW() AND otp_attempts < 3`,
        [user.users_id, user.otp]
      );
      return res.json({ verified: false, message: 'Invalid OTP' });
    }

    const consumed = await queryPromise(
      `UPDATE users SET otp = NULL, otp_expire = NULL, otp_attempts = 0
       WHERE users_id = ? AND otp = ? AND otp_expire > NOW() AND otp_attempts < 3`,
      [user.users_id, createOtpDigest(user.users_id, submittedOtp)]
    );
    if (consumed.affectedRows !== 1) {
      return res.json({ verified: false, message: 'OTP expired or already used' });
    }

    const resetTokenId = crypto.randomUUID();
    issuedPasswordResetTokens.set(resetTokenId, Date.now() + 10 * 60 * 1000);
    const resetToken = jwt.sign(
      { email: normalizeEmail(userEmail), resetAllowed: true, jti: resetTokenId },
      secretKey,
      { expiresIn: '10m' }
    );
    return res.json({ verified: true, resetToken, message: 'OTP verified successfully' });
  } catch (err) {
    console.error('Error verifying password-reset OTP:', err);
    return res.status(500).json({ verified: false, message: 'Internal server error' });
  }
});


app.post('/forgot/reset-password', async (req, res) => {
  const { newPassword, resetToken } = req.body;

  // #4 Require the signed reset token issued by /forgot/verify-otp
  if (!resetToken) {
    return res.status(403).json({ error: 'Reset token required' });
  }

  let emailFromToken;
  try {
    const decoded = jwt.verify(resetToken, secretKey);
    if (!decoded.resetAllowed || !decoded.email || !decoded.jti) {
      return res.status(403).json({ error: 'Invalid reset token' });
    }
    const resetTokenExpiry = issuedPasswordResetTokens.get(decoded.jti);
    if (!resetTokenExpiry || resetTokenExpiry <= Date.now()) {
      issuedPasswordResetTokens.delete(decoded.jti);
      return res.status(403).json({ error: 'Reset token has expired or already been used' });
    }
    // Consume before starting asynchronous password work so concurrent replay
    // attempts cannot both pass validation.
    issuedPasswordResetTokens.delete(decoded.jti);
    emailFromToken = decoded.email;
  } catch {
    return res.status(403).json({ error: 'Invalid or expired reset token' });
  }

  // #7 Enforce password complexity server-side
  if (!isStrongPassword(newPassword)) {
    return res.status(400).json({
      error: 'Password must be at least 15 characters and include uppercase, lowercase, number, and special character'
    });
  }

  try {
    // Resolve users_id from email for history check
    connection.query('SELECT users_id FROM users WHERE email_id = ?', [emailFromToken], async (err, rows) => {
      if (err || rows.length === 0) return res.status(500).json({ error: 'Internal server error' });
      const usersId = rows[0].users_id;

      try {
        await checkAndSavePasswordHistory(usersId, newPassword);
      } catch (histErr) {
        return res.status(400).json({ error: histErr.message });
      }

      try {
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        const currentTimestamp = new Date();
        connection.query(
          'UPDATE users SET password = ?, password_last_updated = ?, new_user = 0 WHERE users_id = ?',
          [hashedPassword, currentTimestamp, usersId],
          (err) => {
            if (err) return res.status(500).json({ error: 'Internal server error' });
            res.json({
              success: true,
              message: 'Password reset successfully',
              password_last_updated: currentTimestamp
            });
          }
        );
      } catch (err) {
        console.error('Error in /forgot/reset-password:', err);
        res.status(500).json({ error: 'Internal server error' });
      }
    });
  } catch (err) {
    console.error('Error in /forgot/reset-password:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// --- REGISTER ROUTE ---


// Function to generate a secure random password
function generatePassword() {
  const length = 14;
  const uppercase = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const lowercase = 'abcdefghijklmnopqrstuvwxyz';
  const numbers = '0123456789';
  const specialChars = '!@#$%^&';
  const allChars = uppercase + lowercase + numbers + specialChars;

  let password = '';
  // Ensure at least one of each required character type
  password += uppercase[Math.floor(Math.random() * uppercase.length)];
  password += lowercase[Math.floor(Math.random() * lowercase.length)];
  password += numbers[Math.floor(Math.random() * numbers.length)];
  password += specialChars[Math.floor(Math.random() * specialChars.length)];

  // Fill the remaining length with random characters
  for (let i = password.length; i < length; i++) {
    password += allChars[Math.floor(Math.random() * allChars.length)];
  }

  // Shuffle the password to randomize character positions
  password = password.split('').sort(() => Math.random() - 0.5).join('');

  return password;
}


app.post('/register', (req, res, next) => {
  // Manually verify token since this route is in PUBLIC_ROUTES (Angular sends it explicitly)
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token not provided' });
  }
  const token = authHeader.slice(7);
  if (tokenBlacklist.has(token)) {
    return res.status(401).json({ error: 'Token has been invalidated. Please login again.' });
  }
  jwt.verify(token, secretKey, (err, decoded) => {
    if (err) return res.status(403).json({ error: 'Invalid token' });
    if (!decoded.verified) return res.status(403).json({ error: 'OTP verification required' });
    if (Number(decoded.role) !== 1) return res.status(403).json({ error: 'Admin access required' });
    req.user = decoded;
    next();
  });
}, async (req, res) => {

  const { email_id, first_name, last_name, contact, role_id, lho_id } = req.body;

  // lho_id can be null (all LHOs selected), a number, or a comma-separated string of IDs
  if (!email_id || !first_name || !last_name || !contact || !role_id) {

    return res.status(400).json({ error: 'All fields are required' });

  }

  // Normalize lho_id: null means all LHOs, otherwise store as-is (number or comma-separated string)
  const lhoIdValue = (lho_id === null || lho_id === undefined || lho_id === '') ? null : lho_id;

  try {

    connection.query('SELECT email_id FROM users WHERE email_id = ?', [email_id], (err, results) => {

      if (err) {

        console.error('Database query error:', err);

        return res.status(500).json({ error: 'Internal server error' });

      }

      if (results.length > 0) {

        return res.status(409).json({ error: 'Email is already in use' });

      }

      const password = generatePassword();

      hashPassword(password)

        .then(async (hashedPassword) => {

          connection.query(

            'INSERT INTO users (email_id, password, first_name, last_name, contact, role_id, lho_id) VALUES (?, ?, ?, ?, ?, ?, ?)',

            [email_id, hashedPassword, first_name, last_name, contact, role_id, lhoIdValue],

            async (err) => {

              if (err) {

                console.error('Database query error:', err);

                return res.status(500).json({ error: 'Internal server error' });

              }

              try {

                await sendMail(

                  email_id,

                  "software@buildint.co",

                  "Your Account Has Been Created",

                  `<p>Hi ${first_name},</p>
<p>Your account has been successfully created.</p>
<p><strong>Your password:</strong> ${password}</p>
<p>Please change your password after logging in.</p>`

                );

                return res.status(201).json({

                  message: 'User registered successfully, password sent via email'

                });

              } catch (emailErr) {

                console.error('Error sending email:', emailErr);

                return res.status(500).json({

                  error: 'User registered, but failed to send email'

                });

              }

            }

          );

        })

        .catch((error) => {

          console.error('Error during password hashing:', error);

          return res.status(500).json({ error: 'Internal server error' });

        });

    });

  } catch (error) {

    console.error('Error during registration:', error);

    return res.status(500).json({ error: 'Internal server error' });

  }

});

function sendMail(to, from, subject, html) {
  let transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: process.env.SMTP_PORT,
    secure: false,
    auth: {
      user: process.env.SMTP_USERNAME,
      pass: process.env.SMTP_PASSWORD,
    },
  });

  // Convert 'to' parameter to an array
  if (!Array.isArray(to)) {
    to = [to];
  }

  // const mailOptions = {
  //   from: process.env.SMTP_HOST,
  //   to: to.join(", "),
  //   cc: [""],
  //   bcc: process.env.SMTP_HOST,
  //   subject: subject,
  //   html: html,
  // };

  const mailOptions = {
    from: "software@buildint.co",
    to: to.join(", "),
    cc: [""],
    bcc: "software@buildint.co",
    subject: subject,
    html: html,
  };

  transporter.sendMail(mailOptions, (error, info) => {
    if (error) {
      return console.error("Error sending email:", error);
    }
    console.log("Email sent to:", to, "From", from);
  });
}


const { from } = require('rxjs');


// app.post('/login', async (req, res) => {
//   const { EmailId, password } = req.body;

//   if (!EmailId || !password) {
//     return res.status(400).json({
//       error: "Bad Request",
//       message: "EmailId and password are required"
//     });
//   }

//   try {
//     connection.query(
//       'SELECT * FROM users WHERE email_id = ? AND is_active = 1',
//       [EmailId],
//       async (err, results) => {
//         if (err) {
//           console.error('Database query error:', err);
//           return res.status(500).json({
//             error: "Database Error",
//             message: "Internal server error"
//           });
//         }

//         if (results.length === 0) {
//           return res.status(401).json({
//             error: "Invalid Credentials",
//             message: "Username not found"
//           });
//         }

//         const user = results[0];

//         // 🚫 Block login if account locked
//         if (user.login_attempts >= 3) {
//           return res.status(403).json({
//             error: "Contact Administrator",
//             message: "Your account is locked due to multiple failed login attempts. Please contact administrator."
//           });
//         }

//         const passwordMatch = await bcrypt.compare(password, user.password);

//         if (!passwordMatch) {
//           const newAttempts = user.login_attempts + 1;

//           connection.query(
//             `UPDATE users SET login_attempts = ? WHERE users_id = ?`,
//             [newAttempts, user.users_id],
//             (err2) => {
//               if (err2) {
//                 console.error("Error updating login attempts:", err2);
//                 return res.status(500).json({
//                   error: "Database Error",
//                   message: "Internal server error"
//                 });
//               }

//               const attemptsLeft = 3 - newAttempts;
//               return res.status(401).json({
//                 error: "Invalid Credentials",
//                 message: "Invalid EmailId or password",
//                 attemptsLeft: attemptsLeft >= 0 ? attemptsLeft : 0
//               });
//             }
//           );
//           return;
//         }

//         // ✅ Reset login_attempts on success
//         connection.query(
//           `UPDATE users SET login_attempts = 0 WHERE users_id = ?`,
//           [user.users_id]
//         );

//         // 🚫 Check if OTP attempts exhausted
//         if (user.otp_attempts >= 3) {
//           return res.status(403).json({
//             error: "OTP Attempts Exceeded",
//             message: "You have exceeded maximum OTP attempts. Please contact administrator."
//           });
//         }

//         // ✅ Generate OTP
//         const otp = crypto.randomInt(100000, 999999).toString();
//         const expiry = moment().add(5, 'minutes').toDate();

//         connection.query(
//           `UPDATE users 
//            SET otp = ?, otp_expire = ?, otp_attempts = 0 
//            WHERE users_id = ?`,
//           [otp, expiry, user.users_id],
//           (err2) => {
//             if (err2) {
//               console.error('Error saving OTP:', err2);
//               return res.status(500).json({
//                 error: "Database Error",
//                 message: "Internal server error"
//               });
//             }

//             // Send OTP mail
//             const subject = 'OTP for verification';
//             const html = `
//               <p>Dear ${user.first_name},</p>
//               <p>Your OTP code is <b>${otp}</b>. It is valid for 5 minutes.</p>
//             `;

//             sendMail(user.email_id, "software@buildint.co", subject, html);

//             // Generate JWT
//             const token = jwt.sign(
//               { userId: user.users_id, email: user.email_id, role: user.role_id },
//               secretKey,
//               { expiresIn: '1h' }
//             );

//             return res.json({
//               success: true,
//               userId: user.users_id,
//               token,
//               roleId: user.role_id,
//               message: "OTP sent to registered email. Please verify."
//             });
//           }
//         );
//       }
//     );
//   } catch (error) {
//     console.error('Error during login:', error);
//     return res.status(500).json({
//       error: "Server Error",
//       message: "Internal server error"
//     });
//   }
// });

//login with admin only
// app.post('/login', async (req, res) => {
//   const { EmailId, password } = req.body;

//   if (!EmailId || !password) {
//     return res.status(400).json({
//       error: "Bad Request",
//       message: "EmailId and password are required"
//     });
//   }

//   try {
//     connection.query(
//       'SELECT * FROM users WHERE email_id = ? AND is_active = 1',
//       [EmailId],
//       async (err, results) => {
//         if (err) {
//           console.error('Database query error:', err);
//           return res.status(500).json({
//             error: "Database Error",
//             message: "Internal server error"
//           });
//         }

//         if (results.length === 0) {
//           return res.status(401).json({
//             error: "Invalid Credentials",
//             message: "Username not found"
//           });
//         }

//         const user = results[0];

//         // 🚫 Allow only role_id = 1
//         // if (parseInt(user.role_id) !== 1) {
//         //   return res.status(503).json({
//         //     error: "Server Upgrading",
//         //     message: "Server is Upgrading. Will be back soon!"
//         //   });
//         // }

//         // 🚫 Block login if account locked
//         if (user.login_attempts >= 3) {
//           return res.status(403).json({
//             error: "Contact Administrator",
//             message: "Your account is locked due to multiple failed login attempts. Please contact administrator."
//           });
//         }

//         const passwordMatch = await bcrypt.compare(password, user.password);

//         if (!passwordMatch) {
//           const newAttempts = user.login_attempts + 1;

//           connection.query(
//             `UPDATE users SET login_attempts = ? WHERE users_id = ?`,
//             [newAttempts, user.users_id],
//             (err2) => {
//               if (err2) {
//                 console.error("Error updating login attempts:", err2);
//                 return res.status(500).json({
//                   error: "Database Error",
//                   message: "Internal server error"
//                 });
//               }

//               const attemptsLeft = 3 - newAttempts;
//               return res.status(401).json({
//                 error: "Invalid Credentials",
//                 message: "Invalid EmailId or password",
//                 attemptsLeft: attemptsLeft >= 0 ? attemptsLeft : 0
//               });
//             }
//           );
//           return;
//         }

//         // ✅ Reset login_attempts on success
//         connection.query(
//           `UPDATE users SET login_attempts = 0 WHERE users_id = ?`,
//           [user.users_id]
//         );

//         // 🚫 Check if OTP attempts exhausted
//         if (user.otp_attempts >= 3) {
//           return res.status(403).json({
//             error: "OTP Attempts Exceeded",
//             message: "You have exceeded maximum OTP attempts. Please contact administrator."
//           });
//         }

//         // ✅ Generate OTP
//         const otp = crypto.randomInt(100000, 999999).toString();
//         const expiry = moment().add(5, 'minutes').toDate();

//         connection.query(
//           `UPDATE users 
//            SET otp = ?, otp_expire = ?, otp_attempts = 0 
//            WHERE users_id = ?`,
//           [otp, expiry, user.users_id],
//           (err2) => {
//             if (err2) {
//               console.error('Error saving OTP:', err2);
//               return res.status(500).json({
//                 error: "Database Error",
//                 message: "Internal server error"
//               });
//             }

//             // Send OTP mail
//             const subject = 'OTP for verification';
//             const html = `
//               <p>Dear ${user.first_name},</p>
//               <p>Your OTP code is <b>${otp}</b>. It is valid for 5 minutes.</p>
//             `;

//             sendMail(user.email_id, "software@buildint.co", subject, html);

//             // Generate JWT
//             const token = jwt.sign(
//               { userId: user.users_id, email: user.email_id, role: user.role_id },
//               secretKey,
//               { expiresIn: '1h' }
//             );

//             return res.json({
//               success: true,
//               userId: user.users_id,
//               token,
//               roleId: user.role_id,
//               message: "OTP sent to registered email. Please verify."
//             });
//           }
//         );
//       }
//     );
//   } catch (error) {
//     console.error('Error during login:', error);
//     return res.status(500).json({
//       error: "Server Error",
//       message: "Internal server error"
//     });
//   }
// });

app.post('/login', authRateLimit, createEmailRateLimiter(15 * 60 * 1000, 3), async (req, res) => {
  const { EmailId, password } = req.body;

  if (!dbAvailable) {
    return res.status(503).json({
      error: 'Service Unavailable',
      message: 'Database is temporarily unavailable. Please try again shortly.'
    });
  }

  if (!EmailId || !password) {
    return res.status(400).json({
      error: "Bad Request",
      message: "Email and password are required"
    });
  }

  try {
    connection.query(
      {
        sql: 'SELECT * FROM users WHERE email_id = ? AND is_active = 1',
        timeout: 20000,
      },
      [EmailId],
      async (err, results) => {

        if (err) {
          console.error('DB error:', err);
          if (isDbConnectivityError(err)) {
            setDbUnavailable(err);
            return res.status(503).json({
              error: 'Service Unavailable',
              message: 'Database is temporarily unavailable. Please try again shortly.'
            });
          }
          return res.status(500).json({ error: "Database Error" });
        }

        // 🚫 No user found
        if (results.length === 0) {
          return res.status(401).json({
            error: "Invalid Credentials",
            message: "Email not found"
          });
        }

        const user = results[0];
        // 🕒 Check Password Expiry (30 Days)
        if (user.password_last_updated) {
          const lastUpdated = moment(user.password_last_updated);
          const today = moment();
          const diffDays = today.diff(lastUpdated, 'days');

          if (diffDays >= 30) {
            return res.status(403).json({
              error: "Password Expired",
              message: "Your password is older than 30 days. Please reset to continue."
            });
          }
        } else {
          // If column is NULL, block or allow (your choice)
          return res.status(403).json({
            error: "Password Expired",
            message: "Please reset your password to continue."
          });
        }

        // 🚫 Account locked
        if (user.login_attempts >= 3) {
          return res.status(403).json({
            error: "Account Locked",
            message: "Too many failed attempts. Contact admin."
          });
        }

        // ❌ Wrong password
        const passwordMatch = await bcrypt.compare(password, user.password);

        if (!passwordMatch) {
          const newAttempts = user.login_attempts + 1;

          connection.query(
            {
              sql: `UPDATE users SET login_attempts = ? WHERE users_id = ?`,
              timeout: 20000,
            },
            [newAttempts, user.users_id]
          );

          return res.status(401).json({
            error: "Invalid Credentials",
            message: "Invalid Email or Password",
            attemptsLeft: Math.max(0, 3 - newAttempts)
          });
        }

        // ✅ Reset attempts on correct password
        connection.query(
          {
            sql: `UPDATE users SET login_attempts = 0 WHERE users_id = ?`,
            timeout: 20000,
          },
          [user.users_id]
        );

        // 🚫 OTP attempts limit
        if (user.otp_attempts >= 3) {
          return res.status(403).json({
            error: "OTP Attempts Exceeded",
            message: "Maximum OTP attempts exceeded. Contact admin."
          });
        }

        // Generate the email OTP, but store only a keyed digest in the database.
        const rawOtp = crypto.randomInt(100000, 1000000).toString();
        const otpDigest = createOtpDigest(user.users_id, rawOtp);
        const expiry = moment().add(2, 'minutes').toDate();

        connection.query(
          {
            sql: `UPDATE users
           SET otp = ?, otp_expire = ?
           WHERE users_id = ?`,
            timeout: 20000,
          },
          [otpDigest, expiry, user.users_id],
          (err2) => {

            if (err2) {
              console.error("Error saving OTP:", err2);
              if (isDbConnectivityError(err2)) {
                setDbUnavailable(err2);
                return res.status(503).json({
                  error: 'Service Unavailable',
                  message: 'Database is temporarily unavailable. Please try again shortly.'
                });
              }
              return res.status(500).json({ error: "Database Error" });
            }

            // ✉️ Send OTP Mail
            sendMail(
              user.email_id,
              "software@buildint.co",
              "OTP for Verification",
              `<p>Dear ${user.first_name},</p>
               <p>Your OTP is <b>${rawOtp}</b>. Valid for 2 minutes.</p>`
            );

            // 🔐 Create TEMPORARY JWT (valid only for OTP stage)
            const tempToken = jwt.sign(
              {
                userId: user.users_id,
                email: user.email_id,
                otpVerified: false,
                purpose: 'login-otp'
              },
              secretKey,
              { expiresIn: "2m" }
            );

            return res.json({
              success: true,
              message: "OTP sent to registered email.",
              tempToken,  // ⬅️ Correct token returned
              roleId: user.role_id,
              lho_id: user.lho_id,
              userId: user.users_id
            });

          }
        );
      }

    );
  } catch (error) {
    console.error("Error:", error);
    return res.status(500).json({
      error: "Server Error",
      message: "Something went wrong"
    });
  }
});




// OTP VERIFICATION API
// app.post('/verify-otp', (req, res) => {
//   let { EmailId, otp } = req.body;

//   if (!EmailId || !otp) {
//     return res.status(400).json({ error: 'EmailId and OTP are required' });
//   }

//   // ✅ Convert OTP to number (to match INT in DB)
//   otp = Number(otp);

//   if (isNaN(otp)) {
//     return res.status(400).json({ error: 'Invalid OTP format' });
//   }

//   connection.query(
//     'SELECT * FROM users WHERE email_id = ?',
//     [EmailId],
//     (err, results) => {
//       if (err) {
//         console.error('Database query error:', err);
//         return res.status(500).json({ error: 'Internal server error' });
//       }

//       if (results.length === 0) {
//         return res.status(404).json({ error: 'User not found' });
//       }

//       const user = results[0];

//       console.log("User object from DB:", user);

//       // If no OTP stored
//       if (!user.otp || !user.otp_expire) {
//         return res.status(400).json({ error: 'No OTP generated. Please login again.' });
//       }

//       // Check expiry
//       if (new Date() > new Date(user.otp_expire)) {
//         return res.status(400).json({ error: 'OTP expired. Please login again.' });
//       }

//       // Check max attempts
//       if (user.otp_attempts >= 3) {
//         connection.query(
//           'UPDATE users SET otp = NULL, otp_expire = NULL WHERE users_id = ?',
//           [user.users_id]
//         );
//         return res.status(403).json({ error: 'Maximum OTP attempts exceeded. Please login again.' });
//       }

//       // ✅ Compare OTP (both numbers now)
//       if (user.otp !== otp) {
//         connection.query(
//           'UPDATE users SET otp_attempts = otp_attempts + 1 WHERE users_id = ?',
//           [user.users_id]
//         );
//         return res.status(401).json({ error: 'Invalid OTP. Please try again.' });
//       }

//       // ✅ OTP is correct → Reset OTP fields
//       connection.query(
//         'UPDATE users SET otp = NULL, otp_expire = NULL, otp_attempts = 0 WHERE users_id = ?',
//         [user.users_id]
//       );

//       // Issue JWT token
//       const token = jwt.sign(
//         {
//           id: user.users_id,
//           email: user.email_id,
//           role: user.role_id,
//         },
//         secretKey,
//         { expiresIn: '1h' }
//       );

//       // Check new_user flag
//       if (user.new_user === 1) {
//         return res.json({ success: true, redirect: 'newpassword', token });
//       } else {
//         return res.json({ success: true, redirect: 'dashboard', token });
//       }
//     }
//   );
// });
app.post('/verify-otp', otpRateLimit, async (req, res) => {
  const { otp } = req.body;

  // ── Require the tempToken issued by /login ───────────────────────────────
  // This binds OTP verification to the specific login session so that nobody
  // can call this endpoint without first passing the password check.
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Login session required. Please login first.' });
  }

  const tempToken = authHeader.slice(7);
  let sessionData;
  try {
    sessionData = jwt.verify(tempToken, secretKey);
  } catch {
    return res.status(401).json({ error: 'Login session expired. Please login again.' });
  }

  // Accept only the short-lived token created by the password step.
  if (sessionData.purpose !== 'login-otp' || sessionData.otpVerified !== false) {
    return res.status(401).json({ error: 'Invalid session. Please login again.' });
  }

  // Extract identity from the verified token — never trust client-supplied EmailId
  const { userId: sessionUserId, email: sessionEmail } = sessionData;
  if (!sessionUserId || !sessionEmail) {
    return res.status(401).json({ error: 'Invalid session token.' });
  }

  if (typeof otp !== 'string' && typeof otp !== 'number') {
    return res.status(400).json({ error: 'OTP is required' });
  }
  const submittedOtp = String(otp);
  if (!/^\d{6}$/.test(submittedOtp)) {
    return res.status(400).json({ error: 'OTP must be exactly 6 digits' });
  }

  try {
    const users = await queryPromise(
      'SELECT users_id, email_id, otp, otp_expire, otp_attempts, role_id, new_user FROM users WHERE users_id = ? AND email_id = ?',
      [sessionUserId, sessionEmail]
    );
    if (!users.length) return res.status(404).json({ error: 'User not found' });
    const user = users[0];

    if (!user.otp || !user.otp_expire) {
      return res.status(400).json({ error: 'No active OTP. Please login again.' });
    }
    if (new Date(user.otp_expire).getTime() <= Date.now()) {
      return res.status(400).json({ error: 'OTP expired. Please login again.' });
    }
    if (Number(user.otp_attempts) >= 3) {
      return res.status(403).json({ error: 'Maximum OTP attempts exceeded. Please contact administrator.' });
    }

    const otpDigest = createOtpDigest(user.users_id, submittedOtp);
    if (!otpDigestMatches(user.users_id, submittedOtp, user.otp)) {
      // The conditional increment is atomic, so simultaneous guesses cannot
      // all pass the same stale attempt count.
      await queryPromise(
        `UPDATE users SET otp_attempts = otp_attempts + 1
         WHERE users_id = ? AND otp = ? AND otp_expire > NOW() AND otp_attempts < 3`,
        [user.users_id, user.otp]
      );
      return res.status(401).json({ error: 'Invalid OTP. Please try again.' });
    }

    // Consume the code with a compare-and-swap update before issuing a token.
    // Only one concurrent request can clear the matching active digest.
    const consumed = await queryPromise(
      `UPDATE users SET otp = NULL, otp_expire = NULL, otp_attempts = 0
       WHERE users_id = ? AND otp = ? AND otp_expire > NOW() AND otp_attempts < 3`,
      [user.users_id, otpDigest]
    );
    if (consumed.affectedRows !== 1) {
      return res.status(401).json({ error: 'OTP expired or already used. Please login again.' });
    }

    const finalToken = jwt.sign(
      {
        userId: user.users_id,
        email: user.email_id,
        role: user.role_id,
        verified: true,
      },
      secretKey,
      { expiresIn: '1h' }
    );

    const prevToken = activeSessionMap.get(user.users_id);
    if (prevToken) {
      tokenBlacklist.add(prevToken);
      tokenLastActive.delete(prevToken);
    }
    activeSessionMap.set(user.users_id, finalToken);
    tokenLastActive.set(finalToken, Date.now());

    return res.json({
      success: true,
      message: 'OTP verified successfully',
      token: finalToken,
      redirect: user.new_user === 1 ? 'newpassword' : 'dashboard'
    });
  } catch (err) {
    console.error('Error verifying login OTP:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
});


app.post('/change-password', async (req, res) => {
  const { oldPassword, newPassword, confirmPassword, userId } = req.body;

  // Check if the confirm password matches the new password
  if (newPassword !== confirmPassword) {
    return res.status(400).json({ msg: 'New password and confirm password do not match' });
  }

  // #7 Enforce password complexity server-side
  if (!isStrongPassword(newPassword)) {
    return res.status(400).json({
      msg: 'Password must be at least 15 characters and include uppercase, lowercase, number, and special character'
    });
  }

  try {
    // Fetch the user from the database
    connection.query('SELECT password FROM users WHERE users_id = ?', [userId], (err, results) => {
      if (err) {
        console.error('Database error:', err);
        return res.status(500).json({ msg: 'Server error' });
      }

      if (results.length === 0) {
        return res.status(404).json({ msg: 'User not found' });
      }

      const user = results[0];

      // Compare old password (assuming the password is stored hashed)
      bcrypt.compare(oldPassword, user.password, (err, isMatch) => {
        if (err) {
          console.error('Error comparing passwords:', err);
          return res.status(500).json({ msg: 'Error verifying old password' });
        }

        if (!isMatch) {
          return res.status(400).json({ msg: 'Old password is incorrect' });
        }

        // Check password history before hashing
        checkAndSavePasswordHistory(userId, newPassword)
          .then(() => {
            bcrypt.hash(newPassword, 10, (err, hashedPassword) => {
              if (err) {
                console.error('Error hashing new password:', err);
                return res.status(500).json({ msg: 'Error hashing new password' });
              }
              connection.query('UPDATE users SET password = ?, new_user = 0, password_last_updated = NOW() WHERE users_id = ?', [hashedPassword, userId], (err) => {
                if (err) {
                  console.error('Error updating password:', err);
                  return res.status(500).json({ msg: 'Error updating password' });
                }
                res.json({ msg: 'Password changed successfully' });
              });
            });
          })
          .catch((histErr) => {
            return res.status(400).json({ msg: histErr.message });
          });
      });
    });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ msg: 'Server error' });
  }
});

const getPasswordExpiryHandler = (req, res) => {
  const { userId } = req.params;

  const query = `SELECT password_last_updated FROM users WHERE users_id = ?`;

  connection.query(query, [userId], (err, results) => {
    if (err) {
      console.error("Error fetching password date:", err);
      return res.status(500).json({ error: "Database query error" });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    const passwordLastUpdated = new Date(results[0].password_last_updated);
    const currentDate = new Date();

    // difference in days
    const diffTime = Math.abs(currentDate - passwordLastUpdated);
    const diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays < 30) {
      return res.json({
        status: "valid",
        message: `Password expires in ${30 - diffDays} days`,
        daysLeft: 30 - diffDays,
      });
    } else {
      return res.json({
        status: "expired",
        message: "Password expired",
        daysLeft: 0,
      });
    }
  });
};

app.all('/api/password-expiry/:userId', allowOnlyMethods('GET'));
app.all('/password-expiry/:userId', allowOnlyMethods('GET'));
app.get('/api/password-expiry/:userId', getPasswordExpiryHandler);
app.get('/password-expiry/:userId', getPasswordExpiryHandler);

app.post('/LHO', (req, res) => {
  const { LHO_Name } = req.body;

  // Validate input
  if (!LHO_Name) {
    return res.status(400).json({ message: 'LHO_Name is required.' });
  }

  // Check if LHO_Name already exists in the database
  const checkLHOQuery = 'SELECT * FROM SiteDetails WHERE LHO_Name = ?';
  connection.query(checkLHOQuery, [LHO_Name], (err, results) => {
    if (err) {
      console.error('Error querying database:', err);
      return res.status(500).json({ message: 'Error checking LHO_Name in the database.' });
    }

    // If LHO_Name already exists, return an error response
    if (results.length > 0) {
      return res.status(400).json({ message: 'LHO_Name already exists. Duplicate entries are not allowed.' });
    }

    // If LHO_Name does not exist, proceed to insert the new entry
    const insertLHOQuery = 'INSERT INTO SiteDetails (LHO_Name) VALUES (?)';
    connection.query(insertLHOQuery, [LHO_Name], (err) => {
      if (err) {
        console.error('Error inserting data into MySQL:', err);
        return res.status(500).json({ message: 'Error inserting data into the database.' });
      }

      return res.status(201).json({ message: 'LHO added successfully', LHO_Name });
    });
  });
});

app.put('/add-atmid', requireRole(1), (req, res) => {
  const { LHO_Name, atm_id } = req.body;

  // Check if LHO_Name and atm_id are provided
  if (!LHO_Name || !atm_id) {
    return res.status(400).json({ error: 'LHO_Name and ATMID are required.' });
  }

  // Query the database to get the current list of ATMIDs for the given LHO_Name
  connection.query('SELECT ATMID FROM SiteDetails WHERE LHO_Name = ?', [LHO_Name], (err, results) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }

    // If no results are found, return an error message
    if (results.length === 0) {
      return res.status(404).json({ message: 'LHO_Name does not exist. Please add LHO_Name first.' });
    }

    try {
      // Get the ATMID field from the results
      const atmidsField = results[0].ATMID;
      let atmIdsArray = [];

      // Parse the ATMID field if it exists
      if (atmidsField) {
        try {
          atmIdsArray = JSON.parse(atmidsField);
        } catch (parseError) {
          console.error('Error parsing ATMID:', parseError.message);
          return res.status(500).json({ error: 'Error processing ATMID data.' });
        }
      }

      // Ensure atmIdsArray is an array
      if (!Array.isArray(atmIdsArray)) {
        atmIdsArray = [];
      }

      // Check if the provided atm_id is already in the list
      if (!atmIdsArray.includes(atm_id)) {
        // Add the new atm_id to the array
        atmIdsArray.push(atm_id);
        const updatedATMIDs = JSON.stringify(atmIdsArray);

        // Update the database with the new list of ATMIDs
        connection.query('UPDATE SiteDetails SET ATMID = ? WHERE LHO_Name = ?', [updatedATMIDs, LHO_Name], (updateErr) => {
          if (updateErr) {
            console.error('Database update error:', updateErr);
            return res.status(500).json({ error: 'Internal Server Error' });
          }

          res.status(200).json({ message: 'ATMID(s) updated successfully.' });
        });
      } else {
        res.status(200).json({ message: 'ATMID already exists in the list.' });
      }
    } catch (error) {
      console.error('Unexpected error:', error.message);
      res.status(500).json({ error: 'Unexpected error occurred.' });
    }
  });
});

app.get('/get-atmid/:name', (req, res) => {
  const { name } = req.params;

  connection.query('SELECT ATMID FROM SiteDetails WHERE LHO_Name = ?', [name], (err, results) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ error: 'Database query error.' });
    }

    if (results.length === 0) {
      return res.status(404).json({ message: 'LHO_Name not found.' });
    }

    let existingATMID = [];

    try {
      const atmidsField = results[0].ATMID;
      if (Array.isArray(atmidsField)) {
        existingATMID = atmidsField;
      } else if (typeof atmidsField === 'string') {
        existingATMID = JSON.parse(atmidsField);
      } else {
        throw new Error('Unexpected data type for ATMID');
      }
    } catch (parseError) {
      console.error('Error parsing ATMID:', parseError.message);
      existingATMID = [];
    }

    res.status(200).json({ LHO_Name: name, count: existingATMID.length, ATMIDs: existingATMID });
  });
});

app.get('/LHO', (req, res) => {
  // Query to fetch all LHO_Name entries and the count of ATMIDs associated with each LHO_Name
  const getAllLHOQuery = `
    SELECT LHO_Name, 
           JSON_LENGTH(ATMID) AS atm_count 
    FROM SiteDetails;
  `;

  connection.query(getAllLHOQuery, (err, results) => {
    if (err) {
      console.error('Error fetching data from MySQL:', err);
      return res.status(500).json({ message: 'Error retrieving data from the database.' });
    }

    // Prepare the response data
    const lhoList = results.map((row) => ({
      LHO_Name: row.LHO_Name,
      atm_count: row.atm_count
    }));

    // Return the list of LHO_Name with ATMID counts and the total count of LHO entries
    return res.status(200).json({
      count: lhoList.length,
      lhoList: lhoList
    });
  });
});

const getAtmListHandler = (req, res) => {
  const query = `SELECT atm_latest, atm_1, atm_2, atm_3, atm_4, atm_5 FROM H_surveillance.atm_list_new3;`;

  connection.query(query, (err, results) => {
    if (err) {
      console.error('Error fetching data from MySQL:', err);
      return res.status(500).json({ message: 'Error retrieving data from the database.' });
    } else {
      // Collect all non-null ATM IDs across every column into one unique flat list
      const seen = new Set();
      const allIds = [];
      for (const row of results) {
        for (const field of ['atm_latest', 'atm_1', 'atm_2', 'atm_3', 'atm_4', 'atm_5']) {
          const id = row[field];
          if (id && !seen.has(id)) {
            seen.add(id);
            allIds.push(id);
          }
        }
      }
      res.status(200).json({ atm_list_new3: allIds });
    }
  });
};

app.all('/atm-list', allowOnlyMethods('GET'));
app.all('/api/atm-list', allowOnlyMethods('GET'));
app.get('/atm-list', getAtmListHandler);
app.get('/api/atm-list', getAtmListHandler);

// Shared helper — fetches and returns the BuildINT site list without touching res/req.
const fetchBuildintSites = async () => {
  const url = process.env.BUILDINT_ALL_SITES;
  if (!url) throw new Error('BUILDINT_ALL_SITES env variable is not configured');

  const response = await retryAxios(() => axios.get(url, {
    headers: {
      'Accept': 'application/json, text/javascript, */*; q=0.01',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    },
    timeout: 30000
  }), { vendorName: 'BUILDINT' });

  const surveillanceData = response.data;

  console.log('BUILDINT fetchBuildintSites response structure:', {
    hasData: !!surveillanceData.Data,
    totalSite: surveillanceData.total_site,
    dataLength: surveillanceData.Data ? surveillanceData.Data.length : 0
  });

  if (!surveillanceData.Data || !Array.isArray(surveillanceData.Data)) {
    console.error('BUILDINT: No Data array found in response');
    throw new Error('Invalid BUILDINT response format');
  }

  const siteDetails = surveillanceData.Data.map((site) => ({
    ATM_ID: site.ATM_ID,
    unitname: site.unitName || 'N/A',
    city: site.city || 'N/A',
    state: site.state || 'N/A',
    SiteStatus: site.siteStatus || 'OFFLINE'
  }));

  console.log(`BUILDINT fetchBuildintSites: Processed ${siteDetails.length} sites`);
  return siteDetails;
};

app.get('/buildintSites', async (req, res) => {
  try {
    const siteDetails = await fetchBuildintSites();
    res.status(200).json(siteDetails);
  } catch (error) {
    console.error('Error fetching BuildINT sites:', error.message);
    res.status(500).json({ success: false, message: 'Failed to fetch BuildINT surveillance data' });
  }
});

app.get('/dashboardData', async (req, res) => {
  try {
    // Increase GROUP_CONCAT limit (safe to keep)
    await new Promise((resolve, reject) => {
      connection.query(
        'SET SESSION group_concat_max_len = 1000000;',
        (err) => (err ? reject(err) : resolve())
      );
    });

    /* ------------------------------------
       FETCH LHO + TOTAL LOCATIONS
       NEW TABLE: atm_list_new
    ------------------------------------ */
    const query = `
      SELECT 
        l.lho_id,
        l.lho_name,
        COUNT(a.id) AS total_locations
      FROM H_surveillance.LHO_list l
      LEFT JOIN atm_list_new3 a 
        ON l.lho_id = a.lho_id
      WHERE (l.is_deleted IS NULL OR l.is_deleted = 0)
      GROUP BY l.lho_id, l.lho_name
      ORDER BY l.lho_name;
    `;

    connection.query(query, (err, results) => {
      if (err) {
        console.error('Dashboard DB error:', err);
        return res.status(500).json({
          message: 'Error retrieving dashboard data'
        });
      }

      let totalLocations = 0;

      const lhoData = results.map(row => {
        totalLocations += row.total_locations;
        return row;
      });

      /* ------------------------------------
         FINAL RESPONSE FORMAT (UNCHANGED)
      ------------------------------------ */
      return res.status(200).json({
        totalLocations,
        lhoDetails: lhoData
      });
    });

  } catch (error) {
    console.error('Dashboard API error:', error);
    return res.status(500).json({
      message: 'Internal server error'
    });
  }
});

// app.get('/lho-list', async (req, res) => {
//   const { lho_id, atm_id } = req.query;
//   try {
//     await new Promise((resolve, reject) => {
//       connection.query('SET SESSION group_concat_max_len = 1000000;', (err) => {
//         if (err) {
//           console.error('Error setting session variable:', err);
//           reject(err);
//         } else {
//           resolve();
//         }
//       });
//     });

//     let query;
//     let queryParams;
//     if (req.query.lho_id) {
//       query += ' WHERE lho_id = ?';
//     }
//     if (lho_id) {
//       query = `
//       SELECT l.lho_id, l.lho_name, COUNT(a.atm_id) AS total_locations, 
//       GROUP_CONCAT(a.atm_id ORDER BY a.atm_id SEPARATOR ',') AS atm_ids
//       FROM H_surveillance.LHO_list l
//       JOIN atm_list_new3 a ON l.lho_id = a.lho_id
//       WHERE l.lho_id = ? AND (l.is_deleted IS NULL OR l.is_deleted != 1)
//       GROUP BY l.lho_id, l.lho_name;
//       `;
//       queryParams = [lho_id];
//     } else if (atm_id) {
//       query = `
//       SELECT l.lho_id, l.lho_name, COUNT(a.atm_id) AS total_locations, 
//       GROUP_CONCAT(a.atm_id ORDER BY a.atm_id SEPARATOR ',') AS atm_ids
//       FROM H_surveillance.LHO_list l
//       JOIN atm_list_new3 a ON l.lho_id = a.lho_id
//       WHERE ? IN (
//         a.atm_latest, a.atm_1, a.atm_2,
//         a.atm_3, a.atm_4, a.atm_5
//       )
//         AND (l.is_deleted IS NULL OR l.is_deleted != 1)
//       GROUP BY l.lho_id, l.lho_name;
//       `;
//       queryParams = [atm_id];
//     } else {
//       query = `
//       SELECT l.lho_id, l.lho_name, COUNT(a.atm_id) AS total_locations, 
//       GROUP_CONCAT(a.atm_id ORDER BY a.atm_id SEPARATOR ',') AS atm_ids
//       FROM H_surveillance.LHO_list l
//       LEFT JOIN atm_list_new3 a ON l.lho_id = a.lho_id
//       WHERE (l.is_deleted IS NULL OR l.is_deleted != 1)
//       GROUP BY l.lho_id, l.lho_name;
//       `;
//       queryParams = [];
//     }

//     connection.query(query, queryParams, async (err, results) => {
//       if (err) {
//         console.error('Error fetching data from MySQL:', err);
//         return res.status(500).json({ message: 'Error retrieving data from the database.' });
//       }

//       results = results.map((row) => ({
//         ...row,
//         atm_ids: row.atm_ids ? row.atm_ids.split(',') : []
//       }));

//       const axiosInstance = axios.create({
//         httpsAgent: new https.Agent({
//           rejectUnauthorized: false
//         })
//       });

//       const headers = { 'Content-Type': 'application/json', 'X-Password': 'thePass' };
//       let siteDetails = [],
//         siteDetails2 = [],
//         siteDetails3 = [],
//         siteDetails4 = [],
//         siteDetails5 = [],
//         siteDetails6 = [],
//         siteDetails7 = [];

//       try {
//         const apiResults = await Promise.allSettled([
//           axios.post(process.env.ITL_ALL_SITES, {}, { headers }),
//           axios.get(process.env.ANIKET_ALL_SITES),
//           axios.get(process.env.SECURENS_ALL_SITES),
//           axios.get('http://localhost:7668/buildintSites'),
//           axios.post(process.env.DFS_ALL_SITES, {}, { headers }),
//           axios.get(process.env.GLOBAL_ALL_SITES),
//           axiosInstance.post(process.env.CTS_ALL_SITES)
//         ]);

//         const [itlApiData, birdsIApiData, securanceApiData, buildintApiData, dfsApiData, globalApiData, ctsApiData] = apiResults.map(
//           (result) => (result.status === 'fulfilled' ? result.value : null)
//         );

//         if (birdsIApiData) siteDetails = JSON.parse(birdsIApiData.data);
//         if (itlApiData) siteDetails2 = itlApiData.data;
//         if (buildintApiData) siteDetails4 = buildintApiData.data;
//         if (dfsApiData) siteDetails5 = dfsApiData.data;
//         if (globalApiData) siteDetails6 = JSON.parse(globalApiData.data);
//         if (ctsApiData) siteDetails7 = ctsApiData.data.Data;
//         if (securanceApiData && Array.isArray(securanceApiData.data?.Data)) {
//           siteDetails3 = securanceApiData.data.Data.map(site => ({
//             ATM_ID: site.ATM_ID,
//             SiteStatus: site.Status?.toUpperCase() || 'NO DATA'
//           }));
//         } else {
//           siteDetails3 = [];
//         }

//         const allSiteDetails = [...siteDetails, ...siteDetails6];

//         const atmIdSet = new Set();
//         siteDetails3.forEach((site) => {
//           if (!atmIdSet.has(site.ATM_ID)) {
//             allSiteDetails.push({
//               ATM_ID: site.ATM_ID,
//               unitname: site.unitname || 'N/A',
//               city: site.city || 'N/A',
//               state: site.state || 'N/A',
//               SiteStatus: site.SiteStatus || 'NO DATA'
//             });
//             atmIdSet.add(site.ATM_ID);
//           }
//         });

//         siteDetails4.forEach((site) => {
//           if (!atmIdSet.has(site.ATM_ID)) {
//             allSiteDetails.push({
//               ATM_ID: site.ATM_ID,
//               unitname: site.unitname || 'N/A',
//               city: site.city || 'N/A',
//               state: site.state || 'N/A',
//               SiteStatus: site.SiteStatus || 'NO DATA'
//             });
//             atmIdSet.add(site.ATM_ID);
//           }
//         });

//         siteDetails2.forEach((site) => {
//           if (!atmIdSet.has(site.AtmID)) {
//             const lastCheckedTime = new Date(site.LastChecked);
//             const currentTime = new Date();
//             const timeDifference = (currentTime - lastCheckedTime) / 60000;
//             const status = timeDifference <= 14440 ? 'ONLINE' : 'OFFLINE';

//             allSiteDetails.push({
//               ATM_ID: site.AtmID,
//               unitname: site.BankName || 'N/A',
//               city: site.CityName || 'N/A',
//               state: site.StateName || 'N/A',
//               SiteStatus: status
//             });
//             atmIdSet.add(site.AtmID);
//           }
//         });

//         siteDetails5.forEach((site) => {
//           if (!atmIdSet.has(site.AtmID)) {
//             const lastCheckedTime = new Date(site.LastChecked);
//             const currentTime = new Date();
//             const timeDifference = (currentTime - lastCheckedTime) / 60000;
//             const status = timeDifference <= 14440 ? 'ONLINE' : 'OFFLINE';

//             allSiteDetails.push({
//               ATM_ID: site.AtmID,
//               unitname: site.BankName || 'N/A',
//               city: site.CityName || 'N/A',
//               state: site.StateName || 'N/A',
//               SiteStatus: status
//             });
//             atmIdSet.add(site.AtmID);
//           }
//         });

//         (siteDetails7 || []).forEach((site) => {
//           if (!atmIdSet.has(site.ATM_ID)) {
//             allSiteDetails.push({
//               ATM_ID: site.ATM_ID,
//               unitname: site.unitName || 'N/A',
//               city: site.city || 'N/A',
//               state: site.state || 'N/A',
//               SiteStatus: site.siteStatus || 'NO DATA'
//             });
//             atmIdSet.add(site.ATM_ID);
//           }
//         });

//         let totalLocations = 0;
//         let totalOnline = 0;
//         let totalOffline = 0;

//         const enrichedResults = results.map((lho) => {
//           let onlineCount = 0,
//             offlineCount = 0;

//           const atmData = lho.atm_ids.map((atm_id) => {
//             const siteDetail = allSiteDetails.find((site) => site.ATM_ID === atm_id);
//             const status = siteDetail ? siteDetail.SiteStatus : 'NO DATA';
//             if (status.toLowerCase() === 'online') {
//               onlineCount++;
//             } else if (status.toLowerCase() === 'offline' || status.toLowerCase() === 'no data') {
//               offlineCount++;
//             }

//             return {
//               atm_id,
//               siteName: siteDetail ? siteDetail.unitname : 'NO DATA',
//               city: siteDetail ? siteDetail.city : 'NO DATA',
//               state: siteDetail ? siteDetail.state : 'NO DATA',
//               status
//             };
//           });

//           const totalATMs = onlineCount + offlineCount;
//           const percentage = totalATMs ? ((onlineCount / totalATMs) * 100).toFixed(2) : '0.00';

//           totalLocations += lho.total_locations;
//           totalOnline += onlineCount;
//           totalOffline += offlineCount;

//           return {
//             ...lho,
//             onlineCount,
//             offlineCount,
//             percentage: parseFloat(percentage),
//             atm_data: atmData
//           };
//         });

//         const overallPercentage = totalLocations ? ((totalOnline / (totalOnline + totalOffline)) * 100).toFixed(2) : '0.00';

//         return res.status(200).json({
//           totalLocations,
//           totalOnline,
//           totalOffline,
//           totalPercentage: parseFloat(overallPercentage),
//           lhoDetails: enrichedResults
//         });
//       });
//     });
//   } catch (error) {
//     console.error('Error fetching data:', error);
//     return res.status(500).json({ message: 'Error retrieving data.' });
//   }
// });

app.get('/lho-list', async (req, res) => {
  try {
    /* 1️⃣ Latest snapshot time */
    const [latest] = await new Promise((resolve, reject) => {
      connection.query(
        `SELECT MAX(captured_at) AS latest_time FROM atm_status_history_test`,
        (err, rows) => err ? reject(err) : resolve(rows)
      );
    });

    if (!latest?.latest_time) {
      return res.json({
        totalLocations: 0,
        totalOnline: 0,
        totalOffline: 0,
        totalPercentage: 0,
        lhoDetails: []
      });
    }

    const snapshotTime = latest.latest_time;

    /* 2️⃣ Fetch ATM master */
    const atmRows = await new Promise((resolve, reject) => {
      connection.query(
        `
        SELECT
          a.lho_id,
          l.lho_name,
          a.atm_latest,
          a.atm_1,
          a.atm_2,
          a.atm_3,
          a.atm_4,
          a.atm_5,
          a.site_address,
          a.city,
          a.state
        FROM atm_list_new3 a
        JOIN LHO_list l ON l.lho_id = a.lho_id
        WHERE (l.is_deleted IS NULL OR l.is_deleted = 0)
        `,
        (err, rows) => err ? reject(err) : resolve(rows)
      );
    });

    /* 3️⃣ Fetch ATM statuses (ONE QUERY) */
    const statusRows = await new Promise((resolve, reject) => {
      connection.query(
        `
       SELECT h.atm_id, h.status
FROM atm_status_history_test h
JOIN (
  SELECT atm_id, MAX(captured_at) AS latest_time
  FROM atm_status_history_test
  GROUP BY atm_id
) t
  ON t.atm_id = h.atm_id
 AND t.latest_time = h.captured_at

        `,
        [snapshotTime],
        (err, rows) => err ? reject(err) : resolve(rows)
      );
    });

    /* 4️⃣ Build status map */
    const statusMap = new Map();
    statusRows.forEach(r => statusMap.set(r.atm_id, r.status));

    /* 5️⃣ Resolve priority & build response */
    const lhoMap = new Map();

    atmRows.forEach(row => {
      const atmPriority = [
        row.atm_latest,
        row.atm_1,
        row.atm_2,
        row.atm_3,
        row.atm_4,
        row.atm_5
      ].filter(v => v && v !== '#N/A');

      let status = 'OFFLINE';
      for (const atm of atmPriority) {
        if (statusMap.get(atm) === 'ONLINE') {
          status = 'ONLINE';
          break;
        }
      }

      if (!lhoMap.has(row.lho_id)) {
        lhoMap.set(row.lho_id, {
          lho_id: row.lho_id,
          lho_name: row.lho_name,
          total_locations: 0,
          onlineCount: 0,
          offlineCount: 0,
          atm_data: []
        });
      }

      const lho = lhoMap.get(row.lho_id);

      lho.total_locations++;
      status === 'ONLINE' ? lho.onlineCount++ : lho.offlineCount++;

      lho.atm_data.push({
        atm_id: row.atm_latest || row.atm_1 || '-',
        atm_latest: row.atm_latest || '-',
        atm_1: row.atm_1 || '-',
        atm_2: row.atm_2 || '-',
        atm_3: row.atm_3 || '-',
        atm_4: row.atm_4 || '-',
        atm_5: row.atm_5 || '-',
        siteName: row.site_address || 'N/A',
        city: row.city || 'N/A',
        state: row.state || 'N/A',
        status
      });
    });

    const lhoDetails = Array.from(lhoMap.values()).map(lho => ({
      ...lho,
      percentage:
        lho.total_locations > 0
          ? Number(((lho.onlineCount / lho.total_locations) * 100).toFixed(2))
          : 0
    }));

    /* 6️⃣ Totals */
    const totals = lhoDetails.reduce(
      (acc, l) => {
        acc.totalLocations += l.total_locations;
        acc.totalOnline += l.onlineCount;
        acc.totalOffline += l.offlineCount;
        return acc;
      },
      { totalLocations: 0, totalOnline: 0, totalOffline: 0 }
    );

    return res.json({
      ...totals,
      totalPercentage:
        totals.totalLocations > 0
          ? Number(((totals.totalOnline / totals.totalLocations) * 100).toFixed(2))
          : 0,
      lhoDetails
    });

  } catch (err) {
    console.error('LHO list optimized error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});




// Initialize cache table
app.get('/init-live-view-cache', (req, res) => {
  
    res.json({ success: true, message: 'Cache table initialized' });

});

// Helper function to update cache
const updateLiveViewCache = (atmId, vendorId, responseData) => {
  if (!atmId) {
    console.warn('Skipping cache update: atmId is null or undefined');
    return;
  }

  // Don't cache a response where every camera is null and no liveViewLink — the DVR is likely
  // offline and stale nulls would block real data for 24 hours once cached.
  const cameraKeys = ['camera_1', 'camera_2', 'camera_3', 'camera_4'];
  const hasAnyCamera = cameraKeys.some(k => responseData[k]);
  const hasLiveViewLink = !!responseData.liveViewLink;
  if (!hasAnyCamera && !hasLiveViewLink) {
    console.warn(`Skipping cache update for ATM ${atmId}: all camera URLs are null (DVR may be offline)`);
    return;
  }
  
  const cacheQuery = `
    INSERT INTO live_view_cache 
    (atm_id, vendor_id, site_name, city, state, camera_1, camera_2, camera_3, camera_4, response_data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
    vendor_id = VALUES(vendor_id),
    site_name = VALUES(site_name),
    city = VALUES(city),
    state = VALUES(state),
    camera_1 = VALUES(camera_1),
    camera_2 = VALUES(camera_2),
    camera_3 = VALUES(camera_3),
    camera_4 = VALUES(camera_4),
    response_data = VALUES(response_data),
    last_updated = CURRENT_TIMESTAMP
  `;
  
  connection.query(
    cacheQuery,
    [
      atmId,
      vendorId,
      responseData.siteName || null,
      responseData.city || null,
      responseData.state || null,
      responseData.camera_1 || null,
      responseData.camera_2 || null,
      responseData.camera_3 || null,
      responseData.camera_4 || null,
      JSON.stringify(responseData)
    ],
    (err) => {
      if (err) {
        console.error('Error updating cache:', err);
      } else {
        console.log(`Cache updated for ATM: ${atmId}`);
      }
    }
  );
};

app.post('/live-view-links', async (req, res) => {
  const { atmId } = req.query;
  let cacheServed = false;

  try {
    // Check cache first
    const cacheQuery = `SELECT * FROM live_view_cache WHERE atm_id = ?`;
    connection.query(cacheQuery, [atmId], (cacheErr, cacheResult) => {
      if (!cacheErr && cacheResult && cacheResult.length > 0) {
        const cachedData = cacheResult[0];
        const cacheAge = Date.now() - new Date(cachedData.last_updated).getTime();
        
        // CTS HLS URLs are temporary and Securens snapshots change on every
        // request. Always request fresh data for these vendors.
        const isCtsStream = Number(cachedData.vendor_id) === 7;
        const isSecurensSnapshot = Number(cachedData.vendor_id) === 3;

        // If cache is less than 24 hours old, serve it immediately (except CTS)
        if (!isCtsStream && !isSecurensSnapshot && cacheAge < 1440 * 60 * 1000) {
          console.log(`Serving cached data for ATM: ${atmId} (age: ${Math.floor(cacheAge / 1000)}s)`);
          cacheServed = true;
          
          // Parse and send cached response
          const cachedResponse = typeof cachedData.response_data === 'string' 
            ? JSON.parse(cachedData.response_data) 
            : cachedData.response_data;
          res.status(200).json(cachedResponse);
          
          // Fetch fresh data in background to update cache
          console.log(`Updating cache in background for ATM: ${atmId}`);
          fetchFreshData(atmId).catch(err => {
            console.error('Background cache update failed:', err.message);
          });
          return;
        }
      }
      
      // No cache or expired - fetch fresh data
      if (!cacheServed) {
        fetchFreshData(atmId)
          .then(data => {
            if (!res.headersSent) {
              res.status(200).json(data);
            }
          })
          .catch(error => {
            if (!res.headersSent) {
              console.error('Error fetching fresh data:', error.message);
              res.status(500).json({ message: error.message || 'Internal Server Error' });
            }
          });
      }
    });
  } catch (error) {
    console.error('Error in live-view-links:', error);
    if (!res.headersSent) {
      res.status(500).json({ message: 'Internal Server Error' });
    }
  }
});

// Helper function to fetch fresh data
const fetchFreshData = async (atmId) => {
  return new Promise((resolve, reject) => {
    const vendorQuery = `SELECT vendor, atm_1, atm_2, atm_3, atm_4, atm_5 FROM H_surveillance.atm_list_new3 WHERE atm_latest = ?;`;
    const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    connection.query(vendorQuery, [atmId], async (err, result) => {
      if (err) {
        console.error('Error fetching data from MySQL:', err);
        return reject(new Error('Error fetching data from the database.'));
      }

      if (result.length === 0) {
        return reject(new Error('Vendor not found in the database.'));
      }

      const vendorId = result[0].vendor;
      const altAtmIds = [result[0].atm_1, result[0].atm_2, result[0].atm_3, result[0].atm_4, result[0].atm_5].filter(Boolean);
      console.log('Vendor ID:', vendorId);

      const generateHLS = async (payload) => {
        console.log('Generate HLS:', payload);
        try {
          // This is already server-side code; call the converter directly.
          // Calling our protected HTTP endpoint internally omitted the user's
          // JWT and could fail with 401 before FFmpeg was ever started.
          startRtspToHls(payload.rtspUrl, payload.cameraId, payload.atmId);
          return { success: true };
        } catch (error) {
          console.error(`Error: ${error.message}`);
          throw new Error(`Error: ${error.message}`);
        }
      };

      // Vendor: Aniket
      if (vendorId === 1) {
        try {
          // Try atm_latest first, then fall back to alternate IDs stored in the DB
          const idsToTry = [atmId, ...altAtmIds];

          // Aniket API returns double-encoded JSON: HTTP body is a JSON string
          // containing another JSON string. axios parses the outer layer, leaving
          // an inner string that must be JSON.parsed again.
          const parseAniketResponse = (raw) => {
            let data = raw;
            if (typeof data === 'string') {
              if (!data) return [];
              try { data = JSON.parse(data); } catch (e) { return []; }
            }
            if (!Array.isArray(data)) return [];
            return data.filter(d => d && d.ATM_ID && d.result !== 'fail');
          };

          const aniketStreamEndpoints = [
            process.env.ANIKET_LIVE_STREAM,
            process.env.ANIKET_LIVE_STREAM_FALLBACK
          ].filter((url, index, list) => url && list.indexOf(url) === index);

          const fetchAniketStream = async (id) => {
            for (const baseUrl of aniketStreamEndpoints) {
              try {
                const response = await axios({
                  method: 'get',
                  url: `${baseUrl}${encodeURIComponent(id)}`,
                  timeout: 30000
                });
                const parsed = parseAniketResponse(response.data);
                if (parsed.length > 0) {
                  console.log(`Aniket live stream found for ${id} via ${new URL(baseUrl).hostname}`);
                  return parsed;
                }
              } catch (error) {
                console.warn(`Aniket endpoint failed for ${id}:`, error.code || error.message);
              }
            }
            return [];
          };

          const fetchAniketSite = async (id) => {
            const response = await axios({
              method: 'get',
              url: `${process.env.ANIKET_SINGLE_SITES}${id}`,
              timeout: 30000
            });
            let data = response.data;
            if (typeof data === 'string') {
              if (!data) return [];
              try { data = JSON.parse(data); } catch (e) { return []; }
            }
            return Array.isArray(data) ? data.filter(d => d && d.result !== 'fail') : [];
          };

          // Try each ID until one returns data
          let siteDetails = null;
          let usedId = atmId;
          for (const id of idsToTry) {
            try {
              const data = await fetchAniketStream(id);
              if (data && data.length > 0) {
                siteDetails = data;
                usedId = id;
                console.log(`Aniket: found data using ID ${id}`);
                break;
              }
              console.log(`Aniket: no data for ID ${id}, trying next`);
            } catch (e) {
              console.error(`Aniket live stream error for ID ${id}:`, e.code || e.message);
            }
          }

          if (!siteDetails || siteDetails.length === 0) {
            console.error('No data returned from Aniket API for ATM:', atmId, '(tried:', idsToTry.join(', ') + ')');
            reject(new Error(`ATM not configured for live view in Aniket API (tried IDs: ${idsToTry.join(', ')})`));
            return;
          }

          const allSites = await fetchAniketSite(usedId);

          const data = siteDetails[0];
          const atmIdFromApi = data.ATM_ID;

          if (!atmIdFromApi) {
            console.error('ATM_ID field missing in Aniket API response for ATM:', atmId);
            reject(new Error('Invalid ATM data received from Aniket API'));
            return;
          }

          const cameras = Object.keys(data)
            .filter((key) => key.toLowerCase().startsWith('camera'))
            .reduce((obj, key, index) => {
              if (index < 4) {
                obj[`camera_${index + 1}`] = data[key];
              }
              return obj;
            }, {});

          const responseObj = {
            vendorId: vendorId,
            atmId: atmIdFromApi,
            siteName: allSites?.[0]?.unitname || 'Unknown',
            city: allSites?.[0]?.city || 'Unknown',
            state: allSites?.[0]?.state || 'Unknown',
            ...cameras
          };

          console.log(responseObj);

          const camerasPayload = Object.keys(responseObj)
            .filter((key) => key.startsWith('camera_'))
            .map((cameraKey) => ({ cameraId: cameraKey, rtspUrl: responseObj[cameraKey] }));

          camerasPayload.forEach((camera) => {
            generateHLS({ atmId: atmIdFromApi, cameraId: camera.cameraId, rtspUrl: camera.rtspUrl });
          });

          updateLiveViewCache(atmIdFromApi, vendorId, responseObj);
          resolve(responseObj);
        } catch (error) {
          console.error('Error in Aniket live view link api:', error.message);
          reject(error);
        }
      }
      // Vendor: ITL
      else if (vendorId === 2) {
        try {
          // Read data from Excel with password protection
          const workbook = await xlsxPopulate.fromFileAsync('AllCamPassword.xlsx', { password: process.env.EXCEL_PASSWORD });
          // Get the sheet by name
          const sheet = workbook.sheet('Sheet1');
          // Read all data in the sheet (starting from A1)
          const excelData = sheet.usedRange().value();
          // console.log(excelData);

          // Fetch ITL API data
          const itlApiData = await axios.post(
            process.env.ITL_ALL_SITES,
            {},
            {
              headers: {
                'Content-Type': 'application/json',
                'X-Password': 'thePass'
              }
            }
          );
          const itlSites = itlApiData.data;

          // Store unique ATM IDs
          const atmIdSet = new Set();
          const siteDetails = [];

          // Parse ITL data and extract required fields
          itlSites.forEach((site) => {
            if (!atmIdSet.has(site.AtmID) && site.CameraName === '2 Way') {
              siteDetails.push({
                ATM_ID: site.AtmID,
                cameraId: site.CameraID || 'N/A',
                siteName: site.BankName || 'No Data',
                city: site.CityName || 'No Data',
                state: site.StateName || 'No Data'
              });
              atmIdSet.add(site.AtmID);
            }
          });

          // Find the matching site based on atmId
          const matchedSite = siteDetails.find((site) => site.ATM_ID === atmId);
          console.log(matchedSite);

          if (matchedSite) {
            // Find corresponding camera password from Excel
            const excelEntry = excelData.find((row) => row[2] === matchedSite.cameraId);
            console.log(excelEntry);
            const password = excelEntry ? excelEntry[4] : '';

            const payload = {
              camId: matchedSite.cameraId,
              username: 'admin',
              password: password
            };

            console.log({ ...payload, password });

            const payloadObj = {
              camId: matchedSite.cameraId
            };

            // Set up HTTPS Agent to skip SSL certificate validation
            const agent = new https.Agent({
              rejectUnauthorized: false
            });

            // Stop the previous stream
            const stopProcess = await axios.post(process.env.ITL_STOP_PROCESS, payloadObj, {
              headers: {
                'Content-Type': 'application/json'
              },
              httpsAgent: agent
            });

            console.log('Response from stopping process ITL:', stopProcess.data);

            // Retry mechanism for starting stream
            const maxRetries = 3;
            let attempts = 0;
            let success = false;
            let response;

            while (attempts < maxRetries && !success) {
              try {
                attempts++;
                response = await axios.post(process.env.ITL_START_PROCESS, payload, {
                  headers: {
                    'Content-Type': 'application/json'
                  },
                  httpsAgent: agent
                });
                success = true;
                console.log(`Successfully generated stream on attempt ${attempts}: ${response.data.url}`);
              } catch (error) {
                console.log(`Attempt ${attempts} failed: ${error.message}`);
                if (attempts >= maxRetries) {
                  console.log('Max retries reached, failing the request.');
                  reject(new Error('Failed to start stream after multiple attempts'));
                  return;
                }
                await delay(500 * attempts);
              }
            }

            if (success) {
              const responseObj = { vendorId: vendorId, ...matchedSite, liveViewLink: response.data.url };
              // Update cache before sending response
              updateLiveViewCache(atmId, vendorId, responseObj);
              resolve(responseObj);
            }
          } else {
            console.log(`ATM ID not found in ITL API data`);
            reject(new Error('ATM ID not found in ITL API data'));
          }
        } catch (error) {
          if (error.response && error.response.data) {
            console.log('Error fetching data from ITL API:', error.response.data);
            reject(new Error(`Error fetching data from ITL API: ${error.response.data.message || error.response.data}`));
          } else if (error.message) {
            console.log('Error message:', error.message);
            reject(error);
          } else {
            console.log('Unknown error occurred');
            reject(new Error('Unknown error occurred'));
          }
        }
      }
      // Vendor: DFS — same flow as ITL (vendor 2) but uses DFS_ALL_SITES
      else if (vendorId === 5) {
        try {
          const workbook = await xlsxPopulate.fromFileAsync('AllCamPassword.xlsx', { password: process.env.EXCEL_PASSWORD });
          const sheet = workbook.sheet('Sheet1');
          const excelData = sheet.usedRange().value();

          const dfsApiData = await axios.post(
            process.env.DFS_ALL_SITES,
            {},
            { headers: { 'Content-Type': 'application/json', 'X-Password': 'thePass' } }
          );
          const dfsSites = dfsApiData.data;

          const atmIdSet = new Set();
          const siteDetails = [];
          dfsSites.forEach((site) => {
            if (!atmIdSet.has(site.AtmID) && site.CameraName === '2 Way') {
              siteDetails.push({
                ATM_ID: site.AtmID,
                cameraId: site.CameraID || 'N/A',
                siteName: site.BankName || 'No Data',
                city: site.CityName || 'No Data',
                state: site.StateName || 'No Data'
              });
              atmIdSet.add(site.AtmID);
            }
          });

          const matchedSite = siteDetails.find((site) => site.ATM_ID === atmId);
          if (!matchedSite) {
            reject(new Error('ATM ID not found in DFS API data'));
            return;
          }

          const excelEntry = excelData.find((row) => row[2] === matchedSite.cameraId);
          const password = excelEntry ? excelEntry[4] : '';
          const payload = { camId: matchedSite.cameraId, username: 'admin', password };
          const payloadObj = { camId: matchedSite.cameraId };
          const agent = new https.Agent({ rejectUnauthorized: false });

          await axios.post(process.env.ITL_STOP_PROCESS, payloadObj, {
            headers: { 'Content-Type': 'application/json' }, httpsAgent: agent
          });

          const maxRetries = 3;
          let attempts = 0, success = false, response;
          while (attempts < maxRetries && !success) {
            try {
              attempts++;
              response = await axios.post(process.env.ITL_START_PROCESS, payload, {
                headers: { 'Content-Type': 'application/json' }, httpsAgent: agent
              });
              success = true;
            } catch (error) {
              if (attempts >= maxRetries) { reject(new Error('DFS: failed to start stream')); return; }
              await delay(500 * attempts);
            }
          }

          if (success) {
            const responseObj = { vendorId, ...matchedSite, liveViewLink: response.data.url };
            updateLiveViewCache(atmId, vendorId, responseObj);
            resolve(responseObj);
          }
        } catch (error) {
          console.error('Error in DFS live view:', error.message);
          reject(error);
        }
      }
      // Vendor: Securens — get DVR configuration from Securens, then request
      // Base64 snapshots from the HawkAI multi-stream images API.
      else if (vendorId === 3) {
        try {
          const securensUsername = process.env.SECURENS_USERNAME;
          const securensPassword = process.env.SECURENS_PASSWORD;
          const hawkaiImagesUrl = process.env.HAWKAI_MULTI_STREAM_IMAGES_URL ||
            'https://algoaiotapi.cms.com/multi_stream_images';
          const hawkaiApiToken = process.env.HAWKAI_API_TOKEN;

          if (!process.env.SECURENS_LOGIN || !process.env.SECURENS_SITE_LIST) {
            throw new Error('Securens login and site-list endpoints are not configured on the server.');
          }
          if (!securensUsername || !securensPassword) {
            throw new Error('Securens login credentials are not configured on the server.');
          }
          if (!hawkaiApiToken) {
            throw new Error('HawkAI snapshot API token is not configured on the server.');
          }

          const loginResponse = await axios.post(process.env.SECURENS_LOGIN, {
            email: securensUsername,
            password: securensPassword
          }, { headers: { 'Content-Type': 'application/json' }, timeout: 20000 });
          const token = loginResponse.data?.token;
          const service = loginResponse.data?.services?.[0];
          if (!token || !service) {
            throw new Error('Securens login response is missing its token or service identifier.');
          }

          const siteListUrl = `${process.env.SECURENS_SITE_LIST}${encodeURIComponent(service)}`;
          const siteListResponse = await axios.post(siteListUrl, {}, {
            headers: { Authorization: `Bearer ${token}` }, timeout: 30000
          });
          const sites = siteListResponse.data?.data;
          if (!Array.isArray(sites)) {
            throw new Error('Securens site-list response did not contain a site array.');
          }

          const matchedSite = sites.find(site => String(site.siteId) === String(atmId));
          const config = matchedSite?.site_config?.[0];
          if (!config) {
            throw new Error('ATM ID or DVR configuration was not found in the Securens site list.');
          }

          const cameraChannels = String(config.camera_num || '')
            .split(',').map(channel => channel.trim()).filter(Boolean).slice(0, 4);
          if (!cameraChannels.length) {
            throw new Error('Securens DVR configuration does not list any camera channels.');
          }

          // API 1 in the integration flow: the existing Securens login + site
          // list provides the ATM's DVR configuration. Preserve the vendor's
          // values and map them to HawkAI's documented field names.
          const dvrData = {
            dvrip: config.dvr_ip,
            dvrport: config.dvr_port || process.env.HAWKAI_DVR_PORT,
            support_port: config.support_port || process.env.HAWKAI_SUPPORT_PORT,
            username: config.dvr_user_id,
            password: config.dvr_password,
            dvrmodel: config.dvr_manufacturer,
            camera_channel: cameraChannels,
            methodforsnap: config.methodforsnap || 'SDK'
          };
          const missingDvrFields = ['dvrip', 'dvrport', 'support_port', 'username', 'password', 'dvrmodel']
            .filter(field => dvrData[field] === undefined || dvrData[field] === null || dvrData[field] === '');
          if (missingDvrFields.length) {
            throw new Error(`Securens DVR configuration is missing required HawkAI fields: ${missingDvrFields.join(', ')}.`);
          }

          // API 2: request all configured channels in one call. DVR credentials
          // stay server-side and are never included in the dashboard response.
          const imagesResponse = await axios.post(hawkaiImagesUrl, dvrData, {
            headers: {
              Authorization: `Bearer ${hawkaiApiToken}`,
              'Content-Type': 'application/json'
            },
            timeout: 45000,
            maxContentLength: 20 * 1024 * 1024,
            maxBodyLength: 2 * 1024 * 1024
          });
          const imagePayload = imagesResponse.data?.data ?? imagesResponse.data;
          const responseObj = {
            vendorId,
            siteId: matchedSite.siteId,
            siteName: matchedSite.address || matchedSite.siteName || null,
            city: matchedSite.city || null,
            state: matchedSite.state || null,
            cameraChannels
          };

          cameraChannels.forEach((channel, index) => {
            const image = imagePayload?.[channel] ?? imagePayload?.[`camera_${index + 1}`];
            if (typeof image === 'string' && image.length) {
              const safeDataUri = image.match(/^data:image\/(?:jpeg|png|webp|gif);base64,/i);
              if (safeDataUri) {
                responseObj[`camera_${index + 1}`] = image;
                return;
              }
              const mimeType = image.startsWith('/9j/') ? 'image/jpeg'
                : image.startsWith('iVBORw0KGgo') ? 'image/png'
                  : image.startsWith('UklGR') ? 'image/webp' : 'image/jpeg';
              responseObj[`camera_${index + 1}`] = `data:${mimeType};base64,${image}`;
            }
          });

          resolve(responseObj);
        } catch (tokenError) {
          const status = tokenError.response?.status;
          console.error('[Securens snapshot] Request failed:', status || tokenError.code || tokenError.message);
          reject(new Error(tokenError.response?.status === 401 || tokenError.response?.status === 403
            ? 'HawkAI snapshot API authorization failed. Check the server-side HawkAI token.'
            : tokenError.message || 'Failed to get Securens camera snapshots.'));
        }
      }
      // Vendor: BuildINT
      else if (vendorId === 4) {
        try {
          const streamDir = path.join(__dirname, 'assets', 'streams', atmId);

          if (!fs.existsSync(streamDir)) {
            fs.mkdirSync(streamDir, { recursive: true });
          } else {
            fs.rmSync(streamDir, { recursive: true, force: true });
            // const files = fs.readdirSync(streamDir);
            // files.forEach((file) => {
            //   const filePath = path.join(streamDir, file);
            //   if (fs.lstatSync(filePath).isFile()) {
            //     fs.unlinkSync(filePath);
            //   }
            // });
          }

          const allSites = await fetchBuildintSites();

          const matchedSite = allSites.find((site) => site.ATM_ID === atmId);

          if (!matchedSite) {
            console.log(`ATM ID not found in Buildint API data`);
            reject(new Error('ATM ID not found in Buildint API data'));
            return;
          }

          const buildintAPIData = async () => {
            try {
              const builintLiveView = process.env.BUILDINT_START_STREAM;
              let fullURL = `${builintLiveView}${atmId}`;
              const response = await axios({ method: 'get', url: fullURL, timeout: 30000 });
              return response.data;
            } catch (error) {
              const msg = error.response?.data || error.message;
              console.error('Error fetching data from Buildint live link API:', msg);
              throw new Error(`Failed to fetch Buildint stream: ${error.response?.status || error.message}`);
            }
          };
          const siteDetails = await buildintAPIData();

          console.log('BuildINT siteDetails:', JSON.stringify(siteDetails)?.substring(0, 200));

          const responseObj = {
            vendorId: vendorId,
            atmId: atmId,
            siteName: matchedSite.unitname,
            city: matchedSite.city,
            state: matchedSite.state
          };

          // Extract camera URLs from startStream response
          if (siteDetails && typeof siteDetails === 'object') {
            // Format A: { camera1: "url", camera2: "url", ... }
            Object.keys(siteDetails)
              .filter(k => /^camera\d*$/i.test(k))
              .slice(0, 4)
              .forEach((k, i) => { responseObj[`camera_${i + 1}`] = siteDetails[k]; });

            // Format B: { cameras: [ { url }, ... ] }
            if (Array.isArray(siteDetails.cameras)) {
              siteDetails.cameras.slice(0, 4).forEach((cam, i) => {
                responseObj[`camera_${i + 1}`] = cam.url || cam.rtspUrl || cam.hlsUrl || cam.stream_url || cam;
              });
            }

            // Format C: single stream { url: "..." }
            if (!responseObj.camera_1 && siteDetails.url) {
              responseObj.camera_1 = siteDetails.url;
            }
          }

          // BUILDINT uses a push model — its client POSTs HLS segments to /get-hls-streams.
          // If the startStream API returned no camera URLs, set the local HLS paths so the
          // frontend can poll /stream-status and play once segments arrive.
          for (let i = 1; i <= 4; i++) {
            if (!responseObj[`camera_${i}`]) {
              responseObj[`camera_${i}`] = `${PUBLIC_API_BASE}/streams/${atmId}/camera_${i}/output.m3u8`;
            }
          }

          console.log(responseObj);
          updateLiveViewCache(atmId, vendorId, responseObj);
          resolve(responseObj);
        } catch (error) {
          console.error('Error processing data:', error);
          reject(error);
        }
      }
      // Vendor: Global
      else if (vendorId === 6) {
        try {
          // Global, like Aniket, returns a JSON string containing the actual
          // JSON array. Axios parses only the outer HTTP JSON layer, so unwrap
          // string layers before reading camera/site fields.
          const parseGlobalResponse = (raw) => {
            let data = raw;
            for (let i = 0; i < 3 && typeof data === 'string'; i++) {
              if (!data.trim()) return [];
              try { data = JSON.parse(data); } catch (_) { return []; }
            }
            if (Array.isArray(data)) return data;
            if (Array.isArray(data?.Data)) return data.Data;
            if (Array.isArray(data?.data)) return data.data;
            return data && typeof data === 'object' ? [data] : [];
          };

          const globalAPIData = async () => {
            try {
              const liveViewlink = process.env.GLOBAL_LIVE_STREAM;
              let fullURL = `${liveViewlink}${atmId}`;
              const response = await axios({
                method: 'get',
                url: fullURL,
                timeout: 30000 // 30 seconds timeout
              });
              return parseGlobalResponse(response.data);
            } catch (error) {
              console.error('Error fetching Global live stream data:', error.code || error.message);
              throw new Error(`Global API error: ${error.code || error.message}`);
            }
          };

          const siteData = async () => {
            try {
              const liveViewlink = process.env.GLOBAL_SINGLE_SITES;
              let fullURL = `${liveViewlink}${atmId}`;
              const response = await axios({
                method: 'get',
                url: fullURL,
                timeout: 30000 // 30 seconds timeout
              });
              return parseGlobalResponse(response.data);
            } catch (error) {
              console.error('Error fetching Global site data:', error.code || error.message);
              throw new Error(`Global API error: ${error.code || error.message}`);
            }
          };

          const siteDetails = await globalAPIData();
          const allSites = await siteData();

          const parsedData = siteDetails;
          const matchedSite = allSites;

          if (parsedData && parsedData.length > 0) {
            const data = parsedData[0];
            const atmId = data.ATM_ID;

            const cameras = Object.keys(data)
              .filter((key) => key.toLowerCase().startsWith('camera'))
              .reduce((obj, key, index) => {
                if (index < 4) {
                  obj[`camera_${index + 1}`] = data[key];
                  return obj;
                } else {
                  return obj;
                }
              }, {});

            const responseObj = {
              vendorId: vendorId,
              atmId: atmId,
              siteName: matchedSite[0].unitname,
              city: matchedSite[0].city,
              state: matchedSite[0].state,
              ...cameras
            };

            console.log(responseObj);

            const camerasPayload = Object.keys(responseObj)
              .filter((key) => key.startsWith('camera_'))
              .map((cameraKey) => ({
                cameraId: cameraKey,
                rtspUrl: responseObj[cameraKey]
              }));

            const payload = {
              atmId: atmId,
              cameras: camerasPayload
            };

            console.log(payload);

            payload.cameras.forEach((camera) => {
              const data = {
                atmId: payload.atmId,
                cameraId: camera.cameraId,
                rtspUrl: camera.rtspUrl
              };
              generateHLS(data);
            });

            updateLiveViewCache(atmId, vendorId, responseObj);
            resolve(responseObj);
          } else {
            reject(new Error('ATM ID not found in Global API data'));
          }
        } catch (error) {
          console.error('Error in Global live view link api:', error.message);
          reject(error);
        }
      }
      // Vendor: CTS
      else if (vendorId === 7) {
        try {
          const ctsAPIData = async () => {
            try {
              const agent = new https.Agent({ rejectUnauthorized: false });
              const response = await axios({
                method: 'get',
                url: process.env.CTS_ALL_SITES,
                auth: {
                  username: process.env.CTS_USERNAME,
                  password: process.env.CTS_PASSWORD
                },
                httpsAgent: agent,
                timeout: 30000
              });
              // Filter to the specific ATM from the full list
              const allData = response.data?.Data || [];
              const match = allData.find(s => s.ATM_ID === atmId);
              return { Data: match ? [match] : [] };
            } catch (error) {
              console.error('Error fetching CTS site details:', error.code || error.message);
              throw new Error(`CTS API error: ${error.code || error.message}`);
            }
          };

          const allSitesData = async () => {
            try {
              const liveViewLink = process.env.CTS_LIVE_STREAM;
              const formData = new URLSearchParams();
              formData.append('atm_id', atmId);
              const agent = new https.Agent({
                rejectUnauthorized: false
              });

              const response = await axios({
                method: 'post',
                url: liveViewLink,
                headers: {
                  'Content-Type': 'application/x-www-form-urlencoded'
                },
                data: formData.toString(),
                httpsAgent: agent,
                timeout: 30000 // 30 seconds timeout
              });

              return response.data;
            } catch (error) {
              console.error('Error fetching CTS live stream data:', error.code || error.message);
              throw new Error(`CTS API error: ${error.code || error.message}`);
            }
          };

          const siteDetails = await ctsAPIData();

          if (siteDetails?.success === false) {
            throw new Error(siteDetails.message || 'CTS API error');
          }

          const siteData = siteDetails?.Data?.[0];
          console.log('CTS siteDetails:', JSON.stringify(siteData || {}).substring(0, 200));

          // Live stream API is queried separately; failure is non-fatal — site info
          // is still returned with empty camera fields until CTS_LIVE_STREAM is corrected.
          let allSites = [];
          try {
            allSites = await allSitesData();
            console.log('CTS allSites response:', JSON.stringify(allSites).substring(0, 200));
          } catch (liveViewErr) {
            console.warn(`CTS live-stream API unavailable for ${atmId} (check CTS_LIVE_STREAM in .env): ${liveViewErr.message}`);
          }

          // Extract camera URLs from result object
          const cameraResult = Array.isArray(allSites) && allSites[0]?.result ? allSites[0].result : {};

          // Validate that we have actual data
          if (!siteData || !siteData.ATM_ID) {
            throw new Error('ATM ID not found in CTS API - no data returned');
          }

          // Map camera URLs from cam1_url, cam2_url format to camera_1, camera_2 format
          const cameras = {};
          for (let i = 1; i <= 4; i++) {
            const camKey = `cam${i}_url`;
            if (cameraResult[camKey]) {
              cameras[`camera_${i}`] = cameraResult[camKey];
            }
          }

          const responseObj = {
            vendorId: vendorId,
            atmId: siteData.ATM_ID,
            siteName: siteData.unitName || 'N/A',
            city: siteData.city || 'N/A',
            state: siteData.state || 'N/A',
            ...cameras
          };

          // CTS creates HLS files asynchronously. Return every camera URL
          // immediately so one unavailable camera never blocks the others for
          // 30 seconds; the frontend retries each camera independently.

          console.log('CTS Final Response:', responseObj);

          updateLiveViewCache(atmId, vendorId, responseObj);
          resolve(responseObj);
        } catch (error) {
          console.error('Error in CTS live view link api:', error.message);
          reject(error);
        }
      }
      else {
        reject(new Error(`Vendor ${vendorId} is not configured for live view`));
      }
    });
  });
};

app.post('/atm-vendor', (req, res) => {
  const atmId = req.body.atmId;

  const query = `SELECT vendor FROM H_surveillance.atm_list_new3 WHERE atm_latest = ?;`;

  connection.query(query, [atmId], (err, result) => {
    if (err) {
      console.error('Error fetching data from MySQL:', err);
      return res.status(500).json({ message: 'Error fetching data from the database.' });
    }
    if (result.length === 0) {
      return res.status(404).json({ message: 'Vendor not found in the database.' });
    }
    return res.status(200).json({ vendor: result[0].vendor });
  });
});

app.post('/add-lho', requireRole(1), (req, res) => {
  const { lho_name } = req.body;
  const query = `INSERT INTO H_surveillance.LHO_list (lho_name) values (?);`;

  connection.query(query, [lho_name], (err, results) => {
    if (err) {
      console.error('Error inserting data into MySQL:', err);
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({ message: 'LHO Name already exists in the database.' });
      }
      return res.status(500).json({ message: 'Error inserting data into the database.' });
    }
    return res.status(201).json({ message: 'LHO added successfully', lho_id: results.insertId });
  });
});

app.post('/add-atm', requireRole(1), (req, res) => {
  const { atmId, lho_id } = req.body;

  const query = `
    INSERT INTO H_surveillance.atm_list_new3 (atm_id, lho_id) VALUES (?, ?)
  `;

  connection.query(query, [atmId, lho_id], (error, result) => {
    if (error) {
      if (error.code === 'ER_DUP_ENTRY') {
        // If there's a duplicate entry, fetch the LHO name of the existing ATM ID
        const fetchLHOQuery = `
          SELECT l.lho_id, l.lho_name 
          FROM H_surveillance.atm_list_new3 a 
          JOIN H_surveillance.LHO_list l ON a.lho_id = l.lho_id 
          WHERE a.atm_id = ?;
        `;

        connection.query(fetchLHOQuery, [atmId], (fetchError, fetchResult) => {
          if (fetchError) {
            console.error('Error fetching LHO data:', fetchError.message);
            return res.status(500).json({ message: 'Error fetching LHO data from the database.' });
          }
          if (fetchResult.length > 0) {
            return res.status(409).json({ message: `ATM ID already exists in ${fetchResult[0].lho_name}` });
          } else {
            return res.status(404).json({ message: 'ATM ID exists but no matching LHO found.' });
          }
        });
      } else {
        return res.status(500).json({ message: 'Error inserting data into the database.' });
      }
    } else {
      return res.status(201).json({ message: 'ATM added successfully' });
    }
  });
});

app.get('/Role', async (req, res) => {
  try {
    // Query the database to get all users
    connection.query('SELECT role_name FROM role', (err, results) => {
      if (err) {
        console.error('Database query error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      // Return the user data as a JSON response
      return res.status(200).json(results);
    });
  } catch (error) {
    console.error('Error during fetching users:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/users', verifyToken, async (req, res) => {
  try {
    const isAdmin = Number(req.user.role) === 1;
    const query = isAdmin
      ? 'SELECT email_id, first_name, last_name, contact, role_id, users_id, login_attempts, is_active, is_delete, created_at FROM users'
      : 'SELECT email_id, first_name, last_name, contact, role_id, users_id, login_attempts, is_active, is_delete, created_at FROM users WHERE is_delete = 0 OR is_delete IS NULL';

    connection.query(query, (err, results) => {
      if (err) {
        console.error('Database query error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }
      return res.status(200).json(results);
    });
  } catch (error) {
    console.error('Error during fetching users:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});

app.get('/itl-dashboard', async (req, res) => {
  try {
    const headers = { 'Content-Type': 'application/json', 'X-Password': 'thePass' };
    let itlData = [];

    const fetchITLData = async () => {
      try {
        const itlApiData = await axios.post(process.env.ITL_ALL_SITES, {}, { headers });
        if (itlApiData) itlData = itlApiData.data;
      } catch (error) {
        console.error('Error fetching ITL data:', error);
      }
    };

    await fetchITLData();

    let totalLocations = 0, totalOnline = 0, totalOffline = 0;

    const processedITLData = itlData.map((site) => {
      const lastCheckedTime = new Date(site.LastChecked);
      const currentTime = new Date();
      const timeDifference = (currentTime - lastCheckedTime) / 60000;
      const status = timeDifference <= 14440 ? 'ONLINE' : 'OFFLINE';

      if (status === 'ONLINE') totalOnline++;
      else totalOffline++;

      totalLocations++;

      return {
        ATM_ID: site.AtmID,
        unitname: site.BankName || 'N/A',
        city: site.CityName || 'N/A',
        state: site.StateName || 'N/A',
        SiteStatus: status
      };
    });

    return res.status(200).json({
      totalLocations,
      totalOnline,
      totalOffline,
      atmDetails: processedITLData
    });
  } catch (error) {
    console.error('Error fetching ITL data:', error);
    return res.status(500).json({ message: 'Error retrieving ITL data.' });
  }
});

// app.delete('/users/:id', verifyToken, async (req, res) => {
//   const userIdToDelete = req.params.id;
//   const loggedInUser = req.user; // from middleware
//   if (loggedInUser.role !== "1") {
//     return res.status(403).json({ error: 'Unauthorized: Admins only can delete users' });
//   }

//   try {
//     connection.query('DELETE FROM users WHERE users_id = ?', [userIdToDelete], (err, result) => {
//       if (err) {
//         console.error('Database deletion error:', err);
//         return res.status(500).json({ error: 'Internal server error' });
//       }

//       if (result.affectedRows === 0) {
//         return res.status(404).json({ error: 'User not found' });
//       }

//       return res.status(200).json({ message: 'User deleted successfully' });
//     });
//   } catch (error) {
//     console.error('Error deleting user:', error);
//     return res.status(500).json({ error: 'Internal server error' });
//   }
// });

app.post('/users/:id', requireRole(1), async (req, res) => {
  // #2 Privilege Escalation: use userId from the verified JWT token, not a client-supplied header
  const userIdToDelete = req.params.id;
  const currentUserId = req.user.userId;

  if (!userIdToDelete) {
    return res.status(400).json({ error: 'User ID to delete is required' });
  }

  // Role is already enforced by requireRole(1) middleware above — no extra DB round-trip needed
  const deleteQuery = `
    UPDATE users
    SET is_delete = 1,
        is_active = 0,
        deleted_by = ?,
        deleted_at = NOW()
    WHERE users_id = ? AND (is_delete = 0 OR is_delete IS NULL)
  `;
  connection.query(deleteQuery, [currentUserId, userIdToDelete], (err2, result2) => {
    if (err2) {
      console.error('Error updating user:', err2);
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (result2.affectedRows === 0) {
      return res.status(404).json({ message: 'User not found or already deleted' });
    }

    res.json({ message: 'User deleted successfully' });
  });
});
// ================== GET SINGLE USER ==================
app.get('/users/:id', (req, res) => {
  const userId = req.params.id;

  const query = `
    SELECT users_id, first_name, last_name, email_id, contact, role_id, is_active, lho_id
    FROM users
    WHERE users_id = ? AND (is_delete IS NULL OR is_delete != 1)
  `;

  connection.query(query, [userId], (err, results) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }

    if (results.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.status(200).json(results[0]);
  });
});

// ================== UPDATE USER ==================
app.put('/users/:id', requireRole(1), (req, res) => {
  const userId = req.params.id;
  const { first_name, last_name, email_id, contact, role_id, is_active, lho_id } = req.body;
  const currentUserId = req.user.userId;

  if (!first_name || !last_name || !email_id || !contact || !role_id || ![0, 1].includes(Number(is_active))) {
    return res.status(400).json({
      error: 'first_name, last_name, email_id, contact, role_id, and valid status are required'
    });
  }

  const normalizedEmail = String(email_id).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
    return res.status(400).json({ error: 'A valid email address is required' });
  }

  // NULL represents all LHOs; a comma-separated value restricts visibility to
  // the selected LHOs. Administrators may also be assigned a specific LHO set.
  const normalizedLhoId = lho_id || null;

  const query = `
    UPDATE users
    SET first_name = ?,
        last_name = ?,
        email_id = ?,
        contact = ?,
        role_id = ?,
        is_active = ?,
        lho_id = ?,
        updated_by = ?,
        updated_at = NOW()
    WHERE users_id = ? AND (is_delete IS NULL OR is_delete != 1)
  `;

  connection.query(
    query,
    [String(first_name).trim(), String(last_name).trim(), normalizedEmail,
      String(contact).trim(), Number(role_id), Number(is_active), normalizedLhoId,
      currentUserId, userId],
    (err, result) => {
      if (err) {
        console.error('Error updating user:', err);
        if (err.code === 'ER_DUP_ENTRY') {
          return res.status(409).json({ error: 'Email ID is already used by another user' });
        }
        return res.status(500).json({ error: 'Database error' });
      }

      if (result.affectedRows === 0) {
        return res.status(404).json({ error: 'User not found or already deleted' });
      }

      return res.json({ message: 'User updated successfully' });
    }
  );
});
// Get all roles
app.get('/roles', async (req, res) => {
  try {
    const query = `
      SELECT role_id, role_name 
      FROM role
    `;

    connection.query(query, (err, results) => {
      if (err) {
        console.error('Database query error:', err);
        return res.status(500).json({ error: 'Internal server error' });
      }

      return res.status(200).json(results);
    });
  } catch (error) {
    console.error('Error during fetching roles:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
});
app.post('/delete-lho/:lho_id', requireRole(1), async (req, res) => {
  const { lho_id } = req.params;
  // const { deleted_by } = req.body; // userId from frontend

  if (!lho_id) {
    return res.status(400).json({ message: 'LHO ID is required.' });
  }

  // if (!deleted_by) {
  //   return res.status(400).json({ message: 'Deleted_by (userId) is required.' });
  // }

  try {
    const query = `
      UPDATE LHO_list
      SET is_deleted = 1,
          deleted_at = NOW()
      WHERE lho_id = ?;
    `;

    connection.query(query, [lho_id], (err, result) => {
      if (err) {
        console.error('Error deleting LHO:', err);
        return res.status(500).json({ message: 'Error deleting LHO.' });
      }

      return res.status(200).json({ message: 'LHO deleted successfully.' });
    });
  } catch (error) {
    console.error('Error in delete LHO API:', error);
    return res.status(500).json({ message: 'Internal server error.' });
  }
});
// update-lho API
app.put('/update-lho/:lho_id', requireRole(1), (req, res) => {
  const lhoId = req.params.lho_id;
  const { lho_name, userId } = req.body; // frontend should send userId

  if (!lho_name || !lhoId) {
    return res.status(400).json({ message: 'LHO ID and Name are required' });
  }

  // First, check if the name already exists for another LHO
  const checkQuery = `SELECT lho_id FROM LHO_list WHERE lho_name = ? AND lho_id != ? AND (is_deleted = 0 OR is_deleted IS NULL)`;
  connection.query(checkQuery, [lho_name, lhoId], (err, results) => {
    if (err) {
      console.error('Error checking LHO name:', err);
      return res.status(500).json({ message: 'Database error' });
    }

    if (results.length > 0) {
      return res.status(409).json({ message: 'LHO Name already exists' });
    }

    // Update LHO
    const updateQuery = `
      UPDATE LHO_list 
      SET lho_name = ?, updated_at = NOW(), updated_by = ? 
      WHERE lho_id = ? AND (is_deleted = 0 OR is_deleted IS NULL)
    `;
    connection.query(updateQuery, [lho_name, userId, lhoId], (err2, results2) => {
      if (err2) {
        console.error('Error updating LHO:', err2);
        return res.status(500).json({ message: 'Error updating LHO' });
      }

      if (results2.affectedRows === 0) {
        return res.status(404).json({ message: 'LHO not found or deleted' });
      }

      return res.status(200).json({ message: 'LHO updated successfully' });
    });
  });
});
app.put('/users/unlock/:id', requireRole(1), (req, res) => {
  const userId = req.params.id;

  const query = `
    UPDATE users
    SET login_attempts = 0
    WHERE users_id = ? AND (is_delete IS NULL OR is_delete != 1)
  `;

  connection.query(query, [userId], (err, result) => {
    if (err) {
      console.error('Error unlocking user:', err);
      return res.status(500).json({ error: 'Database error' });
    }

    if (result.affectedRows === 0) {
      return res.status(404).json({ error: 'User not found or already deleted' });
    }

    return res.json({ message: 'User login attempts reset successfully' });
  });
});

// GET /api/getLHOList
app.get('/api/getLHOList', (req, res) => {
  const query = 'SELECT lho_id, lho_name FROM LHO_list WHERE is_deleted = 0'; // optional filter if you have soft delete

  connection.query(query, (err, results) => {
    if (err) {
      console.error('Database query error:', err);
      return res.status(500).json({ error: 'Internal server error' });
    }

    // return array of objects: { lho_id, lho_name }
    res.json(results);
  });
});

// Get all levels
app.get('/levels', (req, res) => {
  connection.query('SELECT * FROM levels', (err, results) => {
    if (err) {
      console.error('Error fetching levels:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json(results);
  });
});

// Add new level
app.post('/add-levels', requireRole(1), (req, res) => {
  const { level, name, email, contact } = req.body;
  const query = 'INSERT INTO levels (level, name, email, contact) VALUES (?, ?, ?, ?)';
  connection.query(query, [level, name, email, contact], (err, result) => {
    if (err) {
      console.error('Error inserting level:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ message: 'Level added successfully', id: result.insertId });
  });
});

// Update level
app.put('/levels/:id', requireRole(1), (req, res) => {
  const { id } = req.params;
  const { level, name, email, contact } = req.body;
  const query = 'UPDATE levels SET level=?, name=?, email=?, contact=? WHERE id=?';
  connection.query(query, [level, name, email, contact, id], (err) => {
    if (err) {
      console.error('Error updating level:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ message: 'Level updated successfully' });
  });
});

// Delete level
app.delete('/levels/:id', requireRole(1), (req, res) => {
  const { id } = req.params;
  connection.query('DELETE FROM levels WHERE id=?', [id], (err) => {
    if (err) {
      console.error('Error deleting level:', err);
      return res.status(500).json({ error: 'Database error' });
    }
    res.json({ message: 'Level deleted successfully' });
  });
});

const escalationStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads', 'excel');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname); // avoid filename clash
  }
});

const uploadEscalation = multer({ storage: escalationStorage });

// Use the correct Multer instance here
app.post('/levels/upload-excel', requireRole(1), uploadEscalation.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    console.log('File uploaded at:', req.file.path);
    const workbook = XLSX.readFile(req.file.path);
    console.log('Workbook loaded, sheet:', workbook.SheetNames[0]);
    const sheetName = workbook.SheetNames[0];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    if (!data.length) {
      return res.status(400).json({ error: 'Excel file is empty' });
    }

    // Expecting columns: level, name, email, contact
    const values = data.map(row => [row.Level, row.Name, row.Email, row.Contact]);

    const sql = 'INSERT INTO levels (level, name, email, contact) VALUES ?';
    connection.query(sql, [values], (err, result) => {
      if (err) {
        console.error('DB Insert Error:', err);
        return res.status(500).json({ error: 'Failed to insert data into DB' });
      }
      res.json({ message: 'Excel data inserted successfully', inserted: result.affectedRows });
    });

  } catch (error) {
    console.error('Excel Upload Error:', error);
    res.status(500).json({ error: 'Invalid Excel file' });
  }
});

// Storage for Excel bulk user uploads
const excelStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads', 'excel');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, `${Date.now()}-${crypto.randomUUID()}.xlsx`);
  }
});
const uploadExcel = multer({
  storage: excelStorage,
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(String(file.originalname || '')).toLowerCase();
    const allowedMime = new Set([
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/octet-stream'
    ]);
    if (!['.xlsx', '.xls'].includes(ext) || !allowedMime.has(file.mimetype)) {
      return cb(new Error('Only Excel .xlsx or .xls files are allowed'));
    }
    cb(null, true);
  }
});

function validateExcelUpload(req, res, next) {
  if (!req.file) return res.status(400).json({ error: 'No Excel file uploaded' });
  try {
    const header = Buffer.alloc(8);
    const fd = fs.openSync(req.file.path, 'r');
    const bytesRead = fs.readSync(fd, header, 0, header.length, 0);
    fs.closeSync(fd);
    const isZipXlsx = bytesRead >= 4 && header.subarray(0, 4).equals(Buffer.from([0x50, 0x4B, 0x03, 0x04]));
    const isLegacyXls = bytesRead >= 8 && header.equals(Buffer.from([0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1]));
    if (!isZipXlsx && !isLegacyXls) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: 'Uploaded file is not a valid Excel workbook' });
    }
    next();
  } catch (err) {
    if (req.file?.path) fs.unlink(req.file.path, () => {});
    return res.status(400).json({ error: 'Unable to validate uploaded Excel file' });
  }
}

// Generate random password
function generatePassword(length = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789@#$!';
  return Array.from({ length }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

// Bulk Upload API
// Bulk Upload API
app.post('/bulk-upload-users', requireRole(1), uploadExcel.single('file'), validateExcelUpload, (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  const filePath = req.file.path;

  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    let inserted = 0, skipped = 0, errors = [];
    let index = 0;

    function processNextRow() {
      if (index >= rows.length) {
        // All rows processed, send response
        return res.json({ message: 'Bulk upload completed', inserted, skipped, errors });
      }

      const row = rows[index];
      index++;

      // Convert all fields to string to avoid Excel numbers issue
      const first_name = row['First Name'] ? String(row['First Name']).trim() : '';
      const last_name = row['Last Name'] ? String(row['Last Name']).trim() : '';
      const email_id = row['Email'] ? String(row['Email']).trim() : '';
      const contact = row['Contact'] ? String(row['Contact']).trim() : '';
      const roleText = row['Role'] ? String(row['Role']).trim() : '';
      const statusText = row['Active Status'] ? String(row['Active Status']).trim() : '';
      const lhoValue = row['LHO'] !== undefined && row['LHO'] !== null
        ? String(row['LHO']).trim() : '';

      // Map Role
      let role_id = roleText.toLowerCase() === 'admin' ? 1 :
        roleText.toLowerCase() === 'sub admin' ? 2 :
          roleText.toLowerCase() === 'user' ? 3 : undefined;

      // Map Active Status
      let is_active = statusText.toLowerCase() === 'active' ? 1 :
        statusText.toLowerCase() === 'inactive' ? 0 : undefined;

      // Validate required fields, including the LHO mapping.
      if (!first_name || !last_name || !email_id || !contact || !lhoValue || role_id === undefined || is_active === undefined) {
        errors.push({ email: email_id, reason: 'Invalid or missing required fields, including LHO' });
        return processNextRow();
      }

      // Resolve LHO by numeric ID or case-insensitive LHO name.
      const lhoLookup = /^\d+$/.test(lhoValue)
        ? 'SELECT lho_id FROM LHO_list WHERE lho_id = ? AND (is_deleted IS NULL OR is_deleted = 0)'
        : 'SELECT lho_id FROM LHO_list WHERE LOWER(TRIM(lho_name)) = LOWER(?) AND (is_deleted IS NULL OR is_deleted = 0)';
      connection.query(lhoLookup, [lhoValue], (lhoErr, lhoRows) => {
        if (lhoErr || !lhoRows.length) {
          errors.push({ email: email_id, reason: `LHO not found: ${lhoValue}` });
          return processNextRow();
        }
        const lho_id = Number(lhoRows[0].lho_id);

      // Check if email exists
      connection.query('SELECT users_id FROM users WHERE email_id = ?', [email_id], (err, results) => {
        if (err) {
          errors.push({ email: email_id, reason: 'DB check error' });
          return processNextRow();
        }

        if (results.length > 0) {
          skipped++;
          return processNextRow();
        }

        // Generate password
        const password = generatePassword();

        // Hash password (assuming hashPassword uses callback style)
        hashPassword(password)
          .then(hashedPassword => {
            // Insert into DB
            connection.query(
              `INSERT INTO users 
       (email_id, password, first_name, last_name, contact, role_id, lho_id, is_active, created_at) 
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
              [email_id, hashedPassword, first_name, last_name, contact, role_id, lho_id, is_active],
              (insertErr) => {
                if (insertErr) {
                  errors.push({ email: email_id, reason: insertErr.message });
                } else {
                  inserted++;

                  // Send email asynchronously
                  try {
                    sendMail(
                      email_id,
                      "software@buildint.co",
                      "Your Account Has Been Created",
                      `<p>Hi ${first_name},</p>
               <p>Your account has been successfully created.</p>
               <p><strong>Your password:</strong> ${password}</p>
               <p>Please change your password after logging in.</p>`
                    );
                  } catch (mailErr) {
                    console.error("Email error:", mailErr);
                  }
                }
                // Move to next row
                processNextRow();
              }
            );
          })
          .catch(hashErr => {
            errors.push({ email: email_id, reason: 'Hashing failed' });
            processNextRow();
          });
      });
      });
    }

    // Start processing rows
    processNextRow();

  } catch (error) {
    console.error('Bulk upload error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Storage for Excel bulk user uploads
const excelStorageData = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = path.join(__dirname, 'uploads', 'excel');
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir, { recursive: true });
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname); // avoid filename clash
  }
});
const uploadExcelData = multer({ storage: excelStorageData });
// ✅ Excel Upload + DB Update API
// ✅ Excel Upload + DB Update API
// ✅ API: Upload Excel and Update DB
app.post("/update-atm-data", requireRole(1), uploadExcelData.single("file"), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: "No file uploaded" });
  }

  const filePath = req.file.path;

  try {
    const workbook = xlsx.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const rows = xlsx.utils.sheet_to_json(workbook.Sheets[sheetName]);

    if (!rows.length) {
      fs.unlinkSync(filePath);
      return res.json({
        message: "No rows in Excel",
        updated: 0,
        notFoundCount: 0,
        notFoundAtms: [],
      });
    }

    let updatedCount = 0;
    let notFoundAtms = [];

    for (const row of rows) {
      // Clean and normalize Excel data
      const atm_id = (row["ATMID"] || row["atm_id"] || "")
        .toString()
        .replace(/\s+/g, "")
        .trim();

      const site_address = (row["Site Address"] || row["site_address"] || "")
        .toString()
        .trim();
      const city = (row["City"] || row["city"] || "").toString().trim();
      const state = (row["State"] || row["state"] || "").toString().trim();
      const pincode = row["pincode"] ? Number(row["pincode"]) : null;

      if (!atm_id) continue;

      console.log("Processing ATM ID:", atm_id);

      // Check if ATM exists
      const results = await new Promise((resolve, reject) => {
        connection.query(
          "SELECT atm_id FROM atm_list_test WHERE atm_id = ?",
          [atm_id],
          (err, results) => (err ? reject(err) : resolve(results))
        );
      }).catch((err) => {
        console.error("DB select error for ATM ID:", atm_id, err);
        return [];
      });

      if (results.length > 0) {
        // Update ATM record
        await new Promise((resolve, reject) => {
          connection.query(
            `UPDATE atm_list_test
             SET site_address = ?, city = ?, state = ?, pincode = ?, updated_at = NOW()
             WHERE atm_id = ?`,
            [site_address, city, state, pincode, atm_id],
            (err2, result) => (err2 ? reject(err2) : resolve(result))
          );
        })
          .then((result) => {
            if (result.affectedRows > 0) {
              updatedCount++;
              console.log("Updated ATM ID:", atm_id);
            } else {
              console.log("No change for ATM ID:", atm_id);
            }
          })
          .catch((err2) =>
            console.error("Update failed for ATM ID:", atm_id, err2)
          );
      } else {
        notFoundAtms.push(atm_id);
        console.log("ATM not found:", atm_id);
      }
    }

    fs.unlinkSync(filePath);

    res.json({
      message: "Update completed",
      updated: updatedCount,
      notFoundCount: notFoundAtms.length,
      notFoundAtms,
    });
  } catch (error) {
    console.error("Error processing file:", error);
    fs.unlinkSync(filePath);
    res.status(500).json({
      message: "Error processing file",
    });
  }
});

// GET /api/sitemaster
// GET /api/sitemaster - fetch all sites with LHO and Vendor names
app.get('/api/sitemaster', (req, res) => {
  const query = `
    SELECT 
    a.id,
    a.atm_latest,
    a.atm_1,
    a.atm_2,
    a.atm_3,
    a.atm_4,
    a.atm_5,
    a.lho_id,
    l.lho_name,
    a.vendor,
    v.vendor_name,
    a.site_address,
    a.city,
    a.state,
    a.pincode,
    a.is_active,
    a.created_at,
    a.updated_at
FROM atm_list_new3 a
LEFT JOIN LHO_list l 
    ON a.lho_id = l.lho_id
LEFT JOIN vendor v 
    ON a.vendor = v.vendor_id
WHERE 
    (a.is_deleted IS NULL OR a.is_deleted = 0)
ORDER BY a.id ASC;

  `;

  connection.query(query, (err, results) => {
    if (err) {
      console.error('Database error (sitemaster):', err);
      console.error('Database error (sitemaster):', err);
      return res.status(500).json({
        message: 'Database error while fetching Site Master data'
      });
    }

    // Normalize boolean for frontend
    const sites = results.map(row => ({
      ...row,
      is_active: !!row.is_active
    }));

    res.status(200).json({ sites });
  });
});

// === 2️⃣ Read Excel file ===

app.post('/add-site', requireRole(1), (req, res) => {
  const {
    atm_latest,
    atm_1,
    atm_2,
    atm_3,
    atm_4,
    atm_5,
    lho_id,
    is_active,
    vendor,
    site_address,
    city,
    state,
    pincode
  } = req.body;

  const suppliedAtmIds = [atm_latest, atm_1, atm_2, atm_3, atm_4, atm_5]
    .filter((value) => value !== null && value !== undefined && String(value).trim() !== '');
  if (!isValidAtmId(atm_latest) || suppliedAtmIds.some((value) => !isValidAtmId(value))) {
    return res.status(400).json({ message: 'ATM IDs may contain only letters, numbers, hyphens, and underscores.' });
  }
  if ([site_address, city, state].some(hasUnsafeMarkup)) {
    return res.status(400).json({ message: 'Site details contain unsupported characters.' });
  }

  if (
    !atm_latest ||
    !lho_id ||
    !vendor ||
    !site_address ||
    !city ||
    !state ||
    !pincode
  ) {
    return res.status(400).json({
      message: 'Missing required fields.'
    });
  }

  const query = `
    INSERT INTO atm_list_new3
    (
      atm_latest,
      atm_1,
      atm_2,
      atm_3,
      atm_4,
      atm_5,
      lho_id,
      is_active,
      vendor,
      site_address,
      city,
      state,
      pincode,
      created_at,
      updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
  `;

  const values = [
    atm_latest,
    atm_1 || null,
    atm_2 || null,
    atm_3 || null,
    atm_4 || null,
    atm_5 || null,
    lho_id,
    is_active ?? 1,
    vendor,
    site_address,
    city,
    state,
    pincode
  ];

  connection.query(query, values, (err, result) => {
    if (err) {
      console.error('MySQL Insert Error:', err);

      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          message: 'ATM already exists.'
        });
      }

      return res.status(500).json({
        message: 'Database error'
      });
    }

    return res.status(201).json({
      message: 'Site added successfully',
      id: result.insertId
    });
  });
});

app.get("/vendors", (req, res) => {
  const query = "SELECT vendor_id, vendor_name FROM vendor WHERE is_active = 1";
  connection.query(query, (err, results) => {
    if (err) { console.error('DB error (vendor list):', err); return res.status(500).json({ error: 'Internal server error' }); }
    res.json(results);
  });
});

// Get all active LHO list
app.get("/lho-list1", (req, res) => {
  const query = "SELECT lho_id, lho_name FROM LHO_list WHERE is_active = 1 AND is_deleted = 0";
  connection.query(query, (err, results) => {
    if (err) { console.error('DB error (lho-list1):', err); return res.status(500).json({ error: 'Internal server error' }); }
    res.json(results);
  });
});

app.post('/bulk-upload', requireRole(1), upload.single('file'), async (req, res) => {
  const filePath = req.file.path;
  let connection;

  try {
    connection = await mysql.createConnection(dbConfig);

    // Read Excel file
    const workbook = XLSX.readFile(filePath);
    const sheetName = workbook.SheetNames[0];
    const data = XLSX.utils.sheet_to_json(workbook.Sheets[sheetName]);

    const results = [];

    for (const row of data) {
      const {
        ATM_ID,
        LHO_NAME,
        STATUS,
        VENDOR_NAME,
        SITE_ADDRESS,
        CITY,
        STATE,
        PINCODE
      } = row;

      let remark = '';

      try {
        // Check LHO name
        const [lhoRows] = await connection.execute(
          'SELECT lho_id FROM lho WHERE lho_name = ?',
          [LHO_NAME]
        );

        if (lhoRows.length === 0) {
          remark = 'Failed - Invalid LHO';
          results.push({ ...row, Remark: remark });
          continue;
        }

        const lho_id = lhoRows[0].lho_id;

        // Check Vendor
        const [vendorRows] = await connection.execute(
          'SELECT vendor_id FROM vendor WHERE vendor_name = ?',
          [VENDOR_NAME]
        );

        if (vendorRows.length === 0) {
          remark = 'Failed - Invalid Vendor';
          results.push({ ...row, Remark: remark });
          continue;
        }

        const vendor_id = vendorRows[0].vendor_id;

        // Insert record
        await connection.execute(
          `INSERT INTO atm_list_new3 
            (atm_id, lho_id, is_active, created_at, updated_at, vendor, site_address, city, state, pincode)
           VALUES (?, ?, ?, NOW(), NOW(), ?, ?, ?, ?, ?)`,
          [
            ATM_ID,
            lho_id,
            STATUS === 'Active' ? 1 : 0,
            vendor_id,
            SITE_ADDRESS,
            CITY,
            STATE,
            PINCODE
          ]
        );

        remark = 'Success';
      } catch (err) {
        remark = 'Failed - DB Error';
        console.error('Insert error:', err);
      }

      results.push({ ...row, Remark: remark });
    }

    // 🔹 Create output Excel with "Remark" column
    const newSheet = XLSX.utils.json_to_sheet(results);
    const newBook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(newBook, newSheet, 'Results');

    const outputPath = path.join('uploads', `result_${Date.now()}.xlsx`);
    XLSX.writeFile(newBook, outputPath);

    // Send Excel file in response
    res.download(outputPath, 'bulk_upload_result.xlsx', (err) => {
      fs.unlinkSync(filePath); // remove uploaded file
      fs.unlinkSync(outputPath); // remove result file after sending
    });
  } catch (error) {
    console.error(error);
    if (connection) await connection.end();
    res.status(500).json({ message: 'Error processing bulk upload', error });
  }
});

// const https = require("https");
// const axios = require("axios");

// app.get("/api/get-atm-details", async (req, res) => {
//     try {
//         // DB QUERY
//         const dbData = await new Promise((resolve, reject) => {
//             connection.query(
//                 `SELECT a.atm_id, a.lho_id, l.lho_name, a.vendor, v.vendor_name,
//                         a.site_address, a.city, a.state, a.pincode
//                  FROM atm_list_new3 a
//                  LEFT JOIN LHO_list l ON a.lho_id = l.lho_id
//                  LEFT JOIN vendor v ON a.vendor = v.vendor_id`,
//                 (err, results) => {
//                     if (err) reject(err);
//                     else resolve(results);
//                 }
//             );
//         });

//         // ComfortTech API fix
//         const agent = new https.Agent({ rejectUnauthorized: false });

//         const apiResponse = await axios.post(
//             "https://103.141.218.146:8092/ComfortTechnoNew/api/get_atmid_details.php",
//             {},
//             { httpsAgent: agent }
//         );

//         const apiData = apiResponse.data.Data || [];

//         // Merge DB + API
//         const merged = dbData.map(db => {
//             const api = apiData.find(a => a.ATM_ID === db.atm_id);

//             const last = api?.lastDataReceived || '-';

//             return {
//                 LHO: db.lho_name,
//                 ATMID: db.atm_id,
//                 address: db.site_address,
//                 state: db.state,
//                 city: db.city,
//                 pincode: db.pincode,
//                 vendor: db.vendor_name,
//                 lastCommunication: last,
//                 ageing: last === '-' ? '-' : calculateAgeing(last)
//             };
//         });

//         res.json({ data: merged });

//     } catch (error) {
//         console.error("Error:", error);
//         res.status(500).json({ message: "Error", error });
//     }
// });
// app.get("/api/get-atm-details", async (req, res) => {
//   try {
//     const atm_id = req.query.atm_id || "";  // ⭐ GET atm_id FROM QUERY

//     // ================= DB DATA =================
//     const dbData = await new Promise((resolve, reject) => {
//       connection.query(
//         `
//         SELECT 
//           a.atm_latest,
//           a.atm_1,
//           a.atm_2,
//           a.atm_3,
//           a.atm_4,
//           a.atm_5,
//           a.lho_id,
//           l.lho_name,
//           a.vendor,
//           v.vendor_name,
//           a.site_address,
//           a.city,
//           a.state,
//           a.pincode
//         FROM atm_list_new3 a
//         LEFT JOIN LHO_list l ON a.lho_id = l.lho_id
//         LEFT JOIN vendor v ON a.vendor = v.vendor_id
//         WHERE a.is_active = 1
//         `,
//         (err, results) => (err ? reject(err) : resolve(results))
//       );
//     });

//     // ================= COMFORTTECH API =================
//     const agent = new https.Agent({ rejectUnauthorized: false });

//     const apiResponse = await axios.post(
//       `https://103.141.218.146:8092/ComfortTechnoNew/api/get_atmid_details.php?atm_id=${atm_id}`,
//       {},   // POST BODY EMPTY (as per screenshot)
//       { httpsAgent: agent }
//     );

//     const apiData = Array.isArray(apiResponse.data?.Data)
//       ? apiResponse.data.Data
//       : [];

//     // ================= MERGE BOTH =================
//     const merged = dbData.map(db => {
//       // API ATM matches DB ATM
//       const api = apiData.find(a => a.ATM_ID === db.atm_id);

//       const last = api?.lastDataReceived || "-";

//       return {
//         LHO: db.lho_name,

//         atm_latest: db.atm_latest,
//         atm_1: db.atm_1,
//         atm_2: db.atm_2,
//         atm_3: db.atm_3,
//         atm_4: db.atm_4,
//         atm_5: db.atm_5,

//         address: db.site_address,
//         state: db.state,
//         city: db.city,
//         pincode: db.pincode,
//         vendor: db.vendor_name,

//         vendorSource: "CTS",
//         status: "ONLINE",
//         lastCommunication: last,
//         ageing: last === "-" ? "-" : calculateAgeing(last)
//       };
//     });

//     res.json({ data: merged });

//   } catch (error) {
//     console.error("Error:", error);
//     res.status(500).json({ message: "Error", error });
//   }
// });
// app.get("/api/get-atm-details", async (req, res) => {
//   try {
//     const atm_id = req.query.atm_id || "";

//     /* ================= DATABASE DATA ================= */
//     const dbData = await new Promise((resolve, reject) => {
//       connection.query(
//         `
//         SELECT 
//           a.atm_latest,
//           a.atm_1,
//           a.atm_2,
//           a.atm_3,
//           a.atm_4,
//           a.atm_5,
//           a.lho_id,
//           l.lho_name,
//           a.vendor,
//           v.vendor_name,
//           a.site_address,
//           a.city,
//           a.state,
//           a.pincode
//         FROM atm_list_new3 a
//         LEFT JOIN LHO_list l ON a.lho_id = l.lho_id
//         LEFT JOIN vendor v ON a.vendor = v.vendor_id
//         WHERE a.is_active = 1
//         `,
//         (err, results) => (err ? reject(err) : resolve(results))
//       );
//     });

//     /* ================= CTS API ================= */
//     const agent = new https.Agent({ rejectUnauthorized: false });

//     const apiResponse = await axios.post(
//       `https://103.141.218.146:8092/ComfortTechnoNew/api/get_atmid_details.php?atm_id=${atm_id}`,
//       {},
//       { httpsAgent: agent }
//     );

//     const apiData = Array.isArray(apiResponse.data?.Data)
//       ? apiResponse.data.Data
//       : [];

//     /* ================= HELPER ================= */
//     const findCTSMatch = (atmList) => {
//       for (const atm of atmList) {
//         if (!atm) continue;
//         const match = apiData.find(a => a.ATM_ID === atm);
//         if (match) return match;
//       }
//       return null;
//     };

//     /* ================= MERGE DATA ================= */
//     const merged = dbData.map(db => {
//       const atmPriority = [
//         db.atm_latest,
//         db.atm_1,
//         db.atm_2,
//         db.atm_3,
//         db.atm_4,
//         db.atm_5
//       ];

//       const ctsMatch = findCTSMatch(atmPriority);
//       const last = ctsMatch?.lastDataReceived || "-";

//       return {
//         LHO: db.lho_name,

//         atm_latest: db.atm_latest,
//         atm_1: db.atm_1,
//         atm_2: db.atm_2,
//         atm_3: db.atm_3,
//         atm_4: db.atm_4,
//         atm_5: db.atm_5,

//         address: db.site_address,
//         state: db.state,
//         city: db.city,
//         pincode: db.pincode,
//         vendor: db.vendor_name,

//         vendorSource: "CTS",
//         status: "ONLINE",
//         lastCommunication: last,
//         ageing: last === "-" ? "-" : calculateAgeing(last)
//       };
//     });

//     res.json({ data: merged });

//   } catch (error) {
//     console.error("Error in get-atm-details:", error);
//     res.status(500).json({ message: "Error fetching ATM details", error });
//   }
// });

// ── Vendor API cache (refreshed every 5 minutes) ─────────────────────────────
let _vendorCache = null;
const VENDOR_CACHE_TTL_MS = 5 * 60 * 1000;

async function getVendorData(atm_id = '') {
  if (_vendorCache && (Date.now() - _vendorCache.fetchedAt) < VENDOR_CACHE_TTL_MS) {
    return _vendorCache;
  }

  const httpsAgent = new (require("https").Agent)({ rejectUnauthorized: false });

  const parseArrayPayload = (payload) => {
    if (Array.isArray(payload)) return payload;
    if (payload && Array.isArray(payload.Data)) return payload.Data;
    if (typeof payload === 'string') {
      try {
        const parsed = JSON.parse(payload);
        if (Array.isArray(parsed)) return parsed;
        if (parsed && Array.isArray(parsed.Data)) return parsed.Data;
      } catch (e) {
        return [];
      }
    }
    return [];
  };

  const getOptional = (url, config = {}) => {
    if (!url) return Promise.resolve({ data: [] });
    return axios.get(url, config);
  };

  const [ctsRes, icmsRes, securensRes, aniketRes, globalRes] = (await Promise.allSettled([
    axios.get(process.env.CTS_ALL_SITES, {
      auth: { username: process.env.CTS_USERNAME, password: process.env.CTS_PASSWORD },
      httpsAgent, timeout: 5000
    }),
    axios.get(`http://27.107.161.156:100/i-CMS/WebService.asmx/sitelist`, { timeout: 5000 }),
    http2Get(process.env.SECURENS_ALL_SITES, { timeoutMs: 10000 }),
    getOptional(process.env.ANIKET_ALL_SITES, { httpsAgent, timeout: 5000 }),
    getOptional(process.env.GLOBAL_ALL_SITES, { httpsAgent, timeout: 5000 })
  ])).map(r => r.status === 'fulfilled' ? r.value : null);

  if (!securensRes) console.warn('⚠️ SECURENS vendor API failed, skipping SECURENS data');
  if (!aniketRes) console.warn('⚠️ ANIKET vendor API failed, skipping ANIKET data');
  if (!globalRes) console.warn('⚠️ GLOBAL vendor API failed, skipping GLOBAL data');

  _vendorCache = {
    CTS_DATA:     Array.isArray(ctsRes?.data?.Data)  ? ctsRes.data.Data  : [],
    ICMS_DATA:    Array.isArray(icmsRes?.data?.Data) ? icmsRes.data.Data : [],
    SECURENS_DATA: parseArrayPayload(securensRes?.data),
    ANIKET_DATA:  parseArrayPayload(aniketRes?.data),
    GLOBAL_DATA:  parseArrayPayload(globalRes?.data),
    fetchedAt: Date.now()
  };
  return _vendorCache;
}

app.get("/get-atm-details", async (req, res) => {
  try {
    const search    = (req.query.search  || '').trim();
    const exportAll = req.query.export   === 'true';
    const page      = Math.max(1, parseInt(req.query.page)     || 1);
    const pageSize  = Math.min(100, Math.max(1, parseInt(req.query.pageSize) || 20));
    const offset    = (page - 1) * pageSize;

    /* ── Build WHERE + params (mirrors cron actualCounts filter) ── */
    let whereClause = `WHERE a.is_active = 1 AND (a.is_deleted IS NULL OR a.is_deleted != 1)`;
    const queryParams = [];

    if (search) {
      whereClause += ` AND (
        a.atm_latest LIKE ? OR a.atm_1 LIKE ? OR a.atm_2 LIKE ? OR
        a.atm_3 LIKE ? OR a.atm_4 LIKE ? OR a.atm_5 LIKE ? OR
        l.lho_name LIKE ? OR a.site_address LIKE ? OR
        a.city LIKE ? OR a.state LIKE ? OR v.vendor_name LIKE ?
      )`;
      const like = `%${search}%`;
      queryParams.push(like, like, like, like, like, like, like, like, like, like, like);
    }

    const baseFrom = `
      FROM atm_list_new3 a
      LEFT JOIN LHO_list l ON a.lho_id = l.lho_id
      LEFT JOIN vendor v ON a.vendor = v.vendor_id
      ${whereClause}
    `;

    /* ── Total row count ── */
    const [counts] = await new Promise((resolve, reject) =>
      connection.query(
        `SELECT COUNT(*) AS total ${baseFrom}`,
        queryParams,
        (err, r) => err ? reject(err) : resolve(r)
      )
    );
    const total = Number(counts.total);

    /* ── Load latest status per ATM into JS Map (max-per-ATM, same pattern as lho-list) ── */
    const statusMap = new Map();
    const statusRows = await new Promise((resolve, reject) =>
      connection.query(
        `SELECT h.atm_id, h.status
         FROM atm_status_history_test h
         JOIN (
           SELECT atm_id, MAX(captured_at) AS latest_time
           FROM atm_status_history_test
           GROUP BY atm_id
         ) t ON t.atm_id = h.atm_id AND t.latest_time = h.captured_at`,
        (err, r) => err ? reject(err) : resolve(r || [])
      )
    );
    statusRows.forEach(r => { if (r.atm_id) statusMap.set(r.atm_id, r.status); });

    /* ── Rule B: ATMs that were ONLINE at any point in the last 2 days ── */
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    const todayOnlineRows = await new Promise((resolve, reject) =>
      connection.query(
        `SELECT DISTINCT atm_id FROM atm_status_history_test WHERE status = 'ONLINE' AND captured_at >= ?`,
        [twoDaysAgo],
        (err, r) => err ? reject(err) : resolve(r || [])
      )
    );
    const todayOnlineSet = new Set(todayOnlineRows.map(r => r.atm_id));

    /* ── Buffer fallback: last known status for ATMs absent from current vendor snapshot ── */
    const bufferRows = await new Promise((resolve) =>
      connection.query(
        `SELECT atm_id, status FROM atm_last_known_status`,
        (err, r) => resolve(err ? [] : (r || []))
      )
    );
    const bufferMap = new Map(bufferRows.map(r => [r.atm_id, r.status]));

    /* ── Vendor data (cached) — needed for staleDays correction in both count loop and row builder ── */
    const { CTS_DATA, ICMS_DATA, SECURENS_DATA, ANIKET_DATA, GLOBAL_DATA } = await getVendorData();

    const normalizeAtmId = (value) => String(value || '').trim().toUpperCase();
    const getItemAtmId = (item) => normalizeAtmId(
      item?.ATM_ID || item?.atm_id || item?.atmId || item?.ATMID ||
      item?.terminalId || item?.TerminalID || item?.terminal_id || item?.id
    );
    const getLastCommunication = (item) =>
      item?.lastDataReceived || item?.last_Heartbeat || item?.lastHeartbeat ||
      item?.lastCommunication || item?.LastCommunication || item?.LastOnlineDateTime ||
      item?.lastOnlineDateTime || (item?.p && item.p[0] &&
        (item.p[0].LastOnlineDateTime || item.p[0].lastOnlineDateTime)) || null;
    const findByAtmId = (source, list) => {
      const atmSet = new Set(list.map(normalizeAtmId).filter(Boolean));
      const matches = source.filter(item => atmSet.has(getItemAtmId(item)));
      if (!matches.length) return null;

      // APIs can contain duplicate ATM rows. Prefer a row with a usable timestamp,
      // and, where possible, the most recent one.
      return matches.reduce((best, item) => {
        const itemDate = parseVendorDate(getLastCommunication(item));
        const bestDate = parseVendorDate(getLastCommunication(best));
        if (!bestDate && itemDate) return item;
        if (bestDate && itemDate && itemDate > bestDate) return item;
        return best;
      });
    };

    // For these master vendors, communication must come only from the assigned
    // vendor API. This keeps Vendor and Vendor Source consistent in the report.
    const assignedVendorConfigs = {
      'Aniket Amenities': { source: 'ANIKET', data: ANIKET_DATA },
      'Securens': { source: 'SECURENS', data: SECURENS_DATA },
      'CTS': { source: 'CTS', data: CTS_DATA },
      'Global': { source: 'GLOBAL', data: GLOBAL_DATA },
      'BuildINT': { source: 'i-CMS', data: ICMS_DATA }
    };
    const getAssignedVendorCommunication = (vendorName, atmPriority) => {
      const config = assignedVendorConfigs[String(vendorName || '').trim()];
      if (!config) return null;
      const match = findByAtmId(config.data, atmPriority);
      return {
        vendorSource: config.source,
        lastCommunication: match ? (getLastCommunication(match) || '-') : '-',
        matched: Boolean(match),
        apiStatus: match
          ? String(match.SiteStatus || match.siteStatus || match.Status || '').trim().toUpperCase()
          : ''
      };
    };

    // Pre-build ATM→lastCommunication Maps per vendor for O(1) lookup in the count loop
    const makeLastComMap = (data, getLastCom) => {
      const m = new Map();
      data.forEach(item => {
        const id = getItemAtmId(item);
        const value = getLastCom(item) || getLastCommunication(item);
        if (!id || !value) return;
        const existing = m.get(id);
        const valueDate = parseVendorDate(value);
        const existingDate = parseVendorDate(existing);
        if (!existing || (!existingDate && valueDate) ||
            (existingDate && valueDate && valueDate > existingDate)) m.set(id, value);
      });
      return m;
    };
    const ctsLastCom      = makeLastComMap(CTS_DATA,      i => i.lastDataReceived);
    const icmsLastCom     = makeLastComMap(ICMS_DATA,     i => i.lastDataReceived);
    const securensLastCom = makeLastComMap(SECURENS_DATA, i => i.last_Heartbeat);
    const aniketLastCom   = makeLastComMap(ANIKET_DATA,   i => i.LastOnlineDateTime || (i.p && i.p[0] && i.p[0].LastOnlineDateTime));
    const globalLastCom   = makeLastComMap(GLOBAL_DATA,   i => i.lastDataReceived || i.lastCommunication || (i.p && i.p[0] && i.p[0].LastOnlineDateTime));

    // Explicit, auditable fallback values for ATMs that have no vendor timestamp.
    // Genuine vendor communication always takes priority over these overrides.
    const overrideRows = await new Promise((resolve) =>
      connection.query(
        `SELECT atm_id, last_communication
         FROM atm_communication_overrides
         WHERE is_active = 1`,
        (err, r) => {
          if (err) {
            console.warn('[Health Status] Communication overrides unavailable; continuing without them:', err.code || err.message);
            return resolve([]);
          }
          resolve(r || []);
        }
      )
    );
    const communicationOverrideMap = new Map(
      overrideRows.map(r => [normalizeAtmId(r.atm_id), r.last_communication])
    );

    /* ── Online/offline totals — same priority + Rule B + buffer + staleDays as row builder ── */
    const allAtmIdsForCount = await new Promise((resolve, reject) =>
      connection.query(
        `SELECT a.atm_latest, a.atm_1, a.atm_2, a.atm_3, a.atm_4, a.atm_5,
                v.vendor_name
         FROM atm_list_new3 a
         LEFT JOIN vendor v ON v.vendor_id = a.vendor
         WHERE a.is_active = 1 AND (a.is_deleted IS NULL OR a.is_deleted != 1)`,
        (err, r) => err ? reject(err) : resolve(r || [])
      )
    );
    let totalOnline = 0, totalOffline = 0;
    for (const atm of allAtmIdsForCount) {
      const atmPriority = [atm.atm_latest, atm.atm_1, atm.atm_2, atm.atm_3, atm.atm_4, atm.atm_5]
        .filter(v => v && v !== '#N/A');
      let status = null;
      for (const id of atmPriority) {
        if (statusMap.has(id)) { status = statusMap.get(id); break; }
      }
      if (!status) {
        for (const id of atmPriority) {
          if (bufferMap.has(id)) { status = bufferMap.get(id); break; }
        }
      }
      if (!status) status = 'OFFLINE';
      if (status === 'OFFLINE') {
        for (const id of atmPriority) {
          if (todayOnlineSet.has(id)) { status = 'ONLINE'; break; }
        }
      }
      let lastCom = null;
      const assignedCommunication = getAssignedVendorCommunication(atm.vendor_name, atmPriority);
      const hasAuthoritativeAssignedStatus =
        ['ANIKET', 'CTS'].includes(assignedCommunication?.vendorSource) &&
        assignedCommunication.matched &&
        ['ONLINE', 'OFFLINE'].includes(assignedCommunication.apiStatus);
      if (assignedCommunication) {
        lastCom = assignedCommunication.lastCommunication;
        if (hasAuthoritativeAssignedStatus) status = assignedCommunication.apiStatus;
      } else {
        for (const id of atmPriority) {
          const nid = normalizeAtmId(id);
          lastCom = ctsLastCom.get(nid) || icmsLastCom.get(nid) || securensLastCom.get(nid) || aniketLastCom.get(nid) || globalLastCom.get(nid) || communicationOverrideMap.get(nid) || null;
          if (lastCom) break;
        }
      }

      // A missing communication timestamp produces "-" for both report fields.
      // Such rows must be ONLINE, and totals must use the same rule as the table.
      if ((!lastCom || lastCom === '-' || calculateAgeing(lastCom) === '-') && !hasAuthoritativeAssignedStatus) {
        status = 'ONLINE';
      } else if (status === 'ONLINE' && !hasAuthoritativeAssignedStatus) {
        // Apply same staleDays > 30 correction as the per-row builder.
        if (lastCom && lastCom !== '-') {
          const lastDate = parseVendorDate(lastCom);
          if (lastDate && !isNaN(lastDate.getTime())) {
            const staleDays = calculateAgeingDays(lastDate);
            if (staleDays > 30) status = 'OFFLINE';
          }
        }
      }
      if (status === 'ONLINE') totalOnline++; else totalOffline++;
    }

    /* ── Paginated rows ── */
    const limitClause = exportAll ? '' : `LIMIT ${pageSize} OFFSET ${offset}`;
    const dbData = await new Promise((resolve, reject) =>
      connection.query(
        `SELECT a.atm_latest, a.atm_1, a.atm_2, a.atm_3, a.atm_4, a.atm_5,
                a.lho_id, l.lho_name, a.vendor, v.vendor_name,
                a.site_address, a.city, a.state, a.pincode
         ${baseFrom} ${limitClause}`,
        queryParams,
        (err, r) => err ? reject(err) : resolve(r)
      )
    );

    /* ── Build response rows ── */
    const merged = dbData.map(db => {
      const atmPriority = [db.atm_latest, db.atm_1, db.atm_2, db.atm_3, db.atm_4, db.atm_5].filter(v => v && v !== '#N/A');

      /* Resolve status using same logic as dashboard: statusMap → bufferMap → Rule B → OFFLINE */
      let status = null;
      for (const atm of atmPriority) {
        if (statusMap.has(atm)) { status = statusMap.get(atm); break; }
      }
      if (!status) {
        for (const atm of atmPriority) {
          if (bufferMap.has(atm)) { status = bufferMap.get(atm); break; }
        }
      }
      if (!status) status = 'OFFLINE';
      if (status === 'OFFLINE') {
        for (const atm of atmPriority) {
          if (todayOnlineSet.has(atm)) { status = 'ONLINE'; break; }
        }
      }

      let vendorSource = '-', lastCommunication = '-';

      const assignedCommunication = getAssignedVendorCommunication(db.vendor_name, atmPriority);
      const hasAuthoritativeAssignedStatus =
        ['ANIKET', 'CTS'].includes(assignedCommunication?.vendorSource) &&
        assignedCommunication.matched &&
        ['ONLINE', 'OFFLINE'].includes(assignedCommunication.apiStatus);
      if (assignedCommunication) {
        vendorSource = assignedCommunication.vendorSource;
        lastCommunication = assignedCommunication.lastCommunication;
        if (hasAuthoritativeAssignedStatus) status = assignedCommunication.apiStatus;
      } else {
        const ctsMatch = findByAtmId(CTS_DATA, atmPriority);
        if (ctsMatch) {
          vendorSource = 'CTS';
          lastCommunication = getLastCommunication(ctsMatch) || '-';
        } else {
          const icmsMatch = findByAtmId(ICMS_DATA, atmPriority);
          if (icmsMatch) {
            vendorSource = 'i-CMS';
            lastCommunication = getLastCommunication(icmsMatch) || '-';
          } else {
            const securensMatch = findByAtmId(SECURENS_DATA, atmPriority);
            if (securensMatch) {
              vendorSource = 'SECURENS';
              lastCommunication = getLastCommunication(securensMatch) || '-';
            } else {
              const aniketMatch = findByAtmId(ANIKET_DATA, atmPriority);
              if (aniketMatch) {
                vendorSource = 'ANIKET';
                lastCommunication = getLastCommunication(aniketMatch) || '-';
              } else {
                const globalMatch = findByAtmId(GLOBAL_DATA, atmPriority);
                if (globalMatch) {
                  vendorSource = 'GLOBAL';
                  lastCommunication = getLastCommunication(globalMatch) || '-';
                }
              }
            }
          }
        }
      }

      if (lastCommunication === '-') {
        for (const atm of atmPriority) {
          const override = communicationOverrideMap.get(normalizeAtmId(atm));
          if (override) {
            vendorSource = 'DUMMY/OVERRIDE';
            lastCommunication = override;
            break;
          }
        }
      }

      const hasMissingCommunication = lastCommunication === '-';
      let ageing = hasMissingCommunication ? '-' : calculateAgeing(lastCommunication);

      if (hasMissingCommunication && ageing === '-' && !hasAuthoritativeAssignedStatus) {
        status = 'ONLINE';
        lastCommunication = new Date().toISOString();
        ageing = '0 days';
      } else if (status === 'ONLINE' && !hasAuthoritativeAssignedStatus) {
        // If last communication is more than 30 days ago, the device cannot be ONLINE
        // regardless of what the vendor API reports (vendor-side data lag/bug).
        const lastDate = parseVendorDate(lastCommunication);
        if (lastDate && !isNaN(lastDate.getTime())) {
          const staleDays = calculateAgeingDays(lastDate);
          if (staleDays > 30) status = 'OFFLINE';
        }
      }

      // Online ageing is not derived from Last Communication. Once the final
      // status is known, every ONLINE record must display the default bucket.
      // OFFLINE records keep the existing calendar-day calculation unchanged.
      if (status === 'ONLINE') ageing = '0 days';

      return {
        LHO: db.lho_name,
        lho_id: db.lho_id,
        atm_latest: db.atm_latest, atm_1: db.atm_1, atm_2: db.atm_2,
        atm_3: db.atm_3, atm_4: db.atm_4, atm_5: db.atm_5,
        address: db.site_address, state: db.state, city: db.city,
        pincode: db.pincode, vendor: db.vendor_name,
        vendorSource, status, lastCommunication,
        ageing
      };
    });

    return res.json({ data: merged, total, totalOnline, totalOffline, page, pageSize });

  } catch (error) {
    console.error('❌ Error in get-atm-details:', error);
    return res.status(500).json({ message: 'Error fetching ATM details' });
  }
});


function parseVendorDate(dateStr) {
  if (!dateStr) return null;

  if (dateStr instanceof Date) return dateStr;
  if (typeof dateStr === 'number') {
    const millis = dateStr < 100000000000 ? dateStr * 1000 : dateStr;
    return new Date(millis);
  }
  dateStr = String(dateStr).trim();

  // Format: YYYY-MM-DD HH:mm:ss  (API 1)
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) {
    return new Date(dateStr.replace(" ", "T"));
  }

  // Format: DD-MM-YYYY HH:mm:ss  (API 2)
  if (/^\d{2}-\d{2}-\d{4}/.test(dateStr)) {
    const [datePart, timePart] = dateStr.split(" ");
    const [dd, mm, yyyy] = datePart.split("-");
    return new Date(`${yyyy}-${mm}-${dd}T${timePart}`);
  }

  // ISO-8601 (including timezone), slash-separated dates and vendor variants.
  const parsed = new Date(dateStr);
  if (!isNaN(parsed.getTime())) return parsed;

  return null;
}


function calculateAgeingDays(lastCommunication, now = new Date()) {
  const last = parseVendorDate(lastCommunication);
  if (!last || isNaN(last.getTime())) return null;

  // Ageing is a calendar-day bucket, not a count of completed 24-hour
  // periods. Normalizing both values to local midnight prevents a record six
  // dates old from displaying five days because of a few seconds difference.
  const lastDay = Date.UTC(last.getFullYear(), last.getMonth(), last.getDate());
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today - lastDay) / 86400000));
}

function calculateAgeing(lastCommunication) {
  const days = calculateAgeingDays(lastCommunication);
  if (days === null) return "-";

  return `${days} days`;
}




const upload2 = multer({ storage: multer.memoryStorage() });

app.post('/api/bulk-upload-sites', requireRole(1), upload2.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: 'Excel file is required' });
    }

    /* ------------------------------------------------
       1️⃣ READ EXCEL
    ------------------------------------------------ */
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rows.length) {
      return res.status(400).json({ message: 'Excel file is empty' });
    }

    /* ------------------------------------------------
       2️⃣ FETCH MASTER DATA
    ------------------------------------------------ */
    const [vendors, lhos, existingAtms] = await Promise.all([
      queryPromise(`SELECT vendor_id, vendor_name FROM vendor WHERE is_active = 1`),
      queryPromise(`SELECT lho_id, lho_name FROM LHO_list WHERE is_deleted = 0`),
      queryPromise(`
        SELECT atm_latest, atm_1, atm_2, atm_3, atm_4, atm_5
        FROM atm_list_new3
      `)
    ]);

    const vendorMap = new Map(
      vendors.map(v => [v.vendor_name.trim().toLowerCase(), v.vendor_id])
    );

    const lhoMap = new Map(
      lhos.map(l => [l.lho_name.trim().toLowerCase(), l.lho_id])
    );

    /* ------------------------------------------------
       3️⃣ EXISTING ATM SET
    ------------------------------------------------ */
    const existingAtmSet = new Set();
    existingAtms.forEach(row => {
      Object.values(row).forEach(v => {
        if (v) existingAtmSet.add(v.toString().trim());
      });
    });

    const inserted = [];
    const skipped = [];

    /* ------------------------------------------------
       4️⃣ PROCESS EACH ROW
    ------------------------------------------------ */
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];

      const rowNumber = i + 2; // Excel row (header + 1)

      /* ---------- ATM VALIDATION ---------- */
      const atms = [
        r.atm_latest,
        r.atm_1,
        r.atm_2,
        r.atm_3,
        r.atm_4,
        r.atm_5
      ].map(a => a?.toString().trim()).filter(Boolean);

      if (!atms.length) {
        skipped.push({ row: rowNumber, reason: 'At least one ATM ID is required' });
        continue;
      }

      const duplicateAtm = atms.find(a => existingAtmSet.has(a));
      if (duplicateAtm) {
        skipped.push({
          row: rowNumber,
          reason: `ATM already exists: ${duplicateAtm}`
        });
        continue;
      }

      /* ---------- REQUIRED FIELDS ---------- */
      if (
        !r.site_address ||
        !r.city ||
        !r.state ||
        !r.pincode ||
        !r.vendor_name ||
        !r.lho_name
      ) {
        skipped.push({
          row: rowNumber,
          reason: 'Address, City, State, Pincode, Vendor, LHO are mandatory'
        });
        continue;
      }

      /* ---------- PINCODE ---------- */
      const pincodeStr = r.pincode.toString().trim();
      if (!/^\d{6}$/.test(pincodeStr)) {
        skipped.push({
          row: rowNumber,
          reason: 'Pincode must be exactly 6 digits'
        });
        continue;
      }

      /* ---------- VENDOR & LHO ---------- */
      const vendorId = vendorMap.get(r.vendor_name.trim().toLowerCase());
      if (!vendorId) {
        skipped.push({ row: rowNumber, reason: 'Invalid vendor name' });
        continue;
      }

      const lhoId = lhoMap.get(r.lho_name.trim().toLowerCase());
      if (!lhoId) {
        skipped.push({ row: rowNumber, reason: 'Invalid LHO name' });
        continue;
      }

      /* ---------- STATUS ---------- */
      const statusText = r.status?.toString().toLowerCase();
      const isActive =
        statusText === 'active' ? 1 :
          statusText === 'inactive' ? 0 : null;

      if (isActive === null) {
        skipped.push({
          row: rowNumber,
          reason: 'Status must be Active or Inactive'
        });
        continue;
      }

      /* ------------------------------------------------
         5️⃣ INSERT
      ------------------------------------------------ */
      await queryPromise(
        `
        INSERT INTO atm_list_new3
        (
          atm_latest, atm_1, atm_2, atm_3, atm_4, atm_5,
          lho_id, is_active, vendor,
          site_address, city, state, pincode,
          created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
        `,
        [
          r.atm_latest || null,
          r.atm_1 || null,
          r.atm_2 || null,
          r.atm_3 || null,
          r.atm_4 || null,
          r.atm_5 || null,
          lhoId,
          isActive,
          vendorId,
          r.site_address.trim(),
          r.city.trim(),
          r.state.trim(),
          Number(pincodeStr)
        ]
      );

      atms.forEach(a => existingAtmSet.add(a));
      inserted.push({ row: rowNumber });
    }

    /* ------------------------------------------------
       6️⃣ RESPONSE
    ------------------------------------------------ */
    return res.json({
      message: 'Bulk upload completed',
      insertedCount: inserted.length,
      skippedCount: skipped.length,
      skippedRows: skipped
    });

  } catch (err) {
    console.error('Bulk upload error:', err);
    console.error('Bulk upload error:', err);
    res.status(500).json({
      message: 'Bulk upload failed'
    });
  }
});

// Soft-delete Site Master records listed in an Excel workbook. The first sheet
// must contain an "ATM ID" column. An ID can match atm_latest or ATM 1-5.
app.post('/api/bulk-delete-sites', requireRole(1), upload2.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ message: 'Excel file is required' });
  }

  try {
    const workbook = XLSX.read(req.file.buffer, { type: 'buffer' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    const rawRows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

    if (!rawRows.length) {
      return res.status(400).json({ message: 'Excel file is empty' });
    }
    if (rawRows.length > 10000) {
      return res.status(400).json({ message: 'A maximum of 10,000 rows is allowed per file' });
    }

    const requested = [];
    const invalidRows = [];
    const seen = new Set();

    rawRows.forEach((row, index) => {
      const normalizedRow = Object.fromEntries(
        Object.entries(row).map(([key, value]) => [
          String(key).trim().toLowerCase().replace(/[\s_-]+/g, ''),
          value
        ])
      );
      const atmId = String(normalizedRow.atmid || normalizedRow.atmlatest || '').trim();
      const excelRow = index + 2;

      if (!atmId || atmId === '-') {
        invalidRows.push({ row: excelRow, atmId: '', reason: 'ATM ID is required' });
        return;
      }

      const normalizedId = atmId.toUpperCase();
      if (!seen.has(normalizedId)) {
        seen.add(normalizedId);
        requested.push({ atmId, normalizedId, row: excelRow });
      }
    });

    if (!requested.length) {
      return res.status(400).json({
        message: 'No valid ATM IDs were found. Use the column heading "ATM ID".',
        skippedRows: invalidRows
      });
    }

    const placeholders = requested.map(() => '?').join(',');
    const ids = requested.map(item => item.normalizedId);
    const matches = await queryPromise(
      `SELECT id, atm_latest, atm_1, atm_2, atm_3, atm_4, atm_5, is_deleted
       FROM atm_list_new3
       WHERE UPPER(TRIM(COALESCE(atm_latest, ''))) IN (${placeholders})
          OR UPPER(TRIM(COALESCE(atm_1, ''))) IN (${placeholders})
          OR UPPER(TRIM(COALESCE(atm_2, ''))) IN (${placeholders})
          OR UPPER(TRIM(COALESCE(atm_3, ''))) IN (${placeholders})
          OR UPPER(TRIM(COALESCE(atm_4, ''))) IN (${placeholders})
          OR UPPER(TRIM(COALESCE(atm_5, ''))) IN (${placeholders})`,
      [...ids, ...ids, ...ids, ...ids, ...ids, ...ids]
    );

    const matchByAtm = new Map();
    matches.forEach(site => {
      [site.atm_latest, site.atm_1, site.atm_2, site.atm_3, site.atm_4, site.atm_5]
        .filter(Boolean)
        .forEach(id => matchByAtm.set(String(id).trim().toUpperCase(), site));
    });

    const siteIds = new Set();
    const deletedAtms = [];
    const skippedRows = [...invalidRows];
    requested.forEach(item => {
      const site = matchByAtm.get(item.normalizedId);
      if (!site) {
        skippedRows.push({ row: item.row, atmId: item.atmId, reason: 'ATM ID not found' });
      } else if (Number(site.is_deleted) === 1) {
        skippedRows.push({ row: item.row, atmId: item.atmId, reason: 'Site is already deleted' });
      } else if (siteIds.has(site.id)) {
        skippedRows.push({ row: item.row, atmId: item.atmId, reason: 'Another ATM ID in this file belongs to the same site' });
      } else {
        siteIds.add(site.id);
        deletedAtms.push({ row: item.row, atmId: item.atmId, siteId: site.id });
      }
    });

    if (siteIds.size) {
      const sitePlaceholders = Array.from(siteIds).map(() => '?').join(',');
      await queryPromise(
        `UPDATE atm_list_new3
         SET is_deleted = 1,
             is_active = 0,
             deleted_at = NOW(),
             deleted_by = ?,
             updated_at = NOW()
         WHERE id IN (${sitePlaceholders})
           AND (is_deleted IS NULL OR is_deleted != 1)`,
        [req.user.userId, ...Array.from(siteIds)]
      );
    }

    return res.json({
      message: 'Bulk delete completed',
      requestedCount: requested.length,
      deletedCount: siteIds.size,
      skippedCount: skippedRows.length,
      deletedAtms,
      skippedRows
    });
  } catch (err) {
    console.error('Bulk delete error:', err);
    return res.status(500).json({ message: 'Bulk delete failed' });
  }
});

/* ------------------------------------------------
   HELPER
------------------------------------------------ */
function queryPromise(sql, params = []) {
  return new Promise((resolve, reject) => {
    connection.query(sql, params, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
  });
}


app.post('/api/delete-site', requireRole(1), (req, res) => {
  const { id, deleted_by } = req.body;

  // 🔴 Basic validation
  if (!id || !deleted_by) {
    return res.status(400).json({
      message: 'Site id and deleted_by are required'
    });
  }

  // 🔍 Check if site exists & not already deleted
  const checkQuery = `
    SELECT id 
    FROM atm_list_new3
    WHERE id = ?
      AND (is_deleted IS NULL OR is_deleted != 1)
  `;

  connection.query(checkQuery, [id], (err, results) => {
    if (err) {
      console.error('DB check error:', err);
      return res.status(500).json({ message: 'Database error' });
    }

    if (results.length === 0) {
      return res.status(404).json({
        message: 'Site not found or already deleted'
      });
    }

    // 🗑️ Soft delete + deactivate
    const deleteQuery = `
      UPDATE atm_list_new3
      SET 
        is_deleted = 1,
        is_active = 0,
        deleted_at = NOW(),
        deleted_by = ?,
        updated_at = NOW()
      WHERE id = ?
    `;

    connection.query(deleteQuery, [deleted_by, id], (err2) => {
      if (err2) {
        console.error('Delete error:', err2);
        return res.status(500).json({
          message: 'Failed to delete site'
        });
      }

      return res.status(200).json({
        message: 'Site deleted successfully',
        id
      });
    });
  });
});

app.get('/api/site/:id', (req, res) => {
  const { id } = req.params;

  const query = `
    SELECT 
      a.id,
      a.atm_latest,
      a.atm_1,
      a.atm_2,
      a.atm_3,
      a.atm_4,
      a.atm_5,
      a.lho_id,
      l.lho_name,
      a.vendor,
      v.vendor_name,
      a.site_address,
      a.city,
      a.state,
      a.pincode,
      a.is_active
    FROM atm_list_new3 a
    LEFT JOIN LHO_list l ON a.lho_id = l.lho_id
    LEFT JOIN vendor v ON a.vendor = v.vendor_id
    WHERE a.id = ? AND (a.is_deleted IS NULL OR a.is_deleted = 0)
  `;

  connection.query(query, [id], (err, results) => {
    if (err) return res.status(500).json({ message: 'DB error' });
    if (!results.length) {
      return res.status(404).json({ message: 'Site not found' });
    }
    res.json(results[0]);
  });
});

app.post('/api/update-site', requireRole(1), (req, res) => {
  const {
    id,
    atm_latest,
    atm_1,
    atm_2,
    atm_3,
    atm_4,
    atm_5,
    lho_id,
    vendor,
    site_address,
    city,
    state,
    pincode,
    is_active,
    updated_by
  } = req.body;

  if (!id || !atm_latest || !lho_id || !vendor || !site_address || !city || !state || !pincode) {
    return res.status(400).json({ message: 'Missing required fields' });
  }

  const suppliedAtmIds = [atm_latest, atm_1, atm_2, atm_3, atm_4, atm_5]
    .filter((value) => value !== null && value !== undefined && String(value).trim() !== '');
  if (!isValidAtmId(atm_latest) || suppliedAtmIds.some((value) => !isValidAtmId(value))) {
    return res.status(400).json({ message: 'ATM IDs may contain only letters, numbers, hyphens, and underscores.' });
  }
  if ([site_address, city, state].some(hasUnsafeMarkup)) {
    return res.status(400).json({ message: 'Site details contain unsupported characters.' });
  }

  const query = `
    UPDATE atm_list_new3
    SET
      atm_latest = ?,
      atm_1 = ?,
      atm_2 = ?,
      atm_3 = ?,
      atm_4 = ?,
      atm_5 = ?,
      lho_id = ?,
      vendor = ?,
      site_address = ?,
      city = ?,
      state = ?,
      pincode = ?,
      is_active = ?,
      updated_by = ?,
      updated_at = NOW()
    WHERE id = ?
  `;

  connection.query(
    query,
    [
      atm_latest,
      atm_1 || null,
      atm_2 || null,
      atm_3 || null,
      atm_4 || null,
      atm_5 || null,
      lho_id,
      vendor,
      site_address,
      city,
      state,
      pincode,
      is_active,
      updated_by,
      id
    ],
    (err) => {
      if (err) return res.status(500).json({ message: 'Update failed' });
      res.json({ message: 'Site updated successfully' });
    }
  );
});

app.get('/dashboard-snapshot', async (req, res) => {
  const { lho_id } = req.query;

  try {
    // 1️⃣ Get latest snapshot time
    const [latest] = await new Promise((resolve, reject) => {
      connection.query(
        `SELECT MAX(captured_at) AS latest_time FROM lho_status_snapshot`,
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

    if (!latest?.latest_time) {
      return res.json({
        totalLocations: 0,
        totalOnline: 0,
        totalOffline: 0,
        totalPercentage: 0,
        lhoDetails: []
      });
    }

    const snapshotTime = latest.latest_time;

    // 2️⃣ Build query
    let query = `
      SELECT 
        l.lho_id,
        l.lho_name,
        s.total_locations,
        s.online_count,
        s.offline_count,
        s.percentage
      FROM lho_status_snapshot s
      JOIN LHO_list l ON l.lho_id = s.lho_id
      WHERE s.captured_at = ?
        AND (l.is_deleted IS NULL OR l.is_deleted = 0)
    `;

    const params = [snapshotTime];

    if (lho_id) {
      query += ` AND l.lho_id = ?`;
      params.push(lho_id);
    }

    // 3️⃣ Execute query
    const rows = await new Promise((resolve, reject) => {
      connection.query(query, params, (err, result) =>
        err ? reject(err) : resolve(result)
      );
    });

    // 4️⃣ Calculate totals
    const totals = rows.reduce(
      (acc, r) => {
        acc.totalLocations += Number(r.total_locations);
        acc.totalOnline += Number(r.online_count);
        acc.totalOffline += Number(r.offline_count);
        return acc;
      },
      { totalLocations: 0, totalOnline: 0, totalOffline: 0 }
    );

    const totalPercentage =
      totals.totalLocations > 0
        ? Number(
          ((totals.totalOnline / totals.totalLocations) * 100).toFixed(2)
        )
        : 0;

    // 5️⃣ Final response
    return res.json({
      ...totals,
      totalPercentage,
      lhoDetails: rows
    });

  } catch (err) {
    console.error('Dashboard snapshot error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

function bulkInsert(query, values, batchSize = 500, db = connection) {
  if (!values || values.length === 0) return Promise.resolve();

  const batches = [];
  for (let i = 0; i < values.length; i += batchSize) {
    batches.push(values.slice(i, i + batchSize));
  }

  return batches.reduce((promise, batch) => {
    return promise.then(() => new Promise((resolve, reject) => {
      db.query(query, [batch], (err, result) => {
        if (err) reject(err);
        else resolve(result);
      });
    }));
  }, Promise.resolve());
}

let isLhoCronRunning = false;

cron.schedule('*/2 * * * *', async () => {
  if (!dbAvailable) {
    console.warn(`⏭️ Skipping LHO cron: DB unavailable (${lastDbError || 'unknown'})`);
    return;
  }

  if (isLhoCronRunning) {
    console.warn('⏭️ Skipping LHO cron: previous run still in progress');
    return;
  }

  isLhoCronRunning = true;
  console.log('⏱️ LHO cron started:', new Date().toISOString());

  const capturedAt = new Date();
  capturedAt.setSeconds(0, 0); // remove seconds & milliseconds

  // OPTIONAL: align exactly to 3-minute bucket
  const minutes = capturedAt.getMinutes();
  capturedAt.setMinutes(minutes - (minutes % 3));


  try {
    const { atmStatusRows, lhoMap } =
      await fetchLhoStatusSnapshot(cronConnection);

    /* ---------------- ATM SNAPSHOT ---------------- */

    const atmValues = atmStatusRows.map(r => [
      r.atm_id,
      r.lho_id,
      r.status,
      capturedAt
    ]);

    await bulkInsert(
      `
      INSERT INTO atm_status_history_test
(atm_id, lho_id, status, captured_at)
VALUES ?
ON DUPLICATE KEY UPDATE
  lho_id = VALUES(lho_id),
  status = VALUES(status);

      `,
      atmValues,
      500,
      cronConnection
    );

    /* ---------------- DATA RETENTION CLEANUP ---------------- */
    // Keep only today's rows — older snapshots are no longer needed for daily status logic
    await new Promise((resolve) => {
      cronConnection.query(
        `DELETE FROM atm_status_history_test WHERE captured_at < DATE_SUB(CURDATE(), INTERVAL 1 DAY)`,
        (err, result) => {
          if (err) console.warn('⚠️ Cleanup atm_status_history_test failed:', err.message);
          else if (result.affectedRows > 0)
            console.log(`🗑️ Removed ${result.affectedRows} stale rows from atm_status_history_test`);
          resolve();
        }
      );
    });

    await new Promise((resolve) => {
      cronConnection.query(
        `DELETE FROM atm_status_history WHERE captured_at < CURDATE()`,
        (err, result) => {
          if (err && err.code !== 'ER_NO_SUCH_TABLE')
            console.warn('⚠️ Cleanup atm_status_history failed:', err.message);
          else if (!err && result.affectedRows > 0)
            console.log(`🗑️ Removed ${result.affectedRows} stale rows from atm_status_history`);
          resolve();
        }
      );
    });

    /* ---------------- LHO SNAPSHOT ---------------- */

    // Upsert each LHO row: try UPDATE first, then INSERT if no row was updated
    for (const [lho_id, d] of lhoMap.entries()) {
      const percentage =
        d.total > 0 ? ((d.online / d.total) * 100).toFixed(2) : 0;

      // 1) Try to update existing row for the LHO (use lho_id unique index)
      // Set captured_at to the new timestamp so row always reflects latest snapshot
      const updateParams = [
        d.total,
        d.online,
        d.offline,
        percentage,
        capturedAt,
        lho_id
      ];

      await new Promise((resolve, reject) => {
        cronConnection.query(
          `UPDATE lho_status_snapshot
           SET total_locations = ?, online_count = ?, offline_count = ?, percentage = ?, captured_at = ?
           WHERE lho_id = ?`,
          updateParams,
          (err, result) => {
            if (err) return reject(err);

            // If no row was updated, INSERT a new one
            if (result.affectedRows === 0) {
              cronConnection.query(
                `INSERT INTO lho_status_snapshot
                 (lho_id, total_locations, online_count, offline_count, percentage, captured_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [lho_id, d.total, d.online, d.offline, percentage, capturedAt],
                (err2, res2) => (err2 ? reject(err2) : resolve(res2))
              );
            } else {
              resolve(result);
            }
          }
        );
      });
    }

    console.log('✅ LHO cron completed successfully');

  } catch (err) {
    console.error('❌ LHO cron failed:', err);
    if (isDbConnectivityError(err)) {
      setDbUnavailable(err);
    }
  } finally {
    isLhoCronRunning = false;
  }
});

app.get('/dashboard-summary', async (req, res) => {
  try {
    /* 1️⃣ Get latest snapshot time */
    const [latest] = await new Promise((resolve, reject) => {
      connection.query(
        `SELECT MAX(captured_at) AS latest_time FROM atm_status_history_test`,
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

    if (!latest?.latest_time) {
      return res.json({
        totalLocations: 0,
        totalOnline: 0,
        totalOffline: 0
      });
    }

    const snapshotTime = latest.latest_time;

    /* 2️⃣ Aggregate counts for latest snapshot */
    const stats = await new Promise((resolve, reject) => {
      connection.query(
        `
        SELECT
          COUNT(*) AS totalLocations,
          SUM(status = 'ONLINE') AS totalOnline,
          SUM(status = 'OFFLINE') AS totalOffline
        FROM atm_status_history_test
        WHERE captured_at = ?
        `,
        [snapshotTime],
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

    /* 3️⃣ Response */
    return res.json({
      snapshotTime,
      totalLocations: Number(stats[0].totalLocations),
      totalOnline: Number(stats[0].totalOnline),
      totalOffline: Number(stats[0].totalOffline)
    });

  } catch (err) {
    console.error('Dashboard summary error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

app.get('/dashboard-lho-details', async (req, res) => {
  try {
    /* 1️⃣ Get latest snapshot time */
    const [latest] = await new Promise((resolve, reject) => {
      connection.query(
        `SELECT MAX(captured_at) AS latest_time FROM lho_status_snapshot`,
        (err, rows) => (err ? reject(err) : resolve(rows))
      );
    });

    if (!latest?.latest_time) {
      return res.json({
        snapshotTime: null,
        lhoDetails: []
      });
    }

    const snapshotTime = latest.latest_time;

    /* 2️⃣ Fetch all LHO dashboard data */
    const rows = await new Promise((resolve, reject) => {
      connection.query(
        `
        SELECT
          l.lho_id,
          l.lho_name,
          s.total_locations,
          s.online_count,
          s.offline_count,
          s.percentage
        FROM lho_status_snapshot s
        JOIN LHO_list l ON l.lho_id = s.lho_id
        WHERE s.captured_at = ?
          AND (l.is_deleted IS NULL OR l.is_deleted = 0)
        ORDER BY l.lho_name
        `,
        [snapshotTime],
        (err, result) =>
          err ? reject(err) : resolve(result)
      );
    });

    /* 3️⃣ Response */
    return res.json({
      snapshotTime,
      lhoDetails: rows.map(r => ({
        lho_id: r.lho_id,
        lho_name: r.lho_name,
        total_locations: Number(r.total_locations),
        online_count: Number(r.online_count),
        offline_count: Number(r.offline_count),
        percentage: Number(r.percentage)
      }))
    });

  } catch (err) {
    console.error('Dashboard LHO details error:', err);
    res.status(500).json({ message: 'Internal server error' });
  }
});

// Keep the terminal error handler after every route so upload/parser failures
// are returned as generic JSON and never expose stack traces or filesystem paths.
app.use((err, _req, res, next) => {
  console.error('[request error]', err.message);
  if (res.headersSent) return next(err);
  if (err instanceof multer.MulterError || /Only Excel/.test(err.message || '')) {
    return res.status(400).json({ error: err.message || 'Invalid upload' });
  }
  return res.status(500).json({ error: 'Internal server error' });
});
