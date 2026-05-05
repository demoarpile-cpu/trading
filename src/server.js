require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const express = require('express');
const http = require('http');
const cors = require('cors');
const compression = require('compression');
const { initializeCache } = require('./utils/cacheManager');
const socketManager = require('./websocket/SocketManager');
const marketDataService = require('./services/MarketDataService');
const mockEngine = require('./utils/mockEngine');
const paperTradingEngine = require('./trading-engine/PaperTradingEngine');
const { setIo } = require('./config/socket');
const runMigrations = require('./config/migrate');



const app = express();
app.set('trust proxy', true);
const server = http.createServer(app);

const ALLOWED_ORIGINS = [
    'http://localhost:5173',
    'http://localhost:5174',
    'http://localhost:8081',
    'https://traderss.kiaantechnology.com',
    process.env.FRONTEND_URL
].filter(Boolean);

const io = socketManager.init(server, ALLOWED_ORIGINS);
setIo(io);

// Start Paper Trading Engine moved inside migration callback

const authRoutes = require('./routes/authRoutes');
const tradeRoutes = require('./routes/tradeRoutes');
const userRoutes = require('./routes/userRoutes');
const fundRoutes = require('./routes/fundRoutes');
const securityRoutes = require('./routes/securityRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const signalRoutes = require('./routes/signalRoutes');
const systemRoutes = require('./routes/systemRoutes');
const requestRoutes = require('./routes/requestRoutes');
const accountRoutes = require('./routes/accountRoutes');
const portfolioRoutes = require('./routes/portfolioRoutes');
const supportRoutes = require('./routes/supportRoutes');
const aiRoutes = require('./routes/aiRoutes');
const { aiParse, executeVoiceCommand, smartCommand, masterCommand } = require('./controllers/aiController');
const kiteRoutes = require('./routes/kiteRoutes');
const contractRoutes = require('./routes/contractRoutes');
const bankRoutes = require('./routes/bankRoutes');
const newClientBankRoutes = require('./routes/newClientBankRoutes');
const adminRoutes = require('./routes/adminRoutes');
const notificationRoutes = require('./routes/notificationRoutes');
const alertRoutes = require('./routes/alertRoutes');
const marginRoutes = require('./routes/marginRoutes');
const { logIp } = require('./middleware/logger');

// Middleware
app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(compression({
    level: 6,  // Compression level (0-9, 6 is good balance)
    threshold: 1024  // Only compress responses > 1KB
}));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use(logIp); // Log IP for every authenticated request

// Serve uploaded files statically
const path = require('path');
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

const paperRoutes = require('./routes/paperRoutes');

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/trades', tradeRoutes);
app.use('/api/users', userRoutes);
app.use('/api/funds', fundRoutes);
app.use('/api/security', securityRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/signals', signalRoutes);
app.use('/api/system', systemRoutes);
app.use('/api/requests', requestRoutes);
app.use('/api/accounts', accountRoutes);
app.use('/api/portfolio', portfolioRoutes);
app.use('/api/support', supportRoutes);
app.use('/api/ai', aiRoutes);
app.use('/api/kite', kiteRoutes);
app.use('/api/contracts', contractRoutes);
app.use('/api/bank', bankRoutes);
app.use('/api/new-client-bank', newClientBankRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/alerts', alertRoutes);
app.use('/api/margin', marginRoutes);
app.use('/api/paper-trading', paperRoutes);

const marketDataRoutes = require('./routes/marketDataRoutes');
app.use('/api/market-data', marketDataRoutes);

// ── Root-level voice AI routes (no /api prefix, no auth required for direct access)
app.post('/ai-parse', aiParse);
app.post('/execute-command', executeVoiceCommand);
app.post('/smart-command', smartCommand);
app.post('/master-command', masterCommand);

// Routes Placeholder
app.get('/', (req, res) => {
    res.send('Traders API is running...');
});

// ── Socket Logic handled in SocketManager.js ──
// NOTE: Internal socket event listeners (join, subscribe_market) are 
// managed in src/websocket/SocketManager.js to allow modular integration 
// with PaperTradingEngine and MarketDataService.

// ── Market Data Initialization ──
// Handled inside migration callback

const PORT = process.env.PORT || 5000;

// Share io instance with controllers (before migrations)
setIo(io);

// Auto-sync Kite instruments into database
async function syncKiteInstrumentsOnStartup() {
    try {
        const kiteService = require('./utils/kiteService');
        const db = require('./config/db');

        if (!kiteService.isAuthenticated()) {
            return;
        }
        const instruments = await kiteService.getInstruments();

        if (!Array.isArray(instruments) || instruments.length === 0) {
            return;
        }

        const seen = new Set();
        let syncCount = 0;

        for (const i of instruments) {
            if (i.exchange === 'NSE' && i.instrument_type === 'EQ') {
                const symbol = i.tradingsymbol;
                const key = `NSE:${symbol}`;
                if (seen.has(key)) continue;
                seen.add(key);

                const lotSize = parseInt(i.lot_size) || 1;
                try {
                    await db.execute(
                        `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                         VALUES (?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE lot_size = VALUES(lot_size), market_type = VALUES(market_type)`,
                        [symbol, lotSize, 50, 'EQUITY']
                    );
                    syncCount++;
                } catch (_) {}
            } else if ((i.exchange === 'MCX' || i.exchange === 'NFO') && i.instrument_type === 'FUT') {
                const symbol = i.name || i.tradingsymbol;
                const key = `${i.exchange}:${symbol}`;
                if (seen.has(key)) continue;
                seen.add(key);

                const lotSize = parseInt(i.lot_size) || 1;
                const marketType = i.exchange === 'MCX' ? 'MCX' : 'NFO';
                try {
                    await db.execute(
                        `INSERT INTO scrip_data (symbol, lot_size, margin_req, market_type)
                         VALUES (?, ?, ?, ?)
                         ON DUPLICATE KEY UPDATE lot_size = VALUES(lot_size), market_type = VALUES(market_type)`,
                        [symbol, lotSize, 50, marketType]
                    );
                    syncCount++;
                } catch (_) {}
            }
        }

    } catch (err) {
    }
}

// Run DB migrations first, then start server
runMigrations()
    .then(async () => {
        // Initialize Redis Cache (safe: fails gracefully if unavailable)
        await initializeCache();

        // Sync Kite instruments (if authenticated)
        await syncKiteInstrumentsOnStartup();

        server.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
        });

        // Initialize Paper Trading Engine after DB is ready (if applicable)
        paperTradingEngine.start();

        // Start Expiry Square-off, Rollover Margin, RMS, Target/SL, and Alert Monitoring services
        const { startExpirySquareOffJob } = require('./services/expirySquareOffService');
        const { startRolloverMarginJob } = require('./services/rolloverMarginService');
        const rmsService = require('./services/RMSService');
        const { startTargetSLMonitoring } = require('./services/targetSLService');
        const { startAlertMonitoring } = require('./services/alertMonitoringService');

        startExpirySquareOffJob();
        startRolloverMarginJob();
        rmsService.start(10000); // Check risk every 10 seconds
        startTargetSLMonitoring(); // Monitor target/SL every 5 seconds
        startAlertMonitoring(); // Monitor price alerts every 3 seconds

        // Initialize Market Data (Real Data Only - No Mock Fallback)
        try {
            const db = require('./config/db');
            const [users] = await db.execute('SELECT id FROM user_kite_sessions LIMIT 1');
            if (users.length > 0) {
                try {
                    await marketDataService.init(users[0].id);
                } catch (tickerErr) {
                    console.log('❌ Market data initialization failed. Only real API data will be shown.');
                }
            } else {
                console.log('⚠️  No Kite sessions found. Waiting for real market data from API.');
            }
        } catch (err) {
            console.log('⚠️  Market initialization error. Only real data will be shown:', err.message);
        }

        // Start Crypto + Forex feeds (Twelve Data) — independent of Kite
        try {
            marketDataService.startCryptoForex();
        } catch (cfErr) {
            console.log('Crypto/Forex feeds unavailable');
        }
    })
    .catch((err) => {
        console.error('❌ Migration failed, server not started:', err.message);
        process.exit(1);
    });

// Trigger nodemon restart

module.exports = { app, io };