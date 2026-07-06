function registerNotepadRoutes(app, context) {
    const {
        storage,
        baseUrl,
        nodeEnv,
        pageHistoryCookie,
        pageHistoryCookieAge,
        loadNotepadsList,
        generateUniqueName,
        findNotepadById,
        broadcastUpdate,
        scheduleIndexNotepads
    } = context;

    app.get('/api/notepads', async (req, res) => {
        try {
            let notepadsList = await loadNotepadsList();

            if (req.query.title) {
                const titleQuery = req.query.title.toLowerCase();
                notepadsList = notepadsList.filter(n => n.name.toLowerCase().includes(titleQuery));
            }

            const sortBy = req.query.sortBy || 'updatedAt';
            const order = req.query.order === 'asc' ? 1 : -1;

            notepadsList.sort((a, b) => {
                const valA = a[sortBy] || 0;
                const valB = b[sortBy] || 0;
                if (typeof valA === 'string') {
                    return valA.localeCompare(valB) * order;
                }
                return (valA - valB) * order;
            });

            const noteHistory = req.cookies.dumbpad_page_history || 'default';
            res.json({ notepads_list: notepadsList, note_history: noteHistory });
        } catch (err) {
            res.status(500).json({ error: 'Error reading notepads list' });
        }
    });

    app.post('/api/notepads', async (req, res) => {
        try {
            const { name, content, id: requestedId } = req.body || {};
            await storage.init();

            const newNotepad = await storage.withNotepadWriteLock(async () => {
                const data = await storage.readNotepadsMeta();
                const safeRequestedId = typeof requestedId === 'string' && /^[A-Za-z0-9_-]{3,96}$/.test(requestedId)
                    ? requestedId
                    : '';
                const idExists = safeRequestedId && data.notepads.some(notepad => notepad.id === safeRequestedId);
                const id = safeRequestedId && !idExists
                    ? safeRequestedId
                    : `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
                const desiredName = name || `Notepad ${data.notepads.length + 1}`;
                const uniqueName = generateUniqueName(desiredName, data.notepads);

                const np = {
                    id,
                    name: uniqueName,
                    version: 1,
                    createdAt: Date.now(),
                    updatedAt: Date.now()
                };
                data.notepads.push(np);
                await storage.saveNotepadsMeta(data);
                await storage.writeNoteContent(np, content || '');
                return np;
            });

            res.cookie(pageHistoryCookie, newNotepad.id, {
                httpOnly: true,
                secure: req.secure || (baseUrl.startsWith('https') && nodeEnv === 'production'),
                sameSite: 'strict',
                maxAge: pageHistoryCookieAge
            });

            scheduleIndexNotepads(250);
            res.json(newNotepad);
        } catch (err) {
            console.error('Error creating new notepad:', err);
            res.status(500).json({ error: 'Error creating new notepad' });
        }
    });

    app.post('/api/upload', async (req, res) => {
        try {
            const filename = Buffer.from(req.headers['x-filename'] || `Upload-${Date.now()}.md`, 'latin1').toString('utf8');
            const name = filename.replace(/\.[^/.]+$/, '');

            const body = [];
            let bodySize = 0;
            let tooLarge = false;
            const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB cap (matches express.json limit)
            req.on('data', (chunk) => {
                if (tooLarge) return;
                bodySize += chunk.length;
                if (bodySize > MAX_UPLOAD_BYTES) {
                    tooLarge = true;
                    body.length = 0;
                    if (!res.headersSent) res.status(413).json({ error: 'Uploaded content too large' });
                    req.destroy();
                    return;
                }
                body.push(chunk);
            });
            req.on('error', () => {
                if (!tooLarge && !res.headersSent) res.status(500).json({ error: 'Error uploading file' });
            });
            req.on('end', async () => {
                if (tooLarge) return;
                try {
                    const content = Buffer.concat(body).toString('utf8');

                    const newNotepad = await storage.withNotepadWriteLock(async () => {
                        const data = await storage.readNotepadsMeta();
                        const id = Date.now().toString();
                        const uniqueName = generateUniqueName(name, data.notepads);

                        const np = {
                            id,
                            name: uniqueName,
                            version: 1,
                            createdAt: Date.now(),
                            updatedAt: Date.now()
                        };
                        data.notepads.push(np);
                        await storage.saveNotepadsMeta(data);
                        await storage.writeNoteContent(np, content);
                        return np;
                    });

                    broadcastUpdate(newNotepad.id, content);
                    scheduleIndexNotepads(250);
                    res.json(newNotepad);
                } catch (err) {
                    console.error('Save upload error:', err);
                    res.status(500).json({ error: 'Error saving uploaded content' });
                }
            });
        } catch (err) {
            console.error('Upload error:', err);
            res.status(500).json({ error: 'Error uploading file' });
        }
    });

    app.put('/api/notepads/:id', async (req, res) => {
        try {
            const { id } = req.params;
            const { name, baseVersion } = req.body;

            const result = await storage.withNotepadWriteLock(async () => {
                const { data, notepad } = await findNotepadById(id);
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

                const otherNotepads = data.notepads.filter(n => n.id !== id);
                const uniqueName = generateUniqueName(name, otherNotepads);

                const shouldRenameFile = id !== 'default' && notepad.name !== uniqueName;

                if (shouldRenameFile) {
                    try {
                        await storage.renameNoteContent(notepad, { ...notepad, name: uniqueName });
                    } catch (err) {
                        console.warn(`Failed to rename notepad file for ${notepad.name}:`, err);
                        return { errorStatus: 500, error: 'Failed to rename notepad file. Please try a different name.' };
                    }
                }

                notepad.name = uniqueName;
                notepad.updatedAt = Date.now();
                notepad.version = (notepad.version || 1) + 1;
                await storage.saveNotepadsMeta(data);
                return { notepad, nameChanged: uniqueName !== name };
            });

            if (result.errorStatus) {
                if (result.errorStatus === 404) return res.status(404).json({ error: result.error });
                if (result.errorStatus === 409) return res.status(409).json({ error: result.error, currentVersion: result.currentVersion });
                return res.status(500).json({ error: result.error });
            }

            scheduleIndexNotepads(250);
            res.json({ ...result.notepad, nameChanged: result.nameChanged });
        } catch (err) {
            res.status(500).json({ error: 'Error renaming notepad' });
        }
    });

    app.delete('/api/notepads/:id', async (req, res) => {
        try {
            const { id } = req.params;

            if (id === 'default') {
                return res.status(400).json({ error: 'Cannot delete default notepad' });
            }

            const result = await storage.withNotepadWriteLock(async () => {
                const { data, notepad } = await findNotepadById(id);
                if (!notepad) {
                    return { errorStatus: 404, error: 'Notepad not found' };
                }

                // Order matters: move to trash and remove from meta first, then
                // delete the content file — all inside the lock so a concurrent
                // GET /api/notepads (which self-heals orphan .txt files) cannot
                // re-add the notepad to meta between meta-save and file-delete.
                const trashItem = await storage.moveNotepadToTrash(notepad);
                const notepadIndex = data.notepads.findIndex(n => n.id === id);
                if (notepadIndex !== -1) {
                    data.notepads.splice(notepadIndex, 1);
                }
                await storage.saveNotepadsMeta(data);
                await storage.deleteNoteContent(notepad);
                return { trashItem };
            });

            if (result.errorStatus) {
                return res.status(404).json({ error: result.error });
            }

            scheduleIndexNotepads(250);
            res.json({ success: true, message: 'Notepad moved to trash', trashItem: result.trashItem });
        } catch (err) {
            console.error('Error in delete notepad endpoint:', err);
            res.status(500).json({ error: 'Error deleting notepad' });
        }
    });
}

module.exports = { registerNotepadRoutes };
