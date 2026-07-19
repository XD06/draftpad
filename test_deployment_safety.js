const fs = require('fs');
const path = require('path');

function assert(condition, message) {
    if (!condition) throw new Error(message);
}

(() => {
    const root = __dirname;
    const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
    const service = fs.readFileSync(path.join(root, 'deploy', 'systemd', 'dumbpad-backup.service'), 'utf8');
    const timer = fs.readFileSync(path.join(root, 'deploy', 'systemd', 'dumbpad-backup.timer'), 'utf8');
    const backupEnv = fs.readFileSync(path.join(root, 'deploy', 'systemd', 'backup.env.example'), 'utf8');
    const cli = fs.readFileSync(path.join(root, 'scripts', 'backup', 'backup-cli.js'), 'utf8');

    assert(
        compose.includes('${AUTH_STATE_DIR:-./security}:/app/security') &&
            compose.includes('AUTH_STATE_DIR=/app/security') &&
            compose.includes('AUTH_AUDIT_DIR=/app/security/audit'),
        'Docker deployment must persist authentication state and the audit chain outside the container'
    );
    assert(compose.includes('${DATA_DIR:-./data}:/app/data'), 'security persistence must not replace the existing user-data mount');

    assert(service.includes('User=root'), 'the host backup job must remain root-only');
    assert(service.includes('UMask=0077'), 'backup files must default to owner-only permissions');
    assert(service.includes('NoNewPrivileges=true') && service.includes('PrivateTmp=true'), 'the backup unit should use low-risk systemd hardening');
    assert(service.includes('EnvironmentFile=/etc/dumbpad/backup.env'), 'the backup unit must use the root-only host environment file');
    assert(service.includes('backup-cli.js snapshot'), 'the scheduled unit must explicitly request the write command');
    assert(service.includes('backup-cli.js health'), 'a successful scheduled snapshot must be followed by an integrity health check');
    assert(timer.includes('Persistent=true'), 'a missed low-activity backup should run after the VPS returns');
    assert(timer.includes('OnCalendar=*-*-* 03:30:00 Asia/Shanghai'), 'the low-activity backup schedule should use the documented timezone explicitly');
    assert(backupEnv.includes('BACKUP_STALE_AFTER_MS=172800000'), 'the host backup template should define the 48-hour health window');

    assert(!cli.includes("require('dotenv').config()") && !cli.includes('require("dotenv").config()'), 'the host backup CLI must not silently load the application .env file');
    assert(cli.includes("command: argv[0] || 'health'"), 'the backup CLI must default to a read-only command');

    console.log('Deployment safety checks passed');
})();
