import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeNotepadActivityStats, toLocalDateKey } from '../public/managers/settings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

function runActivityStatsUnitTests() {
    const fixedNow = new Date(2026, 9, 25, 18, 30, 0).getTime(); // 2026-10-25 local
    const todayKey = toLocalDateKey(fixedNow);
    const yesterday = fixedNow - 24 * 60 * 60 * 1000;
    const yesterdayKey = toLocalDateKey(yesterday);
    const fortyDaysAgo = fixedNow - 40 * 24 * 60 * 60 * 1000;
    const fortyDaysAgoKey = toLocalDateKey(fortyDaysAgo);

    const sampleNotepads = [
        {
            id: 'note-1',
            name: '今天新建并编辑',
            createdAt: fixedNow - 3600_000,
            updatedAt: fixedNow,
            lastEditAt: fixedNow,
            editCount: 5
        },
        {
            id: 'note-2',
            name: '昨天更新老文章',
            createdAt: fortyDaysAgo,
            updatedAt: yesterday,
            lastEditAt: yesterday,
            editCount: 3
        }
    ];

    const statsAll = computeNotepadActivityStats(sampleNotepads, {
        now: fixedNow,
        weeks: 31,
        mode: 'all'
    });

    assert.equal(statsAll.totalNotes, 2, 'should count 2 active notepads');
    assert.equal(statsAll.totalEdits, 8, 'should sum editCount (5 + 3)');
    assert.equal(statsAll.recentNotes30d, 2, 'both notes were updated within 30 days');
    assert.equal(statsAll.activeDays, 3, 'today, yesterday, and 40 days ago should be active');
    assert.equal(statsAll.weekCount, 31, 'should generate 31 week columns');
    assert.equal(statsAll.cells.length, 31 * 7, 'should generate 31 * 7 daily square cells');
    assert.equal(statsAll.latestNotepad?.id, 'note-1', 'should identify most recently updated note');

    const todayCell = statsAll.cells.find(cell => cell.dateKey === todayKey);
    const yesterdayCell = statsAll.cells.find(cell => cell.dateKey === yesterdayKey);
    const fortyDaysCell = statsAll.cells.find(cell => cell.dateKey === fortyDaysAgoKey);

    assert.ok(todayCell, 'today cell should exist in heatmap window');
    assert.equal(todayCell.created, 1, 'today should record 1 created note');
    assert.ok(todayCell.edits >= 2, 'today should record capped edit weight');
    assert.ok(todayCell.level >= 1 && todayCell.level <= 4, 'active day should have level 1..4');

    assert.ok(yesterdayCell, 'yesterday cell should exist');
    assert.equal(yesterdayCell.created, 0, 'yesterday had no new note creation');
    assert.ok(yesterdayCell.edits >= 1, 'yesterday had edit activity');

    assert.ok(fortyDaysCell, '40-days-ago cell should exist');
    assert.equal(fortyDaysCell.created, 1, '40 days ago recorded note creation');

    const statsCreated = computeNotepadActivityStats(sampleNotepads, {
        now: fixedNow,
        weeks: 31,
        mode: 'created'
    });
    const yesterdayCreatedCell = statsCreated.cells.find(cell => cell.dateKey === yesterdayKey);
    assert.equal(yesterdayCreatedCell?.score, 0, 'created mode should ignore pure edit days');
    assert.equal(yesterdayCreatedCell?.level, 0, 'created mode should give level 0 to pure edit days');

    const statsEdits = computeNotepadActivityStats(sampleNotepads, {
        now: fixedNow,
        weeks: 31,
        mode: 'edits'
    });
    const fortyDaysEditsCell = statsEdits.cells.find(cell => cell.dateKey === fortyDaysAgoKey);
    assert.equal(fortyDaysEditsCell?.score, 0, 'edits mode should ignore pure creation date when updatedAt differs');
    assert.equal(fortyDaysEditsCell?.level, 0, 'edits mode should give level 0 to pure creation date');
}

function runDomAndCssContractTests() {
    const indexHtml = fs.readFileSync(path.join(projectRoot, 'public/index.html'), 'utf8');
    const stylesCss = fs.readFileSync(path.join(projectRoot, 'public/Assets/styles.css'), 'utf8');

    // Verify 4 navigation tabs and panes exist
    for (const tab of ['overview', 'sync', 'assets', 'trash']) {
        assert.ok(
            indexHtml.includes(`data-settings-tab="${tab}"`),
            `index.html should contain settings tab button for "${tab}"`
        );
        assert.ok(
            indexHtml.includes(`data-settings-pane="${tab}"`),
            `index.html should contain settings tab panel for "${tab}"`
        );
    }

    // Verify all legacy IDs inside #settings-modal are preserved
    const requiredIds = [
        'settings-modal',
        'theme-toggle',
        'moon-icon',
        'sun-icon',
        'autosave-status-interval-input',
        'settings-disable-print-expand',
        'settings-conflict-section',
        'settings-sync-summary',
        'settings-local-version',
        'settings-server-version',
        'settings-cache-time',
        'settings-dirty-notes',
        'settings-conflict-message',
        'settings-conflict-content',
        'settings-retry-local-sync',
        'settings-copy-local-content',
        'settings-discard-local-content',
        'settings-data-cloud-section',
        'settings-cloud-refresh',
        'settings-cloud-status',
        'settings-space-list',
        'settings-local-overwrite-cloud',
        'settings-cloud-overwrite-local',
        'settings-auto-sync-status',
        'settings-cloud-result',
        'settings-trash-section',
        'settings-trash-refresh',
        'settings-trash-list',
        'settings-trash-empty',
        'settings-assets-section',
        'settings-assets-refresh',
        'settings-assets-toolbar',
        'settings-assets-select-all',
        'settings-assets-selected-count',
        'settings-assets-delete-selected',
        'settings-assets-list',
        'settings-cancel',
        'settings-reset',
        'settings-save',
        'settings-stat-total-notes',
        'settings-stat-total-edits',
        'settings-stat-active-days',
        'settings-stat-recent-notes',
        'settings-heatmap-months',
        'settings-heatmap-grid'
    ];

    for (const id of requiredIds) {
        assert.ok(
            indexHtml.includes(`id="${id}"`),
            `index.html must preserve #${id}`
        );
    }

    // Verify square heatmap cells and responsive Scheme B (PC) + Scheme C (Mobile)
    assert.match(
        stylesCss,
        /\.settings-heatmap-cell\s*\{[\s\S]*?width:\s*11px;[\s\S]*?height:\s*11px;[\s\S]*?aspect-ratio:\s*1\s*\/\s*1;/,
        'heatmap cells must be 11x11 squares with aspect-ratio 1/1'
    );
    assert.match(
        stylesCss,
        /\.settings-workspace\s*\{[\s\S]*?grid-template-columns:\s*(?:186px|204px)\s+minmax\(0,\s*1fr\);/,
        'PC settings workspace should use Scheme B left sidebar + right content grid'
    );
    assert.match(
        stylesCss,
        /@media\s*\(max-width:\s*980px\)\s*\{[\s\S]*?\.settings-nav\s*\{[\s\S]*?grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\);/,
        'Mobile settings navigation should use Scheme C 4-column top segmented bar'
    );
}

runActivityStatsUnitTests();
runDomAndCssContractTests();
console.log('Settings modal redesign & activity heatmap tests passed.');

