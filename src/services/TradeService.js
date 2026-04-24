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
            // Get lot_size from scrip_data for accurate P/L
            const [scripRows] = await connection.execute('SELECT lot_size FROM scrip_data WHERE symbol = ?', [trade.symbol]);
            const lotSize = (scripRows.length > 0) ? parseFloat(scripRows[0].lot_size || 1) : 1;

            const finalExitPrice = exitPrice || mockEngine.getPrice(trade.symbol) || trade.entry_price;
            const pnl = trade.type === 'BUY'
                ? (finalExitPrice - trade.entry_price) * trade.qty * lotSize
                : (trade.entry_price - finalExitPrice) * trade.qty * lotSize;

            // 4. Calculate Brokerage & Swap
            let brokerage = 0;
            let swap = 0;
            let brokerSwapRate = 5;

            // Helper: calculate brokerage based on type
            const calcBrokerage = (brokerageVal, brokerageType, qty, exitPrice, entryPrice) => {
                const rate = parseFloat(brokerageVal || 0);
                if (rate <= 0) return 0;
                
                const type = (brokerageType || 'PER_LOT').toUpperCase();
                if (type === 'PER_LOT' || type === 'PER LOT') {
                    return qty * rate;
                } else if (type === 'PER_CRORE' || type === 'PER CRORE') {
                    const turnover = (parseFloat(entryPrice) + parseFloat(exitPrice)) * qty;
                    return (turnover / 10000000) * rate;
                } else {
                    return qty * rate;
                }
            };

            // Clean symbol (remove exchange prefix like "MCX:" and handle formats like GOLD26JUNFUT)
            let rawSymbol = (trade.symbol || '').toUpperCase();
            let cleanSymbol = rawSymbol.includes(':') ? rawSymbol.split(':')[1] : rawSymbol;
            const mType = (trade.market_type || '').toUpperCase();

            // Try to find scrip-specific brokerage in client_settings config
            let scripRate = undefined;

            if (mType === 'MCX') {
                const lotBrokerageMap = { ...clientConfig.mcxLotBrokerage, ...clientConfig.brokerMcxBrokerage };
                // 1. Try exact match on clean symbol
                if (lotBrokerageMap[cleanSymbol] !== undefined) {
                    scripRate = parseFloat(lotBrokerageMap[cleanSymbol]);
                } else {
                    // 2. Try to find if any key in map is a prefix or part of cleanSymbol
                    // Sort keys by length descending to match longest first (e.g., NATURALGAS MINI before NATURALGAS)
                    const sortedKeys = Object.keys(lotBrokerageMap).sort((a, b) => b.length - a.length);
                    for (const key of sortedKeys) {
                        if (cleanSymbol.startsWith(key.toUpperCase().replace(/\s+/g, ''))) {
                            scripRate = parseFloat(lotBrokerageMap[key]);
                            break;
                        }
                    }
                }
            } else if (mType === 'EQUITY') {
                const equityMap = clientConfig.brokerEquityBrokerage || {};
                if (equityMap[cleanSymbol] !== undefined) {
                    scripRate = parseFloat(equityMap[cleanSymbol]);
                } else {
                    const sortedKeys = Object.keys(equityMap).sort((a, b) => b.length - a.length);
                    for (const key of sortedKeys) {
                        if (cleanSymbol.startsWith(key.toUpperCase())) {
                            scripRate = parseFloat(equityMap[key]);
                            break;
                        }
                    }
                }
            }

            if (scripRate !== undefined && scripRate > 0) {
                // Priority 1: Scrip-specific from config
                brokerage = trade.qty * scripRate;
                console.log(`[TradeService] Scrip-specific Brokerage: Raw=${rawSymbol}, Clean=${cleanSymbol}, Rate=${scripRate}, Calculated=${brokerage.toFixed(2)}`);
            } else {
                // Priority 2: Segment Settings from user_segments
                const [segmentRows] = await connection.execute(
                    'SELECT * FROM user_segments WHERE user_id = ? AND segment = ?',
                    [trade.user_id, trade.market_type]
                );

                if (segmentRows.length > 0 && parseFloat(segmentRows[0].brokerage_value) > 0) {
                    const seg = segmentRows[0];
                    brokerage = calcBrokerage(seg.brokerage_value, seg.brokerage_type, trade.qty, finalExitPrice, trade.entry_price);
                    console.log(`[TradeService] Segment ${trade.market_type} Brokerage: Rate=${seg.brokerage_value}, Type=${seg.brokerage_type}, Calculated=${brokerage.toFixed(2)}`);
                } else {
                    // Priority 3: General Fallback from client_settings
                    if (mType === 'MCX') {
                        const rate = parseFloat(clientConfig.brokerMcxBrokerage || clientConfig.mcxBrokerage || 0);
                        brokerage = calcBrokerage(rate, clientConfig.mcxBrokerageType || 'PER_LOT', trade.qty, finalExitPrice, trade.entry_price);
                    } else if (mType === 'EQUITY') {
                        const rate = parseFloat(clientConfig.brokerEquityBrokerage || clientConfig.equityBrokerage || 0);
                        brokerage = calcBrokerage(rate, 'PER_LOT', trade.qty, finalExitPrice, trade.entry_price);
                    } else if (mType === 'OPTIONS') {
                        let rate = 0;
                        if (cleanSymbol.includes('NIFTY') || cleanSymbol.includes('BANKNIFTY')) {
                            rate = parseFloat(clientConfig.brokerOptionsIndexBrokerage || clientConfig.optionsIndexBrokerage || 20);
                        } else if (mType === 'MCX' || cleanSymbol.includes('MCX')) {
                            rate = parseFloat(clientConfig.brokerOptionsMcxBrokerage || clientConfig.optionsMcxBrokerage || 20);
                        } else {
                            rate = parseFloat(clientConfig.brokerOptionsEquityBrokerage || clientConfig.optionsEquityBrokerage || 20);
                        }
                        brokerage = trade.qty * rate;
                    } else if (mType === 'COMEX') {
                        const rate = parseFloat(clientConfig.comexBrokerage || 0);
                        brokerage = calcBrokerage(rate, 'PER_LOT', trade.qty, finalExitPrice, trade.entry_price);
                    } else if (mType === 'FOREX') {
                        const rate = parseFloat(clientConfig.forexBrokerage || 0);
                        brokerage = calcBrokerage(rate, 'PER_LOT', trade.qty, finalExitPrice, trade.entry_price);
                    } else if (mType === 'CRYPTO') {
                        const rate = parseFloat(clientConfig.cryptoBrokerage || 0);
                        brokerage = calcBrokerage(rate, 'PER_LOT', trade.qty, finalExitPrice, trade.entry_price);
                    }
                    
                    if (brokerage > 0) {
                        console.log(`[TradeService] Fallback ${mType} Brokerage Calculated: ${brokerage.toFixed(2)}`);
                    }
                }
            }

            // Calculate Swap if applicable
            if (trade.broker_id) {
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
