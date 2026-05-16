const http = require('http');

function api(path, method = 'GET', body = null) {
    return new Promise((resolve) => {
        const u = new URL(path, 'http://localhost:10003');
        const opt = {
            hostname: u.hostname, port: u.port,
            path: u.pathname + u.search, method,
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer 666666' }
        };
        const r = http.request(opt, (res) => {
            let d = '';
            res.on('data', c => d += c);
            res.on('end', () => {
                try { resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: JSON.parse(d) }); }
                catch (e) { resolve({ ok: false, status: res.statusCode, body: d }); }
            });
        });
        r.on('error', (e) => resolve({ ok: false, error: e.message }));
        if (body) r.write(JSON.stringify(body));
        r.end();
    });
}

let pass = 0, fail = 0;
function check(name, condition, detail) {
    if (condition) { pass++; }
    else { fail++; console.log('  FAIL: ' + name + (detail ? ' — ' + detail : '')); }
}

async function run() {
    let id;

    // ==================== 1. CREATE ====================
    console.log('1. CREATE');

    let r = await api('/api/thoughts', 'POST', { text: 'API测试-纯文本', subItems: [] });
    check('创建纯文本', r.ok && r.body.text === 'API测试-纯文本');
    if (r.ok) await api('/api/thoughts/' + r.body.id, 'DELETE');

    r = await api('/api/thoughts', 'POST', {
        text: 'API测试-带子任务',
        subItems: [{ id: 'a1', text: '子1', completed: false }, { id: 'a2', text: '子2', completed: true }]
    });
    check('创建带子任务', r.ok && r.body.subItems.length === 2);
    id = r.body.id;

    r = await api('/api/thoughts', 'POST', { text: '' });
    check('拒绝空文本', r.status === 400, 'status:' + r.status);

    r = await api('/api/thoughts', 'POST', {});
    check('拒绝无text字段', r.status === 400);

    // ==================== 2. READ ====================
    console.log('2. READ');

    r = await api('/api/thoughts');
    check('获取全部', Array.isArray(r.body) && r.body.length > 0, 'count:' + r.body.length);

    const now = new Date();
    const today = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
    r = await api('/api/thoughts?date=' + today);
    check('按日期过滤', Array.isArray(r.body));

    r = await api('/api/thoughts?q=API测试');
    check('搜索主任务', r.body.length >= 1);

    r = await api('/api/thoughts?q=子1');
    check('搜索子任务', r.body.some(t => t.id === id), 'subitem search');

    r = await api('/api/thoughts?q=zzzznonexistent');
    check('搜索无结果', r.body.length === 0);

    // ==================== 3. TOGGLE MAIN ====================
    console.log('3. TOGGLE MAIN');

    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'toggle_complete' });
    check('切换为完成', r.ok && r.body.thought.completed === true);
    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'toggle_complete' });
    check('切换为未完成', r.ok && r.body.thought.completed === false);
    r = await api('/api/thoughts/999999', 'PATCH', { action: 'toggle_complete' });
    check('不存在的ID toggle', r.status === 404);

    // ==================== 4. TOGGLE SUB ====================
    console.log('4. TOGGLE SUB');

    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'toggle_subitem', subId: 'a1' });
    check('子任务切换', r.ok && r.body.thought.subItems.find(s => s.id === 'a1').completed === true);
    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'toggle_subitem', subId: 'a1' });
    check('子任务切回', r.body.thought.subItems.find(s => s.id === 'a1').completed === false);
    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'toggle_subitem', subId: 'nonexistent' });
    check('不存在的子任务', r.status === 404);

    // ==================== 5. ADD SUB ====================
    console.log('5. ADD SUB');

    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'add_subitem', text: '新增子任务' });
    check('添加子任务', r.ok && r.body.thought.subItems.length === 3);
    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'add_subitem', text: '' });
    check('拒绝空子任务', r.status === 400);

    // ==================== 6. UPDATE SUB ====================
    console.log('6. UPDATE SUB');

    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'update_subitem', subId: 'a2', text: '改名后的子2' });
    check('修改子任务文本', r.ok && r.body.thought.subItems.find(s => s.id === 'a2').text === '改名后的子2');
    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'update_subitem', subId: 'a2', completed: false });
    check('修改子任务状态', r.ok && r.body.thought.subItems.find(s => s.id === 'a2').completed === false);
    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'update_subitem', subId: 'a2', text: '同时改文本', completed: true });
    check('同时改文本和状态', r.ok && r.body.thought.subItems.find(s => s.id === 'a2').text === '同时改文本' && r.body.thought.subItems.find(s => s.id === 'a2').completed === true);
    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'update_subitem', subId: 'nonexistent', text: 'x' });
    check('修改不存在的子任务', r.status === 404);

    // ==================== 7. DELETE SUB ====================
    console.log('7. DELETE SUB');

    const current = await api('/api/thoughts/' + id);
    const newSub = current.body.subItems.find(s => s.text === '新增子任务');
    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'delete_subitem', subId: newSub.id });
    check('删除子任务', r.ok && r.body.thought.subItems.length === 2);
    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'delete_subitem', subId: 'nonexistent' });
    check('删除不存在的子任务', r.status === 404);

    // ==================== 8. OVERWRITE ====================
    console.log('8. OVERWRITE');

    r = await api('/api/thoughts/' + id, 'PATCH', {
        action: 'overwrite',
        text: '完全覆盖测试',
        subItems: [{ id: 'new1', text: '全新子任务', completed: true }]
    });
    check('overwrite全文+子任务', r.ok && r.body.thought.text === '完全覆盖测试' && r.body.thought.subItems.length === 1);

    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'overwrite', text: '只改文本' });
    check('overwrite只改文本', r.ok && r.body.thought.text === '只改文本' && r.body.thought.subItems.length === 1);

    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'overwrite', text: '', subItems: [] });
    check('overwrite清空', r.ok && r.body.thought.text === '' && r.body.thought.subItems.length === 0);

    // ==================== 9. APPEND/REPLACE ====================
    console.log('9. APPEND/REPLACE');

    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'append', text: '追加内容' });
    check('append', r.ok && r.body.thought.text.includes('追加内容'));
    r = await api('/api/thoughts/' + id, 'PATCH', { action: 'replace', target: '追加内容', replacement: '替换内容' });
    check('replace', r.ok && r.body.thought.text.includes('替换内容') && !r.body.thought.text.includes('追加内容'));

    // ==================== 10. DELETE THOUGHT ====================
    console.log('10. DELETE THOUGHT');

    r = await api('/api/thoughts/' + id, 'DELETE');
    check('删除', r.ok);
    r = await api('/api/thoughts/' + id, 'DELETE');
    check('重复删除', r.status === 404);

    // ==================== 11. LEGACY COMPAT ====================
    console.log('11. LEGACY');

    r = await api('/api/thoughts');
    const legacy = r.body.find(t => t.subItems.length === 0 && /^- \[[ x]\]/m.test(t.text));
    if (legacy) {
        check('legacy数据存在', true);
        check('legacy subItems为空', legacy.subItems.length === 0);
        check('legacy text含markdown', /^- \[[ x]\]/m.test(legacy.text));
    } else {
        console.log('  (无legacy数据)');
    }

    // ==================== 12. ERROR CASES ====================
    console.log('12. ERRORS');

    // Create a fresh thought for error testing (id was deleted in step 10)
    const errThought = await api('/api/thoughts', 'POST', { text: 'error-test' });
    const errId = errThought.body.id;

    r = await api('/api/thoughts/' + errId, 'PATCH', { action: 'invalid_action' });
    check('无效action', r.status === 400);

    r = await api('/api/thoughts/' + errId, 'PATCH', {});
    check('缺action', r.status === 400);

    // cleanup
    await api('/api/thoughts/' + errId, 'DELETE');

    // ==================== SUMMARY ====================
    console.log('');
    console.log('=========================');
    console.log('PASS: ' + pass + '  FAIL: ' + fail + '  TOTAL: ' + (pass + fail));
    if (fail > 0) process.exit(1);
}

run().catch(e => { console.error(e); process.exit(1); });
