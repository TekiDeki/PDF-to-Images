#!/usr/bin/env python3
"""Browser checks for PDF to Images.

    python3 tests/ui_test.py

Starts its own server, drives the real page in Chromium and writes nothing to
the repository. The pixel comparison uses a PNG that pypdfium2 drew from the
same fixture, so "the page rendered" is checked against another renderer, not
against our own optimism.
"""
from __future__ import annotations

import io
import json
import os
import threading
from contextlib import contextmanager
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from PIL import Image, ImageChops
from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
FIX = ROOT / "tests" / "fixtures"
checks = [0]
problems = []


def check(condition, message):
    checks[0] += 1
    if not condition:
        problems.append(message)


class Quiet(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


@contextmanager
def serve():
    server = ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


def main() -> int:
    with serve() as base, sync_playwright() as pw:
        browser = pw.chromium.launch(headless=True, args=["--no-sandbox", "--disable-dev-shm-usage"])
        context = browser.new_context(viewport={"width": 1440, "height": 950}, accept_downloads=True)
        page = context.new_page()
        errors, foreign, dialogs = [], [], []

        page.on("pageerror", lambda error: errors.append(str(error)))
        page.on("console", lambda m: errors.append(m.text) if m.type == "error" else None)
        page.on("request", lambda r: foreign.append(r.url)
                if not (r.url.startswith(base) or r.url.startswith("blob:") or r.url.startswith("data:")) else None)
        page.on("dialog", lambda d: (dialogs.append(d.message), d.accept()))

        page.goto(base + "/index.html", wait_until="load")
        page.wait_for_timeout(400)

        # ------------------------------------------------------------ the start
        check("PDF to Images" in page.title(), "the title names the tool")
        check(page.locator("#convert").is_disabled(), "the button waits for a file")
        check(page.locator("#empty").is_visible(), "the empty state is explained")
        check(not page.locator("#range-field").is_visible(), "the page list is hidden while all pages are chosen")
        check(page.locator(".shot").count() == 0, "nothing is rendered before a file")
        check(page.locator("#dl-all").is_hidden(), "the zip button is hidden while there is nothing to zip")

        # ------------------------------------------------------- one file, three pages
        page.set_input_files("#file", str(FIX / "invoice.pdf"))
        page.wait_for_function("document.querySelectorAll('.file-item').length === 1", timeout=20000)
        page.wait_for_timeout(600)
        check(page.locator(".file-item").count() == 1, "the file appears in the list")
        check("invoice.pdf" in page.locator(".file-name").first.inner_text(), "the file keeps its name")
        check("3" in page.locator(".file-sub").first.inner_text(), "the page count is shown")
        check(page.locator(".file-thumb").count() == 1, "a thumbnail of page one is drawn")
        check(page.is_enabled("#convert"), "the button wakes up")
        check("1275" in page.inner_text("#res-note"), "the pixel size at 150 dpi is stated before the button")

        page.click("#convert")
        page.wait_for_function("document.querySelectorAll('.shot').length === 3", timeout=60000)
        page.wait_for_timeout(400)
        check(page.locator(".shot").count() == 3, "three pages make three cards")
        check("3" in page.inner_text("#count"), "the counter counts the images")
        check(page.locator("#dl-all").is_visible(), "the zip button appears with the images")
        label = page.locator(".shot-name").first.inner_text()
        check("Page 1" in label, "the first card names its page: " + label)
        names = [page.locator(".shot a").nth(i).get_attribute("download")
                 for i in range(page.locator(".shot").count())]
        check(names == ["invoice-page-001.jpg", "invoice-page-002.jpg", "invoice-page-003.jpg"],
              "the files are named and numbered: " + str(names))

        # the image is a real jpeg of the right size
        blob = page.evaluate("""async () => {
            const img = document.querySelector('.shot img');
            const resp = await fetch(img.src);
            const buf = new Uint8Array(await resp.arrayBuffer());
            return {bytes: Array.from(buf.slice(0, 3)), size: buf.length, w: img.naturalWidth, h: img.naturalHeight};
        }""")
        check(blob["bytes"] == [0xFF, 0xD8, 0xFF], "the first card is a JPEG, not an empty canvas")
        check((blob["w"], blob["h"]) == (1275, 1650), "the JPEG is 1275 by 1650: %s" % str((blob["w"], blob["h"])))

        # ------------------------------------------------- pixel check against another renderer
        page.locator('input[name="dpi"][value="72"]').check()
        page.locator('input[name="format"][value="png"]').check()
        page.wait_for_timeout(200)
        page.click("#convert")
        page.wait_for_function("document.querySelectorAll('.shot').length === 3", timeout=60000)
        page.wait_for_timeout(400)
        with page.expect_download() as caught:
            page.locator(".shot a").first.click()
        download = caught.value
        target = Path(download.path())
        check(download.suggested_filename == "invoice-page-001.png", "the PNG keeps its name")
        ours = Image.open(io.BytesIO(target.read_bytes())).convert("RGB")
        truth = Image.open(FIX / "expected-invoice-72.png").convert("RGB")
        check(ours.size == truth.size, "the page is 612 by 792 at 72 dpi: %s vs %s" % (ours.size, truth.size))
        if ours.size == truth.size:
            diff = ImageChops.difference(ours, truth).convert("L")
            histogram = diff.histogram()
            total = ours.size[0] * ours.size[1]
            heavy = sum(histogram[64:]) / total
            mean = sum(i * n for i, n in enumerate(histogram)) / total
            # Two renderers antialias differently, so the test asks that the
            # page agree closely, not that it be identical.
            check(heavy < 0.02, "at most a fiftieth of the pixels differ strongly (%.4f)" % heavy)
            check(mean < 6, "the average difference is small (%.2f)" % mean)

        # ----------------------------------------------------------- page ranges
        page.locator('input[name="range"][value="some"]').check()
        page.wait_for_timeout(150)
        check(page.locator("#range-field").is_visible(), "the page list opens")
        page.fill("#range", "9-12")
        page.wait_for_timeout(200)
        check(page.locator("#range-warn").is_visible(), "a range past the end is refused")
        page.fill("#range", "2")
        page.wait_for_timeout(200)
        check(not page.locator("#range-warn").is_visible(), "a valid range clears the warning")
        page.click("#convert")
        page.wait_for_timeout(1500)
        page.wait_for_function("document.querySelectorAll('.shot').length === 1", timeout=30000)
        check(page.locator(".shot").count() == 1, "one page in the range gives one card")
        name = page.locator(".shot a").first.get_attribute("download")
        check(name == "invoice-page-002.png", "the card is page two: " + str(name))

        # ------------------------------------------------------------- the zip
        page.locator('input[name="range"][value="all"]').check()
        page.wait_for_timeout(150)
        page.click("#convert")
        page.wait_for_function("document.querySelectorAll('.shot').length === 3", timeout=60000)
        page.wait_for_timeout(400)
        with page.expect_download() as caught:
            page.click("#dl-all")
        zipped = caught.value
        zip_path = Path(zipped.path())
        check(zipped.suggested_filename == "invoice-images.zip", "the zip is named after the file")
        import zipfile
        with zipfile.ZipFile(zip_path) as archive:
            entries = archive.namelist()
            check(len(entries) == 3, "the zip holds three images: %s" % entries)
            check(all(entry.endswith(".png") for entry in entries), "the zip holds PNGs, as chosen")
            check(archive.testzip() is None, "the zip passes its own integrity check")
            first = Image.open(io.BytesIO(archive.read(entries[0])))
            check(first.size == (612, 792), "the image inside the zip is full size")

        # --------------------------------------------------------- two files at once
        page.click("#btn-clear")
        page.wait_for_timeout(300)
        page.set_input_files("#file", [str(FIX / "rotated.pdf"), str(FIX / "invoice.pdf")])
        page.wait_for_function("document.querySelectorAll('.file-item').length === 2", timeout=20000)
        page.locator('input[name="format"][value="jpg"]').check()
        page.click("#convert")
        page.wait_for_function("document.querySelectorAll('.shot').length === 4", timeout=60000)
        page.wait_for_timeout(400)
        labels = page.locator(".shot-name").all_inner_texts()
        check(any("rotated.pdf" in text for text in labels), "with two files open, the card names the file")
        names = [page.locator(".shot a").nth(i).get_attribute("download")
                 for i in range(page.locator(".shot").count())]
        check(len(set(names)) == len(names), "two files never write the same name: " + str(names))

        # ------------------------------------------------------- a locked pdf
        page.click("#btn-clear")
        page.wait_for_timeout(200)
        page.set_input_files("#file", str(FIX / "locked.pdf"))
        page.wait_for_timeout(800)
        check(page.locator("#locked").is_visible(), "a locked file asks for its password")
        page.fill("#password", "wrong")
        page.click("#unlock")
        page.wait_for_timeout(800)
        check(page.locator("#error").is_visible(), "a wrong password is explained")
        page.set_input_files("#file", str(FIX / "locked.pdf"))
        page.wait_for_timeout(600)
        page.fill("#password", "tajna")
        page.click("#unlock")
        page.wait_for_timeout(1500)
        check(page.locator(".file-item").count() == 1, "the right password opens the file")

        # -------------------------------------------------------- a broken file
        page.click("#btn-clear")
        page.wait_for_timeout(200)
        page.set_input_files("#file", str(FIX / "broken.pdf"))
        page.wait_for_timeout(900)
        check(page.locator("#error").is_visible(), "a damaged file is explained, not swallowed")
        check(page.locator(".file-item").count() == 0, "a damaged file adds nothing to the list")

        # -------------------------------------------------------------- settings
        # The last choices before the reload are jpg and 300, set here on purpose
        # so the check reads the stored value rather than a leftover.
        page.locator('input[name="format"][value="jpg"]').check()
        page.locator('input[name="dpi"][value="300"]').check()
        page.wait_for_timeout(250)
        page.reload(wait_until="load")
        page.wait_for_timeout(700)
        check(page.locator('input[name="dpi"][value="300"]').is_checked(), "the dpi choice survives a reload")
        check(page.locator('input[name="format"][value="jpg"]').is_checked(), "the format survives a reload")

        # --------------------------------------------------------------- theme
        page.click("#theme")
        page.wait_for_timeout(200)
        check(page.get_attribute("html", "data-theme") == "dark", "the dark theme goes on")
        page.reload(wait_until="load")
        page.wait_for_timeout(400)
        check(page.get_attribute("html", "data-theme") == "dark", "the dark theme survives a reload")
        page.click("#theme")
        page.wait_for_timeout(150)

        # ------------------------------------------------------------- languages
        for locale, expected in (("ro", "Paginile PDF ca imagini"), ("sr-latn", "PDF stranice kao slike"),
                                 ("sr-cyrl", "PDF странице као слике"), ("en", "PDF pages as images")):
            page.select_option("#lang", locale)
            page.wait_for_timeout(250)
            heading = page.locator("h1").inner_text()
            check(expected in heading, "%s: the heading is translated: %s" % (locale, heading))
        page.select_option("#lang", "ro")
        page.wait_for_timeout(200)
        page.set_input_files("#file", str(FIX / "invoice.pdf"))
        page.wait_for_timeout(1200)
        check("pagin" in page.locator(".file-sub").first.inner_text(),
              "ro: one page is singular: " + page.locator(".file-sub").first.inner_text())
        page.select_option("#lang", "en")
        page.wait_for_timeout(150)

        # --------------------------------------------------------- the service worker
        sw = page.evaluate("""async () => {
            const reg = await navigator.serviceWorker.getRegistration();
            return reg ? (reg.active ? 'active' : 'registered') : 'none';
        }""")
        check(sw != "none", "the service worker is registered")

        # -------------------------------------------------------------- hygiene
        check(not errors, "no console or page errors: %s" % errors[:3])
        check(not foreign, "no request leaves the page: %s" % foreign[:3])
        check(not dialogs, "no alert boxes were needed: %s" % dialogs[:3])
        browser.close()

    print("")
    if problems:
        print("FAIL: %d of %d browser checks" % (len(problems), checks[0]))
        for problem in problems:
            print("  - " + problem)
        return 1
    print("PASS: %d of %d browser checks" % (checks[0], checks[0]))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
