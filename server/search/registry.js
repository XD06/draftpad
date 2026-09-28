'use strict';

// Aggregates the domain search providers behind one call for the HTTP route.
//
// Adding a data domain (e.g. the future reflections module) means appending
// one provider here — the route, the response contract (each result carries
// its `type`) and the frontend result-type registry pick it up without any
// change to the search core. A failing provider degrades to no results from
// that domain and logs loudly; it never takes the whole search down.

const { splitKeywords } = require('./matcher.js');

const SCOPES = ['notepads', 'thoughts', 'today_drafts', 'all'];
const DEFAULT_SCOPE = 'all';

function createSearchRegistry({ providers }) {
    const providerList = Array.isArray(providers) ? providers : [];

    async function search({ query = '', scope = DEFAULT_SCOPE } = {}) {
        const keywords = splitKeywords(query);
        if (keywords.length === 0) return { keywords, results: [] };

        const selected = providerList.filter(provider => (
            scope === 'all' || provider.scope === scope
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

module.exports = { createSearchRegistry, SCOPES, DEFAULT_SCOPE };
