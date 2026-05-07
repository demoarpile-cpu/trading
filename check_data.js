const db = require('./src/config/db');

async function checkRecentSettings() {
    try {
        const [rows] = await db.execute(`
            SELECT cs.*, u.username 
            FROM client_settings cs
            JOIN users u ON cs.user_id = u.id
            ORDER BY u.id DESC 
            LIMIT 10
        `);
        console.log('--- Recent Client Settings ---');
        console.table(rows.map(r => ({
            id: r.user_id,
            username: r.username,
            trade_equity_units: r.trade_equity_units,
            allow_fresh: r.allow_fresh_entry,
            config: r.config_json ? r.config_json.substring(0, 50) + '...' : 'null'
        })));
        process.exit(0);
    } catch (err) {
        console.error('Error fetching settings:', err);
        process.exit(1);
    }
}

checkRecentSettings();
