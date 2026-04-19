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
            // 1. Check if it's square-off time
            const [ruleRows] = await db.execute('SELECT square_off_time, auto_square_off FROM expiry_rules WHERE id = 1');
            const rule = ruleRows[0];
            if (!rule || rule.auto_square_off !== 'Yes') return;

            const [hh, mm] = (rule.square_off_time || '23:30').split(':');
            const now = new Date();
            if (parseInt(hh) !== now.getHours() || parseInt(mm) !== now.getMinutes()) return;

            console.log(`[RolloverCheck] Starting daily margin check at ${hh}:${mm}...`);

            // 2. Fetch all OPEN trades (excluding pending orders)
            const [trades] = await db.execute(`
                SELECT t.id, t.user_id, t.symbol, t.qty, t.margin_used, t.market_type, t.type, t.entry_price,
                       u.balance,
                       cs.config_json
                FROM trades t
                JOIN users u ON t.user_id = u.id
                JOIN client_settings cs ON t.user_id = cs.user_id
                WHERE t.status = 'OPEN' AND t.is_pending = 0 AND t.market_type = 'MCX'
            `);

            if (trades.length === 0) return;

            for (const trade of trades) {
                try {
                    const clientConfig = JSON.parse(trade.config_json || '{}');
                    const brokerMargins = clientConfig.brokerMcxMargins || {};
                    const baseScrip = getMcxBaseScrip(trade.symbol);
                    
                    // 3. Get Holding Margin Setting
                    const holdingMarginKey = `${baseScrip} HOLDING`;
                    const holdingMarginPerLot = parseFloat(brokerMargins[holdingMarginKey] || 0);

                    // If no specific holding margin (>1), we treat it as no extra requirement
                    if (holdingMarginPerLot <= 1) continue;

                    const totalHoldingRequired = holdingMarginPerLot * trade.qty;
                    const shortfall = totalHoldingRequired - parseFloat(trade.margin_used);

                    if (shortfall <= 0) {
                        // Already covered or no change needed
                        continue;
                    }

                    // 4. Validate Balance
                    if (parseFloat(trade.balance) >= shortfall) {
                        // Enough balance -> Deduct and Update Margin
                        await db.execute(
                            'UPDATE users SET balance = balance - ? WHERE id = ?',
                            [shortfall, trade.user_id]
                        );
                        await db.execute(
                            'UPDATE trades SET margin_used = ? WHERE id = ?',
                            [totalHoldingRequired, trade.id]
                        );
                        console.log(`[RolloverCheck] ✅ Updated margin for trade #${trade.id} (User: ${trade.user_id}). Added: ${shortfall}, New Total: ${totalHoldingRequired}`);
                        
                        await logAction(0, 'ROLLOVER_MARGIN_UPDATE', 'trades', 
                            `Increased margin for trade #${trade.id} from ${trade.margin_used} to ${totalHoldingRequired} (Shortfall ${shortfall} deducted)`);
                    } else {
                        // INSUFFICIENT BALANCE -> FORCE CLOSE (Square-off)
                        console.log(`[RolloverCheck] ❌ Insufficient balance for trade #${trade.id} (User: ${trade.user_id}). Required: ${shortfall}, Available: ${trade.balance}. Force closing...`);
                        
                        // Get current market price
                        const currentPrice = mockEngine.getPrice(trade.symbol) || trade.entry_price;
                        
                        // Calculate PnL
                        const pnl = trade.type === 'BUY'
                            ? (currentPrice - trade.entry_price) * trade.qty
                            : (trade.entry_price - currentPrice) * trade.qty;

                        // Release margin + Add PnL
                        const refundAmount = parseFloat(trade.margin_used) + pnl;

                        await db.execute(
                            'UPDATE trades SET status = "CLOSED", exit_price = ?, exit_time = NOW(), pnl = ? WHERE id = ?',
                            [currentPrice, pnl, trade.id]
                        );
                        await db.execute(
                            'UPDATE users SET balance = balance + ? WHERE id = ?',
                            [refundAmount, trade.user_id]
                        );

                        console.log(`[RolloverCheck] 🛡️ Force closed trade #${trade.id} @ ${currentPrice}. Refunded: ${refundAmount.toFixed(2)} (Margin: ${trade.margin_used} + PnL: ${pnl.toFixed(2)})`);
                        
                        await logAction(0, 'FORCE_CLOSE_ROLLOVER', 'trades', 
                            `Force closed trade #${trade.id} due to insufficient rollover margin. Required: ${totalHoldingRequired}, Balance: ${trade.balance}`);
                    }
                } catch (err) {
                    console.error(`[RolloverCheck] Error processing trade #${trade.id}:`, err.message);
                }
            }
        } catch (err) {
            console.error('[RolloverCheck] Cron error:', err.message);
        }
    });

    console.log('[RolloverCheck] Daily margin rollover job started');
};

module.exports = { startRolloverMarginJob };
