const fs = require('fs');
const path = require('path');
const db = require('../config/db');
const kiteAuthService = require('./KiteAuthService');

const INSTRUMENTS_CACHE = path.join(__dirname, '../../data/instruments.json');

/**
 * Service to manage trading instruments and scrip data.
 */
class InstrumentService {
    
    async syncInstruments(userId) {
        try {
            const kite = await kiteAuthService.getKiteInstance(userId);
            console.log('📡 Fetching instruments from Zerodha...');
            const instruments = await kite.getInstruments();

            if (Array.isArray(instruments) && instruments.length > 0) {
                // Save to file cache for performance
                const dataDir = path.dirname(INSTRUMENTS_CACHE);
                if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
                fs.writeFileSync(INSTRUMENTS_CACHE, JSON.stringify(instruments));
                
                console.log(`✅ Synced ${instruments.length} instruments`);
                return { success: true, count: instruments.length };
            }
            throw new Error('No instruments received');
        } catch (err) {
            console.error('Instrument sync failed:', err.message);
            throw err;
        }
    }

    async getInstrumentBySymbol(symbol) {
        // Search in cache or DB
        // For now, let's load from file cache
        if (!fs.existsSync(INSTRUMENTS_CACHE)) {
            throw new Error('Instruments not synced. Please sync first.');
        }

        const instruments = JSON.parse(fs.readFileSync(INSTRUMENTS_CACHE, 'utf8'));
        // Try exact match or starting with symbol (for futures)
        return instruments.find(i => i.tradingsymbol === symbol || i.name === symbol);
    }

    async searchInstruments(query) {
        if (!fs.existsSync(INSTRUMENTS_CACHE)) return [];
        const instruments = JSON.parse(fs.readFileSync(INSTRUMENTS_CACHE, 'utf8'));
        const q = query.toUpperCase();
        return instruments
            .filter(i => i.tradingsymbol.includes(q) || i.name && i.name.includes(q))
            .slice(0, 20); // Limit results
    }

    getLotSize(symbol) {
        // Placeholder: in a real app, this would be fetched from instrument data
        return 1; 
    }
}

module.exports = new InstrumentService();
