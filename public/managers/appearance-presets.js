/**
 * 外观与阅读色彩预设注册表：维护主题色、划线色、高亮底色、批注色的亮/暗双模式令牌，
 * 负责默认状态零覆盖（保持既定琥珀金与默认标记外观），以及同步首屏防闪烁变量缓存。
 */

export const APPEARANCE_CACHE_KEY = 'dumbpad_appearance_vars_v1';

export const DEFAULT_APPEARANCE = Object.freeze({
    accent: 'default',
    drawColor: 'default',
    highlightColor: 'default',
    annotationColor: 'default',
    calloutStyle: 'default',
    headingStyle: 'default',
    listStyle: 'default'
});

export const ACCENT_PRESETS = Object.freeze({
    default: Object.freeze({
        id: 'default',
        label: '琥珀金',
        swatchLight: '#E5A100',
        swatchDark: '#FFD60A'
    }),
    blue: Object.freeze({
        id: 'blue',
        label: '海盐蓝',
        swatchLight: '#2563EB',
        swatchDark: '#60A5FA',
        light: Object.freeze({ primary: '#2563EB', rgb: '37, 99, 235', checked: '#2563EB', doing: '#1D4ED8' }),
        dark: Object.freeze({ primary: '#60A5FA', rgb: '96, 165, 250', checked: '#60A5FA', doing: '#3B82F6' })
    }),
    sage: Object.freeze({
        id: 'sage',
        label: '鼠尾草绿',
        swatchLight: '#15803D',
        swatchDark: '#4ADE80',
        light: Object.freeze({ primary: '#15803D', rgb: '21, 128, 61', checked: '#15803D', doing: '#166534' }),
        dark: Object.freeze({ primary: '#4ADE80', rgb: '74, 222, 128', checked: '#4ADE80', doing: '#22C55E' })
    }),
    plum: Object.freeze({
        id: 'plum',
        label: '石楠紫',
        swatchLight: '#7C3AED',
        swatchDark: '#A78BFA',
        light: Object.freeze({ primary: '#7C3AED', rgb: '124, 58, 237', checked: '#7C3AED', doing: '#6D28D9' }),
        dark: Object.freeze({ primary: '#A78BFA', rgb: '167, 139, 250', checked: '#A78BFA', doing: '#8B5CF6' })
    }),
    slate: Object.freeze({
        id: 'slate',
        label: '石墨灰',
        swatchLight: '#475569',
        swatchDark: '#CBD5E1',
        light: Object.freeze({ primary: '#475569', rgb: '71, 85, 105', checked: '#475569', doing: '#334155' }),
        dark: Object.freeze({ primary: '#CBD5E1', rgb: '203, 213, 225', checked: '#CBD5E1', doing: '#94A3B8' })
    })
});

export const DRAW_PRESETS = Object.freeze({
    default: Object.freeze({
        id: 'default',
        label: '静谧蓝',
        swatchLight: '#2563EB',
        swatchDark: '#60A5FA'
    }),
    cobalt: Object.freeze({
        id: 'cobalt',
        label: '深海蓝',
        swatchLight: '#1D4ED8',
        swatchDark: '#38BDF8',
        light: '#1D4ED8',
        dark: '#38BDF8'
    }),
    teal: Object.freeze({
        id: 'teal',
        label: '青瓷绿',
        swatchLight: '#0D9488',
        swatchDark: '#2DD4BF',
        light: '#0D9488',
        dark: '#2DD4BF'
    }),
    amber: Object.freeze({
        id: 'amber',
        label: '琥珀棕',
        swatchLight: '#D97706',
        swatchDark: '#FBBF24',
        light: '#D97706',
        dark: '#FBBF24'
    }),
    rose: Object.freeze({
        id: 'rose',
        label: '烟熏玫红',
        swatchLight: '#E11D48',
        swatchDark: '#FB7185',
        light: '#E11D48',
        dark: '#FB7185'
    })
});

export const HIGHLIGHT_PRESETS = Object.freeze({
    default: Object.freeze({
        id: 'default',
        label: '琥珀柔黄',
        swatchLight: '#FDE68A',
        swatchDark: '#B48A16'
    }),
    mint: Object.freeze({
        id: 'mint',
        label: '青柠薄荷',
        swatchLight: '#A7F3D0',
        swatchDark: '#2A7B5C',
        light: 'rgba(52, 211, 153, 0.24)',
        dark: 'rgba(52, 211, 153, 0.22)'
    }),
    sky: Object.freeze({
        id: 'sky',
        label: '晴空冰蓝',
        swatchLight: '#BAE6FD',
        swatchDark: '#256B8E',
        light: 'rgba(56, 189, 248, 0.24)',
        dark: 'rgba(56, 189, 248, 0.22)'
    }),
    lavender: Object.freeze({
        id: 'lavender',
        label: '柔雾浅紫',
        swatchLight: '#DDD6FE',
        swatchDark: '#5D479C',
        light: 'rgba(167, 139, 250, 0.24)',
        dark: 'rgba(167, 139, 250, 0.24)'
    }),
    peach: Object.freeze({
        id: 'peach',
        label: '珊瑚桃粉',
        swatchLight: '#FECDD3',
        swatchDark: '#8C3B4C',
        light: 'rgba(251, 113, 133, 0.22)',
        dark: 'rgba(251, 113, 133, 0.22)'
    })
});

export const ANNOTATION_PRESETS = Object.freeze({
    default: Object.freeze({
        id: 'default',
        label: '珊瑚红',
        swatchLight: '#E74C3C',
        swatchDark: '#E74C3C'
    }),
    amber: Object.freeze({
        id: 'amber',
        label: '焦糖暖橙',
        swatchLight: '#EA580C',
        swatchDark: '#FB923C',
        light: '#EA580C',
        lightHover: '#F97316',
        dark: '#FB923C',
        darkHover: '#FDBA74'
    }),
    indigo: Object.freeze({
        id: 'indigo',
        label: '深邃靛青',
        swatchLight: '#4F46E5',
        swatchDark: '#818CF8',
        light: '#4F46E5',
        lightHover: '#6366F1',
        dark: '#818CF8',
        darkHover: '#A5B4FC'
    }),
    berry: Object.freeze({
        id: 'berry',
        label: '浆果酒红',
        swatchLight: '#DB2777',
        swatchDark: '#F472B6',
        light: '#DB2777',
        lightHover: '#EC4899',
        dark: '#F472B6',
        darkHover: '#F9A8D4'
    }),
    teal: Object.freeze({
        id: 'teal',
        label: '松石青',
        swatchLight: '#0F766E',
        swatchDark: '#2DD4BF',
        light: '#0F766E',
        lightHover: '#14B8A6',
        dark: '#2DD4BF',
        darkHover: '#5EEAD4'
    })
});

export const CALLOUT_STYLE_PRESETS = Object.freeze({
    default: Object.freeze({ id: 'default', label: '雾底左浮标' }),
    tint: Object.freeze({ id: 'tint', label: '纸面圆徽风' }),
    quote: Object.freeze({ id: 'quote', label: '无底引号轻角标' })
});

export const HEADING_STYLE_PRESETS = Object.freeze({
    default: Object.freeze({ id: 'default', label: '极淡边标' }),
    bookmark: Object.freeze({ id: 'bookmark', label: '书签色楔' }),
    section: Object.freeze({ id: 'section', label: '章节印记' }),
    underline: Object.freeze({ id: 'underline', label: '短杠底线' }),
    diamond: Object.freeze({ id: 'diamond', label: '几何微标' })
});

export const LIST_STYLE_PRESETS = Object.freeze({
    default: Object.freeze({ id: 'default', label: '经典圆点' }),
    tinted: Object.freeze({ id: 'tinted', label: '主色柔点' }),
    geometric: Object.freeze({ id: 'geometric', label: '几何方菱' }),
    guide: Object.freeze({ id: 'guide', label: '嵌套引导线' })
});

export const APPEARANCE_GROUP_REGISTRY = Object.freeze({
    accent: ACCENT_PRESETS,
    drawColor: DRAW_PRESETS,
    highlightColor: HIGHLIGHT_PRESETS,
    annotationColor: ANNOTATION_PRESETS,
    calloutStyle: CALLOUT_STYLE_PRESETS,
    headingStyle: HEADING_STYLE_PRESETS,
    listStyle: LIST_STYLE_PRESETS
});

export const APPEARANCE_BUNDLES = Object.freeze([
    Object.freeze({
        id: 'amber-classic',
        label: '琥珀经典',
        subtitle: 'DumbPad 默认原味',
        appearance: Object.freeze({
            accent: 'default',
            drawColor: 'default',
            highlightColor: 'default',
            annotationColor: 'default',
            calloutStyle: 'default',
            headingStyle: 'default',
            listStyle: 'default'
        })
    }),
    Object.freeze({
        id: 'calm-study',
        label: '海盐研读',
        subtitle: '冷静专注 · Notion 风',
        appearance: Object.freeze({
            accent: 'blue',
            drawColor: 'cobalt',
            highlightColor: 'sky',
            annotationColor: 'indigo',
            calloutStyle: 'tint',
            headingStyle: 'bookmark',
            listStyle: 'guide'
        })
    }),
    Object.freeze({
        id: 'sage-forest',
        label: '鼠尾草护眼',
        subtitle: '柔和自然 · 久读不累',
        appearance: Object.freeze({
            accent: 'sage',
            drawColor: 'teal',
            highlightColor: 'mint',
            annotationColor: 'teal',
            calloutStyle: 'tint',
            headingStyle: 'underline',
            listStyle: 'tinted'
        })
    }),
    Object.freeze({
        id: 'warm-paper',
        label: '落日暖茶',
        subtitle: '温润纸感 · 无冷蓝刺激',
        appearance: Object.freeze({
            accent: 'default',
            drawColor: 'amber',
            highlightColor: 'default',
            annotationColor: 'amber',
            calloutStyle: 'quote',
            headingStyle: 'section',
            listStyle: 'tinted'
        })
    }),
    Object.freeze({
        id: 'mist-lavender',
        label: '柔雾暮紫',
        subtitle: '雅致层次 · 重点分明',
        appearance: Object.freeze({
            accent: 'plum',
            drawColor: 'cobalt',
            highlightColor: 'lavender',
            annotationColor: 'berry',
            calloutStyle: 'quote',
            headingStyle: 'diamond',
            listStyle: 'tinted'
        })
    }),
    Object.freeze({
        id: 'nordic-slate',
        label: '极简水墨',
        subtitle: '低噪中性 · 标注点睛',
        appearance: Object.freeze({
            accent: 'slate',
            drawColor: 'teal',
            highlightColor: 'mint',
            annotationColor: 'default',
            calloutStyle: 'default',
            headingStyle: 'underline',
            listStyle: 'geometric'
        })
    })
]);

export function getBundleById(bundleId) {
    const id = typeof bundleId === 'string' ? bundleId.trim() : '';
    return APPEARANCE_BUNDLES.find((item) => item.id === id) || null;
}

export function findMatchingBundleId(appearance) {
    const norm = normalizeAppearanceSettings(appearance);
    const hit = APPEARANCE_BUNDLES.find((bundle) => (
        bundle.appearance.accent === norm.accent
        && bundle.appearance.drawColor === norm.drawColor
        && bundle.appearance.highlightColor === norm.highlightColor
        && bundle.appearance.annotationColor === norm.annotationColor
        && bundle.appearance.calloutStyle === norm.calloutStyle
        && bundle.appearance.headingStyle === norm.headingStyle
        && bundle.appearance.listStyle === norm.listStyle
    ));
    return hit ? hit.id : 'custom';
}

export function getBundleLabel(bundleId) {
    if (bundleId === 'custom') return '自定义微调';
    return getBundleById(bundleId)?.label || '自定义微调';
}

export const MANAGED_APPEARANCE_CSS_VARS = Object.freeze([
    '--primary-color',
    '--primary-rgb',
    '--code-markdown',
    '--success-status-bg',
    '--task-checked-color',
    '--task-doing-color',
    '--draw-color',
    '--thought-draw-color',
    '--highlight-bg',
    '--highlight-preview-bg',
    '--thought-highlight-bg',
    '--thought-highlight-color',
    '--annotation-color',
    '--annotation-color-hover'
]);

function normalizePresetId(groupMap, value) {
    const key = typeof value === 'string' ? value.trim() : '';
    return key && Object.prototype.hasOwnProperty.call(groupMap, key) ? key : 'default';
}

export function normalizeAppearanceSettings(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    return {
        accent: normalizePresetId(ACCENT_PRESETS, src.accent),
        drawColor: normalizePresetId(DRAW_PRESETS, src.drawColor),
        highlightColor: normalizePresetId(HIGHLIGHT_PRESETS, src.highlightColor),
        annotationColor: normalizePresetId(ANNOTATION_PRESETS, src.annotationColor),
        calloutStyle: normalizePresetId(CALLOUT_STYLE_PRESETS, src.calloutStyle),
        headingStyle: normalizePresetId(HEADING_STYLE_PRESETS, src.headingStyle),
        listStyle: normalizePresetId(LIST_STYLE_PRESETS, src.listStyle)
    };
}

export function serializeAppearanceKey(appearance) {
    const norm = normalizeAppearanceSettings(appearance);
    return `${norm.accent}|${norm.drawColor}|${norm.highlightColor}|${norm.annotationColor}`;
}

const LAYOUT_STYLE_ATTRS = Object.freeze([
    ['calloutStyle', 'data-callout-style'],
    ['headingStyle', 'data-heading-style'],
    ['listStyle', 'data-list-style']
]);

export function getPresetLabel(group, id) {
    const groupMap = APPEARANCE_GROUP_REGISTRY[group];
    if (!groupMap) return '';
    const preset = groupMap[id] || groupMap.default;
    return preset ? preset.label : '';
}

export function resolveAppearanceCssVars(appearance, theme = 'light') {
    const norm = normalizeAppearanceSettings(appearance);
    const isDark = theme === 'dark';
    const vars = {};

    if (norm.accent !== 'default') {
        const preset = ACCENT_PRESETS[norm.accent];
        const palette = isDark ? preset.dark : preset.light;
        vars['--primary-color'] = palette.primary;
        vars['--primary-rgb'] = palette.rgb;
        vars['--code-markdown'] = `rgba(${palette.rgb}, ${isDark ? 0.18 : 0.12})`;
        vars['--success-status-bg'] = `rgba(${palette.rgb}, 0.85)`;
        vars['--task-checked-color'] = palette.checked;
        vars['--task-doing-color'] = palette.doing;
    }

    if (norm.drawColor !== 'default') {
        const preset = DRAW_PRESETS[norm.drawColor];
        const color = isDark ? preset.dark : preset.light;
        vars['--draw-color'] = color;
        vars['--thought-draw-color'] = color;
    }

    if (norm.highlightColor !== 'default') {
        const preset = HIGHLIGHT_PRESETS[norm.highlightColor];
        const bg = isDark ? preset.dark : preset.light;
        vars['--highlight-bg'] = bg;
        vars['--highlight-preview-bg'] = bg;
        vars['--thought-highlight-bg'] = bg;
        vars['--thought-highlight-color'] = 'inherit';
    }

    if (norm.annotationColor !== 'default') {
        const preset = ANNOTATION_PRESETS[norm.annotationColor];
        vars['--annotation-color'] = isDark ? preset.dark : preset.light;
        vars['--annotation-color-hover'] = isDark ? preset.darkHover : preset.lightHover;
    }

    return vars;
}

export function applyAppearanceSettings(
    appearance,
    theme = 'light',
    rootEl = (typeof document !== 'undefined' ? document.documentElement : null),
    { storage = null, persistCache = false } = {}
) {
    const norm = normalizeAppearanceSettings(appearance);
    const activeVars = resolveAppearanceCssVars(norm, theme);

    if (rootEl?.style) {
        for (const prop of MANAGED_APPEARANCE_CSS_VARS) {
            if (Object.prototype.hasOwnProperty.call(activeVars, prop)) {
                rootEl.style.setProperty(prop, activeVars[prop]);
            } else {
                rootEl.style.removeProperty(prop);
            }
        }
    }

    if (typeof rootEl?.setAttribute === 'function' && typeof rootEl?.removeAttribute === 'function') {
        for (const [key, attrName] of LAYOUT_STYLE_ATTRS) {
            const val = norm[key];
            if (val && val !== 'default') {
                rootEl.setAttribute(attrName, val);
            } else {
                rootEl.removeAttribute(attrName);
            }
        }
    }

    if (persistCache && storage) {
        try {
            const lightVars = resolveAppearanceCssVars(norm, 'light');
            const darkVars = resolveAppearanceCssVars(norm, 'dark');
            if (Object.keys(lightVars).length === 0 && Object.keys(darkVars).length === 0) {
                storage.removeItem?.(APPEARANCE_CACHE_KEY);
            } else {
                storage.setItem?.(
                    APPEARANCE_CACHE_KEY,
                    JSON.stringify({
                        key: serializeAppearanceKey(norm),
                        light: lightVars,
                        dark: darkVars
                    })
                );
            }
        } catch (_err) {
            // Private browsing / quota disabled: runtime CSS overrides remain active.
        }
    }

    return { appearance: norm, cssVars: activeVars };
}
