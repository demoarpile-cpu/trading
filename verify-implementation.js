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

const verify = async () => {
  let connection = null;
  try {
    console.log('🔍 Verifying Equity Units/Lots Implementation\n');
    console.log('Connecting to database...\n');

    connection = await mysql.createConnection(dbConfig);

    // Check if columns exist
    console.log('📋 Checking if new columns exist in trades table...\n');
    const [columns] = await connection.execute(`
      SELECT COLUMN_NAME, DATA_TYPE, IS_NULLABLE
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'trades'
      ORDER BY ORDINAL_POSITION
    `, [dbConfig.database]);

    const newColumns = ['qty_input', 'actual_qty', 'lot_size_at_entry', 'trade_mode', 'turnover', 'leverage_used', 'equity_units_mode'];
    const existingColumns = columns.map(c => c.COLUMN_NAME);

    console.log('✅ New Columns Status:');
    for (const col of newColumns) {
      if (existingColumns.includes(col)) {
        const colInfo = columns.find(c => c.COLUMN_NAME === col);
        console.log(`   ✓ ${col.padEnd(25)} (${colInfo.DATA_TYPE})`);
      } else {
        console.log(`   ✗ ${col.padEnd(25)} MISSING!`);
      }
    }

    // Check if any trades exist with the new fields
    console.log('\n📊 Checking Recent Trades:\n');
    const [trades] = await connection.execute(`
      SELECT
        id,
        symbol,
        type,
        qty,
        qty_input,
        actual_qty,
        lot_size_at_entry,
        trade_mode,
        ROUND(turnover, 2) as turnover,
        leverage_used,
        margin_used,
        equity_units_mode,
        market_type,
        status,
        DATE_FORMAT(entry_time, '%Y-%m-%d %H:%i:%s') as entry_time
      FROM trades
      WHERE qty_input IS NOT NULL OR actual_qty IS NOT NULL
      ORDER BY id DESC
      LIMIT 10
    `);

    if (trades.length === 0) {
      console.log('⚠️  No trades found with new fields yet.');
      console.log('   → Place a new trade to test the implementation\n');
    } else {
      console.log(`Found ${trades.length} trade(s) with new fields:\n`);
      console.log('═══════════════════════════════════════════════════════════════════════════════════════════════════════');

      for (const trade of trades) {
        console.log(`\nTrade #${trade.id} | ${trade.symbol} | ${trade.type} | ${trade.market_type}`);
        console.log('───────────────────────────────────────────────────────────────────────────────────────────────────────');
        console.log(`  Quantity:         Input=${trade.qty_input}, Actual=${trade.actual_qty}`);
        console.log(`  Lot Size:         ${trade.lot_size_at_entry}`);
        console.log(`  Mode:             ${trade.trade_mode}`);
        console.log(`  Turnover:         ₹${Number(trade.turnover).toLocaleString('en-IN')}`);
        console.log(`  Leverage Used:    ${trade.leverage_used}x`);
        console.log(`  Margin Required:  ₹${Number(trade.margin_used).toLocaleString('en-IN')}`);
        console.log(`  Units Mode:       ${trade.equity_units_mode === 1 ? 'YES (Units)' : 'NO (Lots)'}`);
        console.log(`  Status:           ${trade.status}`);
        console.log(`  Time:             ${trade.entry_time}`);
      }
      console.log('\n═══════════════════════════════════════════════════════════════════════════════════════════════════════');
    }

    // Check index creation
    console.log('\n📑 Checking Indexes:\n');
    const [indexes] = await connection.execute(`
      SELECT INDEX_NAME, COLUMN_NAME
      FROM INFORMATION_SCHEMA.STATISTICS
      WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'trades' AND INDEX_NAME LIKE '%actual_qty%'
    `, [dbConfig.database]);

    if (indexes.length > 0) {
      console.log('✅ Index for faster queries:');
      console.log(`   └─ ${indexes[0].INDEX_NAME} (on ${indexes[0].COLUMN_NAME})`);
    } else {
      console.log('ℹ️  No index found for actual_qty (optional performance optimization)');
    }

    console.log('\n✅ Implementation verification complete!\n');
    console.log('🚀 Ready to test:');
    console.log('   1. Create a new NSE EQUITY trade in UNITS mode');
    console.log('   2. Create a new NSE EQUITY trade in LOTS mode');
    console.log('   3. Create a new NSE FUTURES trade');
    console.log('   4. Create a new MCX trade');
    console.log('   5. Verify all calculations in this script\n');

  } catch (err) {
    console.error('❌ Verification failed:', err.message);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
};

verify();
