const db = require('./src/config/db');

async function checkTestClient() {
    try {
        const [rows] = await db.execute('SELECT config_json, trade_equity_units FROM client_settings WHERE user_id = 171');
        console.log('--- TestClient (171) Data ---');
        console.log('Column Value:', rows[0].trade_equity_units);
        console.log('Config JSON:', rows[0].config_json);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

checkTestClient();
