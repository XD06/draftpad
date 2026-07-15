export const TIME_COMMAND = '/time';
const TIME_MARKER_RE = /\[\[time:(?:(create|update)(?:@([1-4]))?:)?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\]/g;
const TIME_MARKER_EXACT_RE = /^\[\[time:(?:(create|update)(?:@([1-4]))?:)?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\]$/;
const TIME_KIND_LABELS = {
    create: '创建',
    update: '更新'
};

function normalizeTimeKind(kind = 'create') {
    return kind === 'update' ? 'update' : 'create';
}

function normalizeTimeLevel(level = 1) {
    const value = Number.parseInt(level, 10);
    if (!Number.isFinite(value)) return 1;
    return Math.min(4, Math.max(1, value));
}

function escapeAttribute(value = '') {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

export function formatTimeStamp(date = new Date()) {
    const value = date instanceof Date ? date : new Date(date);
    const pad = number => String(number).padStart(2, '0');
    return [
        value.getFullYear(),
        pad(value.getMonth() + 1),
        pad(value.getDate())
    ].join('-') + ' ' + [
        pad(value.getHours()),
        pad(value.getMinutes()),
        pad(value.getSeconds())
    ].join(':');
}

export function buildTimeMarker(date = new Date(), kind = 'create', level = 1) {
    const normalizedKind = normalizeTimeKind(kind);
    const normalizedLevel = normalizeTimeLevel(level);
    const levelSuffix = normalizedKind === 'update' && normalizedLevel > 1 ? `@${normalizedLevel}` : '';
    return `[[time:${normalizedKind}${levelSuffix}:${formatTimeStamp(date)}]]`;
}

export function buildUpdatedTimeMarker(previousMarker = '', date = new Date()) {
    const parsed = parseTimeMarkerText(previousMarker);
    const previousLevel = parsed?.kind === 'update' ? parsed.level : 0;
    return buildTimeMarker(date, 'update', previousLevel + 1);
}

export function parseTimeMarkerText(markerText = '') {
    const match = String(markerText || '').match(TIME_MARKER_EXACT_RE);
    if (!match) return null;
    const kind = normalizeTimeKind(match[1] || 'create');
    const level = kind === 'update' ? normalizeTimeLevel(match[2] || 1) : 1;
    const stamp = match[3];
    return {
        kind,
        level,
        label: TIME_KIND_LABELS[kind],
        stamp,
        source: match[0]
    };
}

export function replaceTimeMarker(source = '', markerText = '', nextMarker = '') {
    const text = String(source || '');
    const marker = String(markerText || '');
    const replacement = String(nextMarker || '');
    if (!marker || !replacement || !text.includes(marker)) return text;
    return text.replace(marker, replacement);
}

export function deleteTimeMarker(source = '', markerText = '') {
    const text = String(source || '');
    const marker = String(markerText || '');
    if (!marker) return text;
    const index = text.indexOf(marker);
    if (index < 0) return text;
    let before = text.slice(0, index);
    let after = text.slice(index + marker.length);
    if (before.endsWith(' ') && after.startsWith(' ')) {
        after = after.slice(1);
    } else if (!after && before.endsWith(' ')) {
        before = before.slice(0, -1);
    } else if (!before && after.startsWith(' ')) {
        after = after.slice(1);
    }
    return before + after;
}

export function moveTimeMarker(value = '', markerText = '', sourceOffset = -1, dropOffset = -1) {
    const text = String(value || '');
    const marker = String(markerText || '');
    const start = Number(sourceOffset);
    const drop = Number(dropOffset);
    if (!marker || !Number.isInteger(start) || !Number.isInteger(drop)) return text;
    if (start < 0 || start + marker.length > text.length) return text;
    if (text.slice(start, start + marker.length) !== marker) return text;

    const end = start + marker.length;
    const clampedDrop = Math.min(text.length, Math.max(0, drop));
    if (clampedDrop >= start && clampedDrop <= end) return text;

    const withoutMarker = text.slice(0, start) + text.slice(end);
    const insertionOffset = clampedDrop > end
        ? clampedDrop - marker.length
        : clampedDrop;
    return `${withoutMarker.slice(0, insertionOffset)}${marker}${withoutMarker.slice(insertionOffset)}`;
}

export function replaceTimeCommandBeforeCursor(value, selectionStart, selectionEnd, { now = () => new Date() } = {}) {
    const text = String(value || '');
    const start = Number(selectionStart);
    const end = Number(selectionEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start !== end) return null;
    if (start < TIME_COMMAND.length) return null;

    const beforeCursor = text.slice(0, start);
    const commandStart = start - TIME_COMMAND.length;
    if (beforeCursor.slice(commandStart) !== TIME_COMMAND) return null;

    const charAfterCommand = text[end] || '';
    if (/^[A-Za-z0-9_-]$/.test(charAfterCommand)) return null;

    const marker = buildTimeMarker(now());
    const nextValue = `${text.slice(0, commandStart)}${marker}${text.slice(end)}`;
    return {
        value: nextValue,
        selectionStart: commandStart + marker.length,
        selectionEnd: commandStart + marker.length,
        marker
    };
}

export function handleTimeCommandKeydown(event, options = {}) {
    if (!event || event.key !== 'Enter' || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.isComposing) {
        return false;
    }

    const target = event.target;
    const currentTarget = event.currentTarget;
    const control = typeof target?.value === 'string'
        ? target
        : (typeof currentTarget?.value === 'string' ? currentTarget : null);
    if (!control || typeof control.value !== 'string') return false;

    const result = replaceTimeCommandBeforeCursor(
        control.value,
        control.selectionStart,
        control.selectionEnd,
        options
    );
    if (!result) return false;

    event.preventDefault();
    control.value = result.value;
    control.setSelectionRange?.(result.selectionStart, result.selectionEnd);
    control.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
}

export function renderTimeMarkers(escaped = '', className = 'time-marker', { draggable = false } = {}) {
    return String(escaped || '').replace(TIME_MARKER_RE, (match, kindValue, levelValue, stamp) => {
        const kind = normalizeTimeKind(kindValue || 'create');
        const level = kind === 'update' ? normalizeTimeLevel(levelValue || 1) : 1;
        const label = TIME_KIND_LABELS[kind];
        const safeSource = escapeAttribute(match);
        const safeStamp = escapeAttribute(stamp);
        const draggableAttr = draggable ? ' data-time-draggable="true"' : '';
        return `<span class="${className} is-${kind} is-level-${level}" data-time-marker="true" data-time-kind="${kind}" data-time-level="${level}" data-time-source="${safeSource}" data-time-label="${label}" data-time-stamp="${safeStamp}" title="${label}时间：${safeStamp}" aria-label="${label}时间：${safeStamp}"${draggableAttr}>${safeSource}</span>`;
    });
}
