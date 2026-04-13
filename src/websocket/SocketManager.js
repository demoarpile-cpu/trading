const { Server } = require('socket.io');

/**
 * Socket Manager
 * Handles socket.io initialization and provides a getter for the io instance.
//  */ 
//  test
class SocketManager {
    constructor() {
        this.io = null;
    }

    init(server, allowedOrigins) {
        this.io = new Server(server, {
            cors: {
                origin: allowedOrigins,
                methods: ["GET", "POST"]
            },
            // ✅ Keep connection alive with ping/pong
            pingInterval: 25000,
            pingTimeout: 60000,
            transports: ['websocket', 'polling']  // Enable both
        });

        this.io.on('connection', (socket) => {
            // console.log('User connected:', socket.id);

            socket.on('join', ({ userId, role }) => {
                if (userId) socket.join(`user:${userId}`);
                if (role) socket.join(`role:${role}`);
            });

            socket.on('subscribe_market', (scrips) => {
                const marketDataService = require('../services/MarketDataService');
                const instrumentService = require('../services/InstrumentService');

                if (Array.isArray(scrips)) {
                    scrips.forEach(async (symbol) => {
                        try {
                            const instrument = await instrumentService.getInstrumentBySymbol(symbol);
                            if (instrument) {
                                marketDataService.subscribe(symbol, instrument.instrument_token);
                            }
                        } catch (e) {
                            console.error(`Subscription failed for ${symbol}:`, e.message);
                        }
                    });
                }
            });

            socket.on('disconnect', () => {
                // console.log('User disconnected');
            });
        });

        return this.io;
    }

    getIo() {
        return this.io;
    }
}

module.exports = new SocketManager();
