const cron = require('node-cron');
const db = require('../config/db');

/**
 * Runs every minute — checks if it's the configured square-off time
 * on any scrip's expiry day, then force-closes all open trades for that scrip.
 */
const startExpirySquareOffJob = () => {
    cron.schedule('* * * * *', async () => {
        try {
            const [ruleRows] = await db.execute('SELECT * FROM expiry_rules WHERE id = 1');
            const rule = ruleRows[0];
            if (!rule || rule.auto_square_off !== 'Yes') return;

            const [hh, mm] = (rule.square_off_time || '11:30').split(':');
            const now = new Date();
            if (parseInt(hh) !== now.getHours() || parseInt(mm) !== now.getMinutes()) return;

            // Find scrips expiring today
            const today = now.toISOString().split('T')[0];
            const [scrips] = await db.execute(
                'SELECT symbol FROM scrip_data WHERE expiry_date = ?',
                [today]
            );
            if (!scrips.length) return;

            for (const scrip of scrips) {
                const symbol = scrip.symbol;

                // Get all open trades for this symbol
                const [trades] = await db.execute(
                    `SELECT t.id, t.user_id, t.type, t.qty, t.entry_price, t.market_type
                     FROM trades t
                     WHERE t.symbol = ? AND t.status = 'OPEN' AND t.is_pending = 0`,
                    [symbol]
                );

                if (!trades.length) continue;

                console.log(`[ExpirySquareOff] Auto closing ${trades.length} trades for ${symbol} (expiry: ${today})`);

                for (const trade of trades) {
                    try {
                        // Get current price from mockEngine if available, otherwise use entry_price
                        let exitPrice = trade.entry_price;
                        try {
                            const mockEngine = require('../utils/mockEngine');
                            const mp = mockEngine.getPrice(symbol);
                            if (mp && mp > 0) exitPrice = mp;
                        } catch (_) {}

                        const pnl = trade.type === 'BUY'
                            ? (exitPrice - trade.entry_price) * trade.qty
                            : (trade.entry_price - exitPrice) * trade.qty;

                        await db.execute(
                            `UPDATE trades SET status = 'CLOSED', exit_price = ?, pnl = ?, closed_at = NOW()
                             WHERE id = ?`,
                            [exitPrice, pnl, trade.id]
                        );

                        // Update user balance
                        await db.execute(
                            'UPDATE users SET balance = balance + ? WHERE id = ?',
                            [pnl, trade.user_id]
                        );

                        console.log(`[ExpirySquareOff] Closed trade #${trade.id} for user ${trade.user_id}, PnL: ${pnl}`);
                    } catch (err) {
                        console.error(`[ExpirySquareOff] Failed to close trade #${trade.id}:`, err.message);
                    }
                }
            }
        } catch (err) {
            console.error('[ExpirySquareOff] Cron error:', err.message);
        }
    });

    console.log('[ExpirySquareOff] Auto square-off cron job started');
};

module.exports = { startExpirySquareOffJob };
