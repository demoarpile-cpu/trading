const cron = require('node-cron');
const db = require('../config/db');
const { getMcxBaseScrip } = require('../utils/symbolHelper');
const mockEngine = require('../utils/mockEngine');
const { logAction } = require('../controllers/systemController');

/**
 * Runs every minute — checks if it's the configured square-off time (Rollover Time)
 * to verify if clients have sufficient balance for overnight HOLDING margins.
 */
const startRolloverMarginJob = () => {
    cron.schedule('* * * * *', async () => {
        try {
            // 1. Fetch all expiry rules
            const [rules] = await db.execute('SELECT * FROM expiry_rules');
            if (!rules.length) return;

            const now = new Date();
            const currentH = now.getHours();
            const currentM = now.getMinutes();

            // 2. Fetch all potentially relevant trades for the whole system once
            const [allTrades] = await db.execute(`
                SELECT t.id, t.user_id, t.symbol, t.qty, t.margin_used, t.market_type, t.type, t.entry_price,
                       u.balance,
                       cs.config_json
                FROM trades t
                JOIN users u ON t.user_id = u.id
                JOIN client_settings cs ON t.user_id = cs.user_id
                WHERE t.status = 'OPEN' AND t.is_pending = 0 AND t.market_type IN ('MCX', 'FOREX', 'CRYPTO', 'COMEX')
            `);

            if (allTrades.length === 0) return;

            // Fetch all users once for hierarchy building
            const [allUsers] = await db.execute('SELECT id, parent_id FROM users');

            for (const rule of rules) {
                if (rule.auto_square_off !== 'Yes') continue;

                const [hh, mm] = (rule.square_off_time || '23:30').split(':');
                if (parseInt(hh) !== currentH || parseInt(mm) !== currentM) continue;

                console.log(`[RolloverCheck] Starting daily margin check for Admin #${rule.user_id} at ${hh}:${mm}...`);

                // Identify descendants of this admin
                const descendantIdsSet = new Set();
                const queue = [rule.user_id];
                const processed = new Set();
                while (queue.length > 0) {
                    const pid = queue.shift();
                    if (processed.has(pid)) continue;
                    processed.add(pid);
                    const children = allUsers.filter(u => u.parent_id === pid).map(u => u.id);
                    for (const cid of children) descendantIdsSet.add(cid);
                    queue.push(...children);
                }

                if (descendantIdsSet.size === 0) continue;

                // Process trades belonging to these descendants
                const relevantTrades = allTrades.filter(t => descendantIdsSet.has(t.user_id));
                if (relevantTrades.length === 0) continue;

                for (const trade of relevantTrades) {
                    try {
                        const clientConfig = JSON.parse(trade.config_json || '{}');
                        let totalHoldingRequired = 0;
                        const currentPrice = mockEngine.getPrice(trade.symbol) || trade.entry_price;

                        if (trade.market_type === 'MCX') {
                            const brokerMargins = clientConfig.brokerMcxMargins || {};
                            const baseScrip = getMcxBaseScrip(trade.symbol);
                            const holdingMarginKey = `${baseScrip} HOLDING`;
                            const holdingMarginPerLot = parseFloat(brokerMargins[holdingMarginKey] || 0);
                            
                            if (holdingMarginPerLot <= 1) continue;
                            totalHoldingRequired = holdingMarginPerLot * trade.qty;
                        } else {
                            let holdingExposure = 0;
                            if (trade.market_type === 'FOREX') holdingExposure = parseFloat(clientConfig.forexConfig?.holdingMargin || 0);
                            else if (trade.market_type === 'CRYPTO') holdingExposure = parseFloat(clientConfig.cryptoConfig?.holdingMargin || 0);
                            else if (trade.market_type === 'COMEX') holdingExposure = parseFloat(clientConfig.comexConfig?.holdingMargin || 0);

                            const turnover = currentPrice * trade.qty;
                            if (holdingExposure > 1) totalHoldingRequired = turnover / holdingExposure;
                            else totalHoldingRequired = turnover * 0.1;
                        }

                        const shortfall = totalHoldingRequired - parseFloat(trade.margin_used);
                        if (shortfall <= 0) continue;

                        const userBalance = parseFloat(trade.balance);
                        if (userBalance >= shortfall) {
                            await db.execute('UPDATE users SET balance = balance - ? WHERE id = ?', [shortfall, trade.user_id]);
                            await db.execute('UPDATE trades SET margin_used = ? WHERE id = ?', [totalHoldingRequired, trade.id]);
                            console.log(`[RolloverCheck] Admin #${rule.user_id}: Updated margin for trade #${trade.id}. New Total: ${totalHoldingRequired.toFixed(2)}`);
                        } else {
                            console.log(`[RolloverCheck] Admin #${rule.user_id}: Insufficient balance for trade #${trade.id}. Force closing...`);
                            const pnl = trade.type === 'BUY'
                                ? (currentPrice - trade.entry_price) * trade.qty
                                : (trade.entry_price - currentPrice) * trade.qty;

                            const refundAmount = parseFloat(trade.margin_used) + pnl;
                            await db.execute('UPDATE trades SET status = "CLOSED", exit_price = ?, exit_time = NOW(), pnl = ? WHERE id = ?', [currentPrice, pnl, trade.id]);
                            await db.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [refundAmount, trade.user_id]);
                        }
                    } catch (err) {
                        console.error(`[RolloverCheck] Error processing trade #${trade.id}:`, err.message);
                    }
                }
            }
        } catch (err) {
            console.error('[RolloverCheck] Cron error:', err.message);
        }
    });

    console.log('[RolloverCheck] Per-admin daily margin rollover job started');
};

module.exports = { startRolloverMarginJob };
