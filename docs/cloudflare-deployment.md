# Cloudflare Deployment Guide for DumbPad

To deploy DumbPad to Cloudflare, you should use **Cloudflare Pages** for the frontend and **Cloudflare Workers** (via Pages Functions) for the backend. Since Cloudflare Workers operate in a serverless environment, the local filesystem (`fs`) is not available. You must use **Cloudflare R2** (Object Storage) or **Cloudflare KV** (Key-Value Storage).

## Prerequisites
1. A Cloudflare account.
2. [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/) installed.
3. An R2 bucket named `dumbpad-data` **OR** a KV namespace named `DUMBPAD_DATA`.

## Recommended Architecture

### 1. Storage Transition (R2 or KV)
Replace `fs` operations in `server.js` with R2 or KV calls.

#### Using R2 (Recommended for large files):
```javascript
const R2_BUCKET = env.DUMBPAD_DATA;
async function getNotepadContent(id) {
  const object = await R2_BUCKET.get(`notes/${id}.txt`);
  return object ? await object.text() : "";
}
```

#### Using KV (Simpler setup, free tier available):
```javascript
const KV = env.DUMBPAD_DATA;
async function getNotepadContent(id) {
  return await KV.get(`notes:${id}`);
}
async function saveNotepadContent(id, content) {
  await KV.put(`notes:${id}`, content);
}
```

### 2. Collaboration (WebSockets)
Cloudflare Workers support WebSockets via **Durable Objects**. You will need to move the WebSocket logic from `ws` to a Durable Object class.

### 3. Deployment Steps

#### Step A: Initialize Wrangler
Create a `wrangler.toml` in the root:
```toml
name = "dumbpad"
pages_build_output_dir = "./public"

[[r2_buckets]]
binding = "DUMBPAD_DATA"
bucket_name = "dumbpad-data"

[durable_objects]
bindings = [{name = "COLLAB_ROOM", class_name = "CollabRoom"}]
```

#### Step B: Backend as Functions
Move `server.js` logic into the `functions/api/` directory of your project. Cloudflare Pages will automatically turn files in `functions/` into Workers.

#### Step C: Deploy
Run:
```bash
npx wrangler pages deploy ./public
```

## Multi-Device Sync
By using Cloudflare's global network and R2 storage, your data is automatically synced across all devices. The `DUMBPAD_PIN` can be stored as a Cloudflare Worker Secret for security.

## ZIP Export
The ZIP export feature added in the latest update works entirely on the client side, so it is fully compatible with Cloudflare deployment without any modifications.
