const http = require('http');

const BASE_URL = 'http://localhost:10003';

function request(path, method = 'GET', body = null) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, BASE_URL);
        const options = {
            hostname: url.hostname,
            port: url.port,
            path: url.pathname + url.search,
            method: method,
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer 666666'
            }
        };

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                if (res.statusCode >= 200 && res.statusCode < 300) {
                    resolve(JSON.parse(data));
                } else {
                    reject(new Error(`Status: ${res.statusCode} Data: ${data}`));
                }
            });
        });

        req.on('error', reject);
        if (body) req.write(JSON.stringify(body));
        req.end();
    });
}

async function test() {
    console.log('Testing Quick Thoughts API...');
    
    try {
        // 1. Create a thought
        console.log('Creating thought...');
        const newThought = await request('/api/thoughts', 'POST', {
            text: 'Test Thought from API'
        });
        const thoughtId = newThought.id;
        console.log('Created:', thoughtId);

        // 2. Fetch all
        console.log('Fetching all...');
        const list = await request('/api/thoughts');
        console.log('List length:', list.length);

        // 3. Append to it
        console.log('Appending...');
        await request(`/api/thoughts/${thoughtId}`, 'PATCH', {
            action: 'append',
            text: ' - Appended text'
        });

        // 4. Toggle complete
        console.log('Toggling complete...');
        await request(`/api/thoughts/${thoughtId}`, 'PATCH', {
            action: 'toggle_complete'
        });

        // 5. Verify
        console.log('Verifying...');
        const updatedList = await request('/api/thoughts');
        const updated = updatedList.find(t => t.id === thoughtId);
        console.log('Updated text:', updated.text);
        console.log('Completed:', updated.completed);

        // 6. Delete
        console.log('Deleting...');
        await request(`/api/thoughts/${thoughtId}`, 'DELETE');
        console.log('Deleted successfully');

        console.log('API Test PASSED!');

    } catch (err) {
        console.error('Test failed:', err.message);
    }
}

test();
