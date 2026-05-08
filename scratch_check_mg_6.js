const db = require('./src/config/db');
async function check() {
    const [rows] = await db.execute('SELECT * FROM market_group_items WHERE group_id = 6');
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
}
check();
