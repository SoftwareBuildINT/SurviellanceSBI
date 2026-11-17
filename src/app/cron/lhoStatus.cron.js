const cron = require('node-cron');
const { fetchLhoStatusSnapshot } = require('../services/lho.service');
const connection = require('../db');

cron.schedule('*/3 * * * *', async () => {
  console.log('⏱️ LHO cron started:', new Date());

  const capturedAt = new Date();

  try {
    const { atmStatusRows, lhoMap } =
      await fetchLhoStatusSnapshot(connection);

    // 🔹 Insert ATM-level snapshot
    const atmValues = atmStatusRows.map(r => [
      r.atm_id,
      r.lho_id,
      r.status,
      capturedAt
    ]);

    await bulkInsert(`
      INSERT INTO atm_status_history
      (atm_id, lho_id, status, captured_at)
      VALUES ?
    `, atmValues);

    // 🔹 Upsert LHO-level snapshot (UPDATE if exists for same lho_id & captured_at, else INSERT)
    for (const [lho_id, d] of lhoMap.entries()) {
      const percentage = ((d.online / d.total) * 100).toFixed(2);

      await new Promise((resolve, reject) => {
        connection.query(
          `UPDATE lho_status_snapshot
           SET total_locations = ?, online_count = ?, offline_count = ?, percentage = ?, captured_at = ?
           WHERE lho_id = ?`,
          [d.total, d.online, d.total - d.online, percentage, capturedAt, lho_id],
          (err, result) => {
            if (err) return reject(err);

            if (result.affectedRows === 0) {
              connection.query(
                `INSERT INTO lho_status_snapshot
                 (lho_id, total_locations, online_count, offline_count, percentage, captured_at)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [lho_id, d.total, d.online, d.total - d.online, percentage, capturedAt],
                (err2, res2) => (err2 ? reject(err2) : resolve(res2))
              );
            } else {
              resolve(result);
            }
          }
        );
      });
    }

    console.log('✅ LHO cron completed');

  } catch (err) {
    console.error('❌ Cron failed:', err);
  }
});
