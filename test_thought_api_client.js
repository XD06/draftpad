const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const sourcePath = path.join(__dirname, 'public', 'managers', 'thought-api-client.js');
const source = fs.readFileSync(sourcePath, 'utf8')
    .replace('export class ThoughtApiError', 'class ThoughtApiError')
    .replace('export default class ThoughtApiClient', 'class ThoughtApiClient')
    + '\nmodule.exports = { ThoughtApiClient, ThoughtApiError };\n';

const context = {
    module: { exports: {} },
    exports: {},
    URLSearchParams,
    window: { fetch: () => Promise.reject(new Error('unused')) }
};
vm.runInNewContext(source, context, { filename: sourcePath });

function response(body = {}) {
    return {
        ok: true,
        headers: { get: () => 'application/json' },
        json: async () => body
    };
}

async function run() {
    const calls = [];
    const client = new context.module.exports.ThoughtApiClient({
        fetchImpl: async (url, options) => {
            calls.push({ url, options });
            return response({ success: true });
        }
    });

    await client.toggleComplete('thought/1', 7);
    assert.deepStrictEqual(
        JSON.parse(calls[0].options.body),
        { action: 'toggle_complete', baseVersion: 7 },
        'toggle mutations should carry the Thought version'
    );
    assert(calls[0].url.endsWith('/thought%2F1'), 'Thought ids should remain URL encoded');

    await client.overwrite('thought-2', { text: 'new', version: 9 });
    assert.strictEqual(JSON.parse(calls[1].options.body).baseVersion, 9, 'overwrite should carry the state version');

    await client.addSubitem('thought-3', 'next', 3);
    assert.strictEqual(JSON.parse(calls[2].options.body).baseVersion, 3, 'subitem mutations should carry the Thought version');

    await client.listPage({
        limit: 10,
        light: true,
        cursor: 'cursor-token',
        updatedSince: 123,
        tag: 'project',
        status: 'todo',
        sort: 'timeline'
    });
    assert(
        calls[3].url.includes('format=page') &&
        calls[3].url.includes('cursor=cursor-token') &&
        calls[3].url.includes('updatedSince=123') &&
        calls[3].url.includes('tag=project') &&
        calls[3].url.includes('status=todo') &&
        calls[3].url.includes('sort=timeline'),
        'page listings should expose cursor, filtering, sorting, and updated-since query parameters'
    );

    console.log('Thought API client checks passed');
}

run().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
