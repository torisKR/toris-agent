import { UsageError, EXIT } from '../../core/errors.js';
import {
  ANDROID_ACTIONS,
  androidStatus,
  androidDevices,
  androidScreenshot,
  androidLogcat,
  androidInstall,
} from '../../core/android.js';
import { printJson, line, table, c, keyValues } from '../output.js';

const ACTIONS = new Set(ANDROID_ACTIONS);

function serialOf(flags) {
  if (typeof flags.serial === 'string') return flags.serial;
  if (typeof flags.s === 'string') return flags.s;
  if (typeof flags.device === 'string') return flags.device;
  return undefined;
}

export async function cmdAndroid(ctx, positionals, flags, deps = {}) {
  const action = positionals[0] || 'status';
  if (!ACTIONS.has(action)) {
    throw new UsageError(
      `Unknown android subcommand "${action}". Use ${[...ACTIONS].join('|')}.`,
    );
  }
  const options = {
    home: ctx.home,
    serial: serialOf(flags),
    detect: deps.detect,
    exec: deps.exec,
    env: deps.env,
  };

  if (action === 'install') {
    const apk = positionals[1];
    if (!apk) throw new UsageError('Missing required argument <apk>');
    options.apk = apk;
  }
  if (action === 'logcat' && flags.lines != null && flags.lines !== true) {
    options.lines = flags.lines;
  }

  const run = deps.run || defaultRun;
  const result = await run(action, options);

  if (ctx.json) {
    printJson(result);
    return EXIT.OK;
  }
  printHuman(action, result);
  return EXIT.OK;
}

async function defaultRun(action, options) {
  if (action === 'status') return androidStatus(options);
  if (action === 'devices') return androidDevices(options);
  if (action === 'screenshot') return androidScreenshot(options);
  if (action === 'logcat') return androidLogcat(options);
  return androidInstall(options);
}

function printHuman(action, result) {
  if (action === 'status') {
    line(c.bold('toris android'));
    line();
    keyValues([
      ['adb', result.adb || 'missing'],
      ['emulator', result.emulator || 'missing'],
      ['version', result.version || '—'],
    ]);
    line();
    if (!result.adb) {
      line(c.yellow('adb is optional. The rest of toris works without it.'));
      return;
    }
    printDevices(result.devices);
    return;
  }
  if (action === 'devices') {
    printDevices(result.devices);
    return;
  }
  if (action === 'screenshot') {
    line(`${c.green('OK')} screenshot ${result.path}`);
    line(c.dim(`${result.bytes} bytes`));
    return;
  }
  if (action === 'logcat') {
    line(`${c.green('OK')} logcat ${result.path}`);
    if (result.tail) {
      line();
      line(result.tail.trimEnd());
    }
    return;
  }
  line(`${c.green('OK')} installed ${result.apk}`);
  if (result.output) line(c.dim(result.output.split(/\r?\n/).slice(-3).join('\n')));
}

function printDevices(devices) {
  if (!devices || devices.length === 0) {
    line(c.dim('  (no devices). Start an emulator or plug in a phone, then retry.'));
    return;
  }
  table(
    ['SERIAL', 'STATE', 'MODEL'],
    devices.map((device) => [device.serial, device.state, device.model || device.product || '']),
  );
}

cmdAndroid.handlesFirstRun = true;
