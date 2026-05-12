const db = require('./src/config/db');

async function getAllTokens() {
    try {
        const [rows] = await db.execute(`
            SELECT id, user_id, kite_user_id, access_token, saved_at
            FROM user_kite_sessions
        `);
        console.log('--- All Access Tokens (Local DB) ---');
        console.log(rows);
        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

getAllTokens();
