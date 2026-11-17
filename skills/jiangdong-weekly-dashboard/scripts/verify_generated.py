"""Check that a generated week and its attachments are present in the HTML build."""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import re
from pathlib import Path

from PIL import Image


def embedded_json(html: str, script_id: str):
    pattern = rf'<script id="{re.escape(script_id)}" type="application/json">([\s\S]*?)</script>'
    match = re.search(pattern, html)
    if not match:
        raise ValueError(f"Missing embedded data: {script_id}")
    return json.loads(match.group(1))


def project_file(project: Path, relative: str) -> Path:
    if not re.fullmatch(r"assets/\d{4}-\d{2}-\d{2}/[A-Za-z0-9._-]+", relative):
        raise ValueError(f"Invalid asset path: {relative}")
    result = (project / relative).resolve()
    if not result.is_relative_to(project):
        raise ValueError(f"Asset is outside project: {relative}")
    if not result.is_file():
        raise FileNotFoundError(result)
    return result


def check(project: Path, week: str) -> dict:
    source = project / "src" / f"weekly-report-{week}.json"
    report = json.loads(source.read_text(encoding="utf-8"))
    html = (project / "周期汇报看板.html").read_text(encoding="utf-8")
    reports = embedded_json(html, "bundledWeeklyReport")
    if not isinstance(reports, list):
        reports = [reports]
    matches = [item for item in reports if item.get("dateStart") == week]
    if len(matches) != 1 or matches[0] != report:
        raise ValueError(f"Week {week} is absent or differs from the HTML build")
    file_assets = embedded_json(html, "bundledFileAssets")
    attachments: dict[str, str] = {}
    detail_count = 0
    text_only_count = 0
    pdf_count = 0
    thumbnail_count = 0
    for item in report.get("work", []):
        details = item.get("details", [])
        if len(details) != int(item.get("quantity", -1)):
            raise ValueError(f"Detail count differs from quantity: {item.get('title')}")
        linked = {asset["id"]: asset for asset in item.get("attachments", [])}
        for detail in details:
            if not str(detail.get("name", "")).strip():
                raise ValueError("Event name is empty")
            detail_count += 1
            attachment_id = detail.get("attachmentId")
            if not attachment_id:
                text_only_count += 1
                continue
            asset = linked.get(attachment_id)
            if not asset:
                raise ValueError(f"Missing attachment for {detail.get('name')}")
            relative = asset["localPath"]
            original = project_file(project, relative)
            if original.stat().st_size != asset["size"]:
                raise ValueError(f"Attachment size changed: {relative}")
            extension = original.suffix.lower()
            if extension not in {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp", ".avif", ".mp4", ".webm"}:
                encoded = file_assets.get(relative)
                if not encoded or hashlib.sha256(base64.b64decode(encoded)).digest() != hashlib.sha256(original.read_bytes()).digest():
                    raise ValueError(f"File was not correctly embedded: {relative}")
            if extension in {".pdf", ".xlsx", ".xls", ".csv", ".tsv"}:
                thumbnail = asset.get("thumbnailPath")
                if not thumbnail:
                    raise ValueError(f"Missing visible thumbnail path: {relative}")
                image_file = project_file(project, thumbnail)
                with Image.open(image_file) as image:
                    image.verify()
                if extension == ".pdf" and image_file.suffix.lower() not in {".jpg", ".jpeg"}:
                    raise ValueError(f"PDF thumbnail is not JPEG: {thumbnail}")
                thumbnail_count += 1
            if extension == ".pdf":
                pdf_count += 1
            attachments[asset["id"]] = relative
    if 'thumbnail?`<img src=' not in html:
        raise ValueError("Dashboard thumbnail renderer is missing")
    return {
        "period": week,
        "workItems": len(report.get("work", [])),
        "details": detail_count,
        "textOnlyDetails": text_only_count,
        "uniqueAttachments": len(attachments),
        "pdfDetails": pdf_count,
        "visibleThumbnails": thumbnail_count,
        "html": str(project / "周期汇报看板.html"),
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--week", required=True)
    arguments = parser.parse_args()
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", arguments.week):
        raise ValueError("--week must be YYYY-MM-DD")
    print(json.dumps(check(arguments.project.resolve(strict=True), arguments.week), ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
