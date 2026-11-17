const axios = require('axios');

/**
 * Fetch dashboard snapshot from backend API
 * JS equivalent of Angular LhoService.getDashboardSnapshot()
 */
async function fetchLhoStatusSnapshot(connection, lhoId = null) {
  console.log('🔥 Node fetchLhoStatusSnapshot running');

   //let url = 'http://localhost:7668/dashboard-snapshot';
  let url = 'https://sbi-dashboard.ifiber.in:3000/api/dashboard-snapshot';

  if (lhoId) {
    url += `?lho_id=${lhoId}`;
  }

  try {
    const response = await axios.get(url);
    const data = response.data;

    /**
     * data structure:
     * {
     *   totalLocations,
     *   totalOnline,
     *   totalOffline,
     *   totalPercentage,
     *   lhoDetails: []
     * }
     */

    // Convert API response → cron-compatible structure
    const atmStatusRows = []; // ⚠️ snapshot API does not give ATM-level data
    const lhoMap = new Map();

    for (const lho of data.lhoDetails || []) {
      lhoMap.set(lho.lho_id, {
        total: Number(lho.total_locations),
        online: Number(lho.online_count ?? lho.onlineCount ?? 0)
      });
    }

    return {
      atmStatusRows,
      lhoMap
    };

  } catch (error) {
    console.error('❌ Failed to fetch dashboard snapshot:', error.message);
    throw error;
  }
}

module.exports = { fetchLhoStatusSnapshot };
