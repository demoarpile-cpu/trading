const fs = require('fs');
const path = require('path');
const kiteService = require('../utils/kiteService');

const CONTRACT_FILE = path.join(__dirname, '../data/selected_contracts.json');
const CONTRACTS_CACHE_FILE = path.join(__dirname, '../data/contracts_cache.json');
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24 hours

// Ensure data directory exists
const dataDir = path.dirname(CONTRACT_FILE);
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize or load selected contracts
let selectedContracts = [];
function loadSelectedContracts() {
    try {
        if (fs.existsSync(CONTRACT_FILE)) {
            const data = fs.readFileSync(CONTRACT_FILE, 'utf8');
            selectedContracts = JSON.parse(data) || [];
        }
    } catch (err) {
        console.error('Error loading selected contracts:', err.message);
        selectedContracts = [];
    }
}

// Cache for all contracts from Kite API
let allContractsCache = null;
let cacheTimestamp = 0;

// Parse contracts from Kite instruments data
function parseContractsFromKite(instruments) {
    const contracts = [];
    const seen = new Set();

    instruments.forEach(instr => {
        // Filter for futures only (ending with FUT)
        if (!instr.tradingsymbol || !instr.tradingsymbol.endsWith('FUT')) return;

        const symbol = `${instr.exchange}:${instr.tradingsymbol}`;

        // Avoid duplicates
        if (seen.has(symbol)) return;
        seen.add(symbol);

        // Extract commodity name and expiry from trading symbol
        // Format: CRUDEOIL26APRFUT → name: CRUDEOIL, expiry: 26APR
        const match = instr.tradingsymbol.match(/^([A-Z]+)(\d{1,2}[A-Z]{3}\d{0,2})FUT$/);

        if (match) {
            const [, name, expiry] = match;
            contracts.push({
                symbol,
                name,
                expiry,
                segment: instr.exchange,
                instrument_token: instr.instrument_token
            });
        }
    });

    return contracts;
}

// Fetch contracts dynamically from Kite API
async function getAllContractsFromKite() {
    try {
        // Check cache first
        if (allContractsCache && (Date.now() - cacheTimestamp) < CACHE_DURATION) {
            console.log('📦 Using cached contracts');
            return allContractsCache;
        }

        console.log('🔄 Fetching contracts from Kite API...');
        const instruments = await kiteService.getInstruments();

        if (!instruments || instruments.length === 0) {
            throw new Error('No instruments returned from Kite API');
        }

        const contracts = parseContractsFromKite(instruments);
        console.log(`✅ Fetched ${contracts.length} contracts from Kite API`);

        // Save cache
        allContractsCache = contracts;
        cacheTimestamp = Date.now();

        try {
            fs.writeFileSync(CONTRACTS_CACHE_FILE, JSON.stringify({
                timestamp: cacheTimestamp,
                data: contracts
            }, null, 2));
        } catch (e) {
            console.warn('⚠️ Could not save contracts cache:', e.message);
        }

        return contracts;
    } catch (err) {
        console.error('❌ Error fetching from Kite API:', err.message);

        // Fall back to cached file if it exists
        try {
            if (fs.existsSync(CONTRACTS_CACHE_FILE)) {
                const cached = JSON.parse(fs.readFileSync(CONTRACTS_CACHE_FILE, 'utf8'));
                console.log('📂 Using offline cache');
                allContractsCache = cached.data;
                cacheTimestamp = cached.timestamp;
                return cached.data;
            }
        } catch (e) {
            console.error('No cache available:', e.message);
        }

        // Return empty array if everything fails
        return [];
    }
}

loadSelectedContracts();

// Get all available contracts
exports.getAllContracts = async (req, res) => {
    try {
        const allContracts = await getAllContractsFromKite();

        const contracts = allContracts.map(contract => ({
            ...contract,
            isSelected: selectedContracts.includes(contract.symbol)
        }));

        res.json({
            status: 'success',
            total: contracts.length,
            data: contracts
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Get selected contracts only
exports.getSelectedContracts = async (req, res) => {
    try {
        const allContracts = await getAllContractsFromKite();
        const selected = allContracts.filter(contract =>
            selectedContracts.includes(contract.symbol)
        );

        res.json({
            status: 'success',
            count: selected.length,
            data: selected.map(c => c.symbol)
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Save selected contracts
exports.saveContractSelection = async (req, res) => {
    try {
        const { contracts } = req.body;

        if (!Array.isArray(contracts)) {
            return res.status(400).json({ error: 'contracts must be an array' });
        }

        // Validate that all selected contracts exist
        const allContracts = await getAllContractsFromKite();
        const validSymbols = allContracts.map(c => c.symbol);
        const invalidSymbols = contracts.filter(c => !validSymbols.includes(c));

        if (invalidSymbols.length > 0) {
            return res.status(400).json({
                error: 'Invalid contract symbols',
                invalid: invalidSymbols
            });
        }

        // Save to file
        selectedContracts = contracts;
        fs.writeFileSync(CONTRACT_FILE, JSON.stringify(contracts, null, 2));

        res.json({
            status: 'success',
            message: `${contracts.length} contracts selected and saved`,
            selected: contracts
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};

// Search contracts
exports.searchContracts = async (req, res) => {
    try {
        const { q } = req.query;
        const allContracts = await getAllContractsFromKite();

        if (!q) {
            return res.json({
                status: 'success',
                total: allContracts.length,
                data: allContracts.map(contract => ({
                    ...contract,
                    isSelected: selectedContracts.includes(contract.symbol)
                }))
            });
        }

        const searchTerm = q.toLowerCase();
        const filtered = allContracts.filter(contract =>
            contract.name.toLowerCase().includes(searchTerm) ||
            contract.symbol.toLowerCase().includes(searchTerm) ||
            contract.expiry.toLowerCase().includes(searchTerm)
        ).map(contract => ({
            ...contract,
            isSelected: selectedContracts.includes(contract.symbol)
        }));

        res.json({
            status: 'success',
            total: filtered.length,
            data: filtered
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
};
