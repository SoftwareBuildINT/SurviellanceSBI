'use strict';

require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const path  = require('path');
const mysql = require('mysql2/promise');
const xlsx  = require('xlsx');

// ─── CONFIG ──────────────────────────────────────────────────────────────────

const EXCEL_FILE = path.join(__dirname, 'Bulk_Upload_Site_Sample (5).xlsx');

// ─── DB ───────────────────────────────────────────────────────────────────────

async function getDb() {
  return mysql.createConnection({
    host:            process.env.DB_HOST,
    user:            process.env.DB_USER,
    password:        process.env.DB_PASSWORD,
    database:        process.env.DB_NAME,
    connectTimeout:  15000,
  });
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function normalise(v) {
  return (v ?? '').toString().trim();
}

function padRow(n) {
  return String(n).padStart(4, ' ');
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('═'.repeat(56));
  console.log('  SBI ATM Site Bulk Upload');
  console.log(`  File : ${path.basename(EXCEL_FILE)}`);
  console.log('═'.repeat(56));

  /* ── 1. Read Excel ──────────────────────────────────────── */
  const wb    = xlsx.readFile(EXCEL_FILE);
  const ws    = wb.Sheets[wb.SheetNames[0]];
  const rows  = xlsx.utils.sheet_to_json(ws, { defval: '' });

  if (!rows.length) {
    console.error('Excel file is empty.');
    process.exit(1);
  }
  console.log(`\nRows in Excel : ${rows.length}`);

  /* ── 2. Connect to DB ───────────────────────────────────── */
  process.stdout.write('Connecting to DB ... ');
  const db = await getDb();
  console.log('OK\n');

  try {
    /* ── 3. Load master data ────────────────────────────── */
    const [[vendors], [lhos], [existingAtms]] = await Promise.all([
      db.query(`SELECT vendor_id, vendor_name FROM vendor WHERE is_active = 1`),
      db.query(`SELECT lho_id, lho_name FROM LHO_list WHERE is_deleted = 0`),
      db.query(`SELECT atm_latest, atm_1, atm_2, atm_3, atm_4, atm_5 FROM atm_list_new3`),
    ]);

    const vendorMap = new Map(
      vendors.map(v => [v.vendor_name.trim().toLowerCase(), v.vendor_id])
    );
    const lhoMap = new Map(
      lhos.map(l => [l.lho_name.trim().toLowerCase(), l.lho_id])
    );

    // Build a flat set of every ATM ID already in the DB (all 6 columns)
    const existingSet = new Set();
    existingAtms.forEach(row => {
      Object.values(row).forEach(v => {
        if (v) existingSet.add(v.toString().trim());
      });
    });

    console.log(`Vendors in DB : ${vendors.length}`);
    console.log(`LHOs in DB    : ${lhos.length}`);
    console.log(`ATMs in DB    : ${existingAtms.length} records (${existingSet.size} unique IDs)\n`);

    /* ── 4. Process rows ────────────────────────────────── */
    const inserted = [];
    const skipped  = [];

    for (let i = 0; i < rows.length; i++) {
      const r       = rows[i];
      const rowNum  = i + 2; // Excel row number (1 = header)

      // Collect all non-empty ATM IDs for this row
      const atmCols = [
        normalise(r.atm_latest),
        normalise(r.atm_1),
        normalise(r.atm_2),
        normalise(r.atm_3),
        normalise(r.atm_4),
        normalise(r.atm_5),
      ].filter(Boolean).filter(v => v !== '-');

      // ── Validation ──────────────────────────────────────

      if (!atmCols.length) {
        skipped.push({ row: rowNum, atm: '—', reason: 'No ATM ID in any column' });
        continue;
      }

      const dupAtm = atmCols.find(a => existingSet.has(a));
      if (dupAtm) {
        skipped.push({ row: rowNum, atm: normalise(r.atm_latest), reason: `Duplicate ATM ID: ${dupAtm}` });
        continue;
      }

      const missingFields = ['site_address', 'city', 'state', 'vendor_name', 'lho_name']
        .filter(f => !normalise(r[f]));
      if (missingFields.length) {
        skipped.push({ row: rowNum, atm: normalise(r.atm_latest), reason: `Missing: ${missingFields.join(', ')}` });
        continue;
      }

      // Pincode — allow empty (nullable in schema)
      const pincodeStr = normalise(r.pincode);
      if (pincodeStr && !/^\d{4,6}$/.test(pincodeStr)) {
        skipped.push({ row: rowNum, atm: normalise(r.atm_latest), reason: `Invalid pincode: ${pincodeStr}` });
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

      const statusStr = normalise(r.status).toLowerCase();
      const isActive  = statusStr === 'active' ? 1 : statusStr === 'inactive' ? 0 : null;
      if (isActive === null) {
        skipped.push({ row: rowNum, atm: normalise(r.atm_latest), reason: `Invalid status: "${normalise(r.status)}"` });
        continue;
      }

      // ── Insert ───────────────────────────────────────────
      await db.execute(
        `INSERT INTO atm_list_new3
          (atm_latest, atm_1, atm_2, atm_3, atm_4, atm_5,
           lho_id, is_active, vendor,
           site_address, city, state, pincode,
           created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          normalise(r.atm_latest)  || null,
          normalise(r.atm_1)       || null,
          normalise(r.atm_2)       || null,
          normalise(r.atm_3)       || null,
          normalise(r.atm_4)       || null,
          normalise(r.atm_5)       || null,
          lhoId,
          isActive,
          vendorId,
          normalise(r.site_address),
          normalise(r.city),
          normalise(r.state),
          pincodeStr ? Number(pincodeStr) : null,
        ]
      );

      // Add all IDs to the set so later rows in the same file are also deduplicated
      atmCols.forEach(a => existingSet.add(a));
      inserted.push({ row: rowNum, atm: normalise(r.atm_latest) });

      process.stdout.write(`\r  Inserted ${inserted.length} | Skipped ${skipped.length} | Processing row ${rowNum}/${rows.length + 1}  `);
    }

    console.log('\n');

    /* ── 5. Print summary ───────────────────────────────── */
    console.log('─'.repeat(56));
    console.log(`  RESULT`);
    console.log('─'.repeat(56));
    console.log(`  Total rows    : ${rows.length}`);
    console.log(`  Inserted      : ${inserted.length}`);
    console.log(`  Skipped       : ${skipped.length}`);
    console.log('─'.repeat(56));

    /* ── 6. Skipped report ──────────────────────────────── */
    if (skipped.length) {
      console.log('\n  SKIPPED ROWS REPORT\n');

      // Group by reason
      const byReason = {};
      skipped.forEach(s => {
        const key = s.reason.startsWith('Duplicate') ? 'Duplicate ATM ID' : s.reason;
        if (!byReason[key]) byReason[key] = [];
        byReason[key].push(s);
      });

      const dupCount = skipped.filter(s => s.reason.startsWith('Duplicate')).length;

      console.log(`  Breakdown by reason:`);
      Object.entries(byReason).forEach(([reason, list]) => {
        console.log(`    • ${reason.padEnd(40)} ${list.length} rows`);
      });

      console.log('\n  Full list:');
      console.log(`  ${'Row'.padEnd(6)} ${'ATM ID'.padEnd(22)} Reason`);
      console.log(`  ${'-'.repeat(6)} ${'-'.repeat(22)} ${'-'.repeat(30)}`);
      skipped.forEach(s => {
        console.log(`  ${padRow(s.row).padEnd(6)} ${s.atm.padEnd(22)} ${s.reason}`);
      });

      /* ── 7. Write skip report Excel ──────────────────── */
      const reportWb  = xlsx.utils.book_new();
      const reportWs  = xlsx.utils.json_to_sheet(
        skipped.map(s => ({ 'Excel Row': s.row, 'ATM ID (atm_latest)': s.atm, 'Reason Skipped': s.reason }))
      );
      // Auto-width
      const cols = [{ wch: 10 }, { wch: 24 }, { wch: 60 }];
      reportWs['!cols'] = cols;
      xlsx.utils.book_append_sheet(reportWb, reportWs, 'Skipped Rows');

      const summaryWs = xlsx.utils.json_to_sheet([
        { Metric: 'Total rows in Excel', Value: rows.length },
        { Metric: 'Inserted', Value: inserted.length },
        { Metric: 'Skipped (duplicates)', Value: dupCount },
        { Metric: 'Skipped (other)', Value: skipped.length - dupCount },
      ]);
      summaryWs['!cols'] = [{ wch: 28 }, { wch: 10 }];
      xlsx.utils.book_append_sheet(reportWb, summaryWs, 'Summary');

      const reportFile = path.join(__dirname, `upload_skipped_report_${new Date().toISOString().slice(0,10)}.xlsx`);
      xlsx.writeFile(reportWb, reportFile);
      console.log(`\n  Skip report saved : ${path.basename(reportFile)}`);
    }

    console.log('\n' + '═'.repeat(56));
    console.log(`  Done — ${inserted.length} rows inserted, ${skipped.length} skipped.`);
    console.log('═'.repeat(56));

  } finally {
    await db.end();
  }
}

main().catch(err => {
  console.error('\nFatal error:', err.message);
  process.exit(1);
});
