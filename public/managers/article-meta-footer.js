/**
 * ArticleMetaFooter renders the article record watermark (created / updated /
 * revision count) anchored just below the article card's bottom edge.
 * It lives entirely OUTSIDE Vditor: the node is a child of .editor-main, never
 * of the .vditor-wysiwyg scroll container, so it cannot shift the article
 * layout, the scroll geometry, or the boot->vditor card handoff. It only reads
 * the card's rect (scroll/ResizeObserver, read-only) to follow the card end;
 * editor-main's overflow:hidden clips it away until the reader gets there.
 */
export class ArticleMetaFooter {
    constructor({ host, getCard }) {
        this.host = host;
        this.getCard = getCard;
        this.gap = 14;
        this.el = null;
        this.lineEl = null;
        this.metaKey = null;
        this.hasMeta = false;
        this.observedCard = null;
        this.handleViewportChange = this.handleViewportChange.bind(this);
    }

    attach() {
        if (this.el || !this.host) return;
        const el = document.createElement('div');
        el.className = 'article-meta';
        el.hidden = true;
        const divider = document.createElement('div');
        divider.className = 'article-meta-divider';
        divider.setAttribute('aria-hidden', 'true');
        const line = document.createElement('div');
        line.className = 'article-meta-line';
        el.append(divider, line);
        this.host.appendChild(el);
        this.el = el;
        this.lineEl = line;
        // Capture catches scroll from any descendant scroller, including the
        // Vditor surface that mounts later; passive + read-only keeps this off
        // the editor's own scroll path.
        this.host.addEventListener('scroll', this.handleViewportChange, { capture: true, passive: true });
        window.addEventListener('resize', this.handleViewportChange);
        document.addEventListener('visibilitychange', this.handleViewportChange);
    }

    setMeta(meta) {
        if (!this.el) return;
        const createdAt = Number(meta?.createdAt);
        const updatedAt = Number(meta?.updatedAt);
        const revision = Number(meta?.revision);
        const segments = [];
        if (Number.isFinite(createdAt) && createdAt > 0) {
            segments.push({ label: '创建', value: this.formatTime(createdAt) });
        }
        // A note that was never edited has updatedAt === createdAt; showing
        // both is noise, so the update segment only appears once they differ.
        if (Number.isFinite(updatedAt) && updatedAt > 0 && updatedAt !== createdAt) {
            segments.push({ label: '更新', value: this.formatTime(updatedAt) });
        }
        const edits = Number.isFinite(revision) ? Math.max(0, revision - 1) : 0;
        if (edits > 0) {
            segments.push({ label: '修改', value: `${edits} 次` });
        }
        const key = segments.map(segment => `${segment.label}${segment.value}`).join('|');
        if (key !== this.metaKey) {
            this.metaKey = key;
            this.renderSegments(segments);
        }
        this.hasMeta = segments.length > 0;
        this.el.hidden = !this.hasMeta;
        this.updatePosition();
    }

    formatTime(timestamp) {
        const date = new Date(timestamp);
        const pad = value => String(value).padStart(2, '0');
        return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
    }

    renderSegments(segments) {
        const line = this.lineEl;
        if (!line) return;
        line.replaceChildren();
        segments.forEach((segment, index) => {
            if (index > 0) {
                const dot = document.createElement('span');
                dot.className = 'article-meta-dot';
                dot.textContent = '·';
                dot.setAttribute('aria-hidden', 'true');
                line.appendChild(dot);
            }
            const item = document.createElement('span');
            item.className = 'article-meta-item';
            item.title = `${segment.label} ${segment.value}`;
            const label = document.createElement('span');
            label.className = 'article-meta-label';
            label.textContent = segment.label;
            item.append(label, document.createTextNode(segment.value));
            line.appendChild(item);
        });
    }

    handleViewportChange() {
        this.updatePosition();
    }

    updatePosition() {
        if (!this.el) return;
        if (!this.hasMeta || this.host.offsetParent === null) {
            this.el.style.visibility = 'hidden';
            return;
        }
        const card = this.getCard?.();
        if (!card) {
            // Boot phase / editor not mounted yet: stay invisible, never at a
            // stale position.
            this.el.style.visibility = 'hidden';
            return;
        }
        this.observeCard(card);
        const hostRect = this.host.getBoundingClientRect();
        const cardRect = card.getBoundingClientRect();
        this.el.style.top = `${Math.round(cardRect.bottom - hostRect.top + this.gap)}px`;
        this.el.style.visibility = '';
    }

    observeCard(card) {
        if (typeof ResizeObserver === 'undefined') return;
        if (this.observedCard === card) return;
        if (!this.resizeObserver) {
            // Card height changes (typing, vditor re-render, workspace display
            // toggles) must move the anchor; the observer only reads rects and
            // writes the footer's own top, so it cannot loop.
            this.resizeObserver = new ResizeObserver(() => this.updatePosition());
        }
        this.resizeObserver.disconnect();
        this.resizeObserver.observe(card);
        this.observedCard = card;
    }
}
