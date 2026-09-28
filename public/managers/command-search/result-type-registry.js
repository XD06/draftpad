// Result-type registry for the global search palette.
//
// Every data domain (notepad / thought / today draft / future modules such
// as reflections) registers how its results are badged and how clicking one
// jumps to the source. The search renderer only reads this registry, so
// adding a domain means one register call — never a change to the search
// core. Unknown types degrade to a generic badge with no jump target.

const fallbackType = Object.freeze({
    label: '其他',
    badgeClass: 'badge-other',
    jump: null
});

const registry = new Map();

export function registerResultType(type, definition) {
    if (!type) return;
    registry.set(String(type), {
        label: String(definition?.label || fallbackType.label),
        badgeClass: String(definition?.badgeClass || fallbackType.badgeClass),
        jump: typeof definition?.jump === 'function' ? definition.jump : null
    });
}

export function getResultType(type) {
    return registry.get(String(type || '')) || fallbackType;
}
