export const CODE_LANGUAGE_CATALOG = [
    { id: 'plaintext', label: 'Plaintxt', aliases: ['text', 'plain', 'txt', 'plaintxt'], icon: 'plaintext.png' },
    { id: 'javascript', label: 'JavaScript', aliases: ['js'], icon: 'javascript.png' },
    { id: 'python', label: 'Python', aliases: ['py'], icon: 'python.png' },
    { id: 'cpp', label: 'C++', aliases: ['c++'], icon: 'cpp.png' },
    { id: 'c', label: 'C', aliases: [], icon: 'c.png' },
    { id: 'java', label: 'Java', aliases: [], icon: 'java.png' },
    { id: 'typescript', label: 'TypeScript', aliases: ['ts'], icon: 'typescript.png' },
    { id: 'go', label: 'Go', aliases: [], icon: 'go.png' },
    { id: 'rust', label: 'Rust', aliases: ['rs'], icon: 'rust.png' },
    { id: 'php', label: 'PHP', aliases: [], icon: 'php.png' },
    { id: 'csharp', label: 'C#', aliases: ['cs', 'c#'], icon: 'csharp.png' },
    { id: 'swift', label: 'Swift', aliases: [], icon: 'swift.png' },
    { id: 'kotlin', label: 'Kotlin', aliases: ['kt'], icon: 'kotlin.png' },
    { id: 'ruby', label: 'Ruby', aliases: ['rb'], icon: 'ruby.png' },
    { id: 'html', label: 'HTML', aliases: [], icon: 'html.png' },
    { id: 'css', label: 'CSS', aliases: [], icon: 'css.png' },
    { id: 'scss', label: 'Sass/SCSS', aliases: ['sass'] },
    { id: 'less', label: 'Less', aliases: [] },
    { id: 'xml', label: 'XML', aliases: [] },
    { id: 'json', label: 'JSON', aliases: [], icon: 'json.png' },
    { id: 'bash', label: 'Shell', aliases: ['sh', 'shell'], icon: 'bash.png' },
    { id: 'powershell', label: 'PowerShell', aliases: ['ps', 'pwsh'], icon: 'powershell.png' },
    { id: 'yaml', label: 'YAML', aliases: ['yml'] },
    { id: 'toml', label: 'TOML', aliases: [] },
    { id: 'dockerfile', label: 'Dockerfile', aliases: ['docker'], icon: 'dockerfile.png' },
    { id: 'ini', label: 'INI', aliases: ['conf'] },
    { id: 'sql', label: 'SQL', aliases: [], icon: 'sql.png' },
    { id: 'markdown', label: 'Markdown', aliases: ['md'], icon: 'markdown.png' },
    { id: 'textile', label: 'Textile', aliases: [] },
    { id: 'latex', label: 'LaTeX', aliases: ['tex'] },
    { id: 'diff', label: 'Diff', aliases: ['patch'] },
    { id: 'http', label: 'HTTP', aliases: [] },
    { id: 'nginx', label: 'Nginx', aliases: [], icon: 'nginx.png' },
    { id: 'mermaid', label: 'Mermaid', aliases: [], icon: 'mermaid.png' }
];

const DEFAULT_LANGUAGE_IDS = ['plaintext', 'javascript', 'python'];
const CUSTOM_LANGUAGE_RE = /^[A-Za-z0-9_+.#-]{1,40}$/;

function normalizeQuery(value) {
    return String(value || '').trim().toLowerCase();
}

export function resolveCodeLanguage(value = '') {
    const query = normalizeQuery(value) || 'plaintext';
    const match = CODE_LANGUAGE_CATALOG.find(item => (
        item.id === query || item.aliases.some(alias => alias.toLowerCase() === query)
    ));
    if (match) return match.id;
    return CUSTOM_LANGUAGE_RE.test(query) ? query : null;
}

export function getCodeLanguageIconPath(value = '') {
    const language = resolveCodeLanguage(value);
    if (!language) return '';
    const item = CODE_LANGUAGE_CATALOG.find(candidate => candidate.id === language);
    return item?.icon ? `/Assets/code-language-icons/${item.icon}` : '';
}

export function findCodeLanguageSuggestions(value = '', limit = 3) {
    const query = normalizeQuery(value);
    const maxItems = Math.max(1, Math.min(3, Number(limit) || 3));
    if (!query) {
        return DEFAULT_LANGUAGE_IDS
            .map(id => CODE_LANGUAGE_CATALOG.find(item => item.id === id))
            .filter(Boolean)
            .slice(0, maxItems);
    }

    return CODE_LANGUAGE_CATALOG
        .map((item, index) => {
            const terms = [item.id, ...item.aliases, item.label].map(term => String(term).toLowerCase());
            let score = Number.POSITIVE_INFINITY;
            terms.forEach((term, termIndex) => {
                if (term === query) score = Math.min(score, termIndex);
                else if (term.startsWith(query)) score = Math.min(score, 10 + termIndex);
                else if (term.includes(query)) score = Math.min(score, 20 + termIndex);
            });
            return { item, index, score };
        })
        .filter(candidate => Number.isFinite(candidate.score))
        .sort((a, b) => a.score - b.score || a.index - b.index)
        .slice(0, maxItems)
        .map(candidate => candidate.item);
}
