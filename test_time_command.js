const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = __dirname;

function loadTimeCommand() {
    const sourcePath = path.join(ROOT, 'public', 'managers', 'time-command.js');
    const source = fs.readFileSync(sourcePath, 'utf8')
        .replace(/export const /g, 'const ')
        .replace(/export function /g, 'function ')
        + '\nmodule.exports = { TIME_COMMAND, buildTimeMarker, buildUpdatedTimeMarker, deleteTimeMarker, formatTimeStamp, handleTimeCommandKeydown, parseTimeMarkerText, replaceTimeCommandBeforeCursor, replaceTimeMarker, renderTimeMarkers };\n';
    const context = {
        module: { exports: {} },
        exports: {},
        Date,
        Event: class FakeEvent {
            constructor(type, options = {}) {
                this.type = type;
                this.bubbles = Boolean(options.bubbles);
            }
        },
        String,
        Number,
        RegExp
    };
    vm.runInNewContext(source, context, { filename: sourcePath });
    return context.module.exports;
}

function run() {
    const {
        buildTimeMarker,
        buildUpdatedTimeMarker,
        deleteTimeMarker,
        formatTimeStamp,
        handleTimeCommandKeydown,
        parseTimeMarkerText,
        replaceTimeCommandBeforeCursor,
        replaceTimeMarker,
        renderTimeMarkers
    } = loadTimeCommand();
    const fixed = new Date(2026, 5, 21, 9, 8, 7);

    assert(formatTimeStamp(fixed) === '2026-06-21 09:08:07', 'formatTimeStamp should use local date and time');
    assert(buildTimeMarker(fixed) === '[[time:create:2026-06-21 09:08:07]]', 'buildTimeMarker should wrap formatted create time');
    assert(buildTimeMarker(fixed, 'update') === '[[time:update:2026-06-21 09:08:07]]', 'buildTimeMarker should wrap formatted update time');
    assert(buildTimeMarker(fixed, 'update', 3) === '[[time:update@3:2026-06-21 09:08:07]]', 'buildTimeMarker should persist stronger update levels');
    const parsedLegacy = parseTimeMarkerText('[[time:2026-06-21 09:08:07]]');
    assert(parsedLegacy.kind === 'create', 'parseTimeMarkerText should treat legacy markers as create markers');
    assert(parsedLegacy.level === 1, 'parseTimeMarkerText should give legacy create markers level 1');
    assert(parsedLegacy.label === '创建', 'parseTimeMarkerText should expose a create label');
    assert(parsedLegacy.stamp === '2026-06-21 09:08:07', 'parseTimeMarkerText should expose the timestamp');
    assert(parsedLegacy.source === '[[time:2026-06-21 09:08:07]]', 'parseTimeMarkerText should preserve source text');
    const parsedUpdateLevel = parseTimeMarkerText('[[time:update@4:2026-06-21 09:08:07]]');
    assert(parsedUpdateLevel.kind === 'update', 'parseTimeMarkerText should parse update level markers');
    assert(parsedUpdateLevel.level === 4, 'parseTimeMarkerText should expose update level markers');
    assert(
        buildUpdatedTimeMarker('[[time:create:2026-06-21 09:08:07]]', fixed) === '[[time:update:2026-06-21 09:08:07]]',
        'buildUpdatedTimeMarker should turn create markers into level 1 update markers'
    );
    assert(
        buildUpdatedTimeMarker('[[time:update@3:2026-06-21 09:08:07]]', fixed) === '[[time:update@4:2026-06-21 09:08:07]]',
        'buildUpdatedTimeMarker should increment update marker levels'
    );
    assert(
        buildUpdatedTimeMarker('[[time:update@4:2026-06-21 09:08:07]]', fixed) === '[[time:update@4:2026-06-21 09:08:07]]',
        'buildUpdatedTimeMarker should cap update marker levels at 4'
    );

    const result = replaceTimeCommandBeforeCursor('记录 /time', '记录 /time'.length, '记录 /time'.length, {
        now: () => fixed
    });
    assert(result.value === '记录 [[time:create:2026-06-21 09:08:07]]', 'replaceTimeCommandBeforeCursor should replace trailing /time');
    assert(result.selectionStart === result.value.length, 'replaceTimeCommandBeforeCursor should move cursor after marker');

    const inlineResult = replaceTimeCommandBeforeCursor('记录/time', '记录/time'.length, '记录/time'.length, { now: () => fixed });
    assert(
        inlineResult.value === '记录[[time:create:2026-06-21 09:08:07]]',
        'replaceTimeCommandBeforeCursor should replace inline /time without requiring a leading space'
    );
    const middleResult = replaceTimeCommandBeforeCursor('记录/time内容', '记录/time'.length, '记录/time'.length, { now: () => fixed });
    assert(
        middleResult.value === '记录[[time:create:2026-06-21 09:08:07]]内容',
        'replaceTimeCommandBeforeCursor should replace /time before CJK text'
    );
    assert(
        replaceTimeCommandBeforeCursor('记录/timeabc', '记录/time'.length, '记录/time'.length, { now: () => fixed }) === null,
        'replaceTimeCommandBeforeCursor should not replace /time before an ASCII word suffix'
    );
    assert(
        replaceTimeCommandBeforeCursor('/time', 0, 0, { now: () => fixed }) === null,
        'replaceTimeCommandBeforeCursor should require the cursor after /time'
    );

    const delegatedControl = {
        value: '记录/time内容',
        selectionStart: '记录/time'.length,
        selectionEnd: '记录/time'.length,
        setSelectionRange(start, end) {
            this.selectionStart = start;
            this.selectionEnd = end;
        },
        dispatchEvent(event) {
            this.lastDispatchedEvent = event;
        }
    };
    let prevented = false;
    const delegatedEvent = {
        key: 'Enter',
        target: delegatedControl,
        currentTarget: {},
        preventDefault() {
            prevented = true;
        }
    };
    assert(handleTimeCommandKeydown(delegatedEvent, { now: () => fixed }) === true, 'handleTimeCommandKeydown should support delegated keydown events');
    assert(prevented === true, 'handleTimeCommandKeydown should prevent the Enter newline after replacing /time');
    assert(
        delegatedControl.value === '记录[[time:create:2026-06-21 09:08:07]]内容',
        'handleTimeCommandKeydown should replace delegated target value inline'
    );
    assert(
        delegatedControl.lastDispatchedEvent?.type === 'input' && delegatedControl.lastDispatchedEvent.bubbles,
        'handleTimeCommandKeydown should dispatch a bubbling input event after replacement'
    );

    assert(
        renderTimeMarkers('x [[time:2026-06-21 09:08:07]]', 'custom-time').includes('class="custom-time is-create is-level-1"'),
        'renderTimeMarkers should render legacy time marker html as create'
    );
    assert(
        renderTimeMarkers('x [[time:2026-06-21 09:08:07]]', 'custom-time').includes('<span class="custom-time') &&
            renderTimeMarkers('x [[time:2026-06-21 09:08:07]]', 'custom-time').includes('>[[time:2026-06-21 09:08:07]]</span>'),
        'renderTimeMarkers should keep source text in an inline span so editors can preserve marker position'
    );
    assert(
        !renderTimeMarkers('x [[time:2026-06-21 09:08:07]]', 'custom-time').includes('<time'),
        'renderTimeMarkers should not emit time tags inside editable content'
    );
    assert(
        renderTimeMarkers('x [[time:update:2026-06-21 09:08:07]]', 'custom-time').includes('class="custom-time is-update is-level-1"'),
        'renderTimeMarkers should render update time marker html'
    );
    assert(
        renderTimeMarkers('x [[time:update@3:2026-06-21 09:08:07]]', 'custom-time').includes('is-level-3'),
        'renderTimeMarkers should render update level classes'
    );
    assert(
        replaceTimeMarker('记录 [[time:create:2026-06-21 09:08:07]]', '[[time:create:2026-06-21 09:08:07]]', '[[time:update:2026-06-21 10:00:00]]') === '记录 [[time:update:2026-06-21 10:00:00]]',
        'replaceTimeMarker should replace the selected marker only'
    );
    assert(
        deleteTimeMarker('记录 [[time:create:2026-06-21 09:08:07]] 内容', '[[time:create:2026-06-21 09:08:07]]') === '记录 内容',
        'deleteTimeMarker should remove the selected marker and one adjacent duplicate space'
    );
    assert(
        deleteTimeMarker('记录 [[time:create:2026-06-21 09:08:07]]', '[[time:create:2026-06-21 09:08:07]]') === '记录',
        'deleteTimeMarker should remove a trailing marker without leaving a trailing space'
    );

    console.log('Time command checks passed');
}

run();
