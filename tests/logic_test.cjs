#!/usr/bin/env node
/* Model checks for PDF to Images. No browser, no network.
 *
 *     node tests/logic_test.cjs
 *
 * The model is the part that can be wrong quietly: a page list read the wrong
 * way, a pixel count off by a rounding, a zip whose central directory points
 * at nothing. Every case below is one of those.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const M = require('../src/model.js');

let checks = 0;
const failures = [];

function ok(condition, message) {
  checks++;
  if (!condition) failures.push(message);
}

function eq(actual, expected, message) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  ok(a === e, message + '\n    expected ' + e + '\n    got      ' + a);
}

/* ------------------------------------------------------------------ range */

eq(M.parseRange('', 5), [1, 2, 3, 4, 5], 'an empty page list means every page');
eq(M.parseRange('1-3, 7, 10-12', 12), [1, 2, 3, 7, 10, 11, 12], 'a mixed list expands in order');
eq(M.parseRange('7', 9), [7], 'a single page is a list of one');
eq(M.parseRange('3,3,3', 9), [3], 'a repeated page is taken once');
eq(M.parseRange(' 2 - 4 ', 9), [2, 3, 4], 'spaces around the dash are fine');
eq(M.parseRange('9-12', 12), [9, 10, 11, 12], 'a span may end on the last page');
ok(M.parseRange('0-2', 9) === null, 'a zero page is refused');
ok(M.parseRange('5-2', 9) === null, 'a backwards span is refused');
ok(M.parseRange('1-20', 9) === null, 'a span past the end is refused');
ok(M.parseRange('abc', 9) === null, 'letters are refused');
ok(M.parseRange('1,,2', 9) === null, 'an empty piece is refused');
ok(M.parseRange('1-2-3', 9) === null, 'two dashes in one piece are refused');
ok(M.parseRange('-3', 9) === null, 'a leading dash is refused');
ok(M.parseRange('4-', 9) === null, 'a trailing dash is refused');
ok(M.parseRange('1;2', 9) === null, 'a semicolon is not a separator');
eq(M.parseRange('1-1', 1), [1], 'a one page span works');

/* --------------------------------------------------------------- pixels */

eq(M.pagePixels(612, 792, 72), { width: 612, height: 792, capped: false }, 'US Letter at 72 dpi is 612 by 792');
eq(M.pagePixels(595, 842, 150), { width: 1240, height: 1754, capped: false }, 'A4 at 150 dpi');
eq(M.pagePixels(595, 842, 300), { width: 2479, height: 3508, capped: false }, 'A4 at 300 dpi');
eq(M.pagePixels(612, 792, 600).width, 5100, 'Letter at 600 dpi');

const huge = M.pagePixels(14400, 14400, 600);
ok(huge.capped, 'a wall sized page is capped');
ok(huge.width * huge.height <= M.MAX_PIXELS, 'the cap keeps the pixel count under the limit');
ok(Math.abs(huge.width - huge.height) <= 1, 'the cap keeps the shape of the page');

const single = M.renderScale(612, 792, 150);
eq([single.width, single.height], [1275, 1650], 'the render scale lands on the right pixels');
ok(Math.abs(single.width / 612 - 150 / 72) < 0.002, 'the scale is the dpi over 72');

eq(M.clampDpi('150'), 150, 'a numeric string is read');
eq(M.clampDpi('9999'), 600, 'an absurd dpi is brought down to the maximum');
eq(M.clampDpi('1'), 36, 'a tiny dpi is brought up to the minimum');
eq(M.clampDpi('nonsense'), 150, 'nonsense falls back to 150');
eq(M.clampQuality('0'), 40, 'quality has a floor');
eq(M.clampQuality('140'), 100, 'quality has a ceiling');
eq(M.ptToMm(595), 210, 'A4 width in millimetres');
eq(M.ptToMm(842), 297, 'A4 height in millimetres');
eq(M.ptToMm(612), 216, 'Letter width in millimetres');

/* ----------------------------------------------------------------- names */

eq(M.baseName('Invoice 2026.PDF'), 'invoice-2026', 'the name is lowered and cleaned');
eq(M.baseName('Faktura br. 12 - mart.pdf'), 'faktura-br-12-mart', 'punctuation becomes one dash');
eq(M.baseName('Čačak Đorđe.pdf'), 'cacak-dorde', 'accents are stripped');
eq(M.baseName(''), 'document', 'an empty name has a fallback');
eq(M.baseName('/deep/path/scan.pdf'), 'scan', 'a path is not part of the name');
eq(M.baseName('!!!.pdf'), 'document', 'a name with nothing usable falls back');
ok(M.baseName('x'.repeat(200) + '.pdf').length <= 48, 'a very long name is cut');
eq(M.outputName('scan', 7, 'jpg'), 'scan-page-007.jpg', 'page numbers are padded to three');
eq(M.outputName('scan', 120, 'png'), 'scan-page-120.png', 'three digits fit');
eq(M.outputName('scan', 1200, 'png'), 'scan-page-1200.png', 'four digits fit');

const taken = { 'a-page-001.jpg': true, 'a-page-001-2.jpg': true };
eq(M.uniqueName(taken, 'a-page-001.jpg'), 'a-page-001-3.jpg', 'a name already taken gets a suffix');
eq(M.uniqueName({}, 'b.png'), 'b.png', 'a free name is left alone');

eq(M.extFor('PNG'), 'png', 'the extension follows the format');
eq(M.extFor('jpg'), 'jpg', 'jpg stays jpg');
eq(M.mimeFor('png'), 'image/png', 'the mime for png');
eq(M.mimeFor('jpg'), 'image/jpeg', 'the mime for jpg');
eq(M.humanSize(900), '900 B', 'bytes under a thousand');
eq(M.humanSize(2048), '2 KB', 'kilobytes');
eq(M.humanSize(5242880), '5,0 MB', 'megabytes with a comma, as Romanian writes them');
eq(M.humanSizeEn(5242880), '5.0 MB', 'and with a dot when English asks');

/* ------------------------------------------------------------------- zip */

const payload = Buffer.from('page one', 'utf8');
const bytes = M.zip([{ name: 'a.txt', data: new Uint8Array(payload) }], new Date(2026, 0, 2, 3, 4, 6));
ok(bytes instanceof Uint8Array, 'zip returns bytes');
eq(Array.from(bytes.slice(0, 4)), [0x50, 0x4b, 0x03, 0x04], 'the local header signature');

const dir = path.join(os.tmpdir(), 'pdf-to-images-test-' + Date.now());
fs.mkdirSync(dir, { recursive: true });
const zipPath = path.join(dir, 'one.zip');
fs.writeFileSync(zipPath, Buffer.from(bytes));

// An unzip that is not ours: if the central directory were wrong, this fails.
let listed = '';
try {
  listed = execFileSync('unzip', ['-l', zipPath], { encoding: 'utf8' });
  ok(/a\.txt/.test(listed), 'unzip lists the file');
} catch (error) {
  ok(false, 'unzip could not read the archive: ' + error.message);
}
try {
  const text = execFileSync('unzip', ['-p', zipPath, 'a.txt'], { encoding: 'utf8' });
  eq(text, 'page one', 'unzip reads the bytes back unchanged');
} catch (error) {
  ok(false, 'unzip could not extract: ' + error.message);
}

// Two files, and a name with a slash, which zip stores literally.
const two = M.zip([
  { name: 'a.txt', data: new Uint8Array(Buffer.from('one')) },
  { name: 'sub/b.txt', data: new Uint8Array(Buffer.from('two')) }
], new Date(2026, 4, 5));
const twoPath = path.join(dir, 'two.zip');
fs.writeFileSync(twoPath, Buffer.from(two));
const listing = execFileSync('unzip', ['-l', twoPath], { encoding: 'utf8' });
ok(/a\.txt/.test(listing) && /sub\/b\.txt/.test(listing), 'two entries are both listed');
eq(execFileSync('unzip', ['-p', twoPath, 'sub/b.txt'], { encoding: 'utf8' }), 'two', 'the nested name reads back');

// A big payload: the CRC has to be right over more than one buffer chunk.
const big = Buffer.alloc(300000);
for (let i = 0; i < big.length; i++) big[i] = i % 251;
const bigZip = path.join(dir, 'big.zip');
fs.writeFileSync(bigZip, Buffer.from(M.zip([{ name: 'big.bin', data: new Uint8Array(big) }], new Date(2026, 1, 1))));
const back = execFileSync('unzip', ['-p', bigZip, 'big.bin'], { maxBuffer: 1 << 24 });
ok(Buffer.compare(back, big) === 0, 'a 300 KB payload comes back byte for byte');

// The zip is stored, not deflated: the payload appears in the archive as is.
const stored = Buffer.from(payload);
ok(Buffer.from(bytes).includes(stored), 'the payload is stored, not compressed');

eq(M.crc32(new Uint8Array(payload)), zlib.crc32(payload), 'crc32 agrees with zlib');

/* ----------------------------------------------------------------- clean */

fs.rmSync(dir, { recursive: true, force: true });

if (failures.length) {
  console.log('FAIL: ' + failures.length + ' of ' + checks + ' checks');
  failures.forEach(function (message) { console.log('  - ' + message); });
  process.exit(1);
}
console.log('PASS: ' + checks + ' logic checks, ranges, pixels, names and a zip an outside tool can read');
