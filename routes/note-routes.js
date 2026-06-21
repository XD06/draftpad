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

            const { notepad } = await findNotepadById(id);
            const clientVersion = Number(req.body.baseVersion);
            const content = req.body.content;
            const senderId = req.body.userId || 'api';
            const saveId = typeof req.body.saveId === 'string' ? req.body.saveId : undefined;
            const contentHash = hashContent(content);
            if (notepad && Number.isFinite(clientVersion) && (notepad.version || 1) > clientVersion) {
                const currentContent = await storage.readNoteContent(notepad);
                if (currentContent === content) {
                    return res.json({
                        success: true,
                        version: notepad.version || 1,
                        saveId,
                        contentHash,
                        unchanged: true
                    });
                }
                return res.status(409).json({
                    error: 'Notepad has been updated on another device',
                    currentVersion: notepad.version || 1
                });
            }

            if (!notepad) {
                const sanitizedId = sanitizeFilename(id);
                const notePath = path.join(dataDir, `${sanitizedId}.txt`);
                await fs.writeFile(notePath, req.body.content);
            } else {
                await storage.writeNoteContent(notepad, req.body.content);
            }

            const data = await storage.readNotepadsMeta();
            const targetNotepad = data.notepads.find(n => n.id === id);
            if (targetNotepad) {
                targetNotepad.updatedAt = Date.now();
                if (!targetNotepad.createdAt) targetNotepad.createdAt = Date.now();
                targetNotepad.version = (targetNotepad.version || 1) + 1;
                await storage.saveNotepadsMeta(data);
            }

            broadcastUpdate(id, content, senderId, targetNotepad?.version || 1, { saveId, contentHash });
            scheduleIndexNotepads();
            res.json({ success: true, version: targetNotepad?.version || 1, saveId, contentHash });
        } catch (err) {
            res.status(500).json({ error: 'Error saving notes' });
        }
    });

    app.patch('/api/notes/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const { action, text, target, replacement, userId, baseVersion } = req.body;
            const senderId = userId || 'api';

            const { notepad } = await findNotepadById(id);
            if (!notepad) {
                return res.status(404).json({ error: 'Notepad not found' });
            }

            const clientVersion = Number(baseVersion);
            if (Number.isFinite(clientVersion) && (notepad.version || 1) > clientVersion) {
                return res.status(409).json({
                    error: 'Notepad has been updated on another device',
                    currentVersion: notepad.version || 1
                });
            }

            let content = await storage.readNoteContent(notepad);

            let modified = false;
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
                            return res.status(400).json({
                                success: false,
                                error: 'Target text not found in document',
                                target
                            });
                        }
                    } else {
                        return res.status(400).json({ success: false, error: 'Replace action requires a non-empty target' });
                    }
                    break;
                case 'replace_first':
                    if (target) {
                        if (content.includes(target)) {
                            content = content.replace(target, replacement || '');
                            modified = true;
                        } else {
                            return res.status(400).json({ success: false, error: 'Target text not found' });
                        }
                    }
                    break;
                case 'overwrite':
                    content = text || '';
                    modified = true;
                    break;
                default:
                    return res.status(400).json({ error: 'Invalid action' });
            }

            if (modified) {
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

                broadcastUpdate(id, content, senderId, targetNotepad.version, { contentHash: hashContent(content) });
                scheduleIndexNotepads();
                return res.json({ success: true, content, modified, version: savedVersion });
            }

            res.json({ success: true, content, modified, version: notepad.version || 1 });
        } catch (err) {
            console.error('Error patching notes:', err);
            res.status(500).json({ error: 'Error patching notes' });
        }
    });
}

module.exports = { registerNoteRoutes };
