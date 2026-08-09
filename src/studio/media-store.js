import { createHash, randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { createReadStream } from 'node:fs';
import { mkdir, open, rename, stat, unlink } from 'node:fs/promises';
import { HttpError } from './http.js';

function safeName(value) {
  const name = basename(String(value || 'upload.mp4')).replace(/[^a-zA-Z0-9._-]/g, '-');
  return name.toLowerCase().endsWith('.mp4') ? name : `${name}.mp4`;
}

export async function saveMp4Upload(request, options) {
  if (request.headers['content-type'] !== 'video/mp4') throw new HttpError(415, 'upload must use video/mp4');
  const maxBytes = options.maxBytes || 512 * 1024 * 1024;
  const directory = join(options.home, 'studio', 'content', options.contentId, 'original');
  const name = safeName(request.headers['x-file-name']);
  const target = join(directory, name);
  const temporary = join(directory, `.${randomUUID()}.upload`);
  await mkdir(directory, { recursive: true });

  const handle = await open(temporary, 'wx');
  const hash = createHash('sha256');
  const signature = Buffer.alloc(12);
  let signatureBytes = 0;
  let size = 0;
  try {
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > maxBytes) throw new HttpError(413, 'video upload is too large');
      if (signatureBytes < signature.length) {
        const copied = buffer.copy(signature, signatureBytes, 0, signature.length - signatureBytes);
        signatureBytes += copied;
      }
      hash.update(buffer);
      await handle.write(buffer);
    }
    if (size < 8 || signature.toString('ascii', 4, 8) !== 'ftyp') throw new HttpError(400, 'upload is not an MP4 file');
    await handle.close();
    await rename(temporary, target);
  } catch (error) {
    await handle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
    throw error;
  }

  return {
    name,
    path: target,
    mime: 'video/mp4',
    size,
    sha256: hash.digest('hex'),
  };
}

export async function mediaResponse(record, rangeHeader) {
  if (!record?.media?.path) throw new HttpError(404, 'content has no local media');
  const info = await stat(record.media.path).catch((error) => {
    if (error.code === 'ENOENT') throw new HttpError(404, 'local media is missing');
    throw error;
  });
  const headers = {
    'accept-ranges': 'bytes',
    'content-type': record.media.mime || 'application/octet-stream',
  };
  if (!rangeHeader) {
    return { status: 200, headers: { ...headers, 'content-length': String(info.size) }, stream: createReadStream(record.media.path) };
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) throw new HttpError(416, 'invalid byte range');
  const start = match[1] ? Number(match[1]) : 0;
  const end = match[2] ? Number(match[2]) : info.size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || end >= info.size) {
    throw new HttpError(416, 'invalid byte range');
  }
  return {
    status: 206,
    headers: {
      ...headers,
      'content-length': String(end - start + 1),
      'content-range': `bytes ${start}-${end}/${info.size}`,
    },
    stream: createReadStream(record.media.path, { start, end }),
  };
}
