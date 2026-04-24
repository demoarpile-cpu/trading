const db = require('./src/config/db');

async function check() {
    try {
        const [trades] = await db.execute('SELECT id, user_id, symbol, market_type, qty, brokerage FROM trades ORDER BY id DESC LIMIT 5');
        console.log('Recent Trades:', JSON.stringify(trades, null, 2));

        if (trades.length > 0) {
            const userId = trades[0].user_id;
            const [settings] = await db.execute('SELECT config_json FROM client_settings WHERE user_id = ?', [userId]);
            if (settings.length > 0) {
                const config = JSON.parse(settings[0].config_json || '{}');
                console.log('Client Config MCX keys:', {
                    mcxLotBrokerage: config.mcxLotBrokerage,
                    mcxBrokerage: config.mcxBrokerage,
                    mcxBrokerageType: config.mcxBrokerageType,
                    brokerMcxBrokerage: config.brokerMcxBrokerage
                });
            }

            const [segments] = await db.execute('SELECT segment, brokerage_value, brokerage_type FROM user_segments WHERE user_id = ?', [userId]);
            console.log('User Segments:', JSON.stringify(segments, null, 2));
        }
    } catch (err) {
        console.error(err);
    } finally {
        process.exit();
    }
}

check();
