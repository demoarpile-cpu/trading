const db = require('./src/config/db');

async function check() {
    try {
        const [rows] = await db.execute('SELECT * FROM trades ORDER BY id DESC LIMIT 1');
        console.log(JSON.stringify(rows[0], null, 2));
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

check();
