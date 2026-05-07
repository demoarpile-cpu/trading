const mysql = require('mysql2/promise');
require('dotenv').config();

const dbConfig = {
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'traderdb',
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
};

const check = async () => {
  let connection = null;
  try {
    connection = await mysql.createConnection(dbConfig);

    console.log('📋 scrip_data table schema:\n');
    const [cols] = await connection.execute('DESCRIBE scrip_data');

    cols.forEach(col => {
      console.log(`${col.Field.padEnd(20)} | ${col.Type.padEnd(20)} | ${col.Null === 'YES' ? 'Nullable' : 'NOT NULL'}`);
    });

    console.log('\n📊 Sample data:\n');
    const [sample] = await connection.execute('SELECT * FROM scrip_data LIMIT 3');
    console.log(JSON.stringify(sample, null, 2));

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    if (connection) await connection.end();
  }
};

check();
