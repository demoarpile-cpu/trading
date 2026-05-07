const cron = require('node-cron');
const db = require('../config/db');
const { getMcxBaseScrip } = require('../utils/symbolHelper');
const marketDataService = require('./MarketDataService');
const kiteService = require('../utils/kiteService');

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
                     AND t.user_id IN (${descendantIds.join(',')})
                     AND t.market_type = 'MCX'`
                );

                for (const trade of allOpenTrades) {
                    try {
                        const userBalance = parseFloat(trade.balance || 0);
                        let userConfig = {};
                        try { userConfig = JSON.parse(trade.config_json || '{}'); } catch (e) {}

                        const base = getMcxBaseScrip(trade.symbol);
                        const defaultHolding = 1000000;
                        let holdingExposure = parseFloat(userConfig?.mcxHoldingMargin || defaultHolding);

                        if (userConfig?.mcxLotMargins) {
                            if (userConfig.mcxLotMargins[base]?.HOLDING) holdingExposure = parseFloat(userConfig.mcxLotMargins[base].HOLDING);
                        }

                        const holdingMarginRequired = holdingExposure * trade.qty;

                        if (userBalance < holdingMarginRequired) {
                            let exitPrice = null;
                            const searchPatterns = [trade.symbol, `MCX:${trade.symbol}`];

                            for (const pattern of searchPatterns) {
                                const liveData = marketDataService.getPrice(pattern);
                                if (liveData) {
                                    exitPrice = trade.type === 'BUY' ? (liveData.bid || liveData.ltp) : (liveData.ask || liveData.ltp);
                                    if (exitPrice && exitPrice > 0) break;
                                }
                            }

                            if (!exitPrice && kiteService.isAuthenticated()) {
                                try {
                                    const kiteSym = trade.symbol.includes(':') ? trade.symbol : `MCX:${trade.symbol}`;
                                    const quoteRes = await kiteService.getQuote(kiteSym);
                                    const quote = quoteRes[kiteSym] || Object.values(quoteRes)[0];
                                    if (quote) exitPrice = trade.type === 'BUY' ? (quote.depth?.buy?.[0]?.price || quote.last_price) : (quote.depth?.sell?.[0]?.price || quote.last_price);
                                } catch (_) {}
                            }

                            if (!exitPrice || exitPrice <= 0) {
                                const mockEngine = require('../utils/mockEngine');
                                exitPrice = mockEngine.getPrice(base) || trade.entry_price;
                            }

                            const INSTRUMENT_META = {
                                'CRUDEOIL': 100, 'NATURALGAS': 1250, 'GOLD': 100, 'GOLDM': 10,
                                'SILVER': 30, 'SILVERM': 5, 'COPPER': 2500, 'ZINC': 5000,
                                'NICKEL': 1500, 'LEAD': 5000, 'ALUMINIUM': 5000, 'MENTHAOIL': 360,
                                'COTTON': 25, 'BULLDEX': 1, 'GOLDGUINEA': 8, 'GOLDPETAL': 1,
                                'ZINCMINI': 1000, 'LEADMINI': 1000, 'NICKELMINI': 100, 'ALUMINI': 1000,
                                'CRUDEOILM': 10, 'NATGASMINI': 250, 'SILVERMIC': 1
                            };
                            const multiplier = INSTRUMENT_META[base] || 1;

                            const pnl = trade.type === 'BUY'
                                ? (exitPrice - trade.entry_price) * trade.qty * multiplier
                                : (trade.entry_price - exitPrice) * trade.qty * multiplier;

                            // ─── BROKERAGE CALCULATION ───
                            let brokerage = 0;
                            const bType = (userConfig.mcxBrokerageType || 'per_crore').toLowerCase();
                            if (bType === 'per_lot') {
                                const lotBrokerageMap = { ...userConfig.brokerMcxBrokerage, ...userConfig.mcxLotBrokerage };
                                const rate = parseFloat(lotBrokerageMap[base] || lotBrokerageMap[trade.symbol] || userConfig.mcxLotBrokerageDefault || 0);
                                brokerage = trade.qty * rate;
                            } else {
                                const rate = parseFloat(userConfig.mcxBrokerage || 0);
                                const turnover = (parseFloat(trade.entry_price) + parseFloat(exitPrice)) * trade.qty * multiplier;
                                brokerage = (turnover / 10000000) * rate;
                            }

                            const balanceChange = pnl - brokerage;

                            await db.execute(
                                `UPDATE trades SET status = 'CLOSED', exit_price = ?, pnl = ?, brokerage = ?, exit_time = NOW(), closed_by = 'ADMIN' WHERE id = ?`,
                                [exitPrice, pnl, brokerage, trade.id]
                            );
                            await db.execute('UPDATE users SET balance = balance + ? WHERE id = ?', [balanceChange, trade.user_id]);
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
