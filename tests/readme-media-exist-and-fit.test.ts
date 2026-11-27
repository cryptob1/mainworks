import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, buildDemoState } from '../scripts/docs-media-demo.mjs';
import { workersView } from '../web/workers-view';

// GY-3919/GY-3926: five media files under docs/media exist, are referenced by README.md, fit size/dimension
// limits, and pipeline.svg has the six labels in order with dark-mode support and no plumbing details.
const root = fileURLToPath(new URL('..', import.meta.url));
const pathOf = (rel: string) => join(root, rel);

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', 'valid PNG signature');
  assert.equal(bytes.subarray(12, 16).toString('ascii'), 'IHDR', 'PNG starts with IHDR');
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** Total animation duration of a GIF89a in seconds from its Graphic Control Extensions. */
function gifSeconds(bytes: Buffer): number {
  assert.equal(bytes.subarray(0, 6).toString('ascii'), 'GIF89a', 'valid GIF89a header');
  let i = 13;
  const packed = bytes[10]!;
  if (packed & 0x80) i += 3 * (1 << ((packed & 0x07) + 1));
  let centiseconds = 0;
  while (i < bytes.length) {
    const introducer = bytes[i++]!;
    if (introducer === 0x3b) break; // trailer
    if (introducer === 0x21) { // extension
      const label = bytes[i++]!;
      if (label === 0xf9 && bytes[i] === 4) {
        centiseconds += bytes.readUInt16LE(i + 2);
      }
      while (i < bytes.length && bytes[i] !== 0) i += 1 + bytes[i]!;
      i++; // block terminator
    } else if (introducer === 0x2c) { // image descriptor
      const imgPacked = bytes[i + 8]!;
      i += 9;
      if (imgPacked & 0x80) i += 3 * (1 << ((imgPacked & 0x07) + 1));
      i++; // LZW min code size
      while (i < bytes.length && bytes[i] !== 0) i += 1 + bytes[i]!;
      i++; // block terminator
    } else {
      break;
    }
  }
  return centiseconds / 100;
}

function mp4Seconds(bytes: Buffer): number {
  const at = bytes.indexOf('mvhd');
  assert.ok(at > 0, 'the MP4 has a movie header');
  const v1 = bytes[at + 4] === 1;
  const scale = bytes.readUInt32BE(at + (v1 ? 24 : 16));
  const duration = v1 ? Number(bytes.readBigUInt64BE(at + 28)) : bytes.readUInt32BE(at + 20);
  return duration / scale;
}

test('unit:readme-media-exist-and-fit — docs/media holds hero.gif+hero.mp4, work.png, change.png, lead.png and pipeline.svg, referenced by README with alt texts of six words or more, within size/dimension limits, reproducible via npm run docs:media from a healthy demo line in plain words', () => {
  const readme = readFileSync(pathOf('README.md'), 'utf8');
  const manifest = JSON.parse(readFileSync(pathOf('package.json'), 'utf8'));
  assert.ok(typeof manifest.scripts?.['docs:media'] === 'string' && manifest.scripts['docs:media'].length > 0, 'package.json defines npm run docs:media');

  const files = [
    'docs/media/hero.gif',
    'docs/media/hero.mp4',
    'docs/media/work.png',
    'docs/media/change.png',
    'docs/media/lead.png',
    'docs/media/pipeline.svg',
  ];
  for (const rel of files) {
    assert.ok(existsSync(pathOf(rel)), `${rel} exists`);
    assert.ok(readme.includes(rel), `README.md references ${rel}`);
  }

  // GY-3962: every image has a descriptive alt text of at least six words.
  const images = [...readme.matchAll(/!\[([^\]]*)\]\((docs\/media\/[^)]+)\)/g)];
  assert.ok(images.length >= 5, `README shows its media as images (${images.length})`);
  for (const [, alt, src] of images) assert.ok(alt.trim().split(/\s+/).length >= 6, `${src} has an alt text of at least six words: "${alt}"`);

  // GY-3962: the Work capture shows a healthy line: at least 3 merges an hour over the six hours its header counts.
  const demo = buildDemoState('static');
  const merges = demo.work.filter(item => item.delivery?.mergedAt && NOW - Date.parse(item.delivery.mergedAt) <= 6 * 3_600_000).length / 6;
  assert.ok(merges >= 3, `the demo Work line reads ${merges.toFixed(1)} merges an hour`);

  // hero.gif: under 4 MB, at most 25 seconds.
  const gifBytes = readFileSync(pathOf('docs/media/hero.gif'));
  assert.ok(gifBytes.length > 0 && gifBytes.length < 4 * 1024 * 1024, `hero.gif is under 4 MB (${gifBytes.length} bytes)`);
  const gifDur = gifSeconds(gifBytes);
  assert.ok(gifDur > 0 && gifDur <= 25, `hero.gif duration is <= 25 s (got ${gifDur} s)`);

  // hero.mp4: valid MP4, at most 25 seconds.
  const mp4Bytes = readFileSync(pathOf('docs/media/hero.mp4'));
  assert.ok(mp4Bytes.length > 0, 'hero.mp4 is non-empty');
  const mp4Dur = mp4Seconds(mp4Bytes);
  assert.ok(mp4Dur > 0 && mp4Dur <= 25, `hero.mp4 duration is <= 25 s (got ${mp4Dur} s)`);

  // PNGs: 1600 px wide.
  for (const png of ['docs/media/work.png', 'docs/media/change.png', 'docs/media/lead.png']) {
    const bytes = readFileSync(pathOf(png));
    const { width, height } = pngDimensions(bytes);
    assert.equal(width, 1600, `${png} is 1600 px wide (got ${width})`);
    assert.ok(height >= 400, `${png} has height >= 400 px (got ${height})`);
    assert.ok(statSync(pathOf(png)).size < 4 * 1024 * 1024, `${png} is under 4 MB`);
  }

  // pipeline.svg: six labels in order, prefers-color-scheme dark variant, no commands/ports/units/file names.
  const svg = readFileSync(pathOf('docs/media/pipeline.svg'), 'utf8');
  assert.ok(svg.trimStart().startsWith('<svg'), 'pipeline.svg is an SVG');
  assert.match(svg, /prefers-color-scheme:\s*dark/, 'pipeline.svg has a dark variant via prefers-color-scheme');

  const textOnly = svg.replace(/<style[\s\S]*?<\/style>/g, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const labels = ['Goal', 'Build', 'Review', 'Merge trial', 'Deploy', 'Watch'];
  let pos = -1;
  for (const label of labels) {
    const next = textOnly.indexOf(label, pos + 1);
    assert.ok(next > pos, `pipeline.svg contains "${label}" in order`);
    pos = next;
  }

  for (const forbidden of [
    /\bmainworks\s+(?:up|doctor|guide|host|master|install|status|upgrade)\b/,
    /\b(?:git|npm|node|docker|journalctl|systemctl)\b/i,
    /\b4310\b/,
    /\.service\b/i,
    /\.(?:json|mjs|tsx?|ya?ml|sh)\b/i,
  ]) {
    assert.doesNotMatch(textOnly, forbidden, `pipeline.svg contains no plumbing (${forbidden})`);
  }

  // GY-3926: the demo seed behind the captures agrees with itself in every hero phase. The header
  // counts what top-bar.tsx counts: running agent sessions plus the Lead's pane, and checks running.
  for (const phase of ['static', 'before-create', 'build', 'review', 'test', 'merged', 'live'] as const) {
    const { work, board, status } = buildDemoState(phase);
    const agents = workersView(work, new Date(NOW)).running.filter(row => !row.stale && row.roleKind !== 'master').length + (status.setup?.panes?.master ? 1 : 0);
    const withAgent = work.filter(item => item.stage === 'build' || item.stage === 'review');
    const testing = work.filter(item => item.stage === 'test');
    assert.ok(status.setup?.panes?.master, `${phase}: the Lead's live session is counted`);
    assert.equal(agents, withAgent.length + 1, `${phase}: agents working = rows building or in review + the Lead`);
    assert.equal(status.checksRunning, testing.length, `${phase}: checks running = rows testing`);
    assert.ok(testing.length + withAgent.length > 0, `${phase}: something is in progress`);
    const moving = board.groups.moving!.map(entry => entry.key).sort();
    assert.deepEqual(moving, [...withAgent, ...testing].map(item => item.key).sort(), `${phase}: the board's moving rows are the in-progress rows`);
    for (const item of work.filter(item => item.stage === 'done')) assert.ok(item.delivery?.mergedAt, `${phase}: ${item.key} shown done is merged`);
    // GY-3987: the Work capture's Now column reads owner-first, never the merge writer's or reviewer's own words.
    for (const { key, does } of board.groups.moving! as { key: string; does: string }[]) assert.doesNotMatch(does, /merge trial|latest main|diff and proofs/i, `${phase}: ${key} Now reads plainly: "${does}"`);
  }
});
