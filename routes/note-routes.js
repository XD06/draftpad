const fs = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { sanitizeFilename } = require('../scripts/notepad-migration');

function hashContent(content) {
    return crypto.createHash('sha256').update(String(content || '')).digest('hex');
}

function registerNoteRoutes(app, context) {
    const {
        storage,
        dataDir,
        baseUrl,
        nodeEnv,
        pageHistoryCookie,
        pageHistoryCookieAge,
        findNotepadById,
        broadcastUpdate,
        scheduleIndexNotepads
    } = context;

    app.get('/api/notes/:id', async (req, res) => {
        try {
            const { id } = req.params;

            const { notepad } = await findNotepadById(id);

            let notes;
            if (notepad) {
                notes = await storage.readNoteContent(notepad);
            } else {
                const sanitizedId = sanitizeFilename(id);
                const notePath = path.join(dataDir, `${sanitizedId}.txt`);
                notes = await fs.readFile(notePath, 'utf8').catch(() => '');
            }

            res.cookie(pageHistoryCookie, id, {
                httpOnly: true,
                secure: req.secure || (baseUrl.startsWith('https') && nodeEnv === 'production'),
                sameSite: 'strict',
                maxAge: pageHistoryCookieAge
            });

            res.json({ content: notes, version: notepad?.version || 1 });
        } catch (err) {
            res.status(500).json({ error: 'Error reading notes' });
        }
    });

    app.post('/api/notes/:id', async (req, res) => {
        try {
            const { id } = req.params;
            if (!id || id === 'undefined' || id === 'null') {
                return res.status(400).json({ error: 'Invalid notepad id' });
            }
            await storage.init();

            const clientVersion = Number(req.body.baseVersion);
            const content = req.body.content;
            const senderId = req.body.userId || 'api';
            const saveId = typeof req.body.saveId === 'string' ? req.body.saveId : undefined;
            const contentHash = hashContent(content);

            const result = await storage.withNotepadWriteLock(async () => {
                const { notepad } = await findNotepadById(id);

                if (notepad && Number.isFinite(clientVersion) && (notepad.version || 1) > clientVersion) {
                    const currentContent = await storage.readNoteContent(notepad);
                    if (currentContent === content) {
                        return { unchanged: true, version: notepad.version || 1 };
                    }
                    return { conflict: true, currentVersion: notepad.version || 1 };
                }

                if (!notepad) {
                    const fallbackNotepad = { id, name: id };
                    await storage.writeNoteContent(fallbackNotepad, req.body.content);
                } else {
                    await storage.writeNoteContent(notepad, req.body.content);
                }

                const data = await storage.readNotepadsMeta();
                const targetNotepad = data.notepads.find(n => n.id === id);
                let version = targetNotepad?.version || 1;
                if (targetNotepad) {
                    targetNotepad.updatedAt = Date.now();
                    if (!targetNotepad.createdAt) targetNotepad.createdAt = Date.now();
                    targetNotepad.version = (targetNotepad.version || 1) + 1;
                    version = targetNotepad.version;
                    await storage.saveNotepadsMeta(data);
                }
                return { version };
            });

            if (result.conflict) {
                return res.status(409).json({
                    error: 'Notepad has been updated on another device',
                    currentVersion: result.currentVersion
                });
            }
            if (result.unchanged) {
                return res.json({
                    success: true,
                    version: result.version,
                    saveId,
                    contentHash,
                    unchanged: true
                });
            }

            broadcastUpdate(id, content, senderId, result.version, { saveId, contentHash });
            scheduleIndexNotepads();
            res.json({ success: true, version: result.version, saveId, contentHash });
        } catch (err) {
            res.status(500).json({ error: 'Error saving notes' });
        }
    });

    app.patch('/api/notes/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const { action, text, target, replacement, userId, baseVersion } = req.body;
            const senderId = userId || 'api';

            const result = await storage.withNotepadWriteLock(async () => {
                const { notepad } = await findNotepadById(id);
                if (!notepad) {
                    return { errorStatus: 404, error: 'Notepad not found' };
                }

                const clientVersion = Number(baseVersion);
                if (Number.isFinite(clientVersion) && (notepad.version || 1) > clientVersion) {
                    return {
                        errorStatus: 409,
                        error: 'Notepad has been updated on another device',
                        currentVersion: notepad.version || 1
                    };
                }

                let content = await storage.readNoteContent(notepad);
                let modified = false;
                let badRequest = null;

                switch (action) {
                    case 'append':
                        if (text !== undefined) {
                            content += text;
                            modified = true;
                        }
                        break;
                    case 'prepend':
                        if (text !== undefined) {
                            content = text + content;
                            modified = true;
                        }
                        break;
                    case 'replace':
                        if (target) {
                            if (content.includes(target)) {
                                content = content.split(target).join(replacement || '');
                                modified = true;
                            } else {
                                badRequest = { success: false, error: 'Target text not found in document', target };
                            }
                        } else {
                            badRequest = { success: false, error: 'Replace action requires a non-empty target' };
                        }
                        break;
                    case 'replace_first':
                        if (target) {
                            if (content.includes(target)) {
                                content = content.replace(target, replacement || '');
                                modified = true;
                            } else {
                                badRequest = { success: false, error: 'Target text not found' };
                            }
                        }
                        break;
                    case 'overwrite':
                        content = text || '';
                        modified = true;
                        break;
                    default:
                        badRequest = { error: 'Invalid action' };
                }
                if (badRequest) {
                    return { errorStatus: 400, errorBody: badRequest };
                }

                if (!modified) {
                    return { content, modified: false, version: notepad.version || 1 };
                }

                await storage.writeNoteContent(notepad, content);

                const data = await storage.readNotepadsMeta();
                const targetNotepad = data.notepads.find(n => n.id === id);
                let savedVersion = notepad.version || 1;
                if (targetNotepad) {
                    targetNotepad.updatedAt = Date.now();
                    targetNotepad.version = (targetNotepad.version || 1) + 1;
                    savedVersion = targetNotepad.version;
                    await storage.saveNotepadsMeta(data);
                }
                return { content, modified: true, version: savedVersion };
            });

            if (result.errorStatus) {
                if (result.errorStatus === 400) return res.status(400).json(result.errorBody);
                if (result.errorStatus === 404) return res.status(404).json({ error: result.error });
                return res.status(409).json({ error: result.error, currentVersion: result.currentVersion });
            }

            if (result.modified) {
                broadcastUpdate(id, result.content, senderId, result.version, { contentHash: hashContent(result.content) });
                scheduleIndexNotepads();
                return res.json({ success: true, content: result.content, modified: true, version: result.version });
            }
            res.json({ success: true, content: result.content, modified: false, version: result.version });
        } catch (err) {
            console.error('Error patching notes:', err);
            res.status(500).json({ error: 'Error patching notes' });
        }
    });
}

module.exports = { registerNoteRoutes };
