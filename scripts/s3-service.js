const {
    S3Client,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    ListObjectsV2Command,
    HeadObjectCommand,
    CopyObjectCommand
} = require('@aws-sdk/client-s3');

let s3Client = null;
let s3Bucket = '';

function getS3Config() {
    return {
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION || 'us-east-1',
        bucket: process.env.S3_BUCKET,
        accessKeyId: process.env.S3_ACCESS_KEY,
        secretAccessKey: process.env.S3_SECRET_KEY || process.env.S3_API_KEY
    };
}

function assertConfigured(config) {
    const missing = [];
    if (!config.bucket) missing.push('S3_BUCKET');
    if (!config.accessKeyId) missing.push('S3_ACCESS_KEY');
    if (!config.secretAccessKey) missing.push('S3_SECRET_KEY or S3_API_KEY');

    if (missing.length) {
        throw new Error(`Missing S3 configuration: ${missing.join(', ')}`);
    }
}

function initS3(overrides = {}) {
    if (overrides.client) {
        s3Client = overrides.client;
        s3Bucket = overrides.bucket || process.env.S3_BUCKET || '';
        if (!s3Bucket) throw new Error('Missing S3 bucket');
        return s3Client;
    }

    const config = { ...getS3Config(), ...overrides };
    assertConfigured(config);

    s3Bucket = config.bucket;
    s3Client = new S3Client({
        endpoint: config.endpoint || undefined,
        region: config.region,
        credentials: {
            accessKeyId: config.accessKeyId,
            secretAccessKey: config.secretAccessKey
        },
        forcePathStyle: true
    });

    return s3Client;
}

function ensureClient() {
    if (!s3Client) initS3();
    return s3Client;
}

function normalizeKey(key) {
    return String(key || '').replace(/^\/+/, '');
}

async function bodyToString(body) {
    return (await bodyToBuffer(body)).toString('utf8');
}

async function bodyToBuffer(body) {
    if (!body) return Buffer.alloc(0);
    if (Buffer.isBuffer(body)) return body;
    if (typeof body === 'string') return Buffer.from(body);
    if (typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());

    const chunks = [];
    for await (const chunk of body) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}

function isNotFound(error) {
    return error?.name === 'NoSuchKey' || error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404;
}

function isCompatibleMissingObject(error) {
    const status = error?.$metadata?.httpStatusCode;
    const name = String(error?.name || '');
    return status === 400 && (name === 'Unknown' || name === 'UnknownError');
}

async function putObject(key, body, contentType = 'application/octet-stream') {
    await ensureClient().send(new PutObjectCommand({
        Bucket: s3Bucket,
        Key: normalizeKey(key),
        Body: body,
        ContentType: contentType
    }));
}

async function getObject(key) {
    try {
        const result = await ensureClient().send(new GetObjectCommand({
            Bucket: s3Bucket,
            Key: normalizeKey(key)
        }));
        return bodyToString(result.Body);
    } catch (error) {
        if (isNotFound(error) || isCompatibleMissingObject(error)) return null;
        throw error;
    }
}

async function getObjectBuffer(key) {
    try {
        const result = await ensureClient().send(new GetObjectCommand({
            Bucket: s3Bucket,
            Key: normalizeKey(key)
        }));
        return bodyToBuffer(result.Body);
    } catch (error) {
        if (isNotFound(error) || isCompatibleMissingObject(error)) return null;
        throw error;
    }
}

async function getJSONObject(key, fallback = null) {
    const text = await getObject(key);
    if (text === null) return fallback;
    try {
        return JSON.parse(text);
    } catch (error) {
        // A single corrupt/partially-written object must not bring down the
        // whole list (readS3SplitThoughts uses Promise.all over all objects).
        console.warn(`s3-service: corrupt JSON at ${key}, returning fallback:`, error.message);
        return fallback;
    }
}

async function deleteObject(key) {
    await ensureClient().send(new DeleteObjectCommand({
        Bucket: s3Bucket,
        Key: normalizeKey(key)
    }));
}

async function listObjects(prefix = '') {
    const client = ensureClient();
    const items = [];
    let ContinuationToken;

    do {
        const result = await client.send(new ListObjectsV2Command({
            Bucket: s3Bucket,
            Prefix: normalizeKey(prefix),
            ContinuationToken
        }));

        for (const item of result.Contents || []) {
            items.push({
                key: item.Key,
                size: item.Size || 0,
                lastModified: item.LastModified || null,
                etag: item.ETag || ''
            });
        }

        ContinuationToken = result.NextContinuationToken;
    } while (ContinuationToken);

    return items;
}

async function headObject(key) {
    try {
        return await ensureClient().send(new HeadObjectCommand({
            Bucket: s3Bucket,
            Key: normalizeKey(key)
        }));
    } catch (error) {
        if (isNotFound(error) || isCompatibleMissingObject(error)) return null;
        throw error;
    }
}

async function copyObject(sourceKey, destKey) {
    const normalizedSource = normalizeKey(sourceKey);
    const normalizedDest = normalizeKey(destKey);
    // CopySource 是 URL 的一部分，必须按路径段 encodeURIComponent：只 encodeURI
    // 整串不编码 `#` / `?`，服务端把 `#` 当 fragment 截断（NoSuchKey）、`?` 当
    // query（InvalidArgument）。文章改名走 copy+delete，名字含 `#`（如 `C#`、
    // 自动命名产出的 `\#`）时旧实现必炸。非 ASCII 由 encodeURIComponent 编成
    // UTF-8 百分号转义，与 S3 规范一致。与 scripts/backup/s3-object-store.js
    // 的 encodeCopySource 同一模式。
    const encodedSource = normalizedSource.split('/').map(encodeURIComponent).join('/');
    await ensureClient().send(new CopyObjectCommand({
        Bucket: s3Bucket,
        CopySource: `${s3Bucket}/${encodedSource}`,
        Key: normalizedDest
    }));
}

module.exports = {
    initS3,
    putObject,
    getObject,
    getObjectBuffer,
    getJSONObject,
    deleteObject,
    listObjects,
    headObject,
    copyObject
};
