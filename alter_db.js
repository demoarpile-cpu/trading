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
        
        try {
            await connection.query("ALTER TABLE expiry_rules ADD COLUMN mcx_square_off_time VARCHAR(10) DEFAULT '23:30';");
            console.log("Added mcx_square_off_time");
        } catch (e) { console.log(e.message); }
        
        try {
            await connection.query("ALTER TABLE expiry_rules ADD COLUMN global_square_off_time VARCHAR(10) DEFAULT '23:30';");
            console.log("Added global_square_off_time");
        } catch (e) { console.log(e.message); }

        console.log("DB Altered successfully");
        process.exit(0);
    } catch (e) {
        console.error(e);
        process.exit(1);
    }
})();
