const db = require('./src/config/db');

async function testUpdate() {
    try {
        const id = 109;
        const allowFreshEntry = 0;
        const allowOrdersBetweenHL = 1;
        const tradeEquityUnits = 1;
        
        const sqlParams = [
            id,
            allowFreshEntry,
            allowOrdersBetweenHL,
            tradeEquityUnits,
            90, 70, 120, 0, 0, null, 17
        ];
        
        console.log('Executing test update for 109...');
        await db.execute(`
            INSERT INTO client_settings
                (user_id, allow_fresh_entry, allow_orders_between_hl, trade_equity_units,
                 auto_close_at_m2m_pct, notify_at_m2m_pct, min_time_to_book_profit,
                 scalping_sl_enabled, ban_all_segment_limit_order, config_json, broker_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE
                allow_fresh_entry = VALUES(allow_fresh_entry),
                allow_orders_between_hl = VALUES(allow_orders_between_hl),
                trade_equity_units = VALUES(trade_equity_units),
                auto_close_at_m2m_pct = VALUES(auto_close_at_m2m_pct),
                notify_at_m2m_pct = VALUES(notify_at_m2m_pct),
                min_time_to_book_profit = VALUES(min_time_to_book_profit),
                scalping_sl_enabled = VALUES(scalping_sl_enabled),
                ban_all_segment_limit_order = VALUES(ban_all_segment_limit_order),
                config_json = VALUES(config_json),
                broker_id = VALUES(broker_id)
        `, sqlParams);
        
        const [rows] = await db.execute('SELECT * FROM client_settings WHERE user_id = 109');
        console.log('Result after update:');
        console.log(rows[0]);
        process.exit(0);
    } catch (err) {
        console.error(err);
        process.exit(1);
    }
}

testUpdate();
