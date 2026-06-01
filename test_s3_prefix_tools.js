process.env.S3_BUCKET = 'dumbpad-test';
process.env.S3_ACCESS_KEY = 'test-access-key';
process.env.S3_SECRET_KEY = 'test-secret-key';
process.env.S3_REGION = 'us-east-1';
process.env.S3_PREFIX = 'dumbpad';

const objects = new Map([
    ['dumbpad/notepads.json', '{"notepads":[]}'],
    ['dumbpad/default.txt', 'hello'],
    ['dumbpad/thoughts/1.json', '{"id":"1"}'],
    ['dumbpad/thoughts.meta/1.json', '{"status":"ready"}'],
    ['dumbpad-real/notepads.json', '{"notepads":[]}'],
    ['cherry-studio/backup.zip', 'not dumbpad']
]);

const fakeS3 = {
    async send(command) {
        const name = command.constructor.name;
        const input = command.input;

        if (name === 'ListObjectsV2Command') {
            return {
                Contents: [...objects.entries()]
                    .filter(([key]) => key.startsWith(input.Prefix || ''))
                    .map(([key, value]) => ({ Key: key, Size: Buffer.byteLength(value) }))
            };
        }

        if (name === 'CopyObjectCommand') {
            const sourceKey = decodeURI(input.CopySource).replace(/^dumbpad-test\//, '');
            objects.set(input.Key, objects.get(sourceKey) || '');
            return {};
        }

        if (name === 'DeleteObjectCommand') {
            objects.delete(input.Key);
            return {};
        }

        throw new Error(`Unhandled fake S3 command: ${name}`);
    }
};

const s3 = require('./scripts/s3-service');
s3.initS3({ client: fakeS3, bucket: 'dumbpad-test' });
s3.initS3 = () => fakeS3;

const tools = require('./scripts/s3-prefix-tools');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

(async () => {
    const positionalArgs = tools.parseArgs(['backup', '--prefix', 'dumbpad', '--backup-prefix', 'dumbpad-backup']);
    assert(positionalArgs.action === 'backup', 'CLI should accept positional backup action');
    assert(positionalArgs.prefix === 'dumbpad', 'CLI should parse prefix with positional action');

    let result = await tools.inventoryPrefix('dumbpad');
    assert(result.objectCount === 4, 'inventory should count prefix objects');
    assert(result.groups.thoughts.count === 1, 'inventory should group nested thought objects');
    assert(result.groups['(root)'].count === 2, 'inventory should group root files');

    const spaceResult = await tools.listSpaces({ root: 'dumbpad' });
    assert(spaceResult.root === 'dumbpad', 'listSpaces should report the app namespace root');
    assert(spaceResult.spaces.some(space => space.prefix === 'dumbpad'), 'listSpaces should keep existing root data as a legacy space');
    assert(spaceResult.spaces.some(space => space.prefix === 'dumbpad-real'), 'listSpaces should include legacy dumbpad-* spaces');
    assert(!spaceResult.spaces.some(space => space.prefix === 'dumbpad/thoughts'), 'listSpaces should not expose internal thought directories as spaces');
    assert(!spaceResult.spaces.some(space => space.prefix === 'cherry-studio'), 'listSpaces should hide other app prefixes');

    result = await tools.backupPrefix('dumbpad', 'dumbpad-backup', { dryRun: true });
    assert(result.objectCount === 4, 'dry-run backup should report all objects');
    assert(!objects.has('dumbpad-backup/notepads.json'), 'dry-run backup should not copy');

    result = await tools.backupPrefix('dumbpad', 'dumbpad-backup', { dryRun: false });
    assert(objects.has('dumbpad-backup/notepads.json'), 'backup should copy root object');
    assert(objects.has('dumbpad-backup/thoughts/1.json'), 'backup should copy nested object');

    result = await tools.deletePrefix('dumbpad', { dryRun: true });
    assert(result.objectCount === 4, 'dry-run delete should report source objects only');
    assert(objects.has('dumbpad/notepads.json'), 'dry-run delete should not delete');

    let refused = false;
    try {
        await tools.deletePrefix('dumbpad', { dryRun: false, confirmPrefix: 'wrong' });
    } catch {
        refused = true;
    }
    assert(refused, 'delete should require matching confirm prefix');

    await tools.deletePrefix('dumbpad', { dryRun: false, confirmPrefix: 'dumbpad' });
    assert(!objects.has('dumbpad/notepads.json'), 'confirmed delete should delete source object');
    assert(objects.has('dumbpad-backup/notepads.json'), 'confirmed delete should not delete backup object');

    console.log('S3 prefix tools checks passed');
})().catch((error) => {
    console.error(error);
    process.exit(1);
});
