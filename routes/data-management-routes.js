const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
const {
    assertDestructiveDataOperationEnabled,
    destructiveDataOperationsEnabled
} = require('../scripts/data-operation-policy');

function compactInventory(inventory) {
    return {
        prefix: inventory.prefix,
        objectCount: inventory.objectCount,
        totalBytes: inventory.totalBytes,
        groups: inventory.groups
    };
}

function cleanPrefix(value) {
    return String(value || '').replace(/^\/+|\/+$/g, '');
}

function requireConfirmedPrefix(prefix, confirmPrefix) {
    const clean = cleanPrefix(prefix);
    const cleanConfirm = cleanPrefix(confirmPrefix);
    if (!clean || clean !== cleanConfirm) {
        const error = new Error(`Confirm prefix must be exactly "${clean}"`);
        error.status = 400;
        throw error;
    }
    return clean;
}

function sendDataManagementError(res, label, err, fallbackMessage) {
    const status = err.status || 500;
    if (status >= 500) {
        console.error(label, err);
    }
    res.status(status).json({ error: err.message || fallbackMessage });
}

function assertSafeDataDir(dataDir) {
    const resolved = path.resolve(String(dataDir || ''));
    const parsed = path.parse(resolved);
    if (!resolved || resolved === parsed.root || path.basename(resolved).toLowerCase() !== 'data') {
        const error = new Error('targetDataDir must be an explicit directory named data');
        error.status = 400;
        throw error;
    }
    return resolved;
}

async function copyDirectoryIfExists(sourceDir, backupDir) {
    if (!fsSync.existsSync(sourceDir)) return false;
    await fs.cp(sourceDir, backupDir, { recursive: true, force: true });
    return true;
}

async function emptyDirectory(dataDir) {
    await fs.mkdir(dataDir, { recursive: true });
    const entries = await fs.readdir(dataDir, { withFileTypes: true });
    for (const entry of entries) {
        await fs.rm(path.join(dataDir, entry.name), { recursive: true, force: true });
    }
}

async function restorePrefixToLocal(prefix, targetDataDir, s3Service) {
    const clean = cleanPrefix(prefix);
    const entries = await s3Service.listObjects(`${clean}/`);
    let written = 0;
    let totalBytes = 0;

    for (const entry of entries) {
        const relative = entry.key.slice(clean.length + 1);
        if (!relative || relative.includes('..')) continue;
        const targetPath = path.join(targetDataDir, ...relative.split('/'));
        const resolvedTarget = path.resolve(targetPath);
        if (!resolvedTarget.startsWith(`${targetDataDir}${path.sep}`) && resolvedTarget !== targetDataDir) {
            throw new Error(`Unsafe S3 key: ${entry.key}`);
        }
        const body = await s3Service.getObject(entry.key);
        await fs.mkdir(path.dirname(resolvedTarget), { recursive: true });
        await fs.writeFile(resolvedTarget, body || '', 'utf8');
        written++;
        totalBytes += entry.size || 0;
    }

    return { written, totalBytes };
}

function currentS3Prefix(storage) {
    return storage.getS3Prefix ? storage.getS3Prefix() : cleanPrefix(process.env.S3_PREFIX);
}

function registerDataManagementRoutes(app, context) {
    const {
        storage,
        s3PrefixTools,
        localToS3Migration,
        s3Service,
        auditLogger = null
    } = context;

    function audit(req, action, details = {}, outcome = 'success') {
        if (!auditLogger) return;
        auditLogger.append({
            type: 'data.operation',
            actor: req.auth?.session?.sessionId || null,
            ip: req.ip || null,
            outcome,
            details: { action, ...details }
        }).catch(error => console.warn('Audit logging failed:', error.message));
    }

    function auditFailure(req, action, error) {
        audit(req, action, {
            method: req.method,
            path: req.path,
            reason: error?.code || error?.status || 'request_failed'
        }, 'failure');
    }

    app.get('/api/data-management/status', async (req, res) => {
        try {
            const prefix = currentS3Prefix(storage);
            let inventory = null;
            if (storage.backend === 's3' && prefix) {
                inventory = compactInventory(await s3PrefixTools.inventoryPrefix(prefix));
            }
            const spaceRoot = s3PrefixTools.cleanSpaceRoot(process.env.S3_SPACE_ROOT || 'dumbpad');

            res.json({
                backend: storage.backend,
                layout: storage.layout,
                dataDir: storage.paths.DATA_DIR,
                safety: {
                    destructiveDataOperationsEnabled: destructiveDataOperationsEnabled()
                },
                s3: {
                    configured: storage.backend === 's3',
                    bucket: process.env.S3_BUCKET || '',
                    prefix,
                    spaceRoot,
                    endpoint: process.env.S3_ENDPOINT || '',
                    region: process.env.S3_REGION || ''
                },
                inventory
            });
        } catch (err) {
            console.error('Error reading data management status:', err);
            res.status(500).json({ error: 'Error reading data management status' });
        }
    });

    app.get('/api/data-management/s3/spaces', async (req, res) => {
        try {
            if (storage.backend !== 's3') {
                return res.json({
                    backend: storage.backend,
                    currentPrefix: '',
                    spaces: []
                });
            }

            const result = await s3PrefixTools.listSpaces({ root: process.env.S3_SPACE_ROOT || 'dumbpad' });
            const currentPrefix = currentS3Prefix(storage);
            res.json({
                backend: storage.backend,
                root: result.root,
                currentPrefix,
                spaces: result.spaces
            });
        } catch (err) {
            sendDataManagementError(res, 'Error listing S3 spaces:', err, 'Error listing S3 spaces');
        }
    });

    app.post('/api/data-management/s3/select-space', async (req, res) => {
        try {
            if (storage.backend !== 's3') {
                return res.status(400).json({ error: 'Current storage backend is not S3' });
            }

            const prefix = cleanPrefix(req.body?.prefix);
            if (!prefix || prefix === '(root)') {
                return res.status(400).json({ error: 'A non-empty S3 data space is required' });
            }

            const result = await s3PrefixTools.listSpaces({ root: process.env.S3_SPACE_ROOT || 'dumbpad' });
            const exists = result.spaces.some(space => space.prefix === prefix);
            if (!exists) {
                return res.status(404).json({ error: 'S3 data space not found' });
            }

            const activePrefix = await storage.setS3Prefix(prefix);
            audit(req, 's3.select-space', { prefix: activePrefix });
            res.json({
                success: true,
                prefix: activePrefix,
                requiresReload: true
            });
        } catch (err) {
            auditFailure(req, 's3.select-space', err);
            sendDataManagementError(res, 'Error selecting S3 space:', err, 'Error selecting S3 space');
        }
    });

    app.post('/api/data-management/s3/inventory', async (req, res) => {
        try {
            const prefix = cleanPrefix(req.body?.prefix || currentS3Prefix(storage));
            const inventory = await s3PrefixTools.inventoryPrefix(prefix);
            res.json(compactInventory(inventory));
        } catch (err) {
            sendDataManagementError(res, 'Error reading S3 inventory:', err, 'Error reading S3 inventory');
        }
    });

    app.post('/api/data-management/s3/backup', async (req, res) => {
        try {
            const prefix = cleanPrefix(req.body?.prefix || currentS3Prefix(storage));
            const backupPrefix = cleanPrefix(req.body?.backupPrefix);
            const dryRun = req.body?.dryRun !== false;
            if (!dryRun) requireConfirmedPrefix(prefix, req.body?.confirmPrefix);
            const result = await s3PrefixTools.backupPrefix(prefix, backupPrefix, { dryRun });
            res.json({
                action: result.action,
                sourcePrefix: result.sourcePrefix,
                backupPrefix: result.backupPrefix,
                objectCount: result.objectCount,
                totalBytes: result.totalBytes,
                dryRun: result.dryRun
            });
        } catch (err) {
            sendDataManagementError(res, 'Error backing up S3 prefix:', err, 'Error backing up S3 prefix');
        }
    });

    app.post('/api/data-management/s3/delete', async (req, res) => {
        try {
            const prefix = cleanPrefix(req.body?.prefix || currentS3Prefix(storage));
            const dryRun = req.body?.dryRun !== false;
            if (!dryRun) assertDestructiveDataOperationEnabled('Deleting an S3 data space');
            if (!dryRun) requireConfirmedPrefix(prefix, req.body?.confirmPrefix);
            const result = await s3PrefixTools.deletePrefix(prefix, {
                dryRun,
                confirmPrefix: req.body?.confirmPrefix
            });
            if (!dryRun) audit(req, 's3.delete-prefix', { prefix: result.prefix, objectCount: result.objectCount, totalBytes: result.totalBytes });
            res.json({
                action: result.action,
                prefix: result.prefix,
                objectCount: result.objectCount,
                totalBytes: result.totalBytes,
                dryRun: result.dryRun
            });
        } catch (err) {
            auditFailure(req, 's3.delete-prefix', err);
            sendDataManagementError(res, 'Error deleting S3 prefix:', err, 'Error deleting S3 prefix');
        }
    });

    app.post('/api/data-management/import-local-to-s3', async (req, res) => {
        try {
            const sourceDataDir = String(req.body?.sourceDataDir || '').trim();
            const prefix = cleanPrefix(req.body?.prefix || currentS3Prefix(storage));
            const reportDir = String(req.body?.reportDir || '').trim();
            const dryRun = req.body?.dryRun !== false;
            if (!dryRun) assertDestructiveDataOperationEnabled('Importing local data into S3');
            if (!sourceDataDir) return res.status(400).json({ error: 'sourceDataDir is required' });
            if (!prefix) return res.status(400).json({ error: 'prefix is required' });
            if (!dryRun) requireConfirmedPrefix(prefix, req.body?.confirmPrefix);

            const args = [
                '--source-data-dir', sourceDataDir,
                '--prefix', prefix
            ];
            if (reportDir) args.push('--report-dir', reportDir);
            if (dryRun) args.push('--dry-run');

            const report = await localToS3Migration.run(args);
            if (!dryRun) audit(req, 'local.import-s3', { prefix, objectCount: report.uploaded.length, totalBytes: report.totalBytes });
            res.json({
                dryRun: report.dryRun,
                dataDir: report.dataDir,
                prefix: report.prefix,
                sourceSummary: report.sourceSummary,
                uploaded: report.uploaded.length,
                missing: report.missing.length,
                totalBytes: report.totalBytes,
                reportPath: report.reportPath
            });
        } catch (err) {
            auditFailure(req, 'local.import-s3', err);
            sendDataManagementError(res, 'Error importing local data to S3:', err, 'Error importing local data to S3');
        }
    });

    app.post('/api/data-management/local-overwrite-s3', async (req, res) => {
        try {
            const sourceDataDir = String(req.body?.sourceDataDir || '').trim();
            const prefix = cleanPrefix(req.body?.prefix || currentS3Prefix(storage));
            const backupPrefix = cleanPrefix(req.body?.backupPrefix);
            const reportDir = String(req.body?.reportDir || '').trim();
            const dryRun = req.body?.dryRun !== false;
            if (!dryRun) assertDestructiveDataOperationEnabled('Overwriting an S3 data space from local data');
            if (!sourceDataDir) return res.status(400).json({ error: 'sourceDataDir is required' });
            if (!prefix) return res.status(400).json({ error: 'prefix is required' });
            if (!backupPrefix) return res.status(400).json({ error: 'backupPrefix is required' });
            if (prefix === backupPrefix) return res.status(400).json({ error: 'backupPrefix must differ from prefix' });
            if (!dryRun) requireConfirmedPrefix(prefix, req.body?.confirmPrefix);

            const before = await s3PrefixTools.inventoryPrefix(prefix);
            const importArgs = [
                '--source-data-dir', sourceDataDir,
                '--prefix', prefix
            ];
            if (reportDir) importArgs.push('--report-dir', reportDir);
            const importDryRunArgs = [...importArgs, '--dry-run'];

            const importReport = await localToS3Migration.run(importDryRunArgs);
            const backup = await s3PrefixTools.backupPrefix(prefix, backupPrefix, { dryRun: true });
            const deletion = await s3PrefixTools.deletePrefix(prefix, { dryRun: true });

            if (!dryRun) {
                await s3PrefixTools.backupPrefix(prefix, backupPrefix, { dryRun: false });
                await s3PrefixTools.deletePrefix(prefix, { dryRun: false, confirmPrefix: prefix });
                await localToS3Migration.run(importArgs);
                audit(req, 'local.overwrite-s3', { prefix, objectCount: deletion.objectCount, totalBytes: deletion.totalBytes });
            }

            res.json({
                action: 'local-overwrite-s3',
                dryRun,
                prefix,
                backupPrefix,
                before: compactInventory(before),
                backup: {
                    objectCount: backup.objectCount,
                    totalBytes: backup.totalBytes,
                    dryRun: backup.dryRun
                },
                deletion: {
                    objectCount: deletion.objectCount,
                    totalBytes: deletion.totalBytes,
                    dryRun: deletion.dryRun
                },
                import: {
                    sourceSummary: importReport.sourceSummary,
                    uploaded: importReport.uploaded.length,
                    missing: importReport.missing.length,
                    totalBytes: importReport.totalBytes,
                    reportPath: importReport.reportPath
                }
            });
        } catch (err) {
            auditFailure(req, 'local.overwrite-s3', err);
            sendDataManagementError(res, 'Error overwriting S3 from local data:', err, 'Error overwriting S3 from local data');
        }
    });

    app.post('/api/data-management/s3-overwrite-local', async (req, res) => {
        try {
            const prefix = cleanPrefix(req.body?.prefix || currentS3Prefix(storage));
            const targetDataDir = assertSafeDataDir(req.body?.targetDataDir || storage.paths.DATA_DIR);
            const dryRun = req.body?.dryRun !== false;
            if (!dryRun) assertDestructiveDataOperationEnabled('Overwriting local data from S3');
            const localBackupDir = path.resolve(
                String(req.body?.localBackupDir || `${targetDataDir}.backup-${Date.now()}`)
            );
            if (!prefix) return res.status(400).json({ error: 'prefix is required' });
            if (!dryRun) requireConfirmedPrefix(prefix, req.body?.confirmPrefix);

            const inventory = await s3PrefixTools.inventoryPrefix(prefix);
            const result = {
                action: 's3-overwrite-local',
                dryRun,
                prefix,
                targetDataDir,
                localBackupDir,
                inventory: compactInventory(inventory),
                restored: null
            };

            if (!dryRun) {
                await copyDirectoryIfExists(targetDataDir, localBackupDir);
                await emptyDirectory(targetDataDir);
                result.restored = await restorePrefixToLocal(prefix, targetDataDir, s3Service);
                audit(req, 's3.overwrite-local', { prefix, objectCount: result.restored.written, totalBytes: result.restored.totalBytes });
            }

            res.json(result);
        } catch (err) {
            auditFailure(req, 's3.overwrite-local', err);
            sendDataManagementError(res, 'Error overwriting local data from S3:', err, 'Error overwriting local data from S3');
        }
    });
}

module.exports = { registerDataManagementRoutes };
