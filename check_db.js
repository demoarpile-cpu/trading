const db = require('./src/config/db');

async function checkSchema() {
    try {
        const [rows] = await db.execute('DESCRIBE client_settings');
        console.log('--- client_settings Table Schema ---');
        console.table(rows);
        process.exit(0);
    } catch (err) {
        console.error('Error fetching schema:', err);
        process.exit(1);
    }
}

checkSchema();
