import assert from 'node:assert/strict';
import test from 'node:test';
import { MP4_FPS, estimateLabels, estimateReferenceBytes, mp4Bitrate } from '../shared.js';

test('MP4: 30 fps, ограниченный битрейт и растущая оценка размера', () => {
  assert.equal(MP4_FPS, 30);
  assert.equal(mp4Bitrate(0, 16, 16), 250_000);
  assert.equal(mp4Bitrate(100, 3840, 2160), 6_000_000);
  for (let quality = 1; quality <= 100; quality++) {
    assert.ok(estimateReferenceBytes(quality, 'mp4') > estimateReferenceBytes(quality - 1, 'mp4'));
  }
  assert.equal(estimateReferenceBytes(80, 'mp4'), Math.round(mp4Bitrate(80, 512, 512) * 5 / 8));
  assert.equal(estimateLabels('mp4').length, 101);
  assert.notEqual(estimateLabels('mp4')[80], estimateLabels()[80]);
});
