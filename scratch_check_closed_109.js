const db = require('./src/config/db');

async function check() {
    try {
        const [rows] = await db.execute("SELECT * FROM trades WHERE user_id = 109 AND status = 'CLOSED' ORDER BY id DESC LIMIT 5");
        console.log(JSON.stringify(rows, null, 2));
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

check();
