const assert = require('assert');
const {
    DEFAULT_MAX_FILE_BYTES,
    MAX_CONFIGURED_FILE_BYTES,
    getMaxFileBytes,
    validateFileAssetUpload
} = require('./scripts/file-asset-policy');

function run() {
    assert.strictEqual(DEFAULT_MAX_FILE_BYTES, 20 * 1024 * 1024, 'ordinary attachments should default to 20 MiB');
    assert.strictEqual(MAX_CONFIGURED_FILE_BYTES, 100 * 1024 * 1024, 'ordinary attachments should have a hard 100 MiB ceiling');
    assert.strictEqual(getMaxFileBytes('1048576'), 1048576, 'a valid environment override should be honoured');
    assert.strictEqual(getMaxFileBytes(String(101 * 1024 * 1024)), MAX_CONFIGURED_FILE_BYTES, 'an override above 100 MiB should clamp to the hard ceiling');
    assert.strictEqual(getMaxFileBytes('invalid'), DEFAULT_MAX_FILE_BYTES, 'an invalid override should fail closed to the default');

    const pdf = validateFileAssetUpload({
        name: '计划.pdf',
        type: 'application/pdf',
        size: 1024
    });
    assert.strictEqual(pdf.ok, true, 'a PDF should be accepted');
    assert.strictEqual(pdf.type, 'application/pdf');

    const archive = validateFileAssetUpload({
        name: '资料.7z',
        type: 'application/octet-stream',
        size: 1024
    });
    assert.strictEqual(archive.ok, true, 'an allowed archive should work with a generic browser MIME type');

    const spoofed = validateFileAssetUpload({
        name: '恶意.pdf',
        type: 'text/html',
        size: 1024
    });
    assert.strictEqual(spoofed.ok, false, 'a dangerous MIME mismatch must be rejected');

    const executable = validateFileAssetUpload({
        name: 'installer.exe',
        type: 'application/octet-stream',
        size: 1024
    });
    assert.strictEqual(executable.ok, false, 'executables must be rejected');

    const tooLarge = validateFileAssetUpload({
        name: 'large.zip',
        type: 'application/zip',
        size: DEFAULT_MAX_FILE_BYTES + 1
    });
    assert.strictEqual(tooLarge.ok, false, 'a file exceeding the 20 MiB limit must be rejected');
    assert.match(tooLarge.error, /20MB/, 'the rejection should report the active configured limit');
    console.log('File asset policy checks passed');
}

run();
