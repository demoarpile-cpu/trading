const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
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

const runMigration = async () => {
  let connection = null;
  try {
    console.log('🔧 Connecting to database...');
    console.log(`   Host: ${dbConfig.host}:${dbConfig.port}, DB: ${dbConfig.database}`);

    connection = await mysql.createConnection(dbConfig);

    console.log('✅ Connected to database');

    // Read migration file
    const migrationPath = path.join(__dirname, 'migrations', 'add_equity_units_columns.sql');
    const migrationSql = fs.readFileSync(migrationPath, 'utf8');

    console.log('\n📋 Executing migration: add_equity_units_columns.sql\n');

    // Split by semicolon and execute each statement
    const statements = migrationSql.split(';').filter(stmt => stmt.trim());

    for (const statement of statements) {
      const trimmedStmt = statement.trim();
      if (trimmedStmt) {
        console.log(`⏳ Executing: ${trimmedStmt.substring(0, 80)}...`);
        try {
          await connection.execute(trimmedStmt);
          console.log('✅ Success\n');
        } catch (err) {
          if (err.code === 'ER_DUP_FIELDNAME' || err.message.includes('already exists')) {
            console.log('⚠️  Column already exists (OK)\n');
          } else {
            throw err;
          }
        }
      }
    }

    console.log('✅ Migration completed successfully!\n');
    console.log('📊 Trade table schema updated with:');
    console.log('   - qty_input (Quantity entered by user)');
    console.log('   - actual_qty (Calculated quantity)');
    console.log('   - lot_size_at_entry (Lot size at trade time)');
    console.log('   - trade_mode (UNITS or LOTS)');
    console.log('   - turnover (Price × Actual Quantity)');
    console.log('   - leverage_used (Leverage applied)');
    console.log('   - equity_units_mode (User setting for EQUITY)');

  } catch (err) {
    console.error('❌ Migration failed:', err.message);
    console.error('\nError details:', err.code, err.sqlState);
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
    }
  }
};

runMigration();
