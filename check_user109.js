const db = require('./src/config/db');

async function checkUser109() {
    try {
        const [rows] = await db.execute('SELECT trade_equity_units FROM client_settings WHERE user_id = 109');
        console.log('--- User 109 Settings ---');
        console.table(rows);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkUser109();
