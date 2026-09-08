import { EXIT, UsageError } from '../../core/errors.js';
import {
  applySavedPatch,
  discardSavedPatch,
  getPatch,
  listPatches,
  readPatchDiff,
} from '../../core/patches.js';
import { formatPatchNotice } from '../../core/channels.js';
import { line, printJson, table, c } from '../output.js';

export async function cmdPatches(ctx, _positionals, flags) {
  const status = typeof flags.status === 'string' ? flags.status : undefined;
  const patches = await listPatches(ctx.store, { status });
  if (ctx.json) {
    printJson({ patches });
    return EXIT.OK;
  }
  if (patches.length === 0) {
    line('No patches.');
    return EXIT.OK;
  }
  line(c.bold(`Patches (${patches.length})`));
  line();
  table(
    ['ID', 'STATUS', 'FILES', 'ORIGIN'],
    patches.map((patch) => [patch.id, patch.status, String(patch.files?.length ?? 0), patch.originPath]),
  );
  return EXIT.OK;
}

export async function cmdDiff(ctx, positionals) {
  const patch = await getPatch(ctx.store, positionals[0]);
  if (!patch) throw new UsageError(`No patch matching "${positionals[0] ?? ''}"`);
  const diff = await readPatchDiff(patch);
  if (ctx.json) {
    printJson({ patch, diff });
    return EXIT.OK;
  }
  line(formatPatchNotice(patch));
  line();
  line(diff || '(empty diff)');
  return EXIT.OK;
}

export async function cmdApply(ctx, positionals) {
  const id = positionals[0];
  if (!id) throw new UsageError('Usage: toris apply <patchId>');
  const patch = await applySavedPatch(ctx.store, id);
  if (ctx.json) {
    printJson({ ok: true, patch });
    return EXIT.OK;
  }
  line(`${c.green('APPLIED')} ${patch.id} → ${patch.originPath}`);
  return EXIT.OK;
}

export async function cmdDiscard(ctx, positionals) {
  const id = positionals[0];
  if (!id) throw new UsageError('Usage: toris discard <patchId>');
  const patch = await discardSavedPatch(ctx.store, id);
  if (ctx.json) {
    printJson({ ok: true, patch });
    return EXIT.OK;
  }
  line(`${c.yellow('DISCARDED')} ${patch.id}`);
  return EXIT.OK;
}
