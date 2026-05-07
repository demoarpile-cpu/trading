const cron = require('node-cron');
const db = require('../config/db');
const { getMcxBaseScrip } = require('../utils/symbolHelper');

/**
 * Helper to calculate brokerage based on type
 */
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
    return Math.max(0, result);
};

const startExpirySquareOffJob = () => {
    cron.schedule('* * * * *', async () => {
        try {
            const marketDataService = require('./MarketDataService');
            const kiteService = require('../utils/kiteService');
            const tradeService = require('./TradeService');

            const [rules] = await db.execute('SELECT * FROM expiry_rules');
            if (!rules.length) return;

            // ⚠️ TIMEZONE FIX: Railway runs in UTC. Convert to IST (UTC+5:30) before comparing.
            const now = new Date();
            const istNow = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
            const currentH = istNow.getHours();
            const currentM = istNow.getMinutes();
            console.log(`[ExpirySquareOff] ⏰ IST Time: ${String(currentH).padStart(2,'0')}:${String(currentM).padStart(2,'0')} | UTC: ${now.toISOString()}`);

            const [allUsers] = await db.execute('SELECT id, parent_id FROM users');

            for (const rule of rules) {
                if (rule.auto_square_off !== 'Yes') continue;

                const [hh, mm] = (rule.square_off_time || '11:30').split(':');
                if (parseInt(hh) !== currentH || parseInt(mm) !== currentM) continue;

                console.log(`[ExpirySquareOff] 🕒 Square-off reached for Admin #${rule.user_id}`);

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

                const [allOpenTrades] = await db.execute(
                    `SELECT t.*, u.balance, cs.config_json
                     FROM trades t
                     JOIN users u ON t.user_id = u.id
                     JOIN client_settings cs ON t.user_id = cs.user_id
                     WHERE t.status = 'OPEN' AND t.is_pending = 0
                     AND t.user_id IN (${descendantIds.join(',')})`
                );

                for (const trade of allOpenTrades) {
                    try {
                        const userConfig = JSON.parse(trade.config_json || '{}');
                        const mType = (trade.market_type || '').toUpperCase();
                        const isNSE = ['NSE', 'EQUITY', 'NIFTY', 'OPTIONS', 'NFO'].includes(mType);
                        const isMCX = mType === 'MCX';

                        if (!isNSE && !isMCX) continue; // Skip other segments for now

                        let holdingMarginRequired = 0;

                        if (isMCX) {
                            // ✅ MCX LOGIC (Per-Lot)
                            const base = getMcxBaseScrip(trade.symbol);
                            const defaultHolding = 1000000;
                            let holdingExposure = parseFloat(userConfig?.mcxHoldingMargin || defaultHolding);

                            if (userConfig?.mcxLotMargins && userConfig.mcxLotMargins[base]?.HOLDING) {
                                holdingExposure = parseFloat(userConfig.mcxLotMargins[base].HOLDING);
                            } else if (userConfig?.mcxLotMargins && userConfig.mcxLotMargins[trade.symbol]?.HOLDING) {
                                holdingExposure = parseFloat(userConfig.mcxLotMargins[trade.symbol].HOLDING);
                            }

                            holdingMarginRequired = holdingExposure * trade.qty;
                        } 
                        else if (isNSE) {
                            // ✅ NSE/NFO LOGIC (Exposure-based: Turnover / Divisor)
                            const holdingDivisor = parseFloat(userConfig?.equityHoldingMargin || 100);
                            const qty = parseFloat(trade.actual_qty || trade.qty || 0);
                            const entryPrice = parseFloat(trade.entry_price || 0);
                            const turnover = entryPrice * qty;

                            holdingMarginRequired = turnover / (holdingDivisor || 1);
                        }

                        console.log(`[ExpirySquareOff] 📊 Checking Trade #${trade.id} (${trade.symbol}): Required: ${holdingMarginRequired.toFixed(2)}, Available: ${trade.balance}`);

                        // 🎯 If balance is less than required holding margin, square off
                        if (parseFloat(trade.balance) < holdingMarginRequired) {
                            console.log(`[ExpirySquareOff] 🚨 Auto-squaring off trade #${trade.id} for User #${trade.user_id} (Insufficient Holding Margin)`);
                            
                            // Use central TradeService for consistent price/brokerage/balance logic
                            const result = await tradeService.closeTrade(trade.id, null, 0); 
                            
                            if (result.success) {
                                console.log(`[ExpirySquareOff] ✅ Squared off trade #${trade.id} @ ${result.exitPrice || 'market'}`);
                            }
                        }
                    } catch (err) {
                        console.error(`[ExpirySquareOff] Error trade #${trade.id}:`, err.message);
                    }
                }
            }
        } catch (err) {
            console.error('[ExpirySquareOff] Cron error:', err.message);
        }
    });
};

module.exports = { startExpirySquareOffJob };
