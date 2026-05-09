const db = require('./src/config/db');

async function migrate() {
    try {
        console.log('🚀 Running migration: Adding executed_from_pending column...');
        await db.execute("ALTER TABLE trades ADD COLUMN executed_from_pending TINYINT DEFAULT 0 AFTER is_pending");
        console.log('✅ Migration successful!');
        process.exit(0);
    } catch (err) {
        if (err.code === 'ER_DUP_COLUMN') {
            console.log('ℹ️ Column already exists, skipping.');
            process.exit(0);
        }
        console.error('❌ Migration failed:', err.message);
        process.exit(1);
    }
}

migrate();
