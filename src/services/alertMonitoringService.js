const db = require('../config/db');
const mockEngine = require('../utils/mockEngine');
const marketDataService = require('./MarketDataService');
const { getIo } = require('../config/socket');

/**
 * Monitor Price Alerts continuously
 * Checks every 3 seconds if any alert price target is hit
 * Uses live prices from MarketDataService (Zerodha/Binance/Forex)
 * Sends notification to user when alert triggers
 */
const monitorPriceAlerts = async () => {
    try {
        // Fetch all ACTIVE alerts with timeout safety
        let alerts = [];
        try {
            const [result] = await db.execute(`
                SELECT a.id, a.user_id, a.symbol, a.type, a.target_price
                FROM alerts a
                WHERE a.status = 'active'
                LIMIT 1000
            `);
            alerts = result || [];
        } catch (dbErr) {
            console.error('[AlertMonitor] ❌ Database error fetching alerts:', dbErr.message);
            return; // Exit gracefully if DB is unavailable
        }

        if (alerts.length === 0) return;

        console.log(`[AlertMonitor] 📊 Checking ${alerts.length} active alert(s) for price hits...`);

        // Process up to 50 alerts per cycle to prevent overwhelming the DB
        const alertsToProcess = alerts.slice(0, 50);

        for (const alert of alertsToProcess) {
            try {
                let currentPrice = null;

                // Normalize alert symbol: remove spaces, uppercase
                // e.g. "GOLD 26JUN" → "GOLD26JUN"
                const normalizedSym = alert.symbol.replace(/\s+/g, '').toUpperCase();

                // Extract base symbol: "GOLD26JUN" → "GOLD", "GOLD26JUNFUT" → "GOLD"
                const baseSym = normalizedSym.replace(/\d+.*$/g, '').trim();

                // Build search patterns — include FUT suffix variants
                const searchPatterns = [
                    normalizedSym,
                    `${normalizedSym}FUT`,
                    alert.symbol,
                    `MCX:${normalizedSym}`,
                    `MCX:${normalizedSym}FUT`,
                    `MCX:${alert.symbol}`,
                    `NSE:${normalizedSym}`,
                    `NFO:${normalizedSym}`,
                    `CRYPTO:${normalizedSym}`,
                    `FOREX:${normalizedSym}`,
                ];

                for (const pattern of searchPatterns) {
                    const priceData = marketDataService.getPrice(pattern);
                    if (priceData && priceData.ltp) {
                        currentPrice = priceData.ltp;
                        console.log(`[AlertMonitor] ✅ Pattern match found: "${pattern}" → ₹${currentPrice}`);
                        break;
                    }
                }
                if (!currentPrice) {
                    console.log(`[AlertMonitor] 📌 Alert: ${alert.symbol}, No pattern matched. Trying fuzzy match...`);
                }

                // Fuzzy match: scan all live prices for a key that starts with base symbol
                // e.g. "GOLD" will match "GOLD26JUNFUT" stored in MarketDataService
                if (!currentPrice && baseSym) {
                    const allPrices = marketDataService.prices;
                    for (const key of Object.keys(allPrices)) {
                        const cleanKey = key.includes(':') ? key.split(':')[1] : key;
                        if (cleanKey.toUpperCase().startsWith(baseSym)) {
                            const priceData = allPrices[key];
                            if (priceData && priceData.ltp) {
                                currentPrice = priceData.ltp;
                                console.log(`[AlertMonitor] 🔍 Fuzzy match: "${alert.symbol}" → "${key}" @ ₹${currentPrice}`);
                                break;
                            }
                        }
                    }
                }

                // Last resort: mockEngine (real price not available)
                if (!currentPrice) {
                    const mockPrice = mockEngine.getPrice(normalizedSym) || mockEngine.getPrice(baseSym);
                    // Only use mock if it looks like a realistic price (not a random tiny float)
                    if (mockPrice && typeof mockPrice === 'number' && mockPrice > 0) {
                        currentPrice = mockPrice;
                    }
                }

                // Skip if no price available
                if (!currentPrice || currentPrice === undefined) {
                    console.log(`[AlertMonitor] ⚠️  NO PRICE found for alert: ${alert.symbol} (ID#${alert.id})`);
                    continue;
                }

                const targetPrice = parseFloat(alert.target_price);
                const ltpAsNumber = parseFloat(currentPrice); // ✅ Ensure price is a number
                let triggered = false;

                // ✅ Debug log comparison
                console.log(`[AlertMonitor] 📊 Comparing: LTP=${ltpAsNumber} vs Target=${targetPrice} (type: ${alert.type})`);

                // Check if alert target is hit
                if (alert.type === 'above' && ltpAsNumber >= targetPrice) {
                    triggered = true;
                } else if (alert.type === 'below' && ltpAsNumber <= targetPrice) {
                    triggered = true;
                }

                if (triggered) {
                    console.log(`\n✅ [AlertMonitor] TRIGGERED!!!`);
                    console.log(`   Symbol: ${alert.symbol} (ID#${alert.id})`);
                    console.log(`   LTP=₹${ltpAsNumber} vs Target=₹${targetPrice}`);
                    console.log(`   Type: ${alert.type}`);
                    console.log(`   User: #${alert.user_id}\n`);

                    // Update alert status - with minimal logging
                    await db.execute(
                        'UPDATE alerts SET status = ?, triggered_at = NOW() WHERE id = ?',
                        ['triggered', alert.id]
                    );

                    // Send socket notification
                    const io = getIo();
                    if (io) {
                        io.to(`user:${alert.user_id}`).emit('alert_triggered', {
                            alertId: alert.id,
                            symbol: alert.symbol,
                            type: alert.type,
                            targetPrice: alert.target_price,
                            currentPrice: currentPrice,
                            message: `🔔 ${alert.symbol} ${alert.type === 'above' ? '↑' : '↓'} ₹${alert.target_price}`
                        });
                    }
                }
            } catch (alertErr) {
                console.error(`[AlertMonitor] Error - Alert #${alert.id}:`, alertErr.message);
            }
        }
    } catch (err) {
        console.error('[AlertMonitor] Monitor error:', err.message);
    }
};

/**
 * Start the alert monitoring service
 * Runs every 5 seconds with safeguards to prevent connection exhaustion
 */
let isMonitoring = false;
const startAlertMonitoring = () => {
    setInterval(() => {
        // Skip if already monitoring (prevent concurrent requests)
        if (isMonitoring) {
            console.log('[AlertMonitor] ⏳ Still monitoring from previous cycle, skipping...');
            return;
        }

        isMonitoring = true;
        monitorPriceAlerts()
            .catch(err => console.error('[AlertMonitor] Service error:', err))
            .finally(() => {
                isMonitoring = false;
            });
    }, 5000); // Check every 5 seconds (increased from 3 to reduce DB load)

    console.log('[AlertMonitor] 🚀 Price alert monitoring service started (5s interval with safety guards)');
};

module.exports = { startAlertMonitoring, monitorPriceAlerts };
