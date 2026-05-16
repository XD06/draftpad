const BASE_URL = 'http://localhost:10003/api';
const PIN = '666666';
const NOTEPAD_ID = '1778947181135';

const headers = {
    'Authorization': `Bearer ${PIN}`,
    'Content-Type': 'application/json'
};

async function testApi() {
    try {
        const patch = async (body) => {
            const res = await fetch(`${BASE_URL}/notes/${NOTEPAD_ID}`, {
                method: 'PATCH',
                headers,
                body: JSON.stringify(body)
            });
            const data = await res.json();
            return { status: res.status, data };
        };

        console.log('--- Overwrite ---');
        let result = await patch({ action: 'overwrite', text: 'Hello World. Hello World.' });
        console.log('Result:', result.data.success ? 'Success' : 'Failed', result.data.content);

        console.log('\n--- Replace All ---');
        result = await patch({ action: 'replace', target: 'Hello', replacement: 'Hi' });
        console.log('Result:', result.data.success ? 'Success' : 'Failed', result.data.content);

        console.log('\n--- Replace First ---');
        await patch({ action: 'overwrite', text: 'Hello World. Hello World.' });
        result = await patch({ action: 'replace_first', target: 'Hello', replacement: 'Hi' });
        console.log('Result:', result.data.success ? 'Success' : 'Failed', result.data.content);

        console.log('\n--- Test: Target Not Found (Error Handling) ---');
        result = await patch({ action: 'replace', target: 'NonExistent', replacement: 'Something' });
        console.log('Status:', result.status);
        console.log('Error:', result.data.error);

        console.log('\n--- Test: Empty Target ---');
        result = await patch({ action: 'replace', target: '', replacement: 'Something' });
        console.log('Status:', result.status);
        console.log('Error:', result.data.error);

        console.log('\n--- Append ---');
        result = await patch({ action: 'append', text: '\nNew line.' });
        console.log('Result:', result.data.success ? 'Success' : 'Failed', result.data.content);

    } catch (error) {
        console.error('Error:', error.message);
    }
}

testApi();
