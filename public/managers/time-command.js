export const TIME_COMMAND = '/time';
const TIME_MARKER_RE = /\[\[time:(?:(create|update):)?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\]/g;
const TIME_MARKER_EXACT_RE = /^\[\[time:(?:(create|update):)?(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\]\]$/;
const TIME_KIND_LABELS = {
    create: '创建',
    update: '更新'
};

function normalizeTimeKind(kind = 'create') {
    return kind === 'update' ? 'update' : 'create';
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

export function buildTimeMarker(date = new Date(), kind = 'create') {
    return `[[time:${normalizeTimeKind(kind)}:${formatTimeStamp(date)}]]`;
}

export function parseTimeMarkerText(markerText = '') {
    const match = String(markerText || '').match(TIME_MARKER_EXACT_RE);
    if (!match) return null;
    const kind = normalizeTimeKind(match[1] || 'create');
    const stamp = match[2];
    return {
        kind,
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

export function replaceTimeCommandBeforeCursor(value, selectionStart, selectionEnd, { now = () => new Date() } = {}) {
    const text = String(value || '');
    const start = Number(selectionStart);
    const end = Number(selectionEnd);
    if (!Number.isFinite(start) || !Number.isFinite(end) || start !== end) return null;
    if (start < TIME_COMMAND.length) return null;

    const beforeCursor = text.slice(0, start);
    const commandStart = start - TIME_COMMAND.length;
    if (beforeCursor.slice(commandStart) !== TIME_COMMAND) return null;

    const charBeforeCommand = commandStart > 0 ? text[commandStart - 1] : '';
    if (charBeforeCommand && !/\s/.test(charBeforeCommand)) return null;

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

    const control = event.currentTarget || event.target;
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

export function renderTimeMarkers(escaped = '', className = 'time-marker') {
    return String(escaped || '').replace(TIME_MARKER_RE, (match, kindValue, stamp) => {
        const kind = normalizeTimeKind(kindValue || 'create');
        const label = TIME_KIND_LABELS[kind];
        const safeSource = escapeAttribute(match);
        const safeStamp = escapeAttribute(stamp);
        return `<time class="${className} is-${kind}" data-time-marker="true" data-time-kind="${kind}" data-time-source="${safeSource}" data-time-stamp="${safeStamp}" title="${label}时间：${safeStamp}" aria-label="${label}时间：${safeStamp}"><span class="time-marker-icon" aria-hidden="true">${timeMarkerIcon(kind)}</span><span class="time-marker-label">${label}</span><span class="time-marker-stamp">${stamp}</span></time>`;
    });
}

function timeMarkerIcon(kind = 'create') {
    if (kind === 'update') {
        return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8"></circle><path d="M12 8v5l3 2"></path></svg>';
    }
    return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.3" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"></path><path d="M5 12h14"></path></svg>';
}
