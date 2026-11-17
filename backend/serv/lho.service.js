const axios = require('axios');
const https = require('https');
const { http2Get } = require('./http2-get');

const isSameDay = (d1, d2) =>
  d1.getFullYear() === d2.getFullYear() &&
  d1.getMonth()    === d2.getMonth()    &&
  d1.getDate()     === d2.getDate();

function parseVendorDate(dateStr) {
  if (!dateStr) return null;
  if (dateStr instanceof Date) return dateStr;
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return new Date(dateStr.replace(' ', 'T'));
  if (/^\d{2}-\d{2}-\d{4}/.test(dateStr)) {
    const [datePart, timePart = '00:00:00'] = dateStr.split(' ');
    const [dd, mm, yyyy] = datePart.split('-');
    return new Date(`${yyyy}-${mm}-${dd}T${timePart}`);
  }
  return null;
}

function calculateCalendarAgeingDays(lastCommunication, now = new Date()) {
  const last = parseVendorDate(lastCommunication);
  if (!last || isNaN(last.getTime())) return null;
  const lastDay = Date.UTC(last.getFullYear(), last.getMonth(), last.getDate());
  const today = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.max(0, Math.round((today - lastDay) / 86400000));
}

const API_MAX_ATTEMPTS = 3;
const API_RETRY_DELAY_MS = Number(process.env.LHO_API_RETRY_DELAY_MS || 3000);
const API_TIMEOUT_MS = Number(process.env.LHO_API_TIMEOUT_MS || 30000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function requestWithRetry(requestFn, sourceLabel) {
  let lastError;

  for (let attempt = 1; attempt <= API_MAX_ATTEMPTS; attempt++) {
    try {
      return await requestFn();
    } catch (error) {
      lastError = error;
      const shouldRetry = attempt < API_MAX_ATTEMPTS;

      console.warn(
        `[LHO Cron] ${sourceLabel} API attempt ${attempt}/${API_MAX_ATTEMPTS} failed: ${error.message}`
      );

      if (!shouldRetry) break;

      await sleep(API_RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

async function fetchLhoStatusSnapshot(connection) {
  console.log('🔥 Node fetchLhoStatusSnapshot running');

  const getLatestSnapshotStatusMap = async () => {
    const [latestRow] = await new Promise((resolve, reject) => {
      connection.query(
        'SELECT MAX(captured_at) AS latest_time FROM atm_status_history_test',
        (err, rows) => (err ? reject(err) : resolve(rows || []))
      );
    });

    if (!latestRow?.latest_time) {
      return new Map();
    }

    const rows = await new Promise((resolve, reject) => {
      connection.query(
        'SELECT atm_id, status FROM atm_status_history_test WHERE captured_at = ?',
        [latestRow.latest_time],
        (err, result) => (err ? reject(err) : resolve(result || []))
      );
    });

    return new Map(rows.map((r) => [r.atm_id, r.status]));
  };

  /* --------------------------------------------------
     1️⃣ FETCH ATM MASTER
  -------------------------------------------------- */
  const atmRows = await new Promise((resolve, reject) => {
    connection.query(
      `
      SELECT 
        a.lho_id,
        a.atm_latest,
        a.atm_1,
        a.atm_2,
        a.atm_3,
        a.atm_4,
        a.atm_5,
        v.vendor_name
      FROM atm_list_new3 a
      JOIN LHO_list l ON l.lho_id = a.lho_id
      LEFT JOIN vendor v ON v.vendor_id = a.vendor
      WHERE (l.is_deleted IS NULL OR l.is_deleted = 0)
        AND a.is_active = 1
        AND (a.is_deleted IS NULL OR a.is_deleted != 1)
`,
      (err, rows) => (err ? reject(err) : resolve(rows))
    );
  });

  /* --------------------------------------------------
     2️⃣ FETCH VENDOR STATUS (REAL SOURCE OF TRUTH)
  -------------------------------------------------- */
  const siteMap = new Map();

  const axiosInstance = axios.create({
    httpsAgent: new https.Agent({ rejectUnauthorized: false })
  });

  const aniketGlobalHeaders = {
    'Content-Type': 'application/json',
    'X-Password': 'thePass'
  };

  const buildintHeaders = {
    'Accept': 'application/json, text/javascript, */*; q=0.01',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
  };

  const apiResults = await Promise.allSettled([
    requestWithRetry(
      () => axiosInstance.get(process.env.BUILDINT_ALL_SITES, { timeout: API_TIMEOUT_MS, headers: buildintHeaders }),
      'BUILDINT'
    ),
    requestWithRetry(
      () => axios.get(process.env.ANIKET_ALL_SITES, { timeout: API_TIMEOUT_MS, headers: aniketGlobalHeaders }),
      'ANIKET'
    ),
    requestWithRetry(
      () => http2Get(process.env.SECURENS_ALL_SITES, { timeoutMs: API_TIMEOUT_MS }),
      'SECURENS'
    ),
    requestWithRetry(
      () => axios.get(process.env.GLOBAL_ALL_SITES, { timeout: API_TIMEOUT_MS, headers: aniketGlobalHeaders }),
      'GLOBAL'
    ),
    requestWithRetry(
      () => axiosInstance.get(process.env.CTS_ALL_SITES, {
        auth: { username: process.env.CTS_USERNAME, password: process.env.CTS_PASSWORD },
        timeout: API_TIMEOUT_MS
      }),
      'CTS'
    )
  ]);

  const [buildint, aniket, securens, global, cts] =
    apiResults.map(r => (r.status === 'fulfilled' ? r.value : null));

  const apiAvailability = {
    BUILDINT: false,
    ANIKET: false,
    SECURENS: false,
    GLOBAL: false,
    CTS: false
  };

  // Aniket / Global
  const parseArrayResponse = (resp) => {
  if (!resp?.data) return [];

  // Case 1: Already an array
  if (Array.isArray(resp.data)) {
    return resp.data;
  }

  // Case 2: JSON string
  if (typeof resp.data === 'string') {
    try {
      const parsed = JSON.parse(resp.data);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error('❌ Failed to parse vendor JSON string');
      return [];
    }
  }

  return [];
};

/* ---------------- ANIKET + GLOBAL ---------------- */

[
  ...parseArrayResponse(aniket),
  ...parseArrayResponse(global)
].forEach(s => {
  if (!s?.ATM_ID) return;

  const status =
    typeof s.SiteStatus === 'string' &&
    s.SiteStatus.toUpperCase() === 'ONLINE'
      ? 'ONLINE'
      : 'OFFLINE';

  siteMap.set(s.ATM_ID, status);
});

  apiAvailability.ANIKET = parseArrayResponse(aniket).length > 0;
  apiAvailability.GLOBAL = parseArrayResponse(global).length > 0;


  // Securens
    securens?.data?.Data?.forEach(s => {
      siteMap.set(s.ATM_ID, s.Status?.toUpperCase() || 'OFFLINE');
    });
  apiAvailability.SECURENS = Array.isArray(securens?.data?.Data) && securens.data.Data.length > 0;

  // CTS
if (cts?.data?.Data && Array.isArray(cts.data.Data)) {
  cts.data.Data.forEach(s => {
    if (!s?.ATM_ID) return;
    // CTS siteStatus is authoritative. lastDataReceived is used only for
    // Last Communication and offline ageing, never to change CTS status.
    const status = typeof s.siteStatus === 'string' && s.siteStatus.toUpperCase() === 'ONLINE'
      ? 'ONLINE'
      : 'OFFLINE';
    siteMap.set(s.ATM_ID, status);
  });

  console.log(`ℹ️ CTS sites processed: ${cts.data.Data.length}`);
}
  apiAvailability.CTS = Array.isArray(cts?.data?.Data) && cts.data.Data.length > 0;


  if (buildint?.data?.Data) {
  const today = new Date();
  buildint.data.Data.forEach(s => {
    if (!s?.ATM_ID) return;

    let status = 'OFFLINE';

    if (typeof s.siteStatus === 'string' && s.siteStatus.toUpperCase() === 'ONLINE') {
      status = 'ONLINE';
    } else if (s.lastDataReceived) {
      // Rule A: communicated today → count as ONLINE for the day
      const last = new Date(s.lastDataReceived);
      if (!isNaN(last.getTime()) && isSameDay(last, today)) {
        status = 'ONLINE';
      }
    }

    siteMap.set(s.ATM_ID, status);
  });
}
  apiAvailability.BUILDINT = Array.isArray(buildint?.data?.Data) && buildint.data.Data.length > 0;

  // Build ATM→lastCommunication map for staleDays > 30 correction (same logic as /get-atm-details)
  const lastComMap = new Map();
  (cts?.data?.Data || []).forEach(s => {
    if (s?.ATM_ID && s.lastDataReceived) lastComMap.set(String(s.ATM_ID).trim().toUpperCase(), s.lastDataReceived);
  });
  (buildint?.data?.Data || []).forEach(s => {
    const id = String(s?.ATM_ID || '').trim().toUpperCase();
    if (id && s.lastDataReceived && !lastComMap.has(id)) lastComMap.set(id, s.lastDataReceived);
  });
  (securens?.data?.Data || []).forEach(s => {
    const id = String(s?.ATM_ID || '').trim().toUpperCase();
    if (id && s.last_Heartbeat && !lastComMap.has(id)) lastComMap.set(id, s.last_Heartbeat);
  });
  [...parseArrayResponse(aniket), ...parseArrayResponse(global)].forEach(s => {
    const id = String(s?.ATM_ID || '').trim().toUpperCase();
    const lastCom = s.LastOnlineDateTime || (s.p && s.p[0] && s.p[0].LastOnlineDateTime);
    if (id && lastCom && !lastComMap.has(id)) lastComMap.set(id, lastCom);
  });

  const normalizeAtmId = value => String(value || '').trim().toUpperCase();
  const strictVendorKeys = {
    'Aniket Amenities': 'ANIKET',
    'Securens': 'SECURENS',
    'CTS': 'CTS',
    'Global': 'GLOBAL',
    'BuildINT': 'BUILDINT'
  };
  const strictStatusMaps = {
    ANIKET: new Map(), SECURENS: new Map(), CTS: new Map(), GLOBAL: new Map(), BUILDINT: new Map()
  };
  const strictLastComMaps = {
    ANIKET: new Map(), SECURENS: new Map(), CTS: new Map(), GLOBAL: new Map(), BUILDINT: new Map()
  };
  const addAniketStyleData = (key, data) => data.forEach(s => {
    const id = normalizeAtmId(s?.ATM_ID);
    if (!id) return;
    strictStatusMaps[key].set(id,
      typeof s.SiteStatus === 'string' && s.SiteStatus.toUpperCase() === 'ONLINE' ? 'ONLINE' : 'OFFLINE');
    const last = s.LastOnlineDateTime || (s.p && s.p[0] && s.p[0].LastOnlineDateTime);
    if (last) strictLastComMaps[key].set(id, last);
  });
  addAniketStyleData('ANIKET', parseArrayResponse(aniket));
  addAniketStyleData('GLOBAL', parseArrayResponse(global));
  (securens?.data?.Data || []).forEach(s => {
    const id = normalizeAtmId(s?.ATM_ID);
    if (!id) return;
    strictStatusMaps.SECURENS.set(id, s.Status?.toUpperCase() || 'OFFLINE');
    if (s.last_Heartbeat) strictLastComMaps.SECURENS.set(id, s.last_Heartbeat);
  });
  (cts?.data?.Data || []).forEach(s => {
    const id = normalizeAtmId(s?.ATM_ID);
    if (!id) return;
    const status = typeof s.siteStatus === 'string' && s.siteStatus.toUpperCase() === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
    strictStatusMaps.CTS.set(id, status);
    if (s.lastDataReceived) strictLastComMaps.CTS.set(id, s.lastDataReceived);
  });
  (buildint?.data?.Data || []).forEach(s => {
    const id = normalizeAtmId(s?.ATM_ID);
    if (!id) return;
    let status = typeof s.siteStatus === 'string' && s.siteStatus.toUpperCase() === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
    if (status === 'OFFLINE' && s.lastDataReceived) {
      const last = new Date(s.lastDataReceived);
      if (!isNaN(last.getTime()) && isSameDay(last, new Date())) status = 'ONLINE';
    }
    strictStatusMaps.BUILDINT.set(id, status);
    if (s.lastDataReceived) strictLastComMaps.BUILDINT.set(id, s.lastDataReceived);
  });

  const hasAnyApiFailure = Object.values(apiAvailability).some((ok) => !ok);
  let previousStatusMap = new Map();
  if (hasAnyApiFailure) {
    previousStatusMap = await getLatestSnapshotStatusMap();
    console.warn(
      `[LHO Cron] API fallback active. Failed/empty sources: ${Object.entries(apiAvailability)
        .filter(([, ok]) => !ok)
        .map(([name]) => name)
        .join(', ') || 'none'}`
    );
  }


  /* --------------------------------------------------
     3️⃣ RESOLVE STATUS BY ATM PRIORITY
  -------------------------------------------------- */

  // Rule B: fetch every ATM that was ONLINE at any point in the last 2 days
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);

  const todayOnlineRows = await new Promise((resolve, reject) => {
    connection.query(
      `SELECT DISTINCT atm_id FROM atm_status_history_test
       WHERE status = 'ONLINE' AND captured_at >= ?`,
      [twoDaysAgo],
      (err, rows) => (err ? reject(err) : resolve(rows || []))
    );
  });
  const todayOnlineSet = new Set(todayOnlineRows.map(r => r.atm_id));

  // Buffer: upsert every ATM currently visible in vendor APIs, then load the full buffer
  // so ATMs absent from the current snapshot can still show their last known status.
  const bufferNow = new Date();
  const bufferValues = Array.from(siteMap.entries()).map(([id, st]) => [id, st, bufferNow]);
  if (bufferValues.length > 0) {
    await new Promise((resolve) => {
      connection.query(
        `INSERT INTO atm_last_known_status (atm_id, status, captured_at) VALUES ?
         ON DUPLICATE KEY UPDATE status = VALUES(status), captured_at = VALUES(captured_at)`,
        [bufferValues],
        (err) => { if (err) console.warn('[Buffer] Upsert failed:', err.message); resolve(); }
      );
    });
  }

  const bufferRows = await new Promise((resolve) => {
    connection.query(
      `SELECT atm_id, status FROM atm_last_known_status`,
      (err, rows) => resolve(err ? [] : (rows || []))
    );
  });
  const bufferMap = new Map(bufferRows.map(r => [r.atm_id, r.status]));

  const atmStatusRows = [];
  const lhoMap = new Map();

  for (const row of atmRows) {
    const atmPriority = [
      row.atm_latest,
      row.atm_1,
      row.atm_2,
      row.atm_3,
      row.atm_4,
      row.atm_5
    ].filter(v => v && v !== '#N/A');

    let status = null;
    let hasAssignedLiveStatus = false;

    // Live status from the assigned API for the four strictly mapped vendors.
    const strictVendorKey = strictVendorKeys[String(row.vendor_name || '').trim()];
    const assignedStatusMap = strictVendorKey ? strictStatusMaps[strictVendorKey] : siteMap;
    for (const atm of atmPriority) {
      const key = normalizeAtmId(atm);
      if (assignedStatusMap.has(key)) {
        status = assignedStatusMap.get(key) === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
        hasAssignedLiveStatus = true;
        break;
      }
    }

    // If an API failed or returned no records, preserve the last known ATM status
    // instead of forcing OFFLINE due to missing fresh data.
    if (!status && hasAnyApiFailure) {
      for (const atm of atmPriority) {
        if (previousStatusMap.has(atm)) {
          status = previousStatusMap.get(atm) === 'ONLINE' ? 'ONLINE' : 'OFFLINE';
          break;
        }
      }
    }

    // Buffer fallback: ATM is absent from all vendor APIs in this snapshot;
    // use the last vendor-confirmed status rather than defaulting to OFFLINE.
    if (!status) {
      for (const atm of atmPriority) {
        if (bufferMap.has(atm)) {
          status = bufferMap.get(atm);
          break;
        }
      }
    }

    if (!status) {
      status = 'OFFLINE';
    }

    // Rule B: even if currently OFFLINE, mark ONLINE if it was online at any point today
    const hasAuthoritativeAssignedStatus = ['ANIKET', 'CTS'].includes(strictVendorKey) && hasAssignedLiveStatus;
    if (status === 'OFFLINE' && !hasAuthoritativeAssignedStatus) {
      for (const atm of atmPriority) {
        if (todayOnlineSet.has(atm)) {
          status = 'ONLINE';
          break;
        }
      }
    }

    let lastCom = null;
    const assignedLastComMap = strictVendorKey ? strictLastComMaps[strictVendorKey] : lastComMap;
    for (const atm of atmPriority) {
      const key = String(atm).trim().toUpperCase();
      if (assignedLastComMap.has(key)) { lastCom = assignedLastComMap.get(key); break; }
    }

    // Keep dashboard snapshots consistent with the Health Status report:
    // no last communication means both report fields are "-", so status is ONLINE.
    if (!lastCom && !hasAuthoritativeAssignedStatus) {
      status = 'ONLINE';
    } else if (status === 'ONLINE' && !hasAuthoritativeAssignedStatus) {
      // staleDays > 30: vendor API reporting ONLINE but last communication is stale — override
      if (lastCom) {
        const lastDate = parseVendorDate(lastCom);
        if (lastDate && !isNaN(lastDate.getTime())) {
          const staleDays = calculateCalendarAgeingDays(lastDate);
          if (staleDays > 30) status = 'OFFLINE';
        }
      }
    }

    atmStatusRows.push({
      atm_id: atmPriority[0],
      lho_id: row.lho_id,
      status
    });

    if (!lhoMap.has(row.lho_id)) {
      lhoMap.set(row.lho_id, { total: 0, online: 0, offline: 0 });
    }

    const l = lhoMap.get(row.lho_id);
    l.total++;
    if (status === 'ONLINE') l.online++;
    else l.offline++;
  }

  // Upsert resolved status (keyed by atm_latest) so all ATMs — regardless of
  // which vendor API they come from — are present in atm_last_known_status.
  const resolvedBufferValues = atmStatusRows
    .filter(r => r.atm_id)
    .map(r => [r.atm_id, r.status, bufferNow]);
  if (resolvedBufferValues.length > 0) {
    await new Promise((resolve) => {
      connection.query(
        `INSERT INTO atm_last_known_status (atm_id, status, captured_at) VALUES ?
         ON DUPLICATE KEY UPDATE status = VALUES(status), captured_at = VALUES(captured_at)`,
        [resolvedBufferValues],
        (err) => { if (err) console.warn('[Buffer] Resolved upsert failed:', err.message); resolve(); }
      );
    });
  }

  return { atmStatusRows, lhoMap };
}

module.exports = { fetchLhoStatusSnapshot };
