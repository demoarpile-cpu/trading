const cron = require('node-cron');
const db = require('../config/db');
const { getMcxBaseScrip } = require('../utils/symbolHelper');

/**
 * Runs every minute — checks if it's the configured square-off time
 * If holding margin > balance for a trade, force-closes it
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
                            await db.execute('UPDATE trades SET status = "CANCELLED", exit_time = NOW(), pnl = 0 WHERE id = ?', [order.id]);
                        } catch (err) {
                            console.error(`[ExpirySquareOff] Failed to cancel pending order #${order.id}:`, err.message);
                        }
                    }
                }

                // ─── 4. CHECK HOLDING MARGIN FOR ALL OPEN TRADES ─────────────────────────
                const [allOpenTrades] = await db.execute(
                    `SELECT t.id, t.user_id, t.symbol, t.type, t.qty, t.entry_price, t.market_type,
                            u.balance, cs.config_json
                     FROM trades t
                     JOIN users u ON t.user_id = u.id
                     JOIN client_settings cs ON t.user_id = cs.user_id
                     WHERE t.status = 'OPEN' AND t.is_pending = 0
                     AND t.user_id IN (${descendantIds.join(',')})
                     AND t.market_type = 'MCX'`
                );

                if (allOpenTrades.length > 0) {
                    const mockEngine = require('../utils/mockEngine');
                    let closedCount = 0;

                    for (const trade of allOpenTrades) {
                        try {
                            const userBalance = parseFloat(trade.balance || 0);
                            let userConfig = {};
                            try { userConfig = JSON.parse(trade.config_json || '{}'); } catch (e) {}

                            // Calculate holding margin for this trade
                            const base = getMcxBaseScrip(trade.symbol);
                            const defaultHolding = 1000000; // Default for MCX
                            let holdingExposure = parseFloat(userConfig?.mcxHoldingMargin || defaultHolding);

                            // Try to get per-instrument holding margin from config
                            if (userConfig?.mcxLotMargins) {
                                if (userConfig.mcxLotMargins[base]?.HOLDING) {
                                    holdingExposure = parseFloat(userConfig.mcxLotMargins[base].HOLDING);
                                } else if (userConfig.mcxLotMargins[`MCX:${base}`]?.HOLDING) {
                                    holdingExposure = parseFloat(userConfig.mcxLotMargins[`MCX:${base}`].HOLDING);
                                } else if (userConfig.mcxLotMargins[trade.symbol]?.HOLDING) {
                                    holdingExposure = parseFloat(userConfig.mcxLotMargins[trade.symbol].HOLDING);
                                }
                            }

                            const holdingMarginRequired = holdingExposure * trade.qty;

                            // Check if balance < holding margin required
                            if (userBalance < holdingMarginRequired) {
                                console.log(`[ExpirySquareOff] 🚨 Holding Margin Check Failed: User #${trade.user_id}, Trade #${trade.id} (${trade.symbol}), Balance=${userBalance}, Required=${holdingMarginRequired}`);

                                // Close at entry price (break-even) since this is a margin-based force closure, not price-based
                                const exitPrice = trade.entry_price;
                                const pnl = 0;

                                // Close the trade
                                await db.execute(
                                    `UPDATE trades SET status = 'CLOSED', exit_price = ?, pnl = ?, exit_time = NOW() WHERE id = ?`,
                                    [exitPrice, pnl, trade.id]
                                );
                                await db.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [pnl, trade.user_id]);
                                closedCount++;
                            }
                        } catch (err) {
                            console.error(`[ExpirySquareOff] Failed to process trade #${trade.id}:`, err.message);
                        }
                    }

                    if (closedCount > 0) {
                        console.log(`[ExpirySquareOff] ✅ Admin #${rule.user_id}: Closed ${closedCount} trades due to holding margin violation`);
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
