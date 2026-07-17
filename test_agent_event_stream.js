const assert = require('assert');
const {
    formatSSEComment,
    formatSSEEvent,
    parseLastEventId
} = require('./scripts/agent/agent-event-stream');

function run() {
    assert.strictEqual(parseLastEventId('12'), 12);
    assert.strictEqual(parseLastEventId('-3'), 0);
    assert.strictEqual(parseLastEventId('not-a-number'), 0);
    assert.strictEqual(parseLastEventId(['7']), 7);

    const event = formatSSEEvent({
        id: 3,
        type: 'text.delta',
        data: { text: '你好\n世界', secret: undefined }
    });
    assert(event.startsWith('id: 3\nevent: text.delta\ndata: '));
    assert(event.endsWith('\n\n'));
    assert(event.includes('你好\\n世界'));
    assert.strictEqual(formatSSEComment('ok\nnope'), ': ok nope\n\n');
    console.log('Agent event stream checks passed');
}

run();
