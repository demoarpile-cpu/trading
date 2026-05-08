const db = require('./src/config/db');
async function migrate() {
    try {
        console.log('Running final migration for scrip_data ENUM...');
        await db.execute("ALTER TABLE scrip_data MODIFY COLUMN market_type ENUM('MCX','NSE','NFO','EQUITY','COMEX','FOREX','CRYPTO') DEFAULT 'MCX'");
        console.log('✅ ENUM Updated');
        process.exit(0);
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
        process.exit(1);
    }
}
migrate();
