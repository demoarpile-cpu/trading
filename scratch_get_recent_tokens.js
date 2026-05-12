const mysql = require('mysql2/promise');
require('dotenv').config();

async function getRecentTokensProduction() {
    try {
        const pool = mysql.createPool({
            uri: process.env.DATABASE_URL
        });
        
        const [rows] = await pool.execute(`
            SELECT id, user_id, kite_user_id, access_token, saved_at
            FROM user_kite_sessions
            ORDER BY id DESC 
            LIMIT 5
        `);
        console.log('--- Recent Access Tokens (Production DB) ---');
        console.log(rows);
        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

getRecentTokensProduction();
