const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const skillPath = path.join(root, 'SKILL.md');
const skill = fs.readFileSync(skillPath, 'utf8');

[
    'Choose The Right Area First',
    'normally no more than 50 Chinese characters',
    'Today Draft',
    '/api/notepads?title=release',
    '/api/notes/<article-id>',
    '/api/thoughts?q=release',
    '/api/thoughts/<thought-id>',
    '/api/assets/images',
    '/api/assets/files',
    'Preserve its existing `attachments`',
    '"assetId":"<new-asset-id>"',
    '/api/today-drafts',
    '/api/today-drafts/today-standup-01',
    '/api/meta',
    '/api/search?q=release&scope=all',
    '409',
    'data/',
    'GET /openapi.json'
].forEach(fragment => {
    assert(skill.includes(fragment), `SKILL.md should document ${fragment}`);
});

const { NOTES } = require('../scripts/seed-demo-data');
const skillDemo = NOTES.find(note => note.id === 'demo-agent-skill' && note.name === 'skill.md');
assert(skillDemo, 'demo data should include a skill.md Notepad');
assert.strictEqual(skillDemo.content, skill, 'the skill.md demo article must exactly match SKILL.md');

console.log('DumbPad API skill checks passed');
