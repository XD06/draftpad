const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');

const metaDir = path.join(__dirname, '.prototype');
const portFile = path.join(metaDir, 'port');
const pidFile = path.join(metaDir, 'pid');
const root = __dirname;

const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8'
};

function findPort(start, callback) {
    const probe = net.createServer();
    probe.listen(start, () => {
        const port = probe.address().port;
        probe.close(() => callback(port));
    });
    probe.on('error', () => findPort(start + 1, callback));
}

findPort(Number(process.env.PORT) || 3000, port => {
    fs.mkdirSync(metaDir, { recursive: true });
    fs.writeFileSync(portFile, String(port));
    fs.writeFileSync(pidFile, String(process.pid));

    http.createServer((request, response) => {
        if (request.url === '/__stop__') {
            fs.rmSync(metaDir, { recursive: true, force: true });
            response.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('stopped');
            process.exit(0);
        }
        const requestedPath = request.url.split('?')[0];
        const pathname = requestedPath === '/' ? '/index.html' : requestedPath;
        const file = path.resolve(root, `.${pathname}`);
        if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
            response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
            response.end('Not found');
            return;
        }
        response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'text/plain; charset=utf-8' });
        fs.createReadStream(file).pipe(response);
    }).listen(port, () => {
        console.log(`Prototype: http://localhost:${port}`);
        console.log(`Stop: http://localhost:${port}/__stop__`);
    });
});
