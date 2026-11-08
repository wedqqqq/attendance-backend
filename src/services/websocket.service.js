'use strict';

const { WebSocketServer, WebSocket } = require('ws');
const { verifyAccessToken } = require('../utils/jwt');
const logger = require('../config/logger');

// Map: userId → Set<WebSocket>
const adminClients = new Map();

/**
 * Attach WebSocket server to an existing HTTP server.
 * Path: /ws?token=<JWT>
 */
function attachWebSocket(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    // Extract token from query string
    const url = new URL(req.url, `http://${req.headers.host}`);
    const token = url.searchParams.get('token');

    if (!token) {
      ws.close(4001, 'Missing token');
      return;
    }

    let user;
    try {
      user = verifyAccessToken(token);
    } catch {
      ws.close(4001, 'Invalid token');
      return;
    }

    if (user.role !== 'admin') {
      ws.close(4003, 'Admins only');
      return;
    }

    // Register admin client
    if (!adminClients.has(user.sub)) adminClients.set(user.sub, new Set());
    adminClients.get(user.sub).add(ws);
    logger.debug('WS admin connected', { userId: user.sub });

    ws.on('close', () => {
      adminClients.get(user.sub)?.delete(ws);
      logger.debug('WS admin disconnected', { userId: user.sub });
    });

    ws.on('error', (err) => logger.error('WS error', { error: err.message }));

    ws.send(JSON.stringify({ type: 'connected', message: 'Real-time map active' }));
  });

  logger.info('WebSocket server attached at /ws');
  return wss;
}

/**
 * Broadcast a location update to all connected admin clients.
 */
function broadcastLocationUpdate(payload) {
  const message = JSON.stringify({ type: 'location_update', data: payload });
  for (const [, clients] of adminClients) {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(message);
      }
    }
  }
}

/**
 * Broadcast an attendance event (check-in / check-out).
 */
function broadcastAttendanceEvent(payload) {
  const message = JSON.stringify({ type: 'attendance_event', data: payload });
  for (const [, clients] of adminClients) {
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(message);
    }
  }
}

module.exports = { attachWebSocket, broadcastLocationUpdate, broadcastAttendanceEvent };
