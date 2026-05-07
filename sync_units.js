const db = require('./src/config/db');

async function syncColumnWithConfig() {
    try {
        const [rows] = await db.execute('SELECT user_id, config_json FROM client_settings');
        let updatedCount = 0;
        for (const row of rows) {
            if (row.config_json) {
                try {
                    const config = JSON.parse(row.config_json);
                    if (config.tradeEquityUnits === true || config.tradeEquityUnits === 1) {
                        await db.execute('UPDATE client_settings SET trade_equity_units = 1 WHERE user_id = ?', [row.user_id]);
                        updatedCount++;
                    }
                } catch (e) {}
            }
        }
        console.log(`Successfully synced ${updatedCount} users from config_json to trade_equity_units column.`);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

syncColumnWithConfig();
