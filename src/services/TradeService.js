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
    async closeTrade(tradeId, exitPrice = null, requesterId = 0, providedPnl = null) {
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
            // Use multiplier from INSTRUMENT_META (hardcoded values for MCX/NSE)
            let lotSize = 1;
            const mType = (trade.market_type || '').toUpperCase();

            // INSTRUMENT_META multipliers (from TradeContext.js)
            const INSTRUMENT_META = {
                'CRUDEOIL': 100, 'NATURALGAS': 1250, 'GOLD': 100, 'GOLDM': 10,
                'SILVER': 30, 'SILVERM': 5, 'COPPER': 2500, 'ZINC': 5000,
                'NICKEL': 1500, 'LEAD': 5000, 'ALUMINIUM': 5000, 'MENTHAOIL': 360,
                'COTTON': 25, 'BULLDEX': 1, 'GOLDGUINEA': 8, 'GOLDPETAL': 1,
                'ZINCMINI': 1000, 'LEADMINI': 1000, 'NICKELMINI': 100, 'ALUMINI': 1000,
                'CRUDEOILM': 10, 'NATGASMINI': 250, 'SILVERMIC': 1,
                'TCS': 1, 'RELIANCE': 1, 'SBIN': 1, 'INFY': 1
            };

            if (mType === 'MCX' || mType === 'EQUITY') {
                const baseSymbol = Object.keys(INSTRUMENT_META).find(key => trade.symbol.toUpperCase().includes(key));
                if (baseSymbol && INSTRUMENT_META[baseSymbol]) {
                    lotSize = INSTRUMENT_META[baseSymbol];
                } else {
                    lotSize = 1;
                }
            } else {
                const [scripRows] = await connection.execute('SELECT lot_size FROM scrip_data WHERE symbol = ?', [trade.symbol]);
                if (scripRows.length > 0 && parseFloat(scripRows[0].lot_size) > 1) {
                    lotSize = parseFloat(scripRows[0].lot_size);
                }
            }

            let finalExitPrice = exitPrice;
            if (!finalExitPrice || finalExitPrice <= 0) {
                const { getMcxBaseScrip } = require('../utils/symbolHelper');
                const cleanSymbol = getMcxBaseScrip(trade.symbol);
                const marketDataService = require('./MarketDataService');
                const liveData = marketDataService.getPrice(trade.symbol) || marketDataService.getPrice(`MCX:${trade.symbol}`);
                
                if (liveData) {
                    finalExitPrice = trade.type === 'BUY' ? (liveData.bid || liveData.ltp) : (liveData.ask || liveData.ltp);
                } else {
                    finalExitPrice = mockEngine.getPrice(cleanSymbol) || trade.entry_price;
                }
            }

            // Use provided P/L from frontend if available (calculated at the moment of exit)
            // Otherwise calculate it based on exit price and lot size
            let pnl;
            if (providedPnl !== null && providedPnl !== undefined) {
                pnl = parseFloat(providedPnl);
                console.log(`[TradeService] Using provided P/L: ${pnl}`);
            } else {
                pnl = trade.type === 'BUY'
                    ? (finalExitPrice - trade.entry_price) * trade.qty * lotSize
                    : (trade.entry_price - finalExitPrice) * trade.qty * lotSize;
                console.log(`[TradeService] Calculated P/L: ${pnl}`);
            }

            // 4. Calculate Brokerage & Swap
            let brokerage = 0;
            let swap = 0;
            let brokerSwapRate = 5;

            // Helper: calculate brokerage based on type
            const calcBrokerage = (brokerageVal, brokerageType, qty, exitPrice, entryPrice, multiplier = 1) => {
                const rate = Math.abs(parseFloat(brokerageVal || 0));
                if (rate <= 0) return 0;

                const type = (brokerageType || 'PER_LOT').toUpperCase();
                let result = 0;

                if (type === 'PER_LOT' || type === 'PER LOT') {
                    result = qty * rate;
                } else if (type === 'PER_CRORE' || type === 'PER CRORE') {
                    const turnover = (parseFloat(entryPrice) + parseFloat(exitPrice)) * qty * multiplier;
                    result = (turnover / 10000000) * rate;
                } else {
                    result = qty * rate;
                }

                // Ensure brokerage is never negative
                return Math.max(0, result);
            };

            // Clean symbol (remove exchange prefix like "MCX:" and handle formats like GOLD26JUNFUT)
            let rawSymbol = (trade.symbol || '').toUpperCase();
            let cleanSymbol = rawSymbol.includes(':') ? rawSymbol.split(':')[1] : rawSymbol;

            // Try to find scrip-specific brokerage in client_settings config
            let scripRate = undefined;

            if (mType === 'MCX') {
                // Priority based on mcxBrokerageType
                const brokerageType = (clientConfig.mcxBrokerageType || 'per_crore').toLowerCase();

                // ONLY look for scrip-specific brokerage if in per_lot mode
                if (brokerageType === 'per_lot') {
                    const lotBrokerageMap = { ...clientConfig.brokerMcxBrokerage, ...clientConfig.mcxLotBrokerage };

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
                }
                // If per_crore mode, skip scrip-specific lookup and use general rate in fallback
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
                    brokerage = calcBrokerage(seg.brokerage_value, seg.brokerage_type, trade.qty, finalExitPrice, trade.entry_price, lotSize);
                    console.log(`[TradeService] Segment ${trade.market_type} Brokerage: Rate=${seg.brokerage_value}, Type=${seg.brokerage_type}, Calculated=${brokerage.toFixed(2)}`);
                } else {
                    // Priority 3: General Fallback from client_settings
                    if (mType === 'MCX') {
                        const brokerageType = (clientConfig.mcxBrokerageType || 'per_crore').toLowerCase();
                        let rate = parseFloat(clientConfig.mcxBrokerage || 0);

                        const calcType = brokerageType === 'per_lot' ? 'PER_LOT' : 'PER_CRORE';
                        brokerage = calcBrokerage(rate, calcType, trade.qty, finalExitPrice, trade.entry_price, lotSize);
                    } else if (mType === 'EQUITY') {
                        const rate = parseFloat(clientConfig.brokerEquityBrokerage || clientConfig.equityBrokerage || 0);
                        brokerage = calcBrokerage(rate, 'PER_LOT', trade.qty, finalExitPrice, trade.entry_price, lotSize);
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
                        brokerage = calcBrokerage(rate, 'PER_LOT', trade.qty, finalExitPrice, trade.entry_price, lotSize);
                    } else if (mType === 'FOREX') {
                        const rate = parseFloat(clientConfig.forexBrokerage || 0);
                        brokerage = calcBrokerage(rate, 'PER_LOT', trade.qty, finalExitPrice, trade.entry_price, lotSize);
                    } else if (mType === 'CRYPTO') {
                        const rate = parseFloat(clientConfig.cryptoBrokerage || 0);
                        brokerage = calcBrokerage(rate, 'PER_LOT', trade.qty, finalExitPrice, trade.entry_price, lotSize);
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
            const balanceChange = pnl - brokerage - swap;

            let closedByRole = 'TRADER';
            if (requesterId === 0) {
                closedByRole = 'ADMIN';
            } else {
                const [reqUserRows] = await connection.execute('SELECT role FROM users WHERE id = ?', [requesterId]);
                if (reqUserRows.length > 0 && reqUserRows[0].role !== 'TRADER') {
                    closedByRole = 'ADMIN';
                }
            }

            await connection.execute(
                'UPDATE trades SET status = "CLOSED", exit_price = ?, exit_time = NOW(), pnl = ?, brokerage = ?, swap = ?, closed_by = ? WHERE id = ?',
                [finalExitPrice, pnl, brokerage, swap, closedByRole, tradeId]
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
