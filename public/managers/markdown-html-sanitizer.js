// Browser-side HTML sanitizer for marked output. marked v15 dropped its
// sanitize option, so the copy-all / print paths in app.js would otherwise
// paste raw note HTML straight into innerHTML / document.write.
// Semantics mirror the share-page sanitizer in routes/share-routes.js:
// strip dangerous elements and on* handlers, neutralize dangerous URL schemes.

// Parsing happens inside <template>, whose content document is inert: no
// resource loads (img src) and no script execution during or after parse.
const DANGEROUS_ELEMENTS = new Set([
    'SCRIPT', 'IFRAME', 'OBJECT', 'EMBED', 'FORM', 'INPUT', 'BUTTON',
    'TEXTAREA', 'SELECT', 'OPTION', 'LINK', 'META', 'BASE', 'STYLE',
    'SVG', 'MATH'
]);

const URL_ATTRIBUTES = new Set([
    'href', 'src', 'action', 'poster', 'background', 'data',
    'srcdoc', 'formaction', 'xlink:href'
]);

// Inline raster data images cannot execute; everything else on the
// data:/blob:/file:/script scheme list is rejected.
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);/i;

function isDangerousUrl(value) {
    const normalized = String(value == null ? '' : value)
        .replace(/&#x([0-9a-f]+);?/gi, (_, hex) => { try { return String.fromCodePoint(parseInt(hex, 16)); } catch { return ''; } })
        .replace(/&#(\d+);?/g, (_, dec) => { try { return String.fromCodePoint(parseInt(dec, 10)); } catch { return ''; } })
        .replace(/&colon;/gi, ':')
        .replace(/&(?:tab|newline);/gi, '')
        .replace(/[\u0000-\u0020\u00a0\u2028\u2029]+/g, '')
        .toLowerCase();
    if (SAFE_DATA_IMAGE.test(normalized)) return false;
    return /^(?:javascript|vbscript|data|file|blob):/.test(normalized);
}

function sanitizeHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html == null ? '' : html);
    const elements = template.content.querySelectorAll('*');
    for (const element of elements) {
        if (DANGEROUS_ELEMENTS.has(element.tagName)) {
            element.remove();
            continue;
        }
        for (const attribute of Array.from(element.attributes)) {
            const name = attribute.name.toLowerCase();
            if (name.startsWith('on')) {
                element.removeAttribute(attribute.name);
            } else if (URL_ATTRIBUTES.has(name) && isDangerousUrl(attribute.value)) {
                element.setAttribute(attribute.name, '#');
            }
        }
    }
    return template.innerHTML;
}

export { sanitizeHtml };
