/**
 * Counts successful note editing sessions independently of sync versions.
 * Runs inside the existing notepad write lock and metadata write.
 * Client activity tokens distinguish continuous typing from inactivity.
 */
const EDIT_SESSION_IDLE_MS = 60000;

function getNoteEditStats(notepad) {
    return {
        editCount: Number.isSafeInteger(notepad?.editCount) ? notepad.editCount : 0,
        editCountStartedAt: notepad?.editCountStartedAt || null,
        updatedAt: notepad?.updatedAt || null
    };
}

function recordNoteEdit(notepad, sessionId, previousSessionId, now = Date.now()) {
    const validSessionId = typeof sessionId === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(sessionId)
        ? sessionId : null;
    const sessionIds = Array.isArray(notepad.editSessionIds) ? notepad.editSessionIds : [];
    const continuing = validSessionId && sessionIds.includes(validSessionId);
    const endedPrevious = validSessionId && typeof previousSessionId === 'string'
        && sessionIds.includes(previousSessionId);
    const idle = !Number.isFinite(notepad.lastEditAt) || now - notepad.lastEditAt >= EDIT_SESSION_IDLE_MS;
    if (!notepad.editCountStartedAt) notepad.editCountStartedAt = now;
    if (!continuing && (idle || endedPrevious)) {
        notepad.editCount = getNoteEditStats(notepad).editCount + 1;
        notepad.editSessionIds = [];
    }
    if (validSessionId) {
        notepad.editSessionIds = [...(notepad.editSessionIds || []).filter(id => id !== validSessionId), validSessionId].slice(-32);
    }
    notepad.lastEditAt = now;
    return getNoteEditStats(notepad);
}

module.exports = { recordNoteEdit, getNoteEditStats };
