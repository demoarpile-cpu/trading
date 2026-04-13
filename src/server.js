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

// Socket.io logic
io.on('connection', (socket) => {
  // console.log('User connected:', socket.id);

  // Client sends { userId, role } right after connecting
  socket.on('join', ({ userId, role }) => {
    if (userId) socket.join(`user:${userId}`);
    if (role) socket.join(`role:${role}`);
  });

  socket.on('subscribe_market', (scrips) => {
    // console.log(`User ${socket.id} subscribed to:`, scrips);
    if (Array.isArray(scrips)) {
      scrips.forEach(s => mockEngine.getPrice(s)); // Ensure mock engine starts tracking them
    }
  });

  socket.on('disconnect', () => {
    // console.log('User disconnected');
  });
});

// ── Market Data Initialization ──
// Handled inside migration callback

const PORT = process.env.PORT || 5000;

// Share io instance with controllers (before migrations)
setIo(io);

// Run DB migrations first, then start server
runMigrations()
    .then(async () => {
        // Initialize Redis Cache (safe: fails gracefully if unavailable)
        await initializeCache();

        server.listen(PORT, () => {
            console.log(`🚀 Server running on port ${PORT}`);
        });

        // Initialize Paper Trading Engine after DB is ready (if applicable)
        paperTradingEngine.start();

        // Start Expiry Square-off cron job
        const { startExpirySquareOffJob } = require('./services/expirySquareOffService');
        startExpirySquareOffJob();

        // Initialize Market Data (with fallback to mock engine)
        try {
            const db = require('./config/db');
            const [users] = await db.execute('SELECT id FROM user_kite_sessions LIMIT 1');
            if (users.length > 0) {
                try {
                    await marketDataService.init(users[0].id);
                    console.log('✅ MarketDataService initialized with real Kite connection');
                } catch (tickerErr) {
                    console.warn('⚠️  Kite ticker failed, falling back to mock engine:', tickerErr.message);
                    marketDataService.startMockEngine();
                }
            } else {
                console.log('ℹ️  No Kite sessions found, starting mock engine');
                marketDataService.startMockEngine();
            }
        } catch (err) {
            console.warn('Market data init failed:', err.message);
            marketDataService.startMockEngine();
        }

        // Start Crypto + Forex feeds (Twelve Data) — independent of Kite
        try {
            marketDataService.startCryptoForex();
            console.log('✅ Crypto + Forex feeds started');
        } catch (cfErr) {
            console.warn('Crypto/Forex feeds failed:', cfErr.message);
        }
    })
    .catch((err) => {
        console.error('❌ Migration failed, server not started:', err.message);
        process.exit(1);
    });

// Trigger nodemon restart

module.exports = { app, io };
