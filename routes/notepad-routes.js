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
            const { name, content } = req.body || {};
            await storage.init();

            const data = await storage.readNotepadsMeta();
            const id = Date.now().toString();
            const desiredName = name || `Notepad ${data.notepads.length + 1}`;
            const uniqueName = generateUniqueName(desiredName, data.notepads);

            const newNotepad = {
                id,
                name: uniqueName,
                version: 1,
                createdAt: Date.now(),
                updatedAt: Date.now()
            };
            data.notepads.push(newNotepad);

            res.cookie(pageHistoryCookie, id, {
                httpOnly: true,
                secure: req.secure || (baseUrl.startsWith('https') && nodeEnv === 'production'),
                sameSite: 'strict',
                maxAge: pageHistoryCookieAge
            });

            await storage.saveNotepadsMeta(data);
            await storage.writeNoteContent(newNotepad, content || '');

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
            req.on('data', (chunk) => body.push(chunk));
            req.on('end', async () => {
                try {
                    const content = Buffer.concat(body).toString('utf8');

                    const data = await storage.readNotepadsMeta();
                    const id = Date.now().toString();
                    const uniqueName = generateUniqueName(name, data.notepads);

                    const newNotepad = {
                        id,
                        name: uniqueName,
                        version: 1,
                        createdAt: Date.now(),
                        updatedAt: Date.now()
                    };
                    data.notepads.push(newNotepad);
                    await storage.saveNotepadsMeta(data);
                    await storage.writeNoteContent(newNotepad, content);

                    broadcastUpdate(id, content);
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
            const { data, notepad } = await findNotepadById(id);
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

            const otherNotepads = data.notepads.filter(n => n.id !== id);
            const uniqueName = generateUniqueName(name, otherNotepads);

            const shouldRenameFile = id !== 'default' && notepad.name !== uniqueName;

            if (shouldRenameFile) {
                try {
                    await storage.renameNoteContent(notepad, { ...notepad, name: uniqueName });
                } catch (err) {
                    console.warn(`Failed to rename notepad file for ${notepad.name}:`, err);
                    return res.status(500).json({ error: 'Failed to rename notepad file. Please try a different name.' });
                }
            }

            notepad.name = uniqueName;
            notepad.updatedAt = Date.now();
            notepad.version = (notepad.version || 1) + 1;
            await storage.saveNotepadsMeta(data);
            scheduleIndexNotepads(250);
            res.json({ ...notepad, nameChanged: uniqueName !== name });
        } catch (err) {
            res.status(500).json({ error: 'Error renaming notepad' });
        }
    });

    app.delete('/api/notepads/:id', async (req, res) => {
        try {
            const { id } = req.params;
            console.log(`Attempting to delete notepad with id: ${id}`);

            if (id === 'default') {
                console.log('Attempted to delete default notepad');
                return res.status(400).json({ error: 'Cannot delete default notepad' });
            }

            const { data, notepad } = await findNotepadById(id);
            console.log('Current notepads:', data.notepads);

            if (!notepad) {
                console.log(`Notepad with id ${id} not found`);
                return res.status(404).json({ error: 'Notepad not found' });
            }

            const notepadToDelete = notepad;

            const notepadIndex = data.notepads.findIndex(n => n.id === id);
            const removedNotepad = data.notepads.splice(notepadIndex, 1)[0];
            console.log('Removed notepad:', removedNotepad);

            await storage.saveNotepadsMeta(data);
            console.log('Updated notepads list saved');

            await storage.deleteNoteContent(notepadToDelete);

            scheduleIndexNotepads(250);
            res.json({ success: true, message: 'Notepad deleted successfully' });
        } catch (err) {
            console.error('Error in delete notepad endpoint:', err);
            res.status(500).json({ error: 'Error deleting notepad' });
        }
    });
}

module.exports = { registerNotepadRoutes };
