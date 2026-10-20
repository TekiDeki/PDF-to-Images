/* PDF model - TekiDeki
   Pure functions only, so the node test can load this file without a browser. */

(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PDModel = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var DPI_MIN = 36;
  var DPI_MAX = 600;
  var MAX_PIXELS = 40 * 1000 * 1000;

  /* ------------------------------------------------------------ page list */

  // "1-3, 7, 10-12" -> [1,2,3,7,10,11,12]. An empty box means every page.
  // Anything the eye would not read as a page list comes back as null.
  function parseRange(text, total) {
    var raw = String(text == null ? '' : text).trim();
    if (!raw) {
      var all = [];
      for (var i = 1; i <= total; i++) all.push(i);
      return all;
    }
    if (!/^[0-9\s,\-]+$/.test(raw)) return null;
    var seen = {};
    var parts = raw.split(',');
    for (var p = 0; p < parts.length; p++) {
      var piece = parts[p].trim();
      if (!piece) return null;
      var span = piece.split('-');
      if (span.length > 2) return null;
      var from = parseInt(span[0], 10);
      var to = span.length === 2 ? parseInt(span[1], 10) : from;
      if (!isFinite(from) || !isFinite(to)) return null;
      if (from > to) return null;
      if (from < 1 || to > total) return null;
      for (var n = from; n <= to; n++) seen[n] = true;
    }
    return Object.keys(seen).map(Number).sort(function (a, b) { return a - b; });
  }

  /* ------------------------------------------------------------- geometry */

  // A PDF measures in points: 72 to the inch. The canvas needs pixels.
  function pagePixels(widthPt, heightPt, dpi) {
    var scale = dpi / 72;
    var w = Math.max(1, Math.round(widthPt * scale));
    var h = Math.max(1, Math.round(heightPt * scale));
    if (w * h <= MAX_PIXELS) return { width: w, height: h, capped: false };
    // Floor, not round: rounding up put the product a few pixels over the cap.
    var shrink = Math.sqrt(MAX_PIXELS / (w * h));
    return {
      width: Math.max(1, Math.floor(w * shrink)),
      height: Math.max(1, Math.floor(h * shrink)),
      capped: true
    };
  }

  // The scale pdf.js wants, after the pixel cap has had its say.
  function renderScale(widthPt, heightPt, dpi) {
    var box = pagePixels(widthPt, heightPt, dpi);
    return { width: box.width, height: box.height, capped: box.capped, scale: box.width / widthPt };
  }

  function clampDpi(value) {
    var n = parseInt(value, 10);
    if (!isFinite(n)) return 150;
    return Math.min(DPI_MAX, Math.max(DPI_MIN, n));
  }

  function clampQuality(value) {
    var n = parseInt(value, 10);
    if (!isFinite(n)) return 85;
    return Math.min(100, Math.max(40, n));
  }

  // Points to millimetres, for the line under the page.
  function ptToMm(value) {
    return Math.round(value * 25.4 / 72);
  }

  /* ---------------------------------------------------------------- names */

  function baseName(fileName) {
    var name = String(fileName || 'document.pdf');
    name = name.replace(/^.*[\\/]/, '').replace(/\.pdf$/i, '');
    // NFD splits most accents but not the stroked letters, so they are mapped
    // by hand: d with a stroke and the two Polish letters that show up in names.
    name = name.replace(/[đĐ]/g, 'd').replace(/[øØ]/g, 'o').replace(/[łŁ]/g, 'l').replace(/[æÆ]/g, 'ae');
    name = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    name = name.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    return name.slice(0, 48) || 'document';
  }

  function pad(number) {
    return String(number).padStart(3, '0');
  }

  function outputName(base, page, ext) {
    return base + '-page-' + pad(page) + '.' + ext;
  }

  function uniqueName(taken, wanted) {
    if (!taken[wanted]) return wanted;
    var dot = wanted.lastIndexOf('.');
    var stem = dot > 0 ? wanted.slice(0, dot) : wanted;
    var ext = dot > 0 ? wanted.slice(dot) : '';
    var n = 2;
    while (taken[stem + '-' + n + ext]) n++;
    return stem + '-' + n + ext;
  }

  function extFor(format) {
    return String(format).toLowerCase() === 'png' ? 'png' : 'jpg';
  }

  function mimeFor(format) {
    return extFor(format) === 'png' ? 'image/png' : 'image/jpeg';
  }

  /* ---------------------------------------------------------------- sizes */

  function humanSize(bytes) {
    var n = Number(bytes) || 0;
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return Math.round(n / 1024) + ' KB';
    return (n / (1024 * 1024)).toFixed(1).replace('.', ',') + ' MB';
  }

  function humanSizeEn(bytes) {
    return humanSize(bytes).replace(',', '.');
  }

  /* ------------------------------------------------------------------ zip */

  var CRC_TABLE = (function () {
    var table = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  }());

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  // Store only. The images are already compressed, so deflate would cost code
  // and buy nothing. Returns the bytes of the archive, ready for a Blob.
  function zip(files, when) {
    var encoder = new TextEncoder();
    var stampDate = when instanceof Date ? when : new Date(2026, 0, 1, 0, 0, 0);
    var time = ((stampDate.getHours() << 11) | (stampDate.getMinutes() << 5) | (stampDate.getSeconds() >> 1)) & 0xFFFF;
    var day = (((stampDate.getFullYear() - 1980) << 9) | ((stampDate.getMonth() + 1) << 5) | stampDate.getDate()) & 0xFFFF;

    var parts = [];
    var central = [];
    var offset = 0;

    files.forEach(function (file) {
      var nameBytes = encoder.encode(file.name);
      var data = file.data instanceof Uint8Array ? file.data : new Uint8Array(file.data);
      var crc = crc32(data);

      var local = new Uint8Array(30 + nameBytes.length);
      var view = new DataView(local.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0x0800, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, time, true);
      view.setUint16(12, day, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, nameBytes.length, true);
      local.set(nameBytes, 30);
      parts.push(local, data);

      var dir = new Uint8Array(46 + nameBytes.length);
      var dview = new DataView(dir.buffer);
      dview.setUint32(0, 0x02014b50, true);
      dview.setUint16(4, 20, true);
      dview.setUint16(6, 20, true);
      dview.setUint16(8, 0x0800, true);
      dview.setUint16(10, 0, true);
      dview.setUint16(12, time, true);
      dview.setUint16(14, day, true);
      dview.setUint32(16, crc, true);
      dview.setUint32(20, data.length, true);
      dview.setUint32(24, data.length, true);
      dview.setUint16(28, nameBytes.length, true);
      dview.setUint32(42, offset, true);
      dir.set(nameBytes, 46);
      central.push(dir);

      offset += local.length + data.length;
    });

    var centralSize = central.reduce(function (sum, part) { return sum + part.length; }, 0);
    var end = new Uint8Array(22);
    var eview = new DataView(end.buffer);
    eview.setUint32(0, 0x06054b50, true);
    eview.setUint16(8, files.length, true);
    eview.setUint16(10, files.length, true);
    eview.setUint32(12, centralSize, true);
    eview.setUint32(16, offset, true);

    var total = offset + centralSize + end.length;
    var out = new Uint8Array(total);
    var at = 0;
    parts.concat(central, [end]).forEach(function (part) {
      out.set(part, at);
      at += part.length;
    });
    return out;
  }

  return {
    parseRange: parseRange,
    pagePixels: pagePixels,
    renderScale: renderScale,
    clampDpi: clampDpi,
    clampQuality: clampQuality,
    ptToMm: ptToMm,
    baseName: baseName,
    outputName: outputName,
    uniqueName: uniqueName,
    extFor: extFor,
    mimeFor: mimeFor,
    humanSize: humanSize,
    humanSizeEn: humanSizeEn,
    crc32: crc32,
    zip: zip,
    MAX_PIXELS: MAX_PIXELS
  };
}));
