'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const path  = require('path');
const mysql = require('mysql2/promise');
const xlsx  = require('xlsx');

const EXCEL_FILE   = path.join(__dirname, 'Bulk_Upload_Site_Sample (5).xlsx');
const DUMMY_CITY   = 'N/A';
const DUMMY_STATE  = 'N/A';

async function getDb() {
  return mysql.createConnection({
    host:           process.env.DB_HOST,
    user:           process.env.DB_USER,
    password:       process.env.DB_PASSWORD,
    database:       process.env.DB_NAME,
    connectTimeout: 15000,
  });
}

function normalise(v) { return (v ?? '').toString().trim(); }
function isBlank(v)   { return !v || v === '-' || v === '—'; }

async function main() {
  console.log('═'.repeat(60));
  console.log('  SBI ATM Bulk Upload — with dummy fill for missing fields');
  console.log('═'.repeat(60));

  const wb   = xlsx.readFile(EXCEL_FILE);
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = xlsx.utils.sheet_to_json(ws, { defval: '' });
  console.log(`\nExcel rows : ${rows.length}`);

  process.stdout.write('Connecting to DB ... ');
  const db = await getDb();
  console.log('OK\n');

  try {
    const [[vendors], [lhos], [existingAtms]] = await Promise.all([
      db.query(`SELECT vendor_id, vendor_name FROM vendor WHERE is_active = 1`),
      db.query(`SELECT lho_id, lho_name FROM LHO_list WHERE is_deleted = 0`),
      db.query(`SELECT atm_latest, atm_1, atm_2, atm_3, atm_4, atm_5 FROM atm_list_new3`),
    ]);

    const vendorMap = new Map(vendors.map(v => [v.vendor_name.trim().toLowerCase(), v.vendor_id]));
    const lhoMap    = new Map(lhos.map(l    => [l.lho_name.trim().toLowerCase(),    l.lho_id]));

    const existingSet = new Set();
    existingAtms.forEach(row => {
      Object.values(row).forEach(v => { if (v) existingSet.add(v.toString().trim()); });
    });

    console.log(`Vendors in DB : ${vendors.length} | LHOs : ${lhos.length} | Existing ATM IDs : ${existingSet.size}\n`);

    const inserted   = [];
    const skipped    = [];
    const dummyFills = [];   // rows where we auto-filled something

    for (let i = 0; i < rows.length; i++) {
      const r      = rows[i];
      const rowNum = i + 2;

      // ── Collect ATM IDs ───────────────────────────────────
      const atmCols = [
        normalise(r.atm_latest), normalise(r.atm_1), normalise(r.atm_2),
        normalise(r.atm_3),      normalise(r.atm_4), normalise(r.atm_5),
      ].filter(v => v && v !== '-' && v !== '—');

      if (!atmCols.length || normalise(r.atm_latest) === 'New ID Pending') {
        skipped.push({ row: rowNum, atm: normalise(r.atm_latest), reason: 'No valid ATM ID' });
        continue;
      }

      // ── Duplicate check ───────────────────────────────────
      const dupAtm = atmCols.find(a => existingSet.has(a));
      if (dupAtm) {
        skipped.push({ row: rowNum, atm: normalise(r.atm_latest), reason: `Duplicate: ${dupAtm}` });
        continue;
      }

      // ── Vendor & LHO (still required) ────────────────────
      if (!normalise(r.vendor_name) || !normalise(r.lho_name)) {
        skipped.push({ row: rowNum, atm: normalise(r.atm_latest), reason: 'Missing vendor_name or lho_name' });
        continue;
      }
      const vendorId = vendorMap.get(normalise(r.vendor_name).toLowerCase());
      if (!vendorId) {
        skipped.push({ row: rowNum, atm: normalise(r.atm_latest), reason: `Unknown vendor: "${normalise(r.vendor_name)}"` });
        continue;
      }
      const lhoId = lhoMap.get(normalise(r.lho_name).toLowerCase());
      if (!lhoId) {
        skipped.push({ row: rowNum, atm: normalise(r.atm_latest), reason: `Unknown LHO: "${normalise(r.lho_name)}"` });
        continue;
      }

      // ── Status (still required) ───────────────────────────
      const statusStr = normalise(r.status).toLowerCase();
      const isActive  = statusStr === 'active' ? 1 : statusStr === 'inactive' ? 0 : null;
      if (isActive === null) {
        skipped.push({ row: rowNum, atm: normalise(r.atm_latest), reason: `Invalid status: "${normalise(r.status)}"` });
        continue;
      }

      // ── Dummy fill: city ──────────────────────────────────
      const filledFields = [];
      let city = normalise(r.city);
      if (!city) { city = DUMMY_CITY; filledFields.push('city=N/A'); }

      // ── Dummy fill: state ─────────────────────────────────
      let state = normalise(r.state);
      if (!state) { state = DUMMY_STATE; filledFields.push('state=N/A'); }

      // ── Dummy fill: site_address ──────────────────────────
      let siteAddress = normalise(r.site_address);
      if (!siteAddress) { siteAddress = 'N/A'; filledFields.push('address=N/A'); }

      // ── Dummy fill: pincode ("-" or blank → NULL) ─────────
      const rawPin    = normalise(r.pincode);
      const pincodeOk = /^\d{4,6}$/.test(rawPin);
      const pincode   = pincodeOk ? Number(rawPin) : null;
      if (!pincodeOk && rawPin) { filledFields.push(`pincode=${rawPin}→NULL`); }

      // ── Insert ────────────────────────────────────────────
      await db.execute(
        `INSERT INTO atm_list_new3
          (atm_latest, atm_1, atm_2, atm_3, atm_4, atm_5,
           lho_id, is_active, vendor,
           site_address, city, state, pincode,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          normalise(r.atm_latest) || null,
          normalise(r.atm_1)      || null,
          normalise(r.atm_2)      || null,
          normalise(r.atm_3)      || null,
          normalise(r.atm_4)      || null,
          normalise(r.atm_5)      || null,
          lhoId, isActive, vendorId,
          siteAddress, city, state, pincode,
        ]
      );

      atmCols.forEach(a => existingSet.add(a));
      inserted.push({ row: rowNum, atm: normalise(r.atm_latest), filled: filledFields.join(' | ') });
      if (filledFields.length) dummyFills.push({ row: rowNum, atm: normalise(r.atm_latest), filled: filledFields.join(' | ') });

      process.stdout.write(
        `\r  Inserted ${inserted.length} (${dummyFills.length} with dummy) | Skipped ${skipped.length} | Row ${rowNum}/${rows.length + 1}  `
      );
    }

    console.log('\n');

    // ── Summary ───────────────────────────────────────────────
    const dupCount = skipped.filter(s => s.reason.startsWith('Duplicate')).length;

    console.log('─'.repeat(60));
    console.log('  RESULT');
    console.log('─'.repeat(60));
    console.log(`  Total Excel rows    : ${rows.length}`);
    console.log(`  Inserted (clean)    : ${inserted.length - dummyFills.length}`);
    console.log(`  Inserted (w/ dummy) : ${dummyFills.length}`);
    console.log(`  Skipped (duplicate) : ${dupCount}`);
    console.log(`  Skipped (other)     : ${skipped.length - dupCount}`);
    console.log('─'.repeat(60));

    // ── Build report workbook ─────────────────────────────────
    const reportWb = xlsx.utils.book_new();

    // Sheet 1: Inserted with dummy fills
    if (dummyFills.length) {
      const ws1 = xlsx.utils.json_to_sheet(
        dummyFills.map(r => ({
          'Excel Row': r.row,
          'ATM ID':   r.atm,
          'Dummy Fields Applied': r.filled,
        }))
      );
      ws1['!cols'] = [{ wch: 10 }, { wch: 22 }, { wch: 50 }];
      xlsx.utils.book_append_sheet(reportWb, ws1, 'Inserted with Dummy');
    }

    // Sheet 2: Skipped rows
    if (skipped.length) {
      const ws2 = xlsx.utils.json_to_sheet(
        skipped.map(s => ({
          'Excel Row':           s.row,
          'ATM ID (atm_latest)': s.atm,
          'Reason Skipped':      s.reason,
        }))
      );
      ws2['!cols'] = [{ wch: 10 }, { wch: 22 }, { wch: 50 }];
      xlsx.utils.book_append_sheet(reportWb, ws2, 'Skipped');
    }

    // Sheet 3: Summary
    const ws3 = xlsx.utils.json_to_sheet([
      { Metric: 'Total rows in Excel',        Value: rows.length },
      { Metric: 'Inserted clean',              Value: inserted.length - dummyFills.length },
      { Metric: 'Inserted with dummy fill',    Value: dummyFills.length },
      { Metric: 'Total inserted',              Value: inserted.length },
      { Metric: 'Skipped — duplicate ATM',     Value: dupCount },
      { Metric: 'Skipped — other',             Value: skipped.length - dupCount },
      { Metric: 'Total skipped',               Value: skipped.length },
    ]);
    ws3['!cols'] = [{ wch: 32 }, { wch: 10 }];
    xlsx.utils.book_append_sheet(reportWb, ws3, 'Summary');

    const reportFile = path.join(
      __dirname,
      `upload_dummy_report_${new Date().toISOString().slice(0, 10)}.xlsx`
    );
    xlsx.writeFile(reportWb, reportFile);
    console.log(`\n  Report saved : ${path.basename(reportFile)}`);
    console.log('═'.repeat(60));

  } finally {
    await db.end();
  }
}

main().catch(err => { console.error('\nFatal:', err.message); process.exit(1); });
