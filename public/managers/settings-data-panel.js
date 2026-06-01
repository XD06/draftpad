export default class SettingsDataPanel {
    constructor({ requestJSON }) {
        if (typeof requestJSON !== 'function') {
            throw new Error('SettingsDataPanel requires requestJSON');
        }
        this.requestJSON = requestJSON;
    }

    status() {
        return this.requestJSON('/api/data-management/status');
    }

    spaces() {
        return this.requestJSON('/api/data-management/s3/spaces');
    }

    selectSpace(prefix) {
        return this.post('/api/data-management/s3/select-space', { prefix });
    }

    inventory({ prefix }) {
        return this.post('/api/data-management/s3/inventory', { prefix });
    }

    importLocalToS3(payload) {
        return this.post('/api/data-management/import-local-to-s3', payload);
    }

    backup(payload) {
        return this.post('/api/data-management/s3/backup', payload);
    }

    deletePrefix(payload) {
        return this.post('/api/data-management/s3/delete', payload);
    }

    localOverwriteS3(payload) {
        return this.post('/api/data-management/local-overwrite-s3', payload);
    }

    s3OverwriteLocal(payload) {
        return this.post('/api/data-management/s3-overwrite-local', payload);
    }

    runAction(action, payload) {
        if (action === 'inventory') return this.inventory(payload);
        if (action === 'import:dry-run' || action === 'import:run') return this.importLocalToS3(payload);
        if (action === 'backup:dry-run' || action === 'backup:run') return this.backup(payload);
        if (action === 'delete:dry-run' || action === 'delete:run') return this.deletePrefix(payload);
        if (action === 'local-overwrite-s3:dry-run' || action === 'local-overwrite-s3:run') return this.localOverwriteS3(payload);
        if (action === 's3-overwrite-local:dry-run' || action === 's3-overwrite-local:run') return this.s3OverwriteLocal(payload);
        throw new Error(`Unsupported cloud action: ${action}`);
    }

    post(url, payload) {
        return this.requestJSON(url, {
            method: 'POST',
            body: JSON.stringify(payload)
        });
    }
}
