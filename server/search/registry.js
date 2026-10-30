'use strict';

// Aggregates the domain search providers behind one call for the HTTP route.
//
// Adding a data domain (e.g. the future reflections module) means appending
// one provider here — the route, the response contract (each result carries
// its `type`) and the frontend result-type registry pick it up without any
// change to the search core. A failing provider degrades to no results from
// that domain and logs loudly; it never takes the whole search down.

const { splitKeywords } = require('./matcher.js');

const SCOPES = ['notepads', 'thoughts', 'instant_drafts', 'today_drafts', 'all'];
const DEFAULT_SCOPE = 'all';

// `today_drafts` is the pre-rename spelling of `instant_drafts`. It stays in
// the accepted enum and is normalized onto the canonical scope so callers
// written against the old name keep selecting the same provider.
const SCOPE_ALIASES = { today_drafts: 'instant_drafts' };

function normalizeScope(scope) {
    const value = String(scope || DEFAULT_SCOPE).toLowerCase();
    return SCOPE_ALIASES[value] || value;
}

function createSearchRegistry({ providers }) {
    const providerList = Array.isArray(providers) ? providers : [];

    async function search({ query = '', scope = DEFAULT_SCOPE } = {}) {
        const keywords = splitKeywords(query);
        if (keywords.length === 0) return { keywords, results: [] };

        const requestedScope = normalizeScope(scope);
        const selected = providerList.filter(provider => (
            requestedScope === 'all' || provider.scope === requestedScope
        ));
        const batches = await Promise.all(selected.map(async provider => {
            try {
                return await provider.search(keywords);
            } catch (error) {
                console.error(`[search] provider "${provider.type}" failed:`, error.message);
                return [];
            }
        }));
        return { keywords, results: batches.flat() };
    }

    return { search, scopes: SCOPES, defaultScope: DEFAULT_SCOPE };
}

module.exports = { createSearchRegistry, SCOPES, DEFAULT_SCOPE, normalizeScope };
