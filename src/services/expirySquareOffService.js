const cron = require('node-cron');
const db = require('../config/db');

/**
 * Runs every minute — checks if it's the configured square-off time
 * on any scrip's expiry day, then force-closes all open trades for that scrip.
 */
const startExpirySquareOffJob = () => {
    cron.schedule('* * * * *', async () => {
        try {
            // 1. Fetch all expiry rules
            const [rules] = await db.execute('SELECT * FROM expiry_rules');
            if (!rules.length) return;

            const now = new Date();
            const currentH = now.getHours();
            const currentM = now.getMinutes();

            // Cache all users to build hierarchy efficiently
            const [allUsers] = await db.execute('SELECT id, parent_id FROM users');

            for (const rule of rules) {
                if (rule.auto_square_off !== 'Yes') continue;

                const [hh, mm] = (rule.square_off_time || '11:30').split(':');
                if (parseInt(hh) !== currentH || parseInt(mm) !== currentM) continue;

                console.log(`[ExpirySquareOff] 🕒 Square-off reached for Admin #${rule.user_id} (${hh}:${mm})`);

                // 2. Find all traders under this Admin/Superadmin
                const descendantIds = [];
                const queue = [rule.user_id];
                const processed = new Set();
                while (queue.length > 0) {
                    const pid = queue.shift();
                    if (processed.has(pid)) continue;
                    processed.add(pid);
                    const children = allUsers.filter(u => u.parent_id === pid).map(u => u.id);
                    descendantIds.push(...children);
                    queue.push(...children);
                }

                if (!descendantIds.length) continue;

                // ─── 3. CANCEL PENDING ORDERS FOR THESE TRADERS ─────────────────────────
                const [pendingOrders] = await db.execute(
                    `SELECT id, user_id, margin_used FROM trades 
                     WHERE status = "OPEN" AND is_pending = 1 AND user_id IN (${descendantIds.join(',')})`
                );

                if (pendingOrders.length > 0) {
                    console.log(`[ExpirySquareOff] Admin #${rule.user_id}: Cancelling ${pendingOrders.length} pending orders...`);
                    for (const order of pendingOrders) {
                        try {
                            const marginRefund = parseFloat(order.margin_used || 0);
                            await db.execute('UPDATE trades SET status = "CANCELLED", exit_time = NOW(), pnl = 0 WHERE id = ?', [order.id]);
                            if (marginRefund > 0) {
                                await db.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [marginRefund, order.user_id]);
                            }
                        } catch (err) {
                            console.error(`[ExpirySquareOff] Failed to cancel pending order #${order.id}:`, err.message);
                        }
                    }
                }

                // ─── 4. SQUARE OFF EXPIRING SCRIPS FOR THESE TRADERS ───────────────────
                const today = now.toISOString().split('T')[0];
                const [expiringScrips] = await db.execute('SELECT symbol FROM scrip_data WHERE expiry_date = ?', [today]);
                
                if (expiringScrips.length > 0) {
                    const symbols = expiringScrips.map(s => s.symbol);
                    const [trades] = await db.execute(
                        `SELECT t.id, t.user_id, t.symbol, t.type, t.qty, t.entry_price 
                         FROM trades t
                         WHERE t.status = 'OPEN' AND t.is_pending = 0 
                         AND t.user_id IN (${descendantIds.join(',')})
                         AND t.symbol IN (${symbols.map(() => '?').join(',')})`,
                        symbols
                    );

                    if (trades.length > 0) {
                        console.log(`[ExpirySquareOff] Admin #${rule.user_id}: Closing ${trades.length} expiring trades...`);
                        const mockEngine = require('../utils/mockEngine');

                        for (const trade of trades) {
                            try {
                                let exitPrice = trade.entry_price;
                                try {
                                    const mp = mockEngine.getPrice(trade.symbol);
                                    if (mp && mp > 0) exitPrice = mp;
                                } catch (_) {}

                                const pnl = trade.type === 'BUY'
                                    ? (exitPrice - trade.entry_price) * trade.qty
                                    : (trade.entry_price - exitPrice) * trade.qty;

                                await db.execute(
                                    `UPDATE trades SET status = 'CLOSED', exit_price = ?, pnl = ?, exit_time = NOW() WHERE id = ?`,
                                    [exitPrice, pnl, trade.id]
                                );
                                await db.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [pnl, trade.user_id]);
                            } catch (err) {
                                console.error(`[ExpirySquareOff] Failed to close trade #${trade.id}:`, err.message);
                            }
                        }
                    }
                }
            }
        } catch (err) {
            console.error('[ExpirySquareOff] Cron error:', err.message);
        }
    });

    console.log('[ExpirySquareOff] Per-admin square-off cron job started');
};

module.exports = { startExpirySquareOffJob };
