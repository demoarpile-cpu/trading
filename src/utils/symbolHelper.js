/**
 * Helper to extract base scrip from MCX symbols (e.g. MCX:CRUDEOIL26APRFUT -> CRUDEOIL)
 */
const getMcxBaseScrip = (symbol) => {
    if (!symbol) return '';
    const s = symbol.split(':').pop().toUpperCase();
    
    // Ordered by length descending to match longest possible prefix first 
    const mcxBases = [
        'GOLDGUINEA', 'GOLDPETAL', 'GOLDM', 'GOLD',
        'SILVERMIC', 'SILVERM', 'SILVER',
        'CRUDEOILM', 'CRUDEOIL',
        'NATGASMINI', 'NATURALGAS',
        'COPPERM', 'COPPER',
        'ZINCMINI', 'ZINC',
        'LEADMINI', 'LEAD',
        'NICKELMINI', 'NICKEL',
        'ALUMINI', 'ALUMINIUM',
        'MENTHAOIL', 'COTTONCNDY', 'COTTON',
        'MCXBULLDEX'
    ];

    for (const base of mcxBases) {
        if (s.startsWith(base)) return base;
    }
    return '';
};

module.exports = { getMcxBaseScrip };
