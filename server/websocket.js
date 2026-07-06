const crypto = require('crypto');
const WebSocket = require('ws');

function parseCookies(cookieHeader) {
    const out = {};
    if (!cookieHeader) return out;
    for (const part of cookieHeader.split(';')) {
        const idx = part.indexOf('=');
        if (idx === -1) continue;
        const key = part.slice(0, idx).trim();
        const val = part.slice(idx + 1).trim();
        if (key) {
            try { out[key] = decodeURIComponent(val); } catch { out[key] = val; }
        }
    }
    return out;
}

function safeEqual(a, b) {
    try {
        return crypto.timingSafeEqual(Buffer.from(String(a)), Buffer.from(String(b)));
    } catch {
        return false;
    }
}

function createWebSocketHub({ server, validateOrigin, pin, cookieName, debug = false, maxClients = 100 }) {
    const clients = new Map();

    const wss = new WebSocket.Server({
        server,
        verifyClient: (info, done) => {
            const origin = info.req.headers.origin;
            if (!validateOrigin(origin)) {
                console.warn('Blocked connection from origin:', { origin });
                return done(false, 403, 'Forbidden');
            }
            // Require a valid PIN cookie: without this, any same-origin client
            // (e.g. an XSS payload, or a browser left on the login screen) could
            // connect and inject forged update events to all other clients.
            if (pin && cookieName) {
                const cookies = parseCookies(info.req.headers.cookie);
                if (!safeEqual(cookies[cookieName], pin)) {
                    return done(false, 401, 'Unauthorized');
                }
            }
            if (clients.size >= maxClients) {
                console.warn('WebSocket connection rejected: max clients reached', clients.size);
                return done(false, 503, 'Too many connections');
            }
            done(true);
        }
    });

    function sendToAll(message, except = null) {
        const payload = JSON.stringify(message);
        clients.forEach((client) => {
            if (client !== except && client.readyState === WebSocket.OPEN) {
                client.send(payload);
            }
        });
    }

    function broadcastWebSocketMessage(message) {
        sendToAll(message);
    }

    function broadcastUpdate(notepadId, content, senderId = 'api', version = undefined, meta = {}) {
        sendToAll({
            type: 'notes_update',
            notepadId,
            content,
            userId: senderId,
            version,
            saveId: meta.saveId,
            contentHash: meta.contentHash,
            source: meta.source || 'save'
        });
    }

    // Heartbeat: detect half-open TCP connections that never fire 'close',
    // which would otherwise leak ws references in the clients Map.
    const heartbeatInterval = setInterval(() => {
        clients.forEach((ws) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (ws.isAlive === false) {
                if (debug) console.log('Terminating dead WebSocket connection');
                ws.terminate();
                return;
            }
            ws.isAlive = false;
            ws.ping();
        });
    }, 30000);

    wss.on('connection', (ws) => {
        console.log('New WebSocket connection established');
        const clientId = crypto.randomUUID();
        clients.set(clientId, ws);
        let userId = null;
        ws.isAlive = true;

        ws.on('pong', () => { ws.isAlive = true; });

        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message);
                if (debug) console.log('Received WebSocket message:', {
                    type: data.type,
                    userId: data.userId,
                    notepadId: data.notepadId,
                    contentLength: typeof data.content === 'string' ? data.content.length : undefined
                });
                if (data.userId && !userId) userId = data.userId;

                // Only relay collaborative 'update' messages (live multi-tab
                // editing) and 'notepad_change' (lightweight UI sync between
                // tabs — carries no content). Server-originated data events
                // (thoughts_update, relations_update) must NEVER be accepted
                // from a client — that would let any connected client forge
                // data broadcasts to all other clients.
                if (data.type === 'update' && data.notepadId) {
                    if (debug) console.log('Content update from user:', userId, 'notepad:', data.notepadId);
                    sendToAll({
                        type: 'notes_update',
                        notepadId: data.notepadId,
                        content: data.content,
                        userId: data.userId
                    }, ws);
                } else if (data.type === 'notepad_change') {
                    sendToAll(data, ws);
                }
            } catch (error) {
                console.error('WebSocket message error:', error);
            }
        });

        ws.on('error', (err) => {
            if (debug) console.warn('WebSocket error:', err.message);
        });

        ws.on('close', () => {
            clients.delete(clientId);
            if (debug) console.log('WebSocket client disconnected:', userId || clientId);
        });
    });

    wss.on('close', () => {
        clearInterval(heartbeatInterval);
    });

    return {
        wss,
        clients,
        broadcastWebSocketMessage,
        broadcastUpdate
    };
}

module.exports = { createWebSocketHub };
