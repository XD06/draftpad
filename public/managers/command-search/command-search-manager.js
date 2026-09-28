// Global search palette (Ctrl+F / Ctrl+K): fetches /api/search, renders the
// grouped result list and routes activation through the result-type
// registry.
//
// Presentation contract with the server (server/search/): each result
// carries `type`, `matchCount` and per-line `occurrences`. The domain that
// owns the currently open article is expanded into individually clickable
// match entries pinned to the top (jump keeps the palette open so Enter can
// walk through matches); every other domain shows one entry per document
// with a source badge and a match-count chip.

import { getResultType } from './result-type-registry.js';

const SEARCH_DEBOUNCE_MS = 200;

// Same keyword semantics as server/search/matcher.js: whitespace-separated,
// lowercase, AND. Only used as a fallback when the server response carries
// no keywords (e.g. an old backend).
function splitKeywords(query) {
    return String(query || '')
        .split(/\s+/)
        .map(keyword => keyword.trim().toLowerCase())
        .filter(Boolean)
        .slice(0, 8);
}

export function createCommandSearchManager({
    fetchJson,
    getCurrentNotepadId,
    isCurrentArticleVisible
}) {
    let overlay = null;
    let input = null;
    let resultsContainer = null;
    let selectedIndex = 0;
    let isActive = false;
    let currentQuery = '';
    let currentKeywords = [];
    let entries = [];
    // Last non-empty search state, restored when the palette reopens so a
    // jump (which closes the palette to reveal the article) can be followed
    // by Ctrl+F → Enter to walk to the next match.
    let lastQuery = '';
    let lastResults = [];
    let lastKeywords = [];
    let searchTimeout = null;

    function init() {
        overlay = document.getElementById('command-palette-overlay');
        input = document.getElementById('command-input');
        resultsContainer = document.getElementById('command-results');
        if (!overlay || !input || !resultsContainer) {
            console.warn('[command-search] palette DOM not found; search disabled');
            return;
        }

        input.addEventListener('input', () => search());
        input.addEventListener('keydown', event => handleKeydown(event));
        overlay.addEventListener('click', event => {
            if (event.target === overlay) close();
        });
        resultsContainer.addEventListener('click', event => {
            const item = event.target.closest('.command-item[data-entry-index]');
            if (!item) return;
            activateEntry(Number(item.dataset.entryIndex));
        });

        // One key, one search: both Ctrl+F and Ctrl+K open the global palette
        // in every workspace (user decision — mobile has no key choice).
        window.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && (event.key.toLowerCase() === 'f' || event.key.toLowerCase() === 'k')) {
                event.preventDefault();
                open();
                return;
            }
            if (event.key === 'Escape' && isActive) close();
        });
    }

    function open() {
        if (!overlay) return;
        isActive = true;
        overlay.classList.add('active');
        if (lastQuery) {
            input.value = lastQuery;
            currentQuery = lastQuery;
            currentKeywords = lastKeywords;
            render(lastResults, { preserveSelection: true });
        } else {
            input.value = '';
            currentQuery = '';
            currentKeywords = [];
            entries = [];
            resultsContainer.innerHTML = '';
        }
        input.focus();
    }

    function close() {
        isActive = false;
        overlay?.classList.remove('active');
    }

    function search() {
        const query = input.value.trim();
        currentQuery = query;
        if (!query) {
            clearTimeout(searchTimeout);
            entries = [];
            resultsContainer.innerHTML = '';
            return;
        }

        clearTimeout(searchTimeout);
        searchTimeout = setTimeout(async () => {
            if (!isActive) return;
            try {
                resultsContainer.innerHTML = '<div class="command-item"><span>Searching…</span></div>';
                const response = await fetchJson(`/api/search?q=${encodeURIComponent(query)}`);
                const data = await response.json();
                if (currentQuery !== query || !isActive) return; // stale response guard
                currentKeywords = Array.isArray(data.keywords) && data.keywords.length
                    ? data.keywords.map(String)
                    : splitKeywords(query);
                render(Array.isArray(data.results) ? data.results : []);
            } catch (error) {
                console.error('Search failed:', error);
                resultsContainer.innerHTML = '<div class="command-item"><span>Search failed</span></div>';
            }
        }, SEARCH_DEBOUNCE_MS);
    }

    // Flatten results into a renderable/focusable list: the current article's
    // occurrences first (all of them — the results container scrolls), then
    // the remaining documents grouped by type in server order.
    function buildEntries(results) {
        const list = Array.isArray(results) ? results : [];
        const currentId = getCurrentNotepadId?.();
        const showCurrentGroup = Boolean(currentId)
            && typeof isCurrentArticleVisible === 'function'
            && isCurrentArticleVisible();
        const currentResult = showCurrentGroup
            ? list.find(item => (
                item?.type === 'notepad'
                && item?.id === currentId
                && Array.isArray(item.occurrences)
                && item.occurrences.length > 0
            ))
            : null;

        const flattened = [];
        if (currentResult) {
            flattened.push({ kind: 'group-header', label: `当前文章 · ${currentResult.occurrences.length} 处匹配` });
            currentResult.occurrences.forEach((occurrence, index) => {
                flattened.push({
                    kind: 'match',
                    result: currentResult,
                    occurrence,
                    ordinal: index + 1,
                    total: currentResult.occurrences.length
                });
            });
            if (currentResult.occurrencesTruncated) {
                flattened.push({ kind: 'more', result: currentResult });
            }
        }

        const seenTypes = new Set();
        for (const item of list) {
            if (!item || item === currentResult) continue;
            const type = String(item.type || '');
            if (!seenTypes.has(type)) {
                seenTypes.add(type);
                flattened.push({ kind: 'group-header', label: getResultType(type).label });
            }
            flattened.push({ kind: 'doc', result: item });
        }
        return flattened;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = String(text ?? '');
        return div.innerHTML;
    }

    // Raw markdown lines carry block decoration (`## `, `1. `, `- [ ] `);
    // the palette shows the bare text so match entries stay scannable.
    function stripLineDecoration(text) {
        return String(text ?? '')
            .replace(/^\s{0,3}(?:- \[[ xX]\]\s+|#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s?)/, '')
            .trimEnd();
    }

    // Case-insensitive keyword highlight: collect every keyword's hit ranges,
    // merge overlaps and wrap them in <mark>. Server results rely on this
    // (they intentionally ship `matches: []` with exact keywords).
    function highlightKeywords(text, keywords) {
        const raw = String(text ?? '');
        if (!raw) return '';
        const lower = raw.toLowerCase();
        const ranges = [];
        for (const keyword of Array.isArray(keywords) ? keywords : []) {
            if (!keyword) continue;
            let cursor = lower.indexOf(keyword);
            while (cursor >= 0) {
                ranges.push([cursor, cursor + keyword.length]);
                cursor = lower.indexOf(keyword, cursor + keyword.length);
            }
        }
        if (ranges.length === 0) return escapeHtml(raw);
        ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
        const merged = ranges.reduce((result, range) => {
            const previous = result[result.length - 1];
            if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
            else result.push(range);
            return result;
        }, []);
        let html = '';
        let cursor = 0;
        for (const [start, end] of merged) {
            html += escapeHtml(raw.slice(cursor, start));
            html += `<mark class="command-search-highlight">${escapeHtml(raw.slice(start, end))}</mark>`;
            cursor = end;
        }
        return html + escapeHtml(raw.slice(cursor));
    }

    // Small block-type badge (like the article table of contents level
    // marks): H1–H6 for headings, 待办/列表/引用/代码 for the rest. Plain
    // paragraphs get no badge — most matches are plain text.
    function renderBlockBadge(block) {
        if (!block) return '';
        if (block.type === 'heading') {
            return `<span class="command-item-blockbadge">H${block.level || 1}</span>`;
        }
        const labels = { todo: '待办', list: '列表', quote: '引用', code: '代码' };
        const label = labels[block.type];
        return label ? `<span class="command-item-blockbadge">${label}</span>` : '';
    }

    // Current-article matches render as two-row entries: head row with the
    // block badge, context chip, section and ordinal; body row with the bare
    // highlighted line (full width, markdown decoration stripped). No
    // per-item badge/tint — the group header already says "当前文章".
    function renderMatchItem(entry, index, selectedClass) {
        const occurrence = entry.occurrence;
        const lineText = stripLineDecoration(occurrence.lineText);
        const showSection = Boolean(occurrence.section) && occurrence.section !== lineText;
        const section = showSection
            ? `<span class="command-item-section">${escapeHtml(occurrence.section)}</span>`
            : '';
        const context = occurrence.context
            ? `<span class="command-item-context">${escapeHtml(occurrence.context)}</span>`
            : '';
        return `
            <div class="command-item command-item-match${selectedClass}" data-entry-index="${index}">
                <div class="command-item-match-head">
                    ${renderBlockBadge(occurrence.block)}${context}${section}
                    <span class="command-item-ordinal">${entry.ordinal}/${entry.total}</span>
                </div>
                <span class="command-item-line">${highlightKeywords(lineText, currentKeywords)}</span>
            </div>`;
    }

    function renderDocItem(entry, index, selectedClass) {
        const typeInfo = getResultType(entry.result.type);
        const matchCount = Number(entry.result.matchCount || 0);
        const countChip = matchCount > 1 ? `<span class="command-item-count">${matchCount} 处</span>` : '';
        const snippet = entry.result.matchType === 'content' && entry.result.snippet
            ? `<span class="command-item-snippet">${highlightKeywords(entry.result.snippet, currentKeywords)}</span>`
            : '';
        const title = highlightKeywords(entry.result.title || entry.result.name || '', currentKeywords);
        return `
            <div class="command-item${selectedClass}" data-entry-index="${index}">
                <div class="command-item-main">
                    <span class="command-item-title">${title}</span>
                    ${snippet}
                </div>
                <span class="command-item-meta">
                    ${countChip}
                    <span class="command-item-badge ${typeInfo.badgeClass}">${escapeHtml(typeInfo.label)}</span>
                </span>
                <kbd>Enter</kbd>
            </div>`;
    }

    function render(results, { preserveSelection = false } = {}) {
        entries = buildEntries(results);
        const focusableCount = entries.filter(entry => entry.kind !== 'group-header').length;
        if (focusableCount === 0) {
            entries = [];
            resultsContainer.innerHTML = '<div class="command-item command-empty"><span>没有匹配的结果</span></div>';
            lastQuery = '';
            lastResults = [];
            lastKeywords = [];
            return;
        }
        if (!preserveSelection) selectedIndex = 0;
        else selectedIndex = Math.min(selectedIndex, focusableCount - 1);
        lastQuery = currentQuery;
        lastResults = Array.isArray(results) ? results : [];
        lastKeywords = currentKeywords;

        let focusOrdinal = 0;
        resultsContainer.innerHTML = entries.map((entry, index) => {
            if (entry.kind === 'group-header') {
                return `<div class="command-group-header">${escapeHtml(entry.label)}</div>`;
            }
            const selectedClass = focusOrdinal === selectedIndex ? ' selected' : '';
            focusOrdinal += 1;
            if (entry.kind === 'match') return renderMatchItem(entry, index, selectedClass);
            if (entry.kind === 'more') {
                return `
                    <div class="command-item command-item-more${selectedClass}" data-entry-index="${index}">
                        <span class="command-item-line">匹配较多未全部列出，进入文章查看</span>
                    </div>`;
            }
            return renderDocItem(entry, index, selectedClass);
        }).join('');
    }

    function activateEntry(index) {
        const entry = entries[index];
        if (!entry || entry.kind === 'group-header') return;
        if (entry.kind === 'match') {
            // Jump precisely to this line's first hit, then close: the modal
            // overlay (blur + dim) would hide the scroll behind it. Reopening
            // restores the query, results and selection, so Ctrl+F → Enter
            // walks to the next match.
            jumpToArticleMatch(entry.result, entry.occurrence);
            close();
            return;
        }
        if (entry.kind === 'more') {
            jumpToArticleMatch(entry.result, null);
            close();
            return;
        }
        const typeInfo = getResultType(entry.result.type);
        if (typeof typeInfo.jump === 'function') {
            Promise.resolve(typeInfo.jump(entry.result, { query: currentQuery, keywords: currentKeywords }))
                .catch(error => console.error('[command-search] jump failed:', error));
        } else {
            console.warn('[command-search] no jump handler registered for type:', entry.result.type);
        }
        close();
    }

    function jumpToArticleMatch(result, occurrence) {
        // Delegated to the app-level notepad jump (selectNotepad), the same
        // handler the `notepad` result type registers — the current-article
        // group only changes presentation, not the jump target domain.
        // `hitIndex` is the line's first hit in the document-wide hit
        // sequence, precise across multi-keyword queries.
        const typeInfo = getResultType(result.type);
        if (typeof typeInfo.jump === 'function') {
            Promise.resolve(typeInfo.jump(result, {
                query: currentQuery,
                keywords: currentKeywords,
                hitIndex: Number(occurrence?.hitIndex) || 0
            }))
                .catch(error => console.error('[command-search] jump failed:', error));
        }
    }

    function handleKeydown(event) {
        const items = resultsContainer.querySelectorAll('.command-item[data-entry-index]');
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            if (items.length === 0) return;
            selectedIndex = (selectedIndex + 1) % items.length;
            updateSelection(items);
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            if (items.length === 0) return;
            selectedIndex = (selectedIndex - 1 + items.length) % items.length;
            updateSelection(items);
        } else if (event.key === 'Enter') {
            const item = items[selectedIndex];
            if (item) activateEntry(Number(item.dataset.entryIndex));
        }
    }

    function updateSelection(items) {
        items.forEach((item, index) => {
            item.classList.toggle('selected', index === selectedIndex);
            if (index === selectedIndex) item.scrollIntoView({ block: 'nearest' });
        });
    }

    return {
        init,
        open,
        close,
        get isActive() {
            return isActive;
        }
    };
}
