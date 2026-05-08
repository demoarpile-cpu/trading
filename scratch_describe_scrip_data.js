const db = require('./src/config/db');

async function check() {
    try {
        const [rows] = await db.execute("DESCRIBE scrip_data");
        console.table(rows);
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

check();
