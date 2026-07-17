const fs = require('fs').promises;
const path = require('path');

const BLOCK_ID_RE = /^[a-f0-9]{64}$/i;
const SNAPSHOT_ID_RE = /^snap_[0-9]{13}_[a-z0-9]{12}$/;

function assertBlockId(blockId) {
    if (!BLOCK_ID_RE.test(String(blockId || ''))) throw new Error('Invalid backup block id');
    return String(blockId).toLowerCase();
}

function assertSnapshotId(snapshotId) {
    if (!SNAPSHOT_ID_RE.test(String(snapshotId || ''))) throw new Error('Invalid backup snapshot id');
    return String(snapshotId);
}

async function listFiles(directory, relative = '') {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
        if (error.code === 'ENOENT') return [];
        throw error;
    });
    const files = [];
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
        const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
            files.push(...await listFiles(absolute, nextRelative));
        } else if (entry.isFile()) {
            const stat = await fs.stat(absolute);
            files.push({ path: nextRelative.replace(/\\/g, '/'), size: stat.size });
        }
    }
    return files;
}

class LocalBackupRepository {
    constructor(rootDirectory) {
        this.rootDirectory = path.resolve(rootDirectory);
    }

    blockPath(blockId) {
        const clean = assertBlockId(blockId);
        return path.join(this.rootDirectory, 'blocks', clean.slice(0, 2), `${clean}.bin`);
    }

    manifestPath(snapshotId, { trash = false } = {}) {
        const clean = assertSnapshotId(snapshotId);
        return path.join(this.rootDirectory, trash ? 'trash' : 'manifests', `${clean}.bin`);
    }

    trashInfoPath(snapshotId) {
        const clean = assertSnapshotId(snapshotId);
        return path.join(this.rootDirectory, 'trash', `${clean}.meta.json`);
    }

    async initialize() {
        await Promise.all([
            fs.mkdir(path.join(this.rootDirectory, 'blocks'), { recursive: true }),
            fs.mkdir(path.join(this.rootDirectory, 'manifests'), { recursive: true }),
            fs.mkdir(path.join(this.rootDirectory, 'trash'), { recursive: true })
        ]);
    }

    async hasBlock(blockId) {
        try {
            await fs.access(this.blockPath(blockId));
            return true;
        } catch {
            return false;
        }
    }

    async writeBlock(blockId, buffer) {
        const target = this.blockPath(blockId);
        await fs.mkdir(path.dirname(target), { recursive: true });
        try {
            await fs.writeFile(target, buffer, { flag: 'wx' });
            return true;
        } catch (error) {
            if (error.code === 'EEXIST') return false;
            throw error;
        }
    }

    async readBlock(blockId) {
        return fs.readFile(this.blockPath(blockId));
    }

    async deleteBlock(blockId) {
        await fs.rm(this.blockPath(blockId), { force: true });
    }

    async writeManifest(snapshotId, buffer) {
        const target = this.manifestPath(snapshotId);
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, buffer, { flag: 'wx' });
    }

    async readManifest(snapshotId, { trash = false } = {}) {
        return fs.readFile(this.manifestPath(snapshotId, { trash }));
    }

    async listManifestIds({ trash = false } = {}) {
        const directory = path.join(this.rootDirectory, trash ? 'trash' : 'manifests');
        const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
            if (error.code === 'ENOENT') return [];
            throw error;
        });
        return entries
            .filter(entry => entry.isFile() && entry.name.endsWith('.bin'))
            .map(entry => entry.name.slice(0, -4))
            .filter(snapshotId => SNAPSHOT_ID_RE.test(snapshotId))
            .sort();
    }

    async moveManifestToTrash(snapshotId, { trashedAt = Date.now() } = {}) {
        const source = this.manifestPath(snapshotId);
        const target = this.manifestPath(snapshotId, { trash: true });
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.rename(source, target);
        await fs.writeFile(this.trashInfoPath(snapshotId), JSON.stringify({ trashedAt }), { encoding: 'utf8', mode: 0o600 });
    }

    async getManifestTrashTimestamp(snapshotId) {
        try {
            const value = JSON.parse(await fs.readFile(this.trashInfoPath(snapshotId), 'utf8'));
            return Number.isFinite(Number(value?.trashedAt)) ? Number(value.trashedAt) : null;
        } catch (error) {
            if (error.code === 'ENOENT') return null;
            throw error;
        }
    }

    async deleteManifest(snapshotId, { trash = false } = {}) {
        await fs.rm(this.manifestPath(snapshotId, { trash }), { force: true });
        if (trash) await fs.rm(this.trashInfoPath(snapshotId), { force: true });
    }

    async listBlocks() {
        const files = await listFiles(path.join(this.rootDirectory, 'blocks'));
        return files
            .map(file => ({ id: path.basename(file.path, '.bin'), size: file.size }))
            .filter(block => BLOCK_ID_RE.test(block.id));
    }

    async usageBytes() {
        const files = await listFiles(this.rootDirectory);
        return files.reduce((total, file) => total + file.size, 0);
    }
}

module.exports = {
    LocalBackupRepository,
    assertBlockId,
    assertSnapshotId
};
