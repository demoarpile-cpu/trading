const db = require('./src/config/db');

async function checkConfig() {
    try {
        const [rows] = await db.execute('SELECT config_json FROM client_settings WHERE user_id = 161');
        console.log('--- Config JSON for ap00 ---');
        console.log(rows[0].config_json);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkConfig();
