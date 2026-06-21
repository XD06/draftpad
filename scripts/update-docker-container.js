#!/usr/bin/env node

const fs = require('fs');
const http = require('http');
const https = require('https');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_SERVICE = 'dumbpad';
const DEFAULT_COMPOSE_FILE = 'docker-compose.yml';
const OVERRIDE_FILE = '.docker-update.override.yml';

function parseArgs(argv) {
    const options = {
        service: process.env.DUMBPAD_DOCKER_SERVICE || DEFAULT_SERVICE,
        composeFiles: [],
        projectName: process.env.DUMBPAD_DOCKER_PROJECT || '',
        healthUrl: process.env.DUMBPAD_HEALTH_URL || '',
        timeoutMs: Number(process.env.DUMBPAD_HEALTH_TIMEOUT_MS || 90000),
        skipGitPull: false,
        imageOnly: false,
        noHealthCheck: false,
        noCache: false,
        help: false
    };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = () => {
            const value = argv[++i];
            if (!value) throw new Error(`Missing value for ${arg}`);
            return value;
        };

        if (arg === '--help' || arg === '-h') options.help = true;
        else if (arg === '--service') options.service = next();
        else if (arg === '--compose-file' || arg === '-f') options.composeFiles.push(next());
        else if (arg === '--project-name' || arg === '-p') options.projectName = next();
        else if (arg === '--health-url') options.healthUrl = next();
        else if (arg === '--timeout-ms') options.timeoutMs = Number(next());
        else if (arg === '--skip-git-pull') options.skipGitPull = true;
        else if (arg === '--image-only') options.imageOnly = true;
        else if (arg === '--no-health-check') options.noHealthCheck = true;
        else if (arg === '--no-cache') options.noCache = true;
        else throw new Error(`Unknown option: ${arg}`);
    }

    if (options.composeFiles.length === 0) options.composeFiles.push(DEFAULT_COMPOSE_FILE);
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
        throw new Error('--timeout-ms must be a positive number');
    }
    if (!options.healthUrl) {
        const port = process.env.DUMBPAD_PORT || process.env.PORT || '3000';
        options.healthUrl = `http://127.0.0.1:${port}/health`;
    }
    return options;
}

function printHelp() {
    console.log(`Usage: npm run docker:update -- [options]

Updates the DumbPad Docker container from this repository.

Options:
  --service <name>         Compose service to update (default: dumbpad)
  -f, --compose-file <yml> Compose file, repeatable (default: docker-compose.yml)
  -p, --project-name <id>  Compose project name
  --health-url <url>       Health check URL (default: http://127.0.0.1:$DUMBPAD_PORT/health)
  --timeout-ms <ms>        Health check timeout (default: 90000)
  --skip-git-pull          Do not run git fetch/pull before updating
  --image-only             Pull and restart the compose image instead of building local source
  --no-health-check        Skip /health polling after restart
  --no-cache               Rebuild without Docker layer cache
  -h, --help               Show this help

Default behavior:
  1. git fetch --prune && git pull --ff-only
  2. docker compose build --pull <service> using local source
  3. docker compose up -d --remove-orphans <service>
  4. poll /health until the app responds`);
}

function run(command, args, { allowFailure = false } = {}) {
    console.log(`\n$ ${[command, ...args].join(' ')}`);
    const result = spawnSync(command, args, {
        cwd: ROOT,
        stdio: 'inherit',
        shell: false
    });
    if (result.error) {
        if (allowFailure) return result;
        throw result.error;
    }
    if (result.status !== 0 && !allowFailure) {
        throw new Error(`${command} ${args.join(' ')} exited with ${result.status}`);
    }
    return result;
}

function detectCompose() {
    const dockerCompose = run('docker', ['compose', 'version'], { allowFailure: true });
    if (dockerCompose.status === 0) return { command: 'docker', prefix: ['compose'] };

    const legacyCompose = run('docker-compose', ['version'], { allowFailure: true });
    if (legacyCompose.status === 0) return { command: 'docker-compose', prefix: [] };

    throw new Error('Docker Compose was not found. Install Docker Compose v2 or docker-compose.');
}

function composeBaseArgs(options, overrideFile = '') {
    const args = [];
    for (const file of options.composeFiles) {
        args.push('-f', file);
    }
    if (overrideFile) args.push('-f', overrideFile);
    if (options.projectName) args.push('-p', options.projectName);
    return args;
}

function writeBuildOverride(service) {
    const content = [
        'services:',
        `  ${service}:`,
        '    image: dumbpad-local:latest',
        '    build:',
        '      context: .',
        ''
    ].join('\n');
    const target = path.join(ROOT, OVERRIDE_FILE);
    fs.writeFileSync(target, content, 'utf8');
    return OVERRIDE_FILE;
}

function updateGit(options) {
    if (options.skipGitPull) {
        console.log('\nSkipping git pull.');
        return;
    }
    run('git', ['fetch', '--prune']);
    run('git', ['pull', '--ff-only']);
}

function updateContainer(options) {
    const compose = detectCompose();
    const runCompose = (args) => run(compose.command, [...compose.prefix, ...args]);

    if (options.imageOnly) {
        const base = composeBaseArgs(options);
        runCompose([...base, 'pull', options.service]);
        runCompose([...base, 'up', '-d', '--remove-orphans', options.service]);
        return;
    }

    const overrideFile = writeBuildOverride(options.service);
    const base = composeBaseArgs(options, overrideFile);
    try {
        const buildArgs = [...base, 'build', '--pull'];
        if (options.noCache) buildArgs.push('--no-cache');
        buildArgs.push(options.service);
        runCompose(buildArgs);
        runCompose([...base, 'up', '-d', '--remove-orphans', options.service]);
        runCompose([...base, 'ps', options.service]);
    } finally {
        fs.rmSync(path.join(ROOT, OVERRIDE_FILE), { force: true });
    }
}

function requestHealth(url) {
    return new Promise((resolve, reject) => {
        const client = url.startsWith('https:') ? https : http;
        const request = client.get(url, { timeout: 5000 }, (response) => {
            response.resume();
            if (response.statusCode >= 200 && response.statusCode < 300) {
                resolve();
            } else {
                reject(new Error(`HTTP ${response.statusCode}`));
            }
        });
        request.on('timeout', () => {
            request.destroy(new Error('request timed out'));
        });
        request.on('error', reject);
    });
}

async function waitForHealth(options) {
    if (options.noHealthCheck) {
        console.log('\nSkipping health check.');
        return;
    }
    const deadline = Date.now() + options.timeoutMs;
    let lastError = null;
    console.log(`\nWaiting for health check: ${options.healthUrl}`);
    while (Date.now() < deadline) {
        try {
            await requestHealth(options.healthUrl);
            console.log('Health check passed.');
            return;
        } catch (error) {
            lastError = error;
            await new Promise(resolve => setTimeout(resolve, 2500));
        }
    }
    throw new Error(`Health check failed after ${options.timeoutMs}ms: ${lastError?.message || 'unknown error'}`);
}

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printHelp();
        return;
    }

    console.log(`Updating Docker service "${options.service}" from ${ROOT}`);
    updateGit(options);
    updateContainer(options);
    await waitForHealth(options);
    console.log('\nDocker update completed.');
}

main().catch((error) => {
    console.error(`\nDocker update failed: ${error.message}`);
    process.exitCode = 1;
});
