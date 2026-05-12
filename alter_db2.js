require('dotenv').config();
const mysql = require('mysql2/promise');

(async () => {
    try {
        const connection = await mysql.createConnection({
            host: process.env.DB_HOST || 'localhost',
            user: process.env.DB_USER || 'root',
            password: process.env.DB_PASSWORD || '',
            database: process.env.DB_NAME || 'traderdb'
        });
        
        const qs = [
            "ALTER TABLE expiry_rules ADD COLUMN crypto_square_off_time VARCHAR(10) DEFAULT '23:30';",
            "ALTER TABLE expiry_rules ADD COLUMN forex_square_off_time VARCHAR(10) DEFAULT '23:30';",
            "ALTER TABLE expiry_rules ADD COLUMN comex_square_off_time VARCHAR(10) DEFAULT '23:30';"
        ];
        
        for (let q of qs) {
            try { 
                await connection.query(q); 
                console.log("Success:", q); 
            } catch(e) { 
                console.log("Err:", e.message); 
            }
        }
        console.log("DB Altered successfully");
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
