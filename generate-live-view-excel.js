'use strict';

const axios    = require('axios');
const https    = require('https');
const xlsx     = require('xlsx');
const readline = require('readline');
const path     = require('path');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const BASE_URL    = 'https://sbi-dashboard.ifiber.in:7668/api';
const CONCURRENCY = 25;   // parallel live-view-links workers
const TIMEOUT_MS  = 40000; // must exceed vendor's 30 s internal timeout
const MAX_RETRIES = 1;     // retry once on transient 5xx

const httpsAgent = new https.Agent({ rejectUnauthorized: false, keepAlive: true });
const httpClient = axios.create({ baseURL: BASE_URL, httpsAgent, timeout: TIMEOUT_MS });

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function ask(q) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(r => rl.question(q, a => { rl.close(); r(a.trim()); }));
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Worker-pool concurrency: keeps all CONCURRENCY slots busy the whole time,
// unlike chunked Promise.all which stalls on the slowest item in each chunk.
async function pool(tasks, limit) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ─── AUTH ─────────────────────────────────────────────────────────────────────

async function login(email, password) {
  const body = new URLSearchParams({ EmailId: email, password });
  const res  = await httpClient.post('/login', body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
  });
  if (!res.data.tempToken) throw new Error(res.data.message || 'Login failed');
  return res.data.tempToken;
}

async function verifyOtp(tempToken, otp) {
  const res = await httpClient.post('/verify-otp', { otp }, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${tempToken}` }
  });
  if (!res.data.token) throw new Error(res.data.message || 'OTP verification failed');
  return res.data.token;
}

// ─── DATA FETCHERS ────────────────────────────────────────────────────────────

async function getAllSites(token) {
  const res = await httpClient.get('/api/sitemaster', {
    headers: { Authorization: `Bearer ${token}` }
  });
  return Array.isArray(res.data.sites) ? res.data.sites : [];
}

async function getLiveViewLinks(token, atmId) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await httpClient.post(
        `/live-view-links?atmId=${encodeURIComponent(atmId)}`,
        {},
        { headers: { Authorization: `Bearer ${token}` } }
      );
      return { ok: true, data: res.data };
    } catch (err) {
      const status = err.response?.status;
      // Retry only on transient server errors (5xx), not on 4xx client errors
      if (attempt < MAX_RETRIES && status >= 500) {
        await sleep(1500);
        continue;
      }
      const msg = err.response?.data?.message || err.response?.data?.error || err.message;
      return { ok: false, error: msg };
    }
  }
}

// ─── PROGRESS DISPLAY ────────────────────────────────────────────────────────

function makeProgress(total) {
  let done = 0;
  const start = Date.now();
  return function tick(label) {
    done++;
    const elapsed = (Date.now() - start) / 1000;
    const rate    = done / elapsed;
    const eta     = rate > 0 ? Math.round((total - done) / rate) : '?';
    const pct     = Math.round((done / total) * 100);
    const bar     = '█'.repeat(Math.round(pct / 5)).padEnd(20, '░');
    process.stdout.write(
      `\r  [${bar}] ${pct.toString().padStart(3)}%  ${done}/${total}  ${rate.toFixed(1)}/s  ETA ${eta}s  ${String(label).padEnd(22)}`
    );
  };
}

// ─── EXCEL BUILDER ────────────────────────────────────────────────────────────

function autoWidth(ws, rows) {
  if (!rows.length) return;
  const keys = Object.keys(rows[0]);
  ws['!cols'] = keys.map(k => ({
    wch: Math.min(Math.max(k.length, ...rows.map(r => String(r[k] ?? '').length)) + 2, 80)
  }));
}

function buildWorkbook(rows) {
  const wb = xlsx.utils.book_new();

  // Sheet 1: all ATMs
  const ws1 = xlsx.utils.json_to_sheet(rows);
  autoWidth(ws1, rows);
  xlsx.utils.book_append_sheet(wb, ws1, 'Live View Links');

  // Sheet 2: summary by LHO
  const lhoMap = {};
  rows.forEach(r => {
    const lho = r['LHO Name'] || 'Unknown';
    if (!lhoMap[lho]) lhoMap[lho] = { total: 0, ok: 0, error: 0, vendors: new Set() };
    lhoMap[lho].total++;
    r['Status'] === 'OK' ? lhoMap[lho].ok++ : lhoMap[lho].error++;
    if (r['Vendor Name']) lhoMap[lho].vendors.add(r['Vendor Name']);
  });
  const lhoRows = Object.entries(lhoMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([lho, s]) => ({
      'LHO Name': lho, 'Total ATMs': s.total,
      'Links Available': s.ok, 'Errors': s.error,
      'Vendors': [...s.vendors].join(', ')
    }));
  const ws2 = xlsx.utils.json_to_sheet(lhoRows);
  autoWidth(ws2, lhoRows);
  xlsx.utils.book_append_sheet(wb, ws2, 'Summary by LHO');

  // Sheet 3: summary by vendor
  const vendorMap = {};
  rows.forEach(r => {
    const v = r['Vendor Name'] || 'Unknown';
    if (!vendorMap[v]) vendorMap[v] = { total: 0, ok: 0, error: 0 };
    vendorMap[v].total++;
    r['Status'] === 'OK' ? vendorMap[v].ok++ : vendorMap[v].error++;
  });
  const vendorRows = Object.entries(vendorMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([v, s]) => ({
      'Vendor Name': v, 'Total ATMs': s.total,
      'Links Available': s.ok, 'Errors': s.error
    }));
  const ws3 = xlsx.utils.json_to_sheet(vendorRows);
  autoWidth(ws3, vendorRows);
  xlsx.utils.book_append_sheet(wb, ws3, 'Summary by Vendor');

  return wb;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════╗');
  console.log('║  SBI ATM Live View Excel Generator       ║');
  console.log(`║  workers=${CONCURRENCY}  retry=${MAX_RETRIES}  timeout=${TIMEOUT_MS/1000}s    ║`);
  console.log('╚══════════════════════════════════════════╝\n');

  // Auth
  const email    = process.env.SBI_EMAIL    || await ask('Email ID : ');
  const password = process.env.SBI_PASSWORD || await ask('Password : ');

  process.stdout.write('\nLogging in ... ');
  let tempToken;
  try {
    tempToken = await login(email, password);
    console.log('OK — OTP sent to registered email.\n');
  } catch (err) { console.error('\nLogin failed:', err.message); process.exit(1); }

  const otp = await ask('Enter OTP   : ');
  let token;
  try {
    token = await verifyOtp(tempToken, otp);
    console.log('\nAuthenticated.\n');
  } catch (err) { console.error('OTP failed:', err.message); process.exit(1); }

  // Fetch site master
  process.stdout.write('Fetching ATM site master ... ');
  let sites;
  try {
    sites = await getAllSites(token);
    console.log(`${sites.length} sites.\n`);
  } catch (err) { console.error('\nFailed:', err.message); process.exit(1); }

  // Fetch live-view-links with maximum concurrency
  console.log(`Fetching live view links  [${CONCURRENCY} workers, retry=${MAX_RETRIES}]\n`);
  const tick = makeProgress(sites.length);

  const tasks = sites.map(site => async () => {
    const atmId  = site.atm_latest;
    const result = await getLiveViewLinks(token, atmId);
    tick(atmId);
    const lv = result.ok ? result.data : {};
    return {
      'ATM ID':       atmId,
      'ATM Alt IDs':  [site.atm_1, site.atm_2, site.atm_3, site.atm_4, site.atm_5].filter(Boolean).join(', '),
      'LHO Name':     site.lho_name    || '',
      'Vendor Name':  site.vendor_name || '',
      'Site Name':    lv.siteName      || site.site_address || '',
      'City':         lv.city          || site.city  || '',
      'State':        lv.state         || site.state || '',
      'Address':      site.site_address || '',
      'Pincode':      site.pincode     || '',
      'Camera 1':     lv.camera_1      || '',
      'Camera 2':     lv.camera_2      || '',
      'Camera 3':     lv.camera_3      || '',
      'Camera 4':     lv.camera_4      || '',
      'Status':       result.ok ? 'OK' : 'ERROR',
      'Error Detail': result.ok ? '' : result.error
    };
  });

  const wallStart = Date.now();
  const rows = await pool(tasks, CONCURRENCY);
  const elapsed = ((Date.now() - wallStart) / 1000).toFixed(1);
  console.log('\n');

  // Sort LHO → ATM ID
  rows.sort((a, b) => {
    const c = (a['LHO Name'] || '').localeCompare(b['LHO Name'] || '');
    return c !== 0 ? c : (a['ATM ID'] || '').localeCompare(b['ATM ID'] || '');
  });

  // Write Excel
  const wb      = buildWorkbook(rows);
  const outFile = path.join(__dirname, `live_view_links_${new Date().toISOString().slice(0, 10)}.xlsx`);
  xlsx.writeFile(wb, outFile);

  const okCount  = rows.filter(r => r['Status'] === 'OK').length;
  const errCount = rows.filter(r => r['Status'] === 'ERROR').length;

  console.log('─'.repeat(52));
  console.log(`Excel saved  : ${path.basename(outFile)}`);
  console.log(`Total ATMs   : ${rows.length}  (${elapsed}s @ ${(rows.length / elapsed).toFixed(1)} ATM/s)`);
  console.log(`  Links OK   : ${okCount}`);
  console.log(`  Errors     : ${errCount}`);
  console.log('─'.repeat(52));
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
