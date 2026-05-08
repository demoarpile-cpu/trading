const db = require('./src/config/db');

async function checkSchema() {
    try {
        const [rows] = await db.execute('DESCRIBE trades');
        console.log('Columns in trades table:');
        rows.forEach(row => console.log(`- ${row.Field} (${row.Type})`));
        process.exit(0);
    } catch (err) {
        console.error('Error:', err.message);
        process.exit(1);
    }
}

checkSchema();
