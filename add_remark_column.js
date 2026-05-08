const db = require('./src/config/db');

async function addRemarkColumn() {
    try {
        await db.execute('ALTER TABLE trades ADD COLUMN close_remark VARCHAR(100) DEFAULT NULL');
        console.log('✅ Successfully added close_remark column to trades table');
        process.exit(0);
    } catch (err) {
        if (err.message.includes('Duplicate column name')) {
            console.log('ℹ️ close_remark column already exists');
            process.exit(0);
        }
        console.error('❌ Error adding column:', err.message);
        process.exit(1);
    }
}

addRemarkColumn();
