import { marked } from '/js/marked/marked.esm.js';

export class CollaborationManager {
    constructor({ userId, userColor, currentNotepadId, operationsManager, editor, onNotepadChange, onUserDisconnect, onCursorUpdate,
            settingsManager, toaster, confirmationManager, saveNotes, renameNotepad, addCopyLangButtonsToCodeBlocks
        })
    {
        this.userId = userId;
        this.userColor = userColor;
        this.currentNotepadId = currentNotepadId;
        this.operationsManager = operationsManager;
        this.editor = editor;
        this.onNotepadChange = onNotepadChange;
        this.onUserDisconnect = onUserDisconnect;
        this.onCursorUpdate = onCursorUpdate;
        this.previewPane = document.getElementById('preview-pane');
        this.settingsManager = settingsManager;
        this.toaster = toaster;
        this.wsCount = 1;
        this.confirmationManager = confirmationManager;
        this.saveNotes = saveNotes;
        this.renameNotepad = renameNotepad;
        this.addCopyLangButtonsToCodeBlocks = addCopyLangButtonsToCodeBlocks;

        this.ws = null;
        this.isReceivingUpdate = false;
        this.lastCursorUpdate = 0;
        this.CURSOR_UPDATE_INTERVAL = 50; // More frequent cursor updates
        this.DEBUG = false;
        
        // For cursor update debouncing
        this.cursorUpdateTimeout = null;

        // Websocket message queue to send messages when the connection is not open
        this.messageQueue = [];
        this.messageQueueTimer = null;
        this.debounceDelay = 200; // 200ms debounce delay
    }

    // Initialize WebSocket connection
    setupWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}`;
        
        if (this.DEBUG) {
            console.log('Attempting WebSocket connection to:', wsUrl);
        }
        
        this.ws = new WebSocket(wsUrl);
        this.setupWebSocketHandlers();
    }

    // Set up WebSocket event handlers
    setupWebSocketHandlers() {
        this.ws.onmessage = this.handleWebSocketMessage.bind(this);
        
        this.ws.onclose = () => {
            if (this.DEBUG) {
                console.log('WebSocket connection closed');
            }
            clearTimeout(this.messageQueueTimer);
            setTimeout(() => this.setupWebSocket(), 5000);
        };
        
        this.ws.onopen = () => {
            if (this.DEBUG) {
                console.log('WebSocket connection established');
            }
            this.updateLocalCursor();

            // Send any queued messages
            this.debounceSendQueue();
        };
        
        this.ws.onerror = (error) => {
            console.error('WebSocket error:', error);
            clearTimeout(this.messageQueueTimer);
            this.toaster.show(`Websocket connection error: ${error}`, 'error');
        };
    }

    // Handle incoming WebSocket messages
    handleWebSocketMessage(event) {
        try {
            const data = JSON.parse(event.data);
            if (this.DEBUG) {
                console.log('Received WebSocket message:', data);
            }

            if (data.type === 'user_connected') {
                if (data.count > 1) {
                    this.toastRemoteConnection(true, data);
                    this.wsCount = data.count;
                }
            }
            
            if (data.type === 'cursor' && data.notepadId === this.currentNotepadId) {
                this.handleCursorUpdate(data);
            }
            else if (data.type === 'ack') {
                this.handleOperationAck(data);
            }
            else if (data.type === 'operation' && data.notepadId === this.currentNotepadId) {
                this.handleRemoteOperation(data);
            }
            else if (data.type === 'thoughts_update') {
                window.dispatchEvent(new CustomEvent('thoughts_update', { 
                    detail: { action: data.action, payload: data.payload } 
                }));
            }
            else if (data.type === 'notes_update' && data.notepadId === this.currentNotepadId) {
                this.handleRemoteContentUpdate(data);
            }
            else if (data.type === 'notepad_rename') {
                this.handleNotepadRename(data);
            }
            else if (data.type === 'notepad_change') {
                this.onNotepadChange();
            }
            else if (data.type === 'user_disconnected') {
                this.onUserDisconnect(data.userId);
                this.toastRemoteConnection(false, data);
                this.wsCount = data.count;
            }
        } catch (error) {
            console.error('WebSocket message error:', error);
        }
    }

    // Handle cursor updates from other users
    handleCursorUpdate(data) {
        if (data.userId === this.userId) return;
        this.onCursorUpdate(data.userId, data.position, data.color);
    }

    // Handle operation acknowledgments from the server
    handleOperationAck(data) {
        this.operationsManager.handleOperationAck(data.operationId, data.serverVersion);
    }

    // Handle remote operations from other users
    handleRemoteOperation(data) {
        if (data.userId === this.userId) return;
        this.isReceivingUpdate = true;
        const currentContent = this.editor.value;
        const newContent = this.operationsManager.applyOperation(data.operation, currentContent);
        this.editor.value = newContent;
        this.isReceivingUpdate = false;
    }

    // Handle remote content updates (full sync)
    handleRemoteContentUpdate(data) {
        if (data.userId === this.userId) return;
        this.isReceivingUpdate = true;
        this.editor.value = data.content;
        this.isReceivingUpdate = false;
    }

    handleNotepadRename(data) {
        if (data.notepadId === this.currentNotepadId) {
            this.onNotepadChange(data.newName);
        }
    }

    // Toast for remote connection
    toastRemoteConnection(connected, data) {
        const settings = this.settingsManager.getSettings();
        if (!settings || !settings.enableRemoteConnectionMessages) return;
        const message = connected ? `User ${data.userId} connected` : `User ${data.userId} disconnected`;
        this.toaster.show(message, connected ? 'info' : 'warning');
    }

    // Update local cursor position
    updateLocalCursor() {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
        const position = this.editor.selectionStart;
        this.sendWebSocketMessage({
            type: 'cursor',
            userId: this.userId,
            color: this.userColor,
            notepadId: this.currentNotepadId,
            position: position
        });
    }

    // Send operation to server
    sendOperation(operation) {
        this.sendWebSocketMessage({
            type: 'operation',
            userId: this.userId,
            notepadId: this.currentNotepadId,
            operation: operation
        });
    }

    // Send WebSocket message with queueing
    sendWebSocketMessage(message) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify(message));
        } else {
            this.messageQueue.push(message);
        }
    }

    // Debounce sending queued messages
    debounceSendQueue() {
        if (this.messageQueueTimer) clearTimeout(this.messageQueueTimer);
        this.messageQueueTimer = setTimeout(() => {
            while (this.messageQueue.length > 0) {
                const message = this.messageQueue.shift();
                this.sendWebSocketMessage(message);
            }
        }, this.debounceDelay);
    }
}
