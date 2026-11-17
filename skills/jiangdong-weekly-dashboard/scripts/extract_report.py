"""Extract source evidence for a Jiangdong weekly dashboard draft.

This is a read-only extraction step. The agent reviews the JSON before creating
work items; images and scanned PDF pages are returned for visual reading.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import shutil
import ssl
import subprocess
import tempfile
import zipfile
from html.parser import HTMLParser
from pathlib import Path
from urllib.parse import urljoin, urlparse
from urllib.error import URLError
from urllib.request import Request, urlopen


class ReportHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.tables: list[list[list[str]]] = []
        self.images: list[dict[str, str]] = []
        self.skipped = ""
        self.table: list[list[str]] | None = None
        self.row: list[str] | None = None
        self.cell: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.skipped:
            return
        if tag in {"script", "style", "noscript", "svg"}:
            self.skipped = tag
            return
        if tag in {"p", "div", "br", "li", "tr", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")
        if tag == "table":
            self.table = []
        elif tag == "tr" and self.table is not None:
            self.row = []
        elif tag in {"td", "th"} and self.row is not None:
            self.cell = []
        elif tag == "img":
            values = dict(attrs)
            src = values.get("src") or ""
            alt = values.get("alt") or ""
            self.images.append({"src": src, "alt": alt})
            if alt:
                self.parts.append(alt)

    def handle_endtag(self, tag: str) -> None:
        if self.skipped:
            if tag == self.skipped:
                self.skipped = ""
            return
        if tag in {"td", "th"} and self.cell is not None and self.row is not None:
            self.row.append(" ".join(" ".join(self.cell).split()))
            self.cell = None
        elif tag == "tr" and self.row is not None and self.table is not None:
            if any(self.row):
                self.table.append(self.row)
            self.row = None
        elif tag == "table" and self.table is not None:
            if self.table:
                self.tables.append(self.table)
            self.table = None
        if tag in {"p", "div", "li", "tr", "section", "article", "h1", "h2", "h3", "h4", "h5", "h6"}:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.skipped and data.strip():
            value = " ".join(data.split())
            self.parts.append(value)
            if self.cell is not None:
                self.cell.append(value)


def extract_html_markup(markup: str, base: str = "") -> dict:
    parser = ReportHtmlParser()
    parser.feed(markup)
    text = "".join(part if part == "\n" else f" {part}" for part in parser.parts)
    text = re.sub(r" *\n *", "\n", text).strip()
    images = [{**image, "resolved": urljoin(base, image["src"]) if base and image["src"] else image["src"]} for image in parser.images]
    return {"kind": "html", "text": text[:300000], "tables": parser.tables[:200], "images": images[:500]}


def extract_url(source: str, output: Path) -> dict:
    parsed = urlparse(source)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise ValueError("Web link must start with http:// or https://")
    request = Request(source, headers={"User-Agent": "Mozilla/5.0 JiangdongWeeklyReport/1.0"})
    try:
        with urlopen(request, timeout=20) as response:
            final_url = response.geturl()
            media_type = response.headers.get_content_type()
            encoding = response.headers.get_content_charset()
            payload = response.read(5_000_001)
    except URLError as error:
        if not isinstance(error.reason, ssl.SSLCertVerificationError) or not shutil.which("curl"):
            raise
        with tempfile.NamedTemporaryFile(prefix="jiangdong-web-", suffix=".tmp", dir=output.parent, delete=False) as temporary:
            temporary_path = Path(temporary.name)
        try:
            result = subprocess.run(
                [shutil.which("curl"), "--location", "--fail", "--silent", "--show-error", "--max-time", "20", "--max-filesize", "5000000", "--output", str(temporary_path), "--write-out", "%{url_effective}\n%{content_type}", source],
                check=True, capture_output=True, text=True,
            )
            lines = result.stdout.splitlines()
            final_url = lines[-2]
            content_type = lines[-1]
            media_type = content_type.split(";", 1)[0].strip().lower()
            charset = re.search(r"charset=([^;\s]+)", content_type, re.I)
            encoding = charset.group(1).strip('"') if charset else None
            payload = temporary_path.read_bytes()
        finally:
            temporary_path.unlink(missing_ok=True)
    if len(payload) > 5_000_000:
        raise ValueError("Web page is larger than the 5 MB extraction limit")
    suffix = Path(urlparse(final_url).path).suffix.lower()
    if media_type == "application/pdf" or suffix == ".pdf" or payload.startswith(b"%PDF"):
        suffix = ".pdf"
    elif media_type == "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
        suffix = ".xlsx"
    elif media_type == "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        suffix = ".docx"
    elif media_type.startswith("image/"):
        suffix = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/bmp": ".bmp", "image/tiff": ".tiff"}.get(media_type, suffix)
    if suffix in {".pdf", ".xlsx", ".docx", ".csv", ".tsv", ".txt", ".md", ".markdown", ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}:
        temporary = output.parent / f"{output.stem}-download{suffix}"
        temporary.write_bytes(payload)
        content = extract(temporary, output)["content"]
    elif media_type in {"text/html", "application/xhtml+xml", "text/plain"} or suffix in {".html", ".htm"}:
        if encoding:
            markup = payload.decode(encoding, errors="replace")
        else:
            try:
                markup = payload.decode("utf-8")
            except UnicodeDecodeError:
                markup = payload.decode("gb18030", errors="replace")
        content = extract_html_markup(markup, final_url) if media_type != "text/plain" or suffix in {".html", ".htm"} else {"kind": "text", "text": markup}
    else:
        raise ValueError(f"Web link returned unsupported content type: {media_type}")
    return {"source": source, "resolvedUrl": final_url, "content": content}


def extract_xlsx(source: Path) -> dict:
    from openpyxl import load_workbook

    workbook = load_workbook(source, read_only=True, data_only=False)
    sheets = []
    for sheet in workbook:
        rows = []
        active_period = ""
        for row in sheet.iter_rows():
            values = [cell.value for cell in row]
            while values and values[-1] is None:
                values.pop()
            if not any(value is not None and str(value).strip() for value in values):
                continue
            first = str(values[0] or "").strip()
            if re.search(r"\d{1,4}[/-]\d{1,2}.*\d{1,2}", first):
                active_period = first
            rows.append({
                "row": row[0].row,
                "period": active_period,
                "cells": [str(value).strip() if value is not None else "" for value in values],
            })
        sheets.append({"name": sheet.title, "rows": rows})
    return {"kind": "spreadsheet", "sheets": sheets}


def extract_delimited(source: Path, delimiter: str) -> dict:
    with source.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
        rows = list(csv.reader(handle, delimiter=delimiter))
    return {"kind": "table", "rows": [{"row": index + 1, "cells": row} for index, row in enumerate(rows)]}


def extract_docx(source: Path, output: Path) -> dict:
    from docx import Document

    document = Document(source)
    paragraphs = [paragraph.text.strip() for paragraph in document.paragraphs if paragraph.text.strip()]
    tables = [[[cell.text.strip() for cell in row.cells] for row in table.rows] for table in document.tables]
    result = {"kind": "document", "paragraphs": paragraphs, "tables": tables}
    with zipfile.ZipFile(source) as archive:
        images = [name for name in archive.namelist() if name.startswith("word/media/") and name.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"))]
        if images:
            media_dir = output.parent / f"{output.stem}-media"
            media_dir.mkdir(parents=True, exist_ok=True)
            visual = []
            for index, name in enumerate(images, 1):
                destination = media_dir / f"image-{index:03d}{Path(name).suffix.lower()}"
                destination.write_bytes(archive.read(name))
                visual.append(str(destination))
            result["visualReview"] = visual
    return result


def extract_pdf(source: Path, output: Path) -> dict:
    from pypdf import PdfReader

    reader = PdfReader(source)
    pages = [{"page": index + 1, "text": (page.extract_text() or "").strip()} for index, page in enumerate(reader.pages)]
    result = {"kind": "pdf", "pages": pages}
    if sum(len(page["text"]) for page in pages) < 40:
        renderer = shutil.which("pdftoppm")
        if not renderer:
            bundled = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/Library/bin/pdftoppm.exe"
            renderer = str(bundled) if bundled.is_file() else None
        if renderer:
            render_dir = output.parent / f"{output.stem}-pages"
            render_dir.mkdir(parents=True, exist_ok=True)
            prefix = render_dir / "page"
            subprocess.run([renderer, "-f", "1", "-l", str(len(pages)), "-scale-to", "1700", "-png", str(source), str(prefix)], check=True, capture_output=True)
            result["visualReview"] = [str(path) for path in sorted(render_dir.glob("page-*.png"))]
        else:
            result["visualReview"] = [str(source)]
    return result


def extract(source: Path, output: Path) -> dict:
    extension = source.suffix.lower()
    if extension == ".xlsx":
        content = extract_xlsx(source)
    elif extension in {".csv", ".tsv"}:
        content = extract_delimited(source, "\t" if extension == ".tsv" else ",")
    elif extension == ".docx":
        content = extract_docx(source, output)
    elif extension in {".html", ".htm"}:
        payload = source.read_bytes()
        try:
            markup = payload.decode("utf-8-sig")
        except UnicodeDecodeError:
            markup = payload.decode("gb18030", errors="replace")
        content = extract_html_markup(markup, source.as_uri())
        visual = []
        for image in content["images"]:
            parsed = urlparse(image["src"])
            if parsed.scheme or parsed.netloc or not parsed.path.lower().endswith((".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff")):
                continue
            candidate = (source.parent / parsed.path).resolve()
            if candidate.is_file():
                visual.append(str(candidate))
        if visual:
            content["visualReview"] = visual
    elif extension == ".pdf":
        content = extract_pdf(source, output)
    elif extension in {".txt", ".md", ".markdown"}:
        content = {"kind": "text", "text": source.read_text(encoding="utf-8-sig", errors="replace")}
    elif extension in {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}:
        content = {"kind": "image", "visualReview": [str(source)]}
    else:
        raise ValueError(f"Unsupported input format: {extension}. Convert old .doc/.xls files to .docx/.xlsx first.")
    return {"source": str(source), "content": content}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("source")
    parser.add_argument("--output", required=True, type=Path)
    arguments = parser.parse_args()
    output = arguments.output.resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    if arguments.source.startswith(("http://", "https://")):
        data = extract_url(arguments.source, output)
    else:
        source = Path(arguments.source).resolve(strict=True)
        data = extract(source, output)
    output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"output": str(output), "kind": data["content"]["kind"], "visualReview": data["content"].get("visualReview", [])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
