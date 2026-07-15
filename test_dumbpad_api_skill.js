const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = __dirname;
const skillPath = path.join(root, 'SKILL.md');
const skill = fs.readFileSync(skillPath, 'utf8');

[
    'Authorization: Bearer $DUMBPAD_PIN',
    'GET /api/notepads',
    'POST /api/notes/:id',
    'PATCH /api/notepads/:id',
    'GET /api/thoughts',
    'PATCH /api/thoughts/:id',
    'GET /api/search',
    '409',
    'data/',
    'public/openapi.json'
].forEach(fragment => {
    assert(skill.includes(fragment), `SKILL.md should document ${fragment}`);
});

const { NOTES } = require('./scripts/seed-demo-data');
const skillDemo = NOTES.find(note => note.id === 'demo-agent-skill' && note.name === 'skill.md');
assert(skillDemo, 'demo data should include a skill.md Notepad');
assert.strictEqual(skillDemo.content, skill, 'the skill.md demo article must exactly match SKILL.md');

console.log('DumbPad API skill checks passed');
