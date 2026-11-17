const axios = require('axios');
const https = require('https');

async function fetchLhoStatusSnapshot(connection) {
  console.log('🔥 Node fetchLhoStatusSnapshot running');

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
        a.atm_5
      FROM atm_list_new3 a
      JOIN LHO_list l ON l.lho_id = a.lho_id
      WHERE (l.is_deleted IS NULL OR l.is_deleted = 0)
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

  const headers = {
    'Content-Type': 'application/json',
    'X-Password': 'thePass'
  };

  const apiResults = await Promise.allSettled([
    axios.get(process.env.BUILDINT_ALL_SITES),
    axios.get(process.env.ANIKET_ALL_SITES),
    axios.get(process.env.SECURENS_ALL_SITES),
    axios.get(process.env.GLOBAL_ALL_SITES),
    axiosInstance.post(process.env.CTS_ALL_SITES)
  ]);

  const [buildint, aniket, securens, global, cts] =
    apiResults.map(r => (r.status === 'fulfilled' ? r.value : null));

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


  // Securens
    securens?.data?.Data?.forEach(s => {
      siteMap.set(s.ATM_ID, s.Status?.toUpperCase() || 'OFFLINE');
    });

  // CTS
if (cts?.data?.Data && Array.isArray(cts.data.Data)) {
  cts.data.Data.forEach(s => {
    if (!s?.ATM_ID) return;

    let status = 'OFFLINE';

    // 1️⃣ Primary: siteStatus (case-insensitive)
    if (typeof s.siteStatus === 'string') {
      status =
        s.siteStatus.toUpperCase() === 'ONLINE'
          ? 'ONLINE'
          : 'OFFLINE';
    }

    // 2️⃣ Fallback: lastDataReceived heartbeat
    else if (s.lastDataReceived) {
      const last = new Date(s.lastDataReceived);
      if (!isNaN(last.getTime())) {
        const minutesDiff =
          (Date.now() - last.getTime()) / 60000;
        status = minutesDiff <= 1440 ? 'ONLINE' : 'OFFLINE';
      }
    }

    siteMap.set(s.ATM_ID, status);
  });
  
  console.log(`ℹ️ CTS sites processed: ${cts.data.Data.length}`);
}


  if (buildint?.data?.Data) {
  buildint.data.Data.forEach(s => {
    if (!s?.ATM_ID) return;

    let status = 'OFFLINE';

    // 1️⃣ Primary source: siteStatus
    if (typeof s.siteStatus === 'string') {
      status = s.siteStatus.toUpperCase() === 'ONLINE'
        ? 'ONLINE'
        : 'OFFLINE';
    }

    // 2️⃣ Fallback: lastDataReceived heartbeat (optional)
    else if (s.lastDataReceived) {
      const last = new Date(s.lastDataReceived);
      if (!isNaN(last.getTime())) {
        const minutesDiff =
          (Date.now() - last.getTime()) / 60000;
        status = minutesDiff <= 1440 ? 'ONLINE' : 'OFFLINE';
      }
    }

    siteMap.set(s.ATM_ID, status);
  });
}


  /* --------------------------------------------------
     3️⃣ RESOLVE STATUS BY ATM PRIORITY
  -------------------------------------------------- */
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
    ].filter(Boolean);

    let status = 'OFFLINE';

    for (const atm of atmPriority) {
      if (siteMap.get(atm) === 'ONLINE') {
        status = 'ONLINE';
        break;
      }
    }

    atmStatusRows.push({
      atm_id: atmPriority[0],
      lho_id: row.lho_id,
      status
    });

    if (!lhoMap.has(row.lho_id)) {
      lhoMap.set(row.lho_id, { total: 0, online: 0 });
    }

    const l = lhoMap.get(row.lho_id);
    l.total++;
    if (status === 'ONLINE') l.online++;
  }

  return { atmStatusRows, lhoMap };
}

module.exports = { fetchLhoStatusSnapshot };
