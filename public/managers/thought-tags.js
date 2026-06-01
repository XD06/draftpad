const DEFAULT_TAG_STORAGE_KEY = 'dumbpad_thought_tags';
const DEFAULT_LOCALE = 'zh-Hans-CN';

export function normalizeTag(value) {
    return String(value || '')
        .replace(/^#+/, '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 24);
}

function sortTags(tags, locale = DEFAULT_LOCALE) {
    return [...tags].sort((a, b) => a.localeCompare(b, locale));
}

function hasTag(tags, tag) {
    const normalized = normalizeTag(tag);
    if (!normalized) return false;
    return tags.some(item => item.toLowerCase() === normalized.toLowerCase());
}

export class ThoughtTagRegistry {
    constructor({
        storage = globalThis.localStorage,
        key = DEFAULT_TAG_STORAGE_KEY,
        locale = DEFAULT_LOCALE,
        onError = (message, error) => console.warn(message, error)
    } = {}) {
        this.storage = storage;
        this.key = key;
        this.locale = locale;
        this.onError = onError;
        this.savedTags = this.load();
    }

    normalize(value) {
        return normalizeTag(value);
    }

    load() {
        try {
            if (!this.storage) return [];
            const raw = this.storage.getItem(this.key);
            if (!raw) return [];
            const tags = JSON.parse(raw);
            if (!Array.isArray(tags)) return [];
            return sortTags(tags.map(tag => normalizeTag(tag)).filter(Boolean), this.locale);
        } catch (err) {
            this.onError('Failed to load thought tags:', err);
            return [];
        }
    }

    persist() {
        try {
            if (!this.storage) return;
            this.storage.setItem(this.key, JSON.stringify(this.savedTags));
        } catch (err) {
            this.onError('Failed to save thought tags:', err);
        }
    }

    saveTag(value) {
        const tag = normalizeTag(value);
        if (!tag) return '';
        if (!hasTag(this.savedTags, tag)) {
            this.savedTags.push(tag);
            this.savedTags = sortTags(this.savedTags, this.locale);
            this.persist();
        }
        return tag;
    }

    collectFromThoughts(thoughts = []) {
        const tagMap = new Map();
        for (const thought of Array.isArray(thoughts) ? thoughts : []) {
            for (const rawTag of Array.isArray(thought.tags) ? thought.tags : []) {
                const tag = normalizeTag(rawTag);
                if (!tag) continue;
                const key = tag.toLowerCase();
                if (!tagMap.has(key)) tagMap.set(key, tag);
            }
        }
        return sortTags(Array.from(tagMap.values()), this.locale);
    }

    getAllTags(thoughts = []) {
        return this.collectFromThoughts(thoughts);
    }

    syncFromThoughts(thoughts = []) {
        let changed = false;
        for (const tag of this.collectFromThoughts(thoughts)) {
            if (!hasTag(this.savedTags, tag)) {
                this.savedTags.push(tag);
                changed = true;
            }
        }
        if (changed) {
            this.savedTags = sortTags(this.savedTags, this.locale);
            this.persist();
        }
    }

    isTagUsed(thoughts = [], rawTag) {
        const tag = normalizeTag(rawTag).toLowerCase();
        if (!tag) return false;
        return (Array.isArray(thoughts) ? thoughts : []).some(thought => (
            Array.isArray(thought.tags) &&
            thought.tags.some(item => normalizeTag(item).toLowerCase() === tag)
        ));
    }
}

export function renderThoughtTagFilters({ tags = [], activeTag = '', escapeHtml }) {
    const active = String(activeTag || '').toLowerCase();
    const tagButtons = tags.map(tag => `
            <button type="button" class="thoughts-tag-filter ${tag.toLowerCase() === active ? 'active' : ''}" data-tag-filter="${escapeHtml(tag)}">
                <span>#</span>${escapeHtml(tag)}
            </button>
        `).join('');

    return `
            <div class="thoughts-tag-filter-row">
                ${tagButtons}
                <label class="thoughts-tag-create">
                    <span>#</span>
                    <input id="thoughts-tag-filter-input" class="thoughts-tag-filter-input" type="text" placeholder="新建或筛选" autocomplete="off">
                </label>
                ${activeTag ? '<button type="button" class="thoughts-tag-clear" data-clear-tag-filter>清除</button>' : ''}
            </div>
        `;
}

export function renderQuickAddTagChoices({ tags = [], selectedTags = [], escapeHtml }) {
    const selected = new Set(selectedTags.map(tag => String(tag || '').toLowerCase()));
    if (tags.length === 0) {
        return '<div class="quick-add-tags-empty">No saved tags</div>';
    }

    return tags.map(tag => {
        const isSelected = selected.has(tag.toLowerCase());
        return `
                <button type="button" class="quick-add-tag-chip ${isSelected ? 'selected' : ''}" data-quick-tag-choice="${escapeHtml(tag)}" aria-pressed="${isSelected}">
                    <span>#${escapeHtml(tag)}</span>
                </button>
            `;
    }).join('');
}

export function renderQuickAddTagSuggestions({ suggestions = [], escapeHtml }) {
    return suggestions.map(tag => `
            <button type="button" class="quick-add-tag-suggestion" data-quick-tag-suggestion="${escapeHtml(tag)}">#${escapeHtml(tag)}</button>
        `).join('');
}

export function renderAISuggestedTags({ thought, userTags = [], escapeHtml }) {
    const current = new Set((userTags || []).map(tag => String(tag || '').toLowerCase()));
    const suggestions = (thought?.aiTags || [])
        .map(tag => normalizeTag(tag))
        .filter(Boolean)
        .filter(tag => !current.has(tag.toLowerCase()))
        .slice(0, 4);

    if (suggestions.length === 0) return '';

    return `
            <div class="thought-ai-tags" title="AI 建议标签，点击后加入当前 Thought">
                ${suggestions.map(tag => `
                    <button type="button" class="thought-ai-tag-suggestion" data-ai-tag="${escapeHtml(tag)}">
                        +#${escapeHtml(tag)}
                    </button>
                `).join('')}
            </div>
        `;
}
