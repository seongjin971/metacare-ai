import assert from 'node:assert/strict';
import test from 'node:test';
import { fitPhotoSize, stampLayout } from '../src/photo-stamp-layout.ts';
import { MAX_CAPTURE_PIXELS } from '../src/picture-size.ts';

// About as wide as "메타케어 · 2026.11.12 (목) 오후 7:03" in a bold system font.
const measure = (fontSize: number) => fontSize * 20;
const near = (actual: number, expected: number) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≈ ${expected}`);

test('a capture within the budget keeps its size; a larger one shrinks with the same aspect ratio', () => {
  assert.deepEqual(fitPhotoSize(1920, 1080), { width: 1920, height: 1080 });
  assert.deepEqual(fitPhotoSize(640, 480), { width: 640, height: 480 });
  const large = fitPhotoSize(4000, 3000);
  assert.ok(large.width * large.height <= MAX_CAPTURE_PIXELS);
  assert.ok(Math.abs(large.width / large.height - 4 / 3) < 0.01);
  assert.deepEqual(fitPhotoSize(8000, 500), { width: 4096, height: 256 });
  for (const [width, height] of [[0, 480], [640, -1], [640.5, 480], [Number.NaN, 480]]) {
    assert.throws(() => fitPhotoSize(width, height), /크기/);
  }
});

test('the stamp sits in the bottom-left corner, sized to the shorter side like the installed app', () => {
  const layout = stampLayout(1920, 1080, measure);
  assert.equal(layout.fontSize, 1080 * 0.045);
  near(layout.box.x, 1080 * 0.03);
  near(layout.box.y + layout.box.height, 1080 - 1080 * 0.03);
  near(layout.box.width, measure(layout.fontSize) + layout.fontSize * 0.6 * 2);
  near(layout.radius, layout.fontSize * 0.6 * 0.7);
  near(layout.text.x, layout.box.x + layout.fontSize * 0.6);
  near(layout.text.y, layout.box.y + layout.box.height / 2);
});

test('a long label shrinks so the stamp never runs past the photo', () => {
  for (const [width, height] of [[1080, 1920], [480, 640], [300, 2000], [64, 64]]) {
    const layout = stampLayout(width, height, measure);
    const margin = Math.min(width, height) * 0.03;
    assert.ok(layout.box.x + layout.box.width <= width - margin + 1e-9, `${width}×${height} fits its width`);
    assert.ok(layout.box.y >= 0, `${width}×${height} fits its height`);
    assert.ok(layout.fontSize <= Math.min(width, height) * 0.045);
  }
  assert.ok(stampLayout(1080, 1920, measure).fontSize < 1080 * 0.045);
  assert.throws(() => stampLayout(0, 100, measure), /크기/);
});
