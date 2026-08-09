import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTENT_STATUS } from './content.js';
import { runAutoShorts as defaultRunAutoShorts } from './python-bridge.js';

const DEFAULT_BUNDLE = resolve(dirname(fileURLToPath(import.meta.url)), '../../python/auto_shorts');

function inside(root, candidate) {
  const base = resolve(root);
  const value = resolve(candidate);
  return value === base || value.startsWith(`${base}${sep}`);
}

function validateInput(job) {
  const targetDuration = Number(job.targetDuration ?? 15);
  if (!Number.isFinite(targetDuration) || targetDuration < 15 || targetDuration > 60) throw new Error('targetDuration must be between 15 and 60 seconds');
  const title = String(job.title || '').trim();
  if (!title) throw new Error('render title is required');
  return { targetDuration, title, text: String(job.text || title).trim() || title };
}

export class RenderService {
  constructor(options) {
    this.home = options.home;
    this.contents = options.contents;
    this.pythonPath = options.pythonPath || process.env.TORIS_STUDIO_PYTHON || join(options.home, 'runtime', 'auto-shorts', 'bin', 'python');
    this.bundleRoot = options.bundleRoot || DEFAULT_BUNDLE;
    this.runAutoShorts = options.runAutoShorts || defaultRunAutoShorts;
  }

  async render(job) {
    const input = validateInput(job);
    const content = await this.contents.get(job.contentId);
    if (!content) throw new Error(`Unknown content: ${job.contentId}`);
    const sourceMedia = content.render?.sourceMedia || content.media;
    if (!sourceMedia?.path) throw new Error('content needs local source media before rendering');
    if (!inside(this.home, sourceMedia.path)) throw new Error('source media path is outside TORIS_HOME');

    const contentRoot = join(this.home, 'studio', 'content', content.id);
    const planDirectory = join(contentRoot, 'plan');
    const renderDirectory = join(contentRoot, 'render');
    const planPath = join(planDirectory, 'plan.json');
    const outputPath = join(renderDirectory, 'final.mp4');
    await mkdir(planDirectory, { recursive: true });
    await mkdir(renderDirectory, { recursive: true });
    const plan = {
      title: input.title,
      description: 'Rendered locally by Toris Studio',
      target_duration: input.targetDuration,
      output: outputPath,
      segments: [{ text: input.text, source: sourceMedia.path, start: 0 }],
    };
    const temporary = `${planPath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(plan, null, 2)}\n`, 'utf8');
    await rename(temporary, planPath);
    await this.contents.update(content.id, { status: CONTENT_STATUS.RENDERING, render: { planPath, outputPath, sourceMedia } });

    try {
      const rendered = await this.runAutoShorts({
        pythonPath: this.pythonPath,
        projectRoot: this.bundleRoot,
        args: ['render', planPath, '--output', outputPath],
        timeoutMs: 15 * 60 * 1000,
      });
      const quality = await this.runAutoShorts({
        pythonPath: this.pythonPath,
        projectRoot: this.bundleRoot,
        args: ['quality', outputPath],
        timeoutMs: 60 * 1000,
      });
      if (quality.passed !== true) {
        await this.contents.update(content.id, { status: CONTENT_STATUS.QUALITY_FAILED, quality, render: { planPath, outputPath, sourceMedia, result: rendered } });
        throw new Error('rendered video failed quality checks');
      }
      const bytes = await readFile(outputPath);
      const info = await stat(outputPath);
      return await this.contents.update(content.id, {
        kind: 'video',
        title: input.title,
        status: CONTENT_STATUS.AWAITING_REVIEW,
        media: { name: 'final.mp4', path: outputPath, mime: 'video/mp4', size: info.size, sha256: createHash('sha256').update(bytes).digest('hex') },
        quality,
        render: { planPath, outputPath, sourceMedia, result: rendered },
      });
    } catch (error) {
      const latest = await this.contents.get(content.id);
      if (latest?.status !== CONTENT_STATUS.QUALITY_FAILED) await this.contents.update(content.id, { status: CONTENT_STATUS.FAILED, render: { ...(latest?.render || {}), error: error.message } });
      throw error;
    }
  }
}
