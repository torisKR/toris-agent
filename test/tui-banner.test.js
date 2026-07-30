import test from 'node:test';
import assert from 'node:assert/strict';

import {
  renderBanner,
  renderTurnStatus,
  shortenPath,
  resolveWidth,
  DEFAULT_TERMINAL_WIDTH,
  MIN_TERMINAL_WIDTH,
  BOX_MAX_WIDTH,
  BOX_MIN_WIDTH,
} from '../src/cli/tui/banner.js';
import { needsOnboarding, onboardingSteps, renderOnboarding } from '../src/cli/tui/onboarding.js';
import { SYM } from '../src/cli/tui/theme.js';
import { stripAnsi, stringWidth } from '../src/cli/tui/text.js';

const info = {
  version: '0.1.0',
  profile: 'main',
  provider: 'anthropic',
  model: 'some-model',
  cwd: '/home/dev/projects/toris-agent',
  autonomy: 'L2',
  approvals: 'ask',
  tools: 5,
  skills: 2,
  width: 80,
  home: '/home/dev',
};

// --- banner -----------------------------------------------------------------

test('the banner answers what, where and how freely, in a few lines', () => {
  const text = stripAnsi(renderBanner(info).join('\n'));

  assert.match(text, /toris/);
  assert.match(text, /0\.1\.0/);
  assert.match(text, /anthropic\/some-model/);
  assert.match(text, /main/);
  assert.match(text, /L2/);
  assert.match(text, /~\/projects\/toris-agent/);
  // The box costs two border rows and a spacer; past that it is one line per
  // fact, and there are only six facts.
  assert.ok(renderBanner(info).length <= 12, 'stays compact');
});

test('the banner names the keys that get an operator unstuck', () => {
  const text = stripAnsi(renderBanner(info).join('\n'));
  assert.match(text, /\/help/);
  assert.match(text, /ctrl-c/);
  assert.match(text, /ctrl-d/);
});

test('the banner never overflows the terminal it is drawn in', () => {
  for (const width of [40, 60, 80, 120]) {
    for (const line of renderBanner({ ...info, width })) {
      assert.ok(stringWidth(stripAnsi(line)) <= width, `width ${width}: ${stripAnsi(line)}`);
    }
  }
});

test('a cramped banner keeps its fields whole rather than cutting a value', () => {
  const lines = renderBanner({ ...info, width: 46 }).map(stripAnsi);
  const modelRow = lines.find((l) => l.includes('model'));

  assert.ok(modelRow, 'the most important field survives');
  assert.ok(!modelRow.includes('…'), `no field was cut mid-value: ${modelRow}`);
  assert.match(modelRow, /anthropic\/some-model/);
  for (const l of lines) assert.ok(stringWidth(l) <= 46, l);
});

test('a terminal too narrow to frame falls back to plain stacked lines', () => {
  const lines = renderBanner({ ...info, width: 24 }).map(stripAnsi);
  const text = lines.join('\n');

  assert.ok(!text.includes('╭'), 'no box is drawn where it cannot fit');
  assert.match(text, /toris/);
  for (const l of lines) assert.ok(stringWidth(l) <= 24, l);
});

test('a roomy terminal gets a closed, aligned box', () => {
  const lines = renderBanner({ ...info, width: 100 }).map(stripAnsi);

  assert.match(lines[0], /^╭─+╮$/);
  assert.match(lines.at(-2), /^╰─+╯$/);
  const widths = new Set(lines.slice(0, -1).map(stringWidth));
  assert.equal(widths.size, 1, 'every box row is the same width');
  assert.ok([...widths][0] <= 64, 'the box is capped, not stretched');
});

test('one turn is not "1 turns"', () => {
  const one = stripAnsi(renderTurnStatus({ provider: 'p', model: 'm', usage: { turns: 1 } }));
  assert.match(one, /1 turn\b/);
  assert.doesNotMatch(one, /1 turns/);
});

test('a delegated backend reports delegation rather than a misleading zero', () => {
  const text = stripAnsi(
    renderBanner({ ...info, tools: 'delegated', skills: 'delegated' }).join('\n'),
  );
  assert.match(text, /tools\s+delegated/);
});

test('home is collapsed, but only when the path is really under it', () => {
  assert.equal(shortenPath('/home/dev/src', '/home/dev'), '~/src');
  assert.equal(shortenPath('/home/dev', '/home/dev'), '~');
  assert.equal(shortenPath('/home/developer/src', '/home/dev'), '/home/developer/src');
  assert.equal(shortenPath('/etc', '/home/dev'), '/etc');
  assert.equal(shortenPath('/etc', ''), '/etc');
});

// --- width resolution -------------------------------------------------------

test('a terminal that reports no size gets the default, not a zero-width layout', () => {
  // Regression: `script`, some CI runners and detached ptys report columns 0,
  // which `?? ` accepts, and every line collapsed to a bare "…".
  for (const columns of [0, -1, undefined, null, NaN, 'wide', Infinity]) {
    assert.equal(resolveWidth(columns), DEFAULT_TERMINAL_WIDTH, String(columns));
  }
});

test('an honest width is obeyed, down to the point of uselessness', () => {
  assert.equal(resolveWidth(120), 120);
  assert.equal(resolveWidth(40.7), 40);
  assert.equal(resolveWidth(5), MIN_TERMINAL_WIDTH, 'absurdly narrow is clamped, not honoured');
});

test('a banner drawn in a size-less terminal still says something', () => {
  const lines = renderBanner({ ...info, width: 0 }).map(stripAnsi);
  assert.match(lines.join('\n'), /toris/);
  assert.ok(
    lines.every((l) => stringWidth(l) <= DEFAULT_TERMINAL_WIDTH),
    'falls back to the default width',
  );
});

// --- turn footer ------------------------------------------------------------

test('the turn footer reports the model and what it spent', () => {
  const text = stripAnsi(
    renderTurnStatus({
      provider: 'anthropic',
      model: 'some-model',
      usage: { inputTokens: 120, outputTokens: 34, turns: 2 },
    }),
  );

  assert.match(text, /anthropic\/some-model/);
  assert.match(text, /120 in/);
  assert.match(text, /34 out/);
  assert.match(text, /2 turns/);
});

test('the turn footer is truncated, not wrapped, on a narrow terminal', () => {
  const text = renderTurnStatus({
    provider: 'anthropic',
    model: 'a-very-long-model-identifier-indeed',
    usage: { inputTokens: 1, outputTokens: 2, turns: 3 },
    width: 24,
  });

  assert.ok(!stripAnsi(text).includes('\n'));
  assert.ok(stringWidth(stripAnsi(text)) <= 24);
});

test('missing usage reads as zero rather than undefined', () => {
  const text = stripAnsi(renderTurnStatus({ provider: 'p', model: 'm', usage: undefined }));
  assert.match(text, /0 in/);
  assert.doesNotMatch(text, /undefined/);
});

// --- onboarding -------------------------------------------------------------

test('onboarding is needed until both a config and a profile exist', () => {
  assert.equal(needsOnboarding({ configExists: false, profileCount: 0 }), true);
  assert.equal(needsOnboarding({ configExists: true, profileCount: 0 }), true);
  assert.equal(needsOnboarding({ configExists: false, profileCount: 2 }), true);
  assert.equal(needsOnboarding({ configExists: true, profileCount: 1 }), false);
});

test('finished steps are marked done so progress is visible on a second run', () => {
  const steps = onboardingSteps({ configExists: true, profileCount: 0, home: '/home/dev/.toris' });
  assert.equal(steps[0].done, true, 'init already ran');
  assert.equal(steps[1].done, false, 'still no profile');
});

test('the first-run message names the command that fixes it', () => {
  const text = stripAnsi(
    renderOnboarding({
      version: '0.1.0',
      configExists: false,
      profileCount: 0,
      home: '/home/dev/.toris',
    }).join('\n'),
  );

  assert.match(text, /toris init/);
  assert.match(text, /config\.json/, 'says where state will land');
  assert.match(text, /API_KEY/, 'says credentials live in the environment');
  assert.doesNotMatch(text, /Error|E_CONFIG|stack/i, 'a first run is not a failure');
});

test('a configured-but-profileless install gets the narrower explanation', () => {
  const text = stripAnsi(
    renderOnboarding({
      version: '0.1.0',
      configExists: true,
      profileCount: 0,
      home: '/home/dev/.toris',
    }).join('\n'),
  );
  assert.match(text, /No model profile is configured/);
});

// --- boxed banner -----------------------------------------------------------

/** The four sides of the frame, as drawn. */
const frame = (lines) => ({
  top: lines[0],
  bottom: lines.findLast((l) => l.startsWith(SYM.bottomLeft)),
  sides: lines.filter((l) => l.startsWith(SYM.vertical)),
});

test('the banner is a closed rounded box', () => {
  const lines = renderBanner({ ...info, width: 80 }).map(stripAnsi);
  const { top, bottom, sides } = frame(lines);

  assert.ok(top.startsWith(SYM.topLeft) && top.endsWith(SYM.topRight), top);
  assert.ok(bottom.startsWith(SYM.bottomLeft) && bottom.endsWith(SYM.bottomRight), bottom);
  assert.ok(sides.length >= 4, 'title, blank, and the fact rows');
  for (const side of sides) {
    assert.ok(side.endsWith(SYM.vertical), `right edge is closed: ${side}`);
  }
});

test('every row of the box is exactly as wide as the frame', () => {
  for (const width of [40, 41, 55, 64, 80, 200]) {
    const lines = renderBanner({ ...info, width }).map(stripAnsi);
    const widths = new Set(lines.filter((l) => l.trim()).map(stringWidth));
    const box = lines.filter((l) => l.startsWith(SYM.vertical) || l.startsWith(SYM.topLeft));
    const boxWidths = new Set(box.map(stringWidth));
    assert.equal(boxWidths.size, 1, `ragged box at ${width}: ${[...boxWidths]}`);
    assert.ok(Math.max(...widths) <= width, `overflow at ${width}`);
  }
});

test('the box stops growing at 64 columns however wide the terminal is', () => {
  const lines = renderBanner({ ...info, width: 200 }).map(stripAnsi);
  assert.equal(stringWidth(lines[0]), BOX_MAX_WIDTH);
});

test('the title row carries the product name and version', () => {
  const lines = renderBanner({ ...info, width: 64 }).map(stripAnsi);
  assert.match(lines[1], new RegExp(`${SYM.star} toris v\\d`), lines[1]);
});

test('the facts are labelled, aligned, and complete', () => {
  const lines = renderBanner({ ...info, width: 64 }).map(stripAnsi);

  const valueColumns = ['model', 'cwd', 'autonomy'].map((label) => {
    const row = lines.find((l) => l.includes(`${label} `));
    assert.ok(row, `${label} has a row`);
    const after = row.slice(row.indexOf(label) + label.length);
    return row.length - after.length + (after.length - after.trimStart().length);
  });

  assert.equal(new Set(valueColumns).size, 1, `values line up: ${valueColumns}`);
});

test('a narrow terminal falls back to the old plain lines rather than a broken box', () => {
  const lines = renderBanner({ ...info, width: BOX_MIN_WIDTH - 1 }).map(stripAnsi);

  assert.ok(!lines.some((l) => l.includes(SYM.topLeft)), 'no half-drawn frame');
  assert.match(lines.join('\n'), /toris/);
  for (const line of lines) {
    assert.ok(stringWidth(line) <= BOX_MIN_WIDTH - 1, `${stringWidth(line)}: ${line}`);
  }
});

test('at the 20-column floor the banner still says what it must', () => {
  const lines = renderBanner({ ...info, width: MIN_TERMINAL_WIDTH }).map(stripAnsi);

  assert.ok(lines.length > 0);
  for (const line of lines) {
    assert.ok(stringWidth(line) <= MIN_TERMINAL_WIDTH, `${stringWidth(line)}: ${line}`);
  }
  assert.match(lines.join('\n'), /toris/);
});

test('a long cwd is clipped inside the box, never past its edge', () => {
  const lines = renderBanner({
    ...info,
    width: 48,
    cwd: '/home/dev/very/deeply/nested/workspace/that/keeps/going/forever',
  }).map(stripAnsi);

  for (const line of lines) {
    assert.ok(stringWidth(line) <= 48, `${stringWidth(line)}: ${line}`);
  }
  assert.ok(lines.some((l) => l.includes('…')), 'the overflow is marked, not silently cut');
});

test('the hint line names the three keys a newcomer needs', () => {
  const text = stripAnsi(renderBanner({ ...info, width: 80 }).join('\n'));
  assert.match(text, /\/help/);
  assert.match(text, /ctrl-c/);
  assert.match(text, /ctrl-d/);
});
