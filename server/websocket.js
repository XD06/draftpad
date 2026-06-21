const crypto = require('crypto');
const WebSocket = require('ws');

function createWebSocketHub({ server, validateOrigin, debug = false }) {
    const wss = new WebSocket.Server({
        server,
        verifyClient: (info, done) => {
            const origin = info.req.headers.origin;
            const isOriginValid = validateOrigin(origin);
            if (isOriginValid) {
                done(true);
            } else {
                console.warn('Blocked connection from origin:', { origin });
                done(false, 403, 'Forbidden');
            }
        }
    });

    const clients = new Map();

    function sendToAll(message, except = null) {
        clients.forEach((client) => {
            if (client !== except && client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(message));
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

    wss.on('connection', (ws) => {
        console.log('New WebSocket connection established');
        const clientId = crypto.randomUUID();
        clients.set(clientId, ws);
        let userId = null;

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

                if (data.type === 'update' && data.notepadId) {
                    if (debug) console.log('Content update from user:', userId, 'notepad:', data.notepadId);
                    sendToAll({
                        type: 'notes_update',
                        notepadId: data.notepadId,
                        content: data.content,
                        userId: data.userId
                    }, ws);
                } else if (['thoughts_update', 'notes_update', 'relations_update', 'notepad_change'].includes(data.type)) {
                    if (debug) console.log('Broadcasting lightweight message type:', data.type);
                    sendToAll(data, ws);
                }
            } catch (error) {
                console.error('WebSocket message error:', error);
            }
        });

        ws.on('close', () => {
            clients.delete(clientId);
            if (debug) console.log('WebSocket client disconnected:', userId || clientId);
        });
    });

    return {
        wss,
        clients,
        broadcastWebSocketMessage,
        broadcastUpdate
    };
}

module.exports = { createWebSocketHub };
