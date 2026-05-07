const db = require('./src/config/db');

async function checkAllUser109() {
    try {
        const [rows] = await db.execute('SELECT * FROM client_settings WHERE user_id = 109');
        console.log('--- User 109 ALL Settings ---');
        console.log(rows[0]);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkAllUser109();
