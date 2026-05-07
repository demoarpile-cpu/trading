const mysql = require('mysql2/promise');
require('dotenv').config();

const dbConfig = {
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'traderdb',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  waitForConnections: true,
  connectionLimit: 1
};

const check = async () => {
  let connection = null;
  try {
    console.log('🔍 NSE Scripts के lot_size check कर रहे हैं...\n');

    connection = await mysql.createConnection(dbConfig);

    // Query 1: lot_size > 1 वाली scripts
    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log('📊 NSE Scripts जिनका LOT_SIZE > 1 है:');
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');

    const [lotsizeGreater] = await connection.execute(`
      SELECT
        symbol,
        market_type,
        lot_size,
        margin_req,
        COALESCE(expiry_date, '-') as expiry_date
      FROM scrip_data
      WHERE market_type IN ('EQUITY', 'NFO')
        AND lot_size > 1
      ORDER BY lot_size DESC
      LIMIT 50
    `);

    if (lotsizeGreater.length === 0) {
      console.log('⚠️  कोई script नहीं मिली lot_size > 1 के साथ\n');
    } else {
      console.log(`Found ${lotsizeGreater.length} scripts:\n`);
      lotsizeGreater.forEach((row, idx) => {
        console.log(`${idx + 1}. ${row.symbol.padEnd(20)} | Lot Size: ${row.lot_size} | Type: ${row.instrument_type || 'EQ'} | Expiry: ${row.expiry}`);
      });
    }

    // Query 2: lot_size = 1 वाली scripts कितनी हैं
    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('📊 NSE Scripts का Lot Size Distribution:');
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');

    const [distribution] = await connection.execute(`
      SELECT
        lot_size,
        COUNT(*) as count
      FROM scrip_data
      WHERE market_type IN ('EQUITY', 'NFO')
      GROUP BY lot_size
      ORDER BY lot_size ASC
    `);

    console.log('Lot Size Distribution:');
    distribution.forEach(row => {
      const barLength = Math.min(row.count / 10, 50);
      const bar = '█'.repeat(barLength);
      console.log(`  Lot Size ${String(row.lot_size).padEnd(5)}: ${row.count.toString().padEnd(5)} scripts ${bar}`);
    });

    // Query 3: सब से common lot_size
    console.log('\n═══════════════════════════════════════════════════════════════════════════════');
    console.log('📋 Most Common Lot Sizes:');
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');

    const [common] = await connection.execute(`
      SELECT
        lot_size,
        COUNT(*) as script_count,
        GROUP_CONCAT(DISTINCT symbol LIMIT 5) as sample_symbols
      FROM scrip_data
      WHERE market_type IN ('EQUITY', 'NFO')
      GROUP BY lot_size
      ORDER BY script_count DESC
      LIMIT 10
    `);

    common.forEach((row, idx) => {
      console.log(`${idx + 1}. Lot Size ${row.lot_size}:`);
      console.log(`   Total Scripts: ${row.script_count}`);
      console.log(`   Examples: ${row.sample_symbols}\n`);
    });

    // Query 4: अगर कोई lot_size > 1 है तो उसका example calculation
    if (lotsizeGreater.length > 0) {
      const firstScript = lotsizeGreater[0];
      console.log('═══════════════════════════════════════════════════════════════════════════════');
      console.log(`✅ Example: ${firstScript.symbol} (Lot Size: ${firstScript.lot_size})`);
      console.log('═══════════════════════════════════════════════════════════════════════════════\n');

      console.log(`Assume you buy: ${firstScript.symbol} @ ₹100 per unit, 1 lot\n`);

      const price = 100;
      const qty_input = 1;
      const actual_qty = qty_input * firstScript.lot_size;
      const turnover = price * actual_qty;
      const margin = turnover / 5;

      console.log('CALCULATION:');
      console.log(`  qty_input      = ${qty_input} lot`);
      console.log(`  lot_size       = ${firstScript.lot_size}`);
      console.log(`  actual_qty     = ${qty_input} × ${firstScript.lot_size} = ${actual_qty}`);
      console.log(`  price          = ₹${price}`);
      console.log(`  turnover       = ₹${price} × ${actual_qty} = ₹${turnover}`);
      console.log(`  leverage       = 5x`);
      console.log(`  margin         = ₹${turnover} ÷ 5 = ₹${margin}`);
    }

    console.log('\n✅ Check complete!\n');

  } catch (err) {
    console.error('❌ Error:', err.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
};

check();
