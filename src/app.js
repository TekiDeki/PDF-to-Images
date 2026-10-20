/* PDF to Images - TekiDeki
   The page carries its own PDF renderer, so a file is read and drawn here and
   never leaves the tab. */

(function () {
  'use strict';

  var M = window.PDModel;
  var ALL = window.TD_LOCALES || {};

  var SETTINGS_KEY = 'pdf-images.settings';
  var THEME_KEY = 'pdf-images.theme';
  var LANG_KEY = 'pdf-images.lang';
  var MAX_PAGES_PER_RUN = 200;

  var state = {
    lang: 'en',
    files: [],
    results: [],
    running: false,
    pending: null
  };

  var $ = function (id) { return document.getElementById(id); };

  /* --------------------------------------------------------------- strings */

  function t(key, vars) {
    var table = ALL[state.lang] || ALL.en || {};
    var text = table[key];
    if (text === undefined) text = (ALL.en || {})[key];
    if (text === undefined) return key;
    if (vars) {
      Object.keys(vars).forEach(function (name) {
        text = text.split('{' + name + '}').join(String(vars[name]));
      });
    }
    return text;
  }

  // Serbian has three plural shapes, Romanian two plus "de" from twenty up,
  // English two. The count decides which key is read, so no sentence is wrong
  // on the first page of a document.
  function pluralIndex(count) {
    var n = Math.abs(Number(count) || 0);
    if (state.lang === 'ro') {
      if (n === 1) return 'one';
      return (n === 0 || n % 100 >= 20) ? 'many' : 'few';
    }
    if (state.lang === 'sr-latn' || state.lang === 'sr-cyrl') {
      var ten = n % 10;
      var hundred = n % 100;
      if (ten === 1 && hundred !== 11) return 'one';
      if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return 'few';
      return 'many';
    }
    return n === 1 ? 'one' : 'many';
  }

  function tn(base, count, vars) {
    var merged = { n: count };
    if (vars) Object.keys(vars).forEach(function (name) { merged[name] = vars[name]; });
    return t(base + '_' + pluralIndex(count), merged);
  }

  function applyLang(lang) {
    if (!ALL[lang]) lang = 'en';
    state.lang = lang;
    document.documentElement.lang = lang === 'sr-cyrl' ? 'sr-Cyrl' : lang === 'sr-latn' ? 'sr-Latn' : lang;
    document.querySelectorAll('[data-i18n]').forEach(function (node) {
      node.textContent = t(node.getAttribute('data-i18n'));
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(function (node) {
      node.setAttribute('placeholder', t(node.getAttribute('data-i18n-placeholder')));
    });
    document.querySelectorAll('[data-i18n-aria-label]').forEach(function (node) {
      node.setAttribute('aria-label', t(node.getAttribute('data-i18n-aria-label')));
    });
    $('lang').value = lang;
    try { localStorage.setItem(LANG_KEY, lang); } catch (error) {}
    renderFiles();
    renderResults();
    updateNote();
    updateCount();
  }

  function detectLang() {
    try {
      var saved = localStorage.getItem(LANG_KEY);
      if (saved && ALL[saved]) return saved;
    } catch (error) {}
    var nav = (navigator.language || 'en').toLowerCase();
    if (nav.indexOf('ro') === 0) return 'ro';
    if (nav.indexOf('sr') === 0) return /-(cyrl|rs-cyrl)/.test(nav) ? 'sr-cyrl' : 'sr-latn';
    return 'en';
  }

  /* ---------------------------------------------------------------- theme */

  function wireTheme() {
    $('theme').addEventListener('click', function () {
      var dark = document.documentElement.getAttribute('data-theme') === 'dark';
      var next = dark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem(THEME_KEY, next); } catch (error) {}
    });
  }

  /* -------------------------------------------------------------- settings */

  function currentFormat() {
    var picked = document.querySelector('input[name="format"]:checked');
    return picked ? picked.value : 'jpg';
  }

  function currentDpi() {
    var picked = document.querySelector('input[name="dpi"]:checked');
    return picked ? M.clampDpi(picked.value) : 150;
  }

  function currentQuality() {
    return M.clampQuality($('quality').value);
  }

  function rangeMode() {
    var picked = document.querySelector('input[name="range"]:checked');
    return picked ? picked.value : 'all';
  }

  var wired = false;

  function saveSettings() {
    if (!wired) return;
    var data = {
      format: currentFormat(),
      dpi: currentDpi(),
      quality: currentQuality(),
      range: rangeMode(),
      rangeText: $('range').value
    };
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); } catch (error) {}
  }

  function loadSettings() {
    var data = null;
    try { data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null'); } catch (error) {}
    if (!data) return;
    if (data.format === 'png' || data.format === 'jpg') {
      document.querySelector('input[name="format"][value="' + data.format + '"]').checked = true;
    }
    if ([72, 150, 300].indexOf(Number(data.dpi)) >= 0) {
      document.querySelector('input[name="dpi"][value="' + Number(data.dpi) + '"]').checked = true;
    }
    if (data.quality) $('quality').value = M.clampQuality(data.quality);
    if (data.range === 'some') {
      document.querySelector('input[name="range"][value="some"]').checked = true;
      $('range-field').hidden = false;
    }
    if (typeof data.rangeText === 'string') $('range').value = data.rangeText;
  }

  /* --------------------------------------------------------------- engine */

  var enginePromise = null;

  function engine() {
    if (!enginePromise) {
      enginePromise = (async function () {
        var mainText = $('engine-main').textContent;
        var workerText = $('engine-worker').textContent;
        var mainUrl = URL.createObjectURL(new Blob([mainText], { type: 'text/javascript' }));
        var workerUrl = URL.createObjectURL(new Blob([workerText], { type: 'text/javascript' }));
        var lib = await import(mainUrl);
        lib.GlobalWorkerOptions.workerSrc = workerUrl;
        return lib;
      }());
    }
    return enginePromise;
  }

  async function openDocument(bytes, password) {
    var pdfjs = await engine();
    var options = { data: bytes.slice(0), isEvalSupported: false };
    if (password) options.password = password;
    return pdfjs.getDocument(options).promise;
  }

  /* ------------------------------------------------------------ the files */

  function showError(message) {
    var node = $('error');
    if (!message) {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    node.hidden = false;
    node.textContent = message;
    node.setAttribute('role', 'alert');
  }

  function showStatus(message) {
    $('status').textContent = message || '';
  }

  async function renderThumb(doc) {
    var page = await doc.getPage(1);
    var base = page.getViewport({ scale: 1 });
    var scale = 88 / base.width;
    var viewport = page.getViewport({ scale: scale });
    var canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    var ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport: viewport }).promise;
    return canvas.toDataURL('image/jpeg', 0.8);
  }

  async function addFile(file) {
    var name = file.name || 'document.pdf';
    if (!/\.pdf$/i.test(name) && file.type !== 'application/pdf') {
      showError(t('notPdf'));
      return false;
    }
    showError('');
    var bytes = new Uint8Array(await file.arrayBuffer());
    var doc;
    try {
      doc = await openDocument(bytes);
    } catch (error) {
      if (error && error.name === 'PasswordException') {
        var password = await askPassword(name);
        if (password === null) return false;
        try {
          doc = await openDocument(bytes, password);
        } catch (inner) {
          if (inner && inner.name === 'PasswordException') {
            showError(t('wrongPassword'));
            return false;
          }
          showError(t('brokenPdf'));
          return false;
        }
      } else {
        showError(t('brokenPdf'));
        return false;
      }
    }
    var thumb = '';
    try { thumb = await renderThumb(doc); } catch (error) { thumb = ''; }
    var first = await doc.getPage(1);
    var box = first.getViewport({ scale: 1 });
    state.files.push({
      id: 'f' + Date.now() + '-' + state.files.length,
      name: name,
      bytes: bytes,
      doc: doc,
      pages: doc.numPages,
      width: box.width,
      height: box.height,
      thumb: thumb
    });
    renderFiles();
    updateNote();
    updateConvertButton();
    return true;
  }

  function removeFile(id) {
    state.files = state.files.filter(function (file) { return file.id !== id; });
    renderFiles();
    updateNote();
    updateConvertButton();
    if (!state.files.length) clearResults();
  }

  function renderFiles() {
    var list = $('files');
    list.innerHTML = '';
    state.files.forEach(function (file) {
      var item = document.createElement('li');
      item.className = 'file-item';
      if (file.thumb) {
        var img = document.createElement('img');
        img.className = 'file-thumb';
        img.src = file.thumb;
        img.alt = '';
        item.appendChild(img);
      }
      var meta = document.createElement('div');
      meta.className = 'file-meta';
      var title = document.createElement('span');
      title.className = 'file-name';
      title.textContent = file.name;
      var sub = document.createElement('span');
      sub.className = 'file-sub';
      sub.textContent = tn('filePages', file.pages) + ' · ' + M.humanSize(file.bytes.length) +
        ' · ' + M.ptToMm(file.width) + ' × ' + M.ptToMm(file.height) + ' mm';
      meta.appendChild(title);
      meta.appendChild(sub);
      item.appendChild(meta);

      var remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn ghost small file-x';
      remove.textContent = t('remove');
      remove.setAttribute('aria-label', t('remove') + ': ' + file.name);
      remove.addEventListener('click', function () { removeFile(file.id); });
      item.appendChild(remove);
      list.appendChild(item);
    });
    $('btn-clear').hidden = state.files.length === 0 && state.results.length === 0;
  }

  function updateConvertButton() {
    $('convert').disabled = state.running || state.files.length === 0;
    $('convert').textContent = state.results.length ? t('convertAgain') : t('convert');
  }

  /* --------------------------------------------------------------- ranges */

  function pagesOf(file) {
    if (rangeMode() === 'all') {
      var all = [];
      for (var n = 1; n <= file.pages; n++) all.push(n);
      return all;
    }
    return M.parseRange($('range').value, file.pages);
  }

  function chosenTotal() {
    if (rangeMode() === 'all') {
      return state.files.reduce(function (sum, file) { return sum + file.pages; }, 0);
    }
    var total = 0;
    var bad = false;
    state.files.forEach(function (file) {
      var pages = pagesOf(file);
      if (pages === null) bad = true;
      else total += pages.length;
    });
    return bad ? null : total;
  }

  function updateNote() {
    var warn = $('range-warn');
    var bad = false;
    if (rangeMode() === 'some' && state.files.length) {
      state.files.forEach(function (file) {
        if (pagesOf(file) === null) bad = true;
      });
    }
    warn.hidden = !bad;
    if (!state.files.length) {
      $('res-note').textContent = '';
      updateConvertButton();
      return;
    }
    var file = state.files[0];
    var box = M.pagePixels(file.width, file.height, currentDpi());
    $('res-note').textContent = t('resNote', { w: box.width, h: box.height }) +
      (box.capped ? ' ' + t('capped') : '');
    updateConvertButton();
  }

  function updateCount() {
    var count = $('count');
    if (!state.results.length) {
      count.textContent = t('resultsEmpty');
      return;
    }
    var bytes = state.results.reduce(function (sum, item) { return sum + item.bytes; }, 0);
    count.textContent = tn('resultsCount', state.results.length, { size: M.humanSize(bytes) });
  }

  /* ------------------------------------------------------------ converting */

  function clearResults() {
    state.results.forEach(function (item) { URL.revokeObjectURL(item.url); });
    state.results = [];
    $('results').innerHTML = '';
    $('dl-all').hidden = true;
    $('empty').hidden = false;
    updateCount();
    updateConvertButton();
  }

  function canvasToBlob(canvas, mime, quality) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (blob) {
        if (blob) resolve(blob);
        else reject(new Error('toBlob failed'));
      }, mime, quality);
    });
  }

  function addCard(item) {
    var card = document.createElement('figure');
    card.className = 'shot';
    var img = document.createElement('img');
    img.src = item.url;
    img.alt = t('altPage', { n: item.page, name: item.source });
    img.loading = 'lazy';
    card.appendChild(img);

    var foot = document.createElement('div');
    foot.className = 'shot-foot';
    var meta = document.createElement('div');
    meta.className = 'shot-meta';
    var name = document.createElement('span');
    name.className = 'shot-name';
    // With more than one PDF open, "Page 1" alone would name two cards the same.
    var prefix = state.files.length > 1 ? item.source + ' · ' : '';
    name.textContent = prefix + t('pageLabel', { n: item.page }) + ' · ' + item.ext.toUpperCase();
    var sub = document.createElement('span');
    sub.className = 'shot-sub';
    sub.textContent = item.width + ' × ' + item.height + ' · ' + M.humanSize(item.bytes);
    meta.appendChild(name);
    meta.appendChild(sub);
    foot.appendChild(meta);

    var link = document.createElement('a');
    link.className = 'btn small';
    link.href = item.url;
    link.download = item.name;
    link.textContent = t('download');
    foot.appendChild(link);
    card.appendChild(foot);
    $('results').appendChild(card);
  }

  function renderResults() {
    $('results').innerHTML = '';
    state.results.forEach(addCard);
    $('empty').hidden = state.results.length > 0;
    $('dl-all').hidden = state.results.length === 0;
    updateCount();
  }

  async function convert() {
    if (state.running || !state.files.length) return;
    var total = chosenTotal();
    if (total === null) {
      showError(t('rangeBad'));
      updateNote();
      return;
    }
    if (total === 0) return;
    if (total > MAX_PAGES_PER_RUN) {
      showError(t('pagesTooMany', { n: total }));
      return;
    }

    showError('');
    clearResults();
    state.running = true;
    updateConvertButton();
    $('progress').hidden = false;
    $('bar-fill').style.width = '0%';

    var dpi = currentDpi();
    var format = currentFormat();
    var mime = M.mimeFor(format);
    var ext = M.extFor(format);
    var quality = currentQuality() / 100;
    var taken = {};
    var done = 0;
    var failed = 0;

    for (var f = 0; f < state.files.length; f++) {
      var file = state.files[f];
      var pages = pagesOf(file);
      if (!pages) continue;
      var base = M.baseName(file.name);
      for (var p = 0; p < pages.length; p++) {
        var number = pages[p];
        $('progress-text').textContent = t('converting', { n: done + 1, total: total, page: number });
        try {
          var page = await file.doc.getPage(number);
          var first = page.getViewport({ scale: 1 });
          var fit = M.renderScale(first.width, first.height, dpi);
          var viewport = page.getViewport({ scale: fit.scale });
          var canvas = document.createElement('canvas');
          canvas.width = fit.width;
          canvas.height = fit.height;
          var ctx = canvas.getContext('2d');
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, fit.width, fit.height);
          await page.render({ canvasContext: ctx, viewport: viewport }).promise;
          var blob = await canvasToBlob(canvas, mime, quality);
          canvas.width = 1;
          canvas.height = 1;
          var name = M.uniqueName(taken, M.outputName(base, number, ext));
          taken[name] = true;
          var item = {
            name: name,
            blob: blob,
            url: URL.createObjectURL(blob),
            bytes: blob.size,
            width: fit.width,
            height: fit.height,
            page: number,
            source: file.name,
            ext: ext,
            capped: fit.capped
          };
          state.results.push(item);
          addCard(item);
        } catch (error) {
          failed++;
        }
        done++;
        $('bar-fill').style.width = Math.round((done / total) * 100) + '%';
        await new Promise(function (resolve) { setTimeout(resolve, 0); });
      }
    }

    state.running = false;
    $('progress').hidden = true;
    $('empty').hidden = state.results.length > 0;
    $('dl-all').hidden = state.results.length === 0;
    updateCount();
    updateConvertButton();
    showStatus(failed ? tn('doneSome', state.results.length, { failed: failed }) : tn('imagesReady', state.results.length));
  }

  async function downloadZip() {
    if (!state.results.length) return;
    var files = [];
    for (var i = 0; i < state.results.length; i++) {
      var item = state.results[i];
      var data = new Uint8Array(await item.blob.arrayBuffer());
      files.push({ name: item.name, data: data });
    }
    var stamp = new Date();
    var bytes = M.zip(files, stamp);
    var blob = new Blob([bytes], { type: 'application/zip' });
    var url = URL.createObjectURL(blob);
    var base = state.files.length === 1 ? M.baseName(state.files[0].name) : 'pdf';
    var link = document.createElement('a');
    link.href = url;
    link.download = base + '-images.zip';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 20000);
    showStatus(tn('zipReady', files.length, { size: M.humanSize(blob.size) }));
  }

  /* --------------------------------------------------------------- locked */

  function askPassword(name) {
    return new Promise(function (resolve) {
      state.pending = { resolve: resolve };
      $('locked-warn').hidden = true;
      $('password').value = '';
      $('locked').hidden = false;
      $('password').focus();
      $('locked').setAttribute('data-file', name);
    });
  }

  function closePassword(answer) {
    $('locked').hidden = true;
    if (state.pending) {
      var resolve = state.pending.resolve;
      state.pending = null;
      resolve(answer);
    }
  }

  /* ----------------------------------------------------------------- wire */

  function wire() {
    wired = true;
    $('lang').innerHTML = '';
    [['en', 'English'], ['ro', 'Română'], ['sr-latn', 'Srpski'], ['sr-cyrl', 'Српски']].forEach(function (pair) {
      var option = document.createElement('option');
      option.value = pair[0];
      option.textContent = pair[1];
      $('lang').appendChild(option);
    });
    $('lang').addEventListener('change', function (event) {
      applyLang(event.target.value);
      saveSettings();
    });

    wireTheme();

    $('file').addEventListener('change', async function (event) {
      var files = Array.prototype.slice.call(event.target.files || []);
      for (var i = 0; i < files.length; i++) await addFile(files[i]);
      event.target.value = '';
    });

    var drop = $('drop');
    ['dragenter', 'dragover'].forEach(function (name) {
      drop.addEventListener(name, function (event) {
        event.preventDefault();
        drop.classList.add('over');
      });
    });
    ['dragleave', 'drop'].forEach(function (name) {
      drop.addEventListener(name, function (event) {
        event.preventDefault();
        drop.classList.remove('over');
      });
    });
    drop.addEventListener('drop', async function (event) {
      var files = Array.prototype.slice.call(event.dataTransfer && event.dataTransfer.files || []);
      for (var i = 0; i < files.length; i++) await addFile(files[i]);
    });

    $('btn-clear').addEventListener('click', function () {
      state.files = [];
      clearResults();
      renderFiles();
      updateNote();
      showStatus('');
      showError('');
    });

    document.querySelectorAll('input[name="range"]').forEach(function (input) {
      input.addEventListener('change', function () {
        $('range-field').hidden = rangeMode() !== 'some';
        if (rangeMode() === 'some') $('range').focus();
        updateNote();
        saveSettings();
      });
    });
    $('range').addEventListener('input', updateNote);
    $('range').addEventListener('change', saveSettings);

    document.querySelectorAll('input[name="format"]').forEach(function (input) {
      input.addEventListener('change', function () {
        $('quality-field').hidden = currentFormat() !== 'jpg';
        updateNote();
        saveSettings();
      });
    });

    $('quality').addEventListener('input', function () {
      $('quality-out').textContent = currentQuality();
      saveSettings();
    });

    document.querySelectorAll('input[name="dpi"]').forEach(function (input) {
      input.addEventListener('change', function () {
        updateNote();
        saveSettings();
      });
    });

    $('convert').addEventListener('click', convert);
    $('dl-all').addEventListener('click', downloadZip);

    $('unlock').addEventListener('click', function () { closePassword($('password').value || ''); });
    $('locked-cancel').addEventListener('click', function () { closePassword(null); });
    $('password').addEventListener('keydown', function (event) {
      if (event.key === 'Enter') closePassword($('password').value || '');
      if (event.key === 'Escape') closePassword(null);
    });
  }

  /* ----------------------------------------------------------------- boot */

  function boot() {
    loadSettings();
    wire();
    $('quality-out').textContent = currentQuality();
    $('quality-field').hidden = currentFormat() !== 'jpg';
    $('range-field').hidden = rangeMode() !== 'some';
    applyLang(detectLang());
    updateConvertButton();

    var local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
    if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__pdfImages = {
    state: state,
    convert: convert,
    addFileBytes: async function (bytes, name) {
      return addFile(new File([bytes], name, { type: 'application/pdf' }));
    }
  };
}());
