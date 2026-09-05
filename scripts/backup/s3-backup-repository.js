const { joinKey } = require('./s3-object-store');
const { assertBlockId, assertSnapshotId } = require('./local-backup-repository');

class S3BackupRepository {
    constructor({ objectStore, prefix = 'dumbpad-backup' } = {}) {
        if (!objectStore) throw new Error('An S3 backup object store is required');
        this.objectStore = objectStore;
        this.prefix = String(prefix || '').replace(/^\/+|\/+$/g, '');
        if (!this.prefix) throw new Error('A non-empty backup S3 prefix is required');
    }

    blockKey(blockId) {
        const clean = assertBlockId(blockId);
        return joinKey(this.prefix, 'blocks', clean.slice(0, 2), `${clean}.bin`);
    }

    manifestKey(snapshotId, { trash = false } = {}) {
        const clean = assertSnapshotId(snapshotId);
        return joinKey(this.prefix, trash ? 'trash' : 'manifests', `${clean}.bin`);
    }

    trashInfoKey(snapshotId) {
        const clean = assertSnapshotId(snapshotId);
        return joinKey(this.prefix, 'trash', `${clean}.meta.json`);
    }

    async initialize() {}

    async hasBlock(blockId) {
        return this.objectStore.has(this.blockKey(blockId));
    }

    async writeBlock(blockId, buffer) {
        const key = this.blockKey(blockId);
        if (await this.objectStore.has(key)) return false;
        await this.objectStore.put(key, buffer);
        return true;
    }

    async readBlock(blockId) {
        return this.objectStore.get(this.blockKey(blockId));
    }

    async deleteBlock(blockId) {
        await this.objectStore.delete(this.blockKey(blockId));
    }

    async writeManifest(snapshotId, buffer) {
        const key = this.manifestKey(snapshotId);
        if (await this.objectStore.has(key)) throw new Error('Backup snapshot already exists');
        await this.objectStore.put(key, buffer);
    }

    async readManifest(snapshotId, { trash = false } = {}) {
        return this.objectStore.get(this.manifestKey(snapshotId, { trash }));
    }

    async listManifestIds({ trash = false } = {}) {
        const prefix = joinKey(this.prefix, trash ? 'trash' : 'manifests') + '/';
        return (await this.objectStore.list(prefix))
            .map(item => String(item.key || '').slice(prefix.length))
            .filter(name => name.endsWith('.bin'))
            .map(name => name.slice(0, -4))
            .filter(snapshotId => /^snap_[0-9]{13}_[a-z0-9]{12}$/.test(snapshotId))
            .sort();
    }

    async moveManifestToTrash(snapshotId, { trashedAt = Date.now() } = {}) {
        const source = this.manifestKey(snapshotId);
        const target = this.manifestKey(snapshotId, { trash: true });
        await this.objectStore.copy(source, target);
        await this.objectStore.put(this.trashInfoKey(snapshotId), Buffer.from(JSON.stringify({ trashedAt }), 'utf8'));
        await this.objectStore.delete(source);
    }

    async getManifestTrashTimestamp(snapshotId) {
        try {
            const value = JSON.parse((await this.objectStore.get(this.trashInfoKey(snapshotId))).toString('utf8'));
            return Number.isFinite(Number(value?.trashedAt)) ? Number(value.trashedAt) : null;
        } catch (error) {
            if (error?.code === 'NoSuchKey' || error?.$metadata?.httpStatusCode === 404) return null;
            throw error;
        }
    }

    async deleteManifest(snapshotId, { trash = false } = {}) {
        await this.objectStore.delete(this.manifestKey(snapshotId, { trash }));
        if (trash) await this.objectStore.delete(this.trashInfoKey(snapshotId));
    }

    async listBlocks() {
        const prefix = joinKey(this.prefix, 'blocks') + '/';
        return (await this.objectStore.list(prefix))
            .map(item => ({ id: String(item.key || '').split('/').pop().replace(/\.bin$/, ''), size: item.size }))
            .filter(block => /^[a-f0-9]{64}$/i.test(block.id));
    }

    async usageBytes() {
        const entries = await this.objectStore.list(`${this.prefix}/`);
        return entries.reduce((total, item) => total + Number(item.size || 0), 0);
    }
}

module.exports = { S3BackupRepository };
