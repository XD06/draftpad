require('dotenv').config();

const fs = require('fs').promises;
const path = require('path');
const s3 = require('./s3-service');

function cleanPrefix(prefix) {
    return String(prefix || '').replace(/^\/+|\/+$/g, '');
}

function parseArgs(argv = process.argv.slice(2)) {
    const args = {
        sourceDataDir: process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(__dirname, '..', 'data'),
        prefix: cleanPrefix(process.env.S3_PREFIX || ''),
        reportDir: '',
        dryRun: false
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--dry-run') {
            args.dryRun = true;
        } else if (arg === '--source-data-dir') {
            args.sourceDataDir = path.resolve(argv[++i] || '');
        } else if (arg.startsWith('--source-data-dir=')) {
            args.sourceDataDir = path.resolve(arg.slice('--source-data-dir='.length));
        } else if (arg === '--prefix') {
            args.prefix = cleanPrefix(argv[++i] || '');
        } else if (arg.startsWith('--prefix=')) {
            args.prefix = cleanPrefix(arg.slice('--prefix='.length));
        } else if (arg === '--report-dir') {
            args.reportDir = path.resolve(argv[++i] || '');
        } else if (arg.startsWith('--report-dir=')) {
            args.reportDir = path.resolve(arg.slice('--report-dir='.length));
        }
    }

    return args;
}

function s3Key(key, prefix) {
    const cleanKey = String(key || '').replace(/^\/+/, '').replace(/\\/g, '/');
    return prefix ? `${prefix}/${cleanKey}` : cleanKey;
}

function contentTypeFor(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.json') return 'application/json';
    if (ext === '.txt' || ext === '.md') return 'text/plain; charset=utf-8';
    return 'application/octet-stream';
}

async function pathExists(filePath) {
    try {
        await fs.access(filePath);
        return true;
    } catch {
        return false;
    }
}

async function collectFiles(root) {
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    const files = [];

    for (const entry of entries) {
        const filePath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...await collectFiles(filePath));
        } else if (entry.isFile()) {
            files.push(filePath);
        }
    }

    return files;
}

async function uploadFile(report, filePath, key) {
    const stat = await fs.stat(filePath);
    const targetKey = s3Key(key, report.prefix);

    const item = {
        source: filePath,
        key: targetKey,
        bytes: stat.size,
        dryRun: report.dryRun
    };

    if (!report.dryRun) {
        const body = await fs.readFile(filePath);
        await s3.putObject(targetKey, body, contentTypeFor(filePath));
    }

    report.uploaded.push(item);
    report.totalBytes += stat.size;
}

async function uploadDirectory(report, label, localDir, keyPrefix) {
    if (!await pathExists(localDir)) {
        report.missing.push({ label, path: localDir });
        return;
    }

    const files = await collectFiles(localDir);
    for (const filePath of files) {
        const relative = path.relative(localDir, filePath).replace(/\\/g, '/');
        await uploadFile(report, filePath, `${keyPrefix}/${relative}`);
    }
}

async function uploadRootFile(report, label, filename) {
    const filePath = path.join(report.dataDir, filename);
    if (!await pathExists(filePath)) {
        report.missing.push({ label, path: filePath });
        return;
    }

    await uploadFile(report, filePath, filename);
}

async function uploadRootTextNotes(report) {
    const entries = await fs.readdir(report.dataDir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.txt')) continue;
        await uploadFile(report, path.join(report.dataDir, entry.name), entry.name);
    }
}

async function uploadSplitThoughtsFromLegacy(report) {
    if (process.env.STORAGE_LAYOUT !== 'split') return;

    const filePath = path.join(report.dataDir, 'thoughts.json');
    if (!await pathExists(filePath)) return;

    const raw = await fs.readFile(filePath, 'utf8');
    let thoughts = [];
    try {
        const parsed = JSON.parse(raw);
        thoughts = Array.isArray(parsed) ? parsed : [];
    } catch {
        report.missing.push({ label: 'thoughts.json parse', path: filePath });
        return;
    }

    for (const thought of thoughts) {
        if (!thought?.id) continue;
        const body = Buffer.from(JSON.stringify(thought, null, 2), 'utf8');
        const targetKey = s3Key(`thoughts/${String(thought.id).replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()}.json`, report.prefix);
        const item = {
            source: `${filePath}#${thought.id}`,
            key: targetKey,
            bytes: body.length,
            dryRun: report.dryRun
        };
        if (!report.dryRun) {
            await s3.putObject(targetKey, body, 'application/json');
        }
        report.uploaded.push(item);
        report.totalBytes += body.length;
    }
}

async function readJSONCount(filePath, selector) {
    try {
        const parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
        const value = selector(parsed);
        return Array.isArray(value) ? value.length : 0;
    } catch {
        return 0;
    }
}

async function analyzeSource(dataDir) {
    return {
        notepadCount: await readJSONCount(path.join(dataDir, 'notepads.json'), parsed => parsed.notepads),
        thoughtCount: await readJSONCount(path.join(dataDir, 'thoughts.json'), parsed => parsed)
    };
}

async function writeReport(report) {
    const reportDir = report.reportDir || report.dataDir;
    await fs.mkdir(reportDir, { recursive: true });
    const reportPath = path.join(reportDir, `migration-report-local-to-s3-${Date.now()}.json`);
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
    return reportPath;
}

async function run(argv = process.argv.slice(2)) {
    const options = parseArgs(argv);
    const report = {
        startedAt: new Date().toISOString(),
        dryRun: options.dryRun,
        dataDir: options.sourceDataDir,
        reportDir: options.reportDir,
        bucket: process.env.S3_BUCKET || '',
        prefix: options.prefix,
        sourceSummary: await analyzeSource(options.sourceDataDir),
        uploaded: [],
        missing: [],
        totalBytes: 0
    };

    if (!await pathExists(report.dataDir)) {
        throw new Error(`source data dir does not exist: ${report.dataDir}`);
    }

    if (!report.dryRun) {
        s3.initS3();
    }

    await uploadDirectory(report, 'thoughts', path.join(report.dataDir, 'thoughts'), 'thoughts');
    await uploadDirectory(report, 'thoughts.meta', path.join(report.dataDir, 'thoughts.meta'), 'thoughts.meta');
    await uploadDirectory(report, 'relations', path.join(report.dataDir, 'relations'), 'relations');
    await uploadDirectory(report, 'relations.suppressed', path.join(report.dataDir, 'relations.suppressed'), 'relations.suppressed');
    await uploadDirectory(report, 'indexes', path.join(report.dataDir, 'indexes'), 'indexes');
    await uploadDirectory(report, 'notepads', path.join(report.dataDir, 'notepads'), 'notepads');
    await uploadRootFile(report, 'notepads.json', 'notepads.json');
    await uploadRootFile(report, 'thoughts.json', 'thoughts.json');
    await uploadSplitThoughtsFromLegacy(report);
    await uploadRootTextNotes(report);

    report.finishedAt = new Date().toISOString();
    report.reportPath = await writeReport(report);

    console.log(JSON.stringify({
        dryRun: report.dryRun,
        dataDir: report.dataDir,
        prefix: report.prefix,
        sourceSummary: report.sourceSummary,
        uploaded: report.uploaded.length,
        missing: report.missing.length,
        totalBytes: report.totalBytes,
        reportPath: report.reportPath
    }, null, 2));

    return report;
}

if (require.main === module) {
    run().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}

module.exports = {
    parseArgs,
    run
};
