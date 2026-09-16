import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSafeHttpUrl,
  buildBookmarklet,
  buildCssPath,
  composeDesignTurnMessage,
  formatDesignContext,
  injectPickerMarkup,
  normalizeDesignCapture,
} from '../src/studio/design.js';

function el(tag, props = {}, children = []) {
  const node = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    id: '',
    parentElement: null,
    children: [],
    ...props,
  };
  for (const child of children) {
    child.parentElement = node;
    node.children.push(child);
  }
  return node;
}

test('buildCssPath prefers a stable id and nth-of-type among siblings', () => {
  const button = el('button', { id: 'sample-cta' });
  const hero = el('section', { id: 'sample-hero' }, [button]);
  const main = el('main', {}, [hero]);
  assert.equal(buildCssPath(button), '#sample-cta');

  const first = el('p');
  const second = el('p');
  el('div', { id: 'wrap' }, [first, second]);
  assert.equal(buildCssPath(second), '#wrap > p:nth-of-type(2)');
});

test('normalizeDesignCapture bounds HTML and drops unknown style keys', () => {
  const capture = normalizeDesignCapture({
    url: 'http://127.0.0.1:3000/checkout',
    selector: '#buy',
    tagName: 'BUTTON',
    outerHTML: `<button>${'x'.repeat(30_000)}</button>`,
    computedStyle: { color: 'rgb(255, 118, 87)', backgroundColor: 'black', cursor: 'pointer' },
    text: 'Buy now',
    rect: { x: 10, y: 20, width: 120, height: 44 },
    screenshotDataUrl: 'data:image/png;base64,aaaa',
  });
  assert.equal(capture.url, 'http://127.0.0.1:3000/checkout');
  assert.ok(capture.outerHTML.includes('…[truncated]'));
  assert.equal(capture.computedStyle.color, 'rgb(255, 118, 87)');
  assert.equal(capture.computedStyle.cursor, undefined);
  assert.equal(capture.screenshotDataUrl, 'data:image/png;base64,aaaa');
});

test('normalizeDesignCapture rejects non-http URLs', () => {
  assert.throws(() => normalizeDesignCapture({ url: 'file:///etc/passwd' }), /http/);
  assert.throws(() => assertSafeHttpUrl('javascript:alert(1)'), /http/);
});

test('screenshot attachments only keep png or jpeg data URLs', () => {
  const capture = normalizeDesignCapture({
    url: 'http://127.0.0.1:3000/',
    screenshotDataUrl: 'javascript:alert(1)',
  });
  assert.equal(capture.screenshotDataUrl, null);
  const html = normalizeDesignCapture({
    url: 'http://127.0.0.1:3000/',
    screenshotDataUrl: 'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
  });
  assert.equal(html.screenshotDataUrl, null);
});

test('formatDesignContext is evidence the agent can act on', () => {
  const text = formatDesignContext({
    url: 'http://127.0.0.1:5173/',
    selector: '#sample-cta',
    tagName: 'button',
    outerHTML: '<button class="cta">Continue</button>',
    computedStyle: { color: 'rgb(27, 14, 10)', backgroundColor: 'rgb(255, 118, 87)' },
    screenshotPath: '/tmp/des_1.png',
  });
  assert.match(text, /Design Mode attachment/);
  assert.match(text, /#sample-cta/);
  assert.match(text, /backgroundColor: rgb\(255, 118, 87\)/);
  assert.match(text, /\/tmp\/des_1\.png/);
  const composed = composeDesignTurnMessage('Make this 44px.', {
    url: 'http://127.0.0.1:5173/',
    selector: '#sample-cta',
    outerHTML: '<button>Continue</button>',
    computedStyle: {},
  });
  assert.match(composed, /Make this 44px/);
  assert.match(composed, /outerHTML/);
});

test('injectPickerMarkup strips CSP and inserts the picker plus base href', () => {
  const html = injectPickerMarkup(
    '<html><head><meta http-equiv="content-security-policy" content="script-src none"></head><body>hi</body></html>',
    { pickerSrc: '/assets/design-picker.js', baseHref: 'http://127.0.0.1:3000/app/' },
  );
  assert.match(html, /<script src="\/assets\/design-picker\.js"/);
  assert.match(html, /<base href="http:\/\/127\.0\.0\.1:3000\/app\/">/);
  assert.doesNotMatch(html, /content-security-policy/i);
});

test('buildBookmarklet injects the picker from the studio origin', () => {
  const href = buildBookmarklet('http://127.0.0.1:5824');
  assert.match(href, /^javascript:/);
  assert.match(href, /127\.0\.0\.1:5824\/assets\/design-picker\.js/);
  assert.match(href, /bookmarklet/);
});
