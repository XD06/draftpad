const SUPPORTED_EVENTS = new Set([
    'thoughts_update',
    'notes_update',
    'ai_status_update',
    'relations_update',
    'notepad_change'
]);

export class WSClient {
    constructor({ url, reconnectDelay = 3000, maxReconnectDelay = 15000, debug = false } = {}) {
        this.url = url || this.getDefaultUrl();
        this.reconnectDelay = reconnectDelay;
        this.maxReconnectDelay = maxReconnectDelay;
        this.debug = debug;
        this.ws = null;
        this.closedByClient = false;
        this.currentReconnectDelay = reconnectDelay;
        this.messageQueue = [];
        this.reconnectTimer = null;
    }

    getDefaultUrl() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}`;
    }

    connect() {
        this.closedByClient = false;
        clearTimeout(this.reconnectTimer);

        if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
            return;
        }

        this.ws = new WebSocket(this.url);
        this.ws.onopen = () => this.handleOpen();
        this.ws.onmessage = (event) => this.handleMessage(event);
        this.ws.onerror = (error) => this.handleError(error);
        this.ws.onclose = () => this.handleClose();
    }

    close() {
        this.closedByClient = true;
        clearTimeout(this.reconnectTimer);
        if (this.ws) this.ws.close();
    }

    handleOpen() {
        this.currentReconnectDelay = this.reconnectDelay;
        this.flushQueue();
        window.dispatchEvent(new CustomEvent('ws_connected'));
        this.log('WebSocket connected');
    }

    handleMessage(event) {
        let message;
        try {
            message = JSON.parse(event.data);
        } catch (error) {
            console.error('Invalid WebSocket message:', error);
            return;
        }

        const type = message.type === 'update' ? 'notes_update' : message.type;
        if (!SUPPORTED_EVENTS.has(type)) return;

        window.dispatchEvent(new CustomEvent(type, {
            detail: {
                ...message,
                type
            }
        }));
    }

    handleError(error) {
        console.warn('WebSocket error:', error);
    }

    handleClose() {
        this.log('WebSocket closed');
        if (this.closedByClient) return;

        clearTimeout(this.reconnectTimer);
        // Add jitter (0.5x..1.5x) so that when the server restarts, all clients
        // don't reconnect at the exact same instant (thundering herd).
        const jitter = 0.5 + Math.random();
        const delay = Math.min(this.currentReconnectDelay * jitter, this.maxReconnectDelay);
        this.reconnectTimer = setTimeout(() => {
            this.connect();
            this.currentReconnectDelay = Math.min(this.currentReconnectDelay * 1.5, this.maxReconnectDelay);
        }, delay);
    }

    send(message) {
        const payload = JSON.stringify(message);
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(payload);
            return;
        }
        // Cap the offline queue so a long disconnect can't accumulate unbounded
        // updates (which would all flush at once and potentially arrive out of
        // order). Drop oldest when over capacity.
        const MAX_QUEUE = 100;
        if (this.messageQueue.length >= MAX_QUEUE) {
            this.messageQueue.shift();
        }
        this.messageQueue.push(payload);
    }

    sendUpdate(type, payload = {}) {
        this.send({
            type,
            ...payload
        });
    }

    flushQueue() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        while (this.messageQueue.length > 0) {
            this.ws.send(this.messageQueue.shift());
        }
    }

    log(...args) {
        if (this.debug) console.log(...args);
    }
}
