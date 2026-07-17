const {
    CopyObjectCommand,
    DeleteObjectCommand,
    GetObjectCommand,
    HeadObjectCommand,
    ListObjectsV2Command,
    PutObjectCommand,
    S3Client
} = require('@aws-sdk/client-s3');

function cleanPrefix(value) {
    return String(value || '').replace(/^\/+|\/+$/g, '');
}

function joinKey(...parts) {
    return parts.map(cleanPrefix).filter(Boolean).join('/');
}

function isMissingS3Error(error) {
    return error?.name === 'NotFound' || error?.$metadata?.httpStatusCode === 404;
}

async function bodyToBuffer(body) {
    if (Buffer.isBuffer(body)) return body;
    if (body instanceof Uint8Array) return Buffer.from(body);
    if (typeof body?.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray());
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
}

function encodeCopySource(bucket, key) {
    return `${bucket}/${String(key || '').split('/').map(encodeURIComponent).join('/')}`;
}

function createS3ObjectStore({ endpoint, region = 'auto', bucket, accessKeyId, secretAccessKey, client } = {}) {
    if (!bucket) throw new Error('A backup S3 bucket is required');
    const resolvedClient = client || new S3Client({
        endpoint,
        region,
        forcePathStyle: true,
        credentials: {
            accessKeyId,
            secretAccessKey
        }
    });

    return {
        async list(prefix = '') {
            const objects = [];
            let continuationToken;
            do {
                const response = await resolvedClient.send(new ListObjectsV2Command({
                    Bucket: bucket,
                    Prefix: prefix,
                    ContinuationToken: continuationToken
                }));
                for (const item of response.Contents || []) {
                    objects.push({
                        key: item.Key,
                        size: Number(item.Size || 0),
                        lastModified: item.LastModified || null
                    });
                }
                continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
            } while (continuationToken);
            return objects;
        },
        async has(key) {
            try {
                await resolvedClient.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
                return true;
            } catch (error) {
                if (isMissingS3Error(error)) return false;
                throw error;
            }
        },
        async get(key) {
            const response = await resolvedClient.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
            return bodyToBuffer(response.Body);
        },
        async put(key, body, contentType = 'application/octet-stream') {
            await resolvedClient.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
        },
        async delete(key) {
            await resolvedClient.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
        },
        async copy(sourceKey, targetKey) {
            await resolvedClient.send(new CopyObjectCommand({
                Bucket: bucket,
                Key: targetKey,
                CopySource: encodeCopySource(bucket, sourceKey)
            }));
        }
    };
}

module.exports = {
    cleanPrefix,
    createS3ObjectStore,
    joinKey
};
