const db = require('../config/db');
const mockEngine = require('../utils/mockEngine');
const { logAction } = require('../controllers/systemController');
const { invalidateCache } = require('../utils/cacheManager');

/**
 * Service to handle core Trade operations like closing and auto-squaring off.
 */
class TradeService {
    
    /**
     * Closes a single trade by its ID.
     * Reusable for manual close, auto-close, and expiry square-off.
     */
    async closeTrade(tradeId, exitPrice = null, requesterId = 0) {
        const connection = await db.getConnection();
        try {
            await connection.beginTransaction();

            // 1. Fetch trade and client settings
            const [tradeRows] = await connection.execute(
                `SELECT t.*, cs.config_json, cs.broker_id 
                 FROM trades t
                 JOIN client_settings cs ON t.user_id = cs.user_id
                 WHERE t.id = ?`,
                [tradeId]
            );

            if (tradeRows.length === 0) throw new Error('Trade not found');
            const trade = tradeRows[0];
            if (trade.status !== 'OPEN') throw new Error('Trade is already closed');

            const clientConfig = JSON.parse(trade.config_json || '{}');
            const marginToRelease = parseFloat(trade.margin_used || 0);

            // 2. Handle Pending Orders
            if (trade.is_pending == 1) {
                await connection.execute(
                    'UPDATE trades SET status = "CANCELLED", exit_price = entry_price, exit_time = NOW(), pnl = 0 WHERE id = ?',
                    [tradeId]
                );
                await connection.execute(
                    'UPDATE users SET balance = balance + ? WHERE id = ?',
                    [marginToRelease, trade.user_id]
                );
                await connection.commit();
                await logAction(requesterId || trade.user_id, 'CANCEL_TRADE', 'trades', `Cancelled pending order #${trade.id}. Margin refunded: ${marginToRelease}`);
                return { success: true, message: 'Pending order cancelled', pnl: 0 };
            }

            // 3. Normal Market Order Closure
            const finalExitPrice = exitPrice || mockEngine.getPrice(trade.symbol) || trade.entry_price;
            const pnl = trade.type === 'BUY'
                ? (finalExitPrice - trade.entry_price) * trade.qty
                : (trade.entry_price - finalExitPrice) * trade.qty;

            // 4. Calculate Brokerage & Swap
            let brokerage = 0;
            let swap = 0;
            let brokerSwapRate = 5;

            // Segment-specific brokerage
            if (trade.broker_id) {
                if (trade.market_type === 'MCX') {
                    const symbolBrokerage = (clientConfig.brokerMcxBrokerage || {})[trade.symbol];
                    if (symbolBrokerage !== undefined) brokerage = trade.qty * parseFloat(symbolBrokerage);
                } else if (trade.market_type === 'EQUITY') {
                    const symbolBrokerage = (clientConfig.brokerEquityBrokerage || {})[trade.symbol];
                    if (symbolBrokerage !== undefined) brokerage = trade.qty * parseFloat(symbolBrokerage);
                } else if (trade.market_type === 'OPTIONS') {
                    let brokeragePerLot = 0;
                    if (trade.symbol.includes('NIFTY') || trade.symbol.includes('BANKNIFTY')) {
                        brokeragePerLot = parseFloat(clientConfig.brokerOptionsIndexBrokerage || 0);
                    } else if (trade.symbol.includes('MCX')) {
                        brokeragePerLot = parseFloat(clientConfig.brokerOptionsMcxBrokerage || 0);
                    } else {
                        brokeragePerLot = parseFloat(clientConfig.brokerOptionsEquityBrokerage || 0);
                    }
                    brokerage = trade.qty * brokeragePerLot;
                } else if (trade.market_type === 'COMEX') {
                    brokerage = trade.qty * parseFloat(clientConfig.brokerComexBrokerage || 0);
                } else if (trade.market_type === 'FOREX') {
                    brokerage = trade.qty * parseFloat(clientConfig.brokerForexBrokerage || 0);
                } else if (trade.market_type === 'CRYPTO') {
                    brokerage = trade.qty * parseFloat(clientConfig.brokerCryptoBrokerage || 0);
                }

                // Swap Calculation
                const [brokerRows] = await connection.execute('SELECT swap_rate FROM broker_shares WHERE user_id = ?', [trade.broker_id]);
                if (brokerRows.length > 0) brokerSwapRate = parseFloat(brokerRows[0].swap_rate || 5);

                const entryTime = new Date(trade.entry_time);
                const daysHeld = Math.ceil((new Date() - entryTime) / (1000 * 60 * 60 * 24));
                if ((trade.market_type === 'MCX' || trade.market_type === 'EQUITY') && daysHeld > 1) {
                    swap = trade.qty * brokerSwapRate * (daysHeld - 1);
                }
            }

            // 5. Update Database
            const balanceChange = pnl + marginToRelease - brokerage - swap;

            await connection.execute(
                'UPDATE trades SET status = "CLOSED", exit_price = ?, exit_time = NOW(), pnl = ?, brokerage = ?, swap = ? WHERE id = ?',
                [finalExitPrice, pnl, brokerage, swap, tradeId]
            );

            await connection.execute(
                'UPDATE users SET balance = balance + ? WHERE id = ?',
                [balanceChange, trade.user_id]
            );

            await connection.commit();

            // 6. Housekeeping (Logs & Cache)
            await logAction(requesterId || trade.user_id, 'CLOSE_TRADE', 'trades', 
                `Closed trade #${trade.id} @ ${finalExitPrice}. PnL: ${pnl.toFixed(2)}, Brokerage: ${brokerage}, Swap: ${swap}`);
            
            try {
                await invalidateCache(`m2m_${trade.user_id}_TRADER`);
                await invalidateCache(`m2m_${trade.user_id}_BROKER`);
            } catch (_) {}

            return { success: true, pnl, brokerage, swap, balanceChange };
        } catch (err) {
            await connection.rollback();
            throw err;
        } finally {
            connection.release();
        }
    }

    /**
     * Closes all open positions and cancels all pending orders for a user.
     * Used for RMS Auto-Squaring off.
     */
    async closeAllUserTrades(userId, requesterId = 0, reason = 'RMS_AUTO_CLOSE') {
        const [trades] = await db.execute(
            "SELECT id FROM trades WHERE user_id = ? AND status = 'OPEN'",
            [userId]
        );

        const results = [];
        for (const trade of trades) {
            try {
                const res = await this.closeTrade(trade.id, null, requesterId);
                results.push({ id: trade.id, success: true, ...res });
            } catch (err) {
                console.error(`[TradeService] Failed to auto-close trade #${trade.id}:`, err.message);
                results.push({ id: trade.id, success: false, error: err.message });
            }
        }

        if (results.length > 0) {
            await logAction(requesterId, reason, 'users', `Mass squared off ${results.length} trades for user #${userId}`);
        }

        return results;
    }
}

module.exports = new TradeService();
