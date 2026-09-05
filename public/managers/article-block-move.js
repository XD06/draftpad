function splitTrailingGap(raw) {
    const match = String(raw || '').match(/([ \t]*\r?\n(?:[ \t]*\r?\n)*)$/);
    if (!match) return { block: String(raw || ''), gap: '' };
    return {
        block: raw.slice(0, -match[1].length),
        gap: match[1]
    };
}

export function splitTopLevelMarkdownBlocks(value, lexer) {
    const source = String(value || '');
    if (typeof lexer !== 'function') return { ok: false, value: source, blocks: [], gaps: [] };

    let tokens;
    try {
        tokens = lexer(source);
    } catch {
        return { ok: false, value: source, blocks: [], gaps: [] };
    }

    if (!Array.isArray(tokens) || tokens.map(token => token?.raw || '').join('') !== source) {
        return { ok: false, value: source, blocks: [], gaps: [] };
    }

    const blocks = [];
    const gaps = [''];
    let sourceOffset = 0;

    tokens.forEach(token => {
        const raw = String(token?.raw || '');
        if (token?.type === 'space') {
            gaps[blocks.length] += raw;
            sourceOffset += raw.length;
            return;
        }

        const split = splitTrailingGap(raw);
        blocks.push({
            raw: split.block,
            type: String(token?.type || ''),
            start: sourceOffset,
            end: sourceOffset + split.block.length
        });
        gaps.push(split.gap);
        sourceOffset += raw.length;
    });

    const rebuilt = gaps[0] + blocks.map((block, index) => block.raw + gaps[index + 1]).join('');
    return {
        ok: rebuilt === source,
        value: rebuilt,
        blocks,
        gaps
    };
}

export function moveStandaloneMarkdownBlock({
    value,
    markdown,
    sourceIndex,
    targetIndex,
    placement,
    lexer,
    expectedBlockCount
} = {}) {
    const parsed = splitTopLevelMarkdownBlocks(value, lexer);
    const blockCount = parsed.blocks.length;
    if (!parsed.ok || !Number.isInteger(sourceIndex) || !Number.isInteger(targetIndex)) {
        return { ok: false, value: String(value || ''), reason: 'invalid-block-map' };
    }
    if (Number.isInteger(expectedBlockCount) && expectedBlockCount !== blockCount) {
        return { ok: false, value: parsed.value, reason: 'block-count-mismatch' };
    }
    if (sourceIndex < 0 || sourceIndex >= blockCount || targetIndex < 0 || targetIndex >= blockCount || sourceIndex === targetIndex) {
        return { ok: false, value: parsed.value, reason: 'invalid-target' };
    }

    const sourceMarkdown = String(markdown || '');
    if (!sourceMarkdown || parsed.blocks[sourceIndex].raw.trim() !== sourceMarkdown) {
        return { ok: false, value: parsed.value, reason: 'source-mismatch' };
    }

    const blocks = parsed.blocks.map(block => ({ ...block }));
    const [sourceBlock] = blocks.splice(sourceIndex, 1);
    const adjustedTargetIndex = targetIndex - (sourceIndex < targetIndex ? 1 : 0);
    const insertionIndex = adjustedTargetIndex + (placement === 'after' ? 1 : 0);
    if (insertionIndex < 0 || insertionIndex > blocks.length) {
        return { ok: false, value: parsed.value, reason: 'invalid-insertion' };
    }

    blocks.splice(insertionIndex, 0, sourceBlock);
    const next = parsed.gaps[0] + blocks.map((block, index) => block.raw + parsed.gaps[index + 1]).join('');
    return { ok: next !== parsed.value, value: next, reason: next === parsed.value ? 'no-op' : '' };
}
