// language: JavaScript, file: config/database.js, target: Node.js 18+, pg pool to Neon PostgreSQL
'use strict';

const { Pool } = require('pg');
const logger = require('./logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  logger.error('Unexpected error on idle client', { error: err.message });
});

pool.on('connect', () => {
  logger.debug('New database connection established');
});

/**
 * Execute a query. Returns rows array.
 * @param {string} text - SQL query
 * @param {Array}  params - Query parameters
 */
async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Query executed', { query: text.slice(0, 80), duration, rows: result.rowCount });
    return result;
  } catch (err) {
    logger.error('Query error', { query: text.slice(0, 80), error: err.message });
    throw err;
  }
}

/**
 * Run multiple statements in a transaction.
 * @param {Function} callback - async (client) => {...}
 */
async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

async function testConnection() {
  try {
    const result = await query('SELECT NOW() as now');
    logger.info('Database connected', { time: result.rows[0].now });
    return true;
  } catch (err) {
    logger.error('Database connection failed', { error: err.message });
    return false;
  }
}

module.exports = { query, withTransaction, testConnection, pool };
