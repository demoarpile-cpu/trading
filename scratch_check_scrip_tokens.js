const db = require('./src/config/db');

async function check() {
    try {
        const [rows] = await db.execute("SELECT * FROM scrip_data WHERE symbol LIKE '%BANKNIFTY%' LIMIT 5");
        console.log(JSON.stringify(rows, null, 2));
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
}

check();
