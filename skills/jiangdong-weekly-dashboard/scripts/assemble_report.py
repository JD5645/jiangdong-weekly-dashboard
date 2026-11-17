"""Resolve reviewed work items and local files into a Jiangdong HTML report.

The input is a human/agent-reviewed JSON draft; extraction and interpretation
remain separate so a guessed model or file is never silently attached.
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import json
import mimetypes
import re
import shutil
import subprocess
from datetime import date, datetime, timedelta
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont


SUPPORTED = {".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp", ".pdf", ".xlsx", ".xls", ".csv", ".tsv", ".docx", ".txt", ".md", ".mp4", ".webm"}
MODEL_CODE = re.compile(r"(?:SFT|SFD|BJ|MC)\d{3,5}", re.I)


def path_from(value: str, base: Path) -> Path:
    path = Path(str(value))
    return (path if path.is_absolute() else base / path).resolve(strict=True)


def candidate_files(folder: Path) -> list[Path]:
    if not folder.is_dir():
        return []
    return [path for path in folder.rglob("*") if path.is_file() and path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}]


def choose_scene(folder: Path, end: date) -> Path:
    candidates = [path for path in candidate_files(folder) if "场景" in str(path.parent)]
    if not candidates:
        raise ValueError(f"No scene image found in {folder}")
    def usable(path: Path) -> bool:
        with Image.open(path) as image:
            width, height = image.size
            return min(width, height) >= 800 and ("A" not in image.getbands() or image.getchannel("A").getextrema()[0] >= 250)
    candidates = [path for path in candidates if usable(path)]
    if not candidates:
        raise ValueError(f"No large scene image with a background in {folder}")
    preferred = [path for path in candidates if not re.search(r"特写|局部|钥匙|白底|尺寸|面料|色卡|顶视|close.?up", path.name, re.I)]
    candidates = preferred or candidates
    dated = [path for path in candidates if datetime.fromtimestamp(path.stat().st_mtime).date() <= end]
    candidates = dated or candidates
    eye_level = [path for path in candidates if "平视" in path.name]
    candidates = eye_level or candidates
    return max(candidates, key=lambda path: (path.stat().st_mtime, path.stat().st_size))


def resolve_model(code: str, root: Path, end: date) -> Path:
    if not root.is_dir():
        raise ValueError(f"Model root is not a folder: {root}")
    matches = [path for path in root.iterdir() if path.is_dir() and re.match(rf"^{re.escape(code)}(?=$|[\s_-])", path.name, re.I)]
    if len(matches) != 1:
        raise ValueError(f"Expected one folder for {code} in {root}, found {len(matches)}")
    return choose_scene(matches[0], end)


def renderer_path() -> str | None:
    found = shutil.which("pdftoppm")
    if found:
        return found
    bundled = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/native/poppler/Library/bin/pdftoppm.exe"
    return str(bundled) if bundled.is_file() else None


def font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in [Path(r"C:\Windows\Fonts\msyh.ttc"), Path(r"C:\Windows\Fonts\simhei.ttf"), Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf")]:
        if candidate.is_file():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def table_rows(path: Path) -> list[list[str]]:
    if path.suffix.lower() == ".xlsx":
        from openpyxl import load_workbook
        sheet = load_workbook(path, read_only=True, data_only=True).worksheets[0]
        return [[str(cell.value or "")[:22] for cell in row[:4]] for row in list(sheet.iter_rows(max_row=7))]
    if path.suffix.lower() in {".csv", ".tsv"}:
        with path.open("r", encoding="utf-8-sig", errors="replace", newline="") as handle:
            return [[cell[:22] for cell in row[:4]] for _, row in zip(range(7), csv.reader(handle, delimiter="\t" if path.suffix.lower() == ".tsv" else ","))]
    return [[path.name, "表格文件"]]


def draw_thumbnail(path: Path, destination: Path) -> None:
    extension = path.suffix.lower()
    if extension == ".pdf":
        renderer = renderer_path()
        if not renderer:
            raise RuntimeError("PDF first-page thumbnail requires pdftoppm")
        prefix = destination.with_suffix("")
        subprocess.run([renderer, "-f", "1", "-singlefile", "-scale-to", "500", "-jpeg", str(path), str(prefix)], check=True, capture_output=True)
        if not destination.is_file() or destination.stat().st_size == 0:
            raise RuntimeError(f"PDF thumbnail was not created: {destination}")
        return
    image = Image.new("RGB", (460, 320), "#f6f5f2")
    draw = ImageDraw.Draw(image)
    draw.rectangle((0, 0, 460, 50), fill="#b52532")
    label = "表格预览" if extension in {".xlsx", ".xls", ".csv", ".tsv"} else "文件预览"
    draw.text((18, 10), label, fill="white", font=font(24))
    if extension in {".xlsx", ".xls", ".csv", ".tsv"}:
        for row_number, row in enumerate(table_rows(path)):
            y = 60 + row_number * 36
            if y > 285:
                break
            draw.rectangle((12, y, 448, y + 34), outline="#d5d2cc", fill="#ffffff" if row_number % 2 == 0 else "#eeeeea")
            for column, value in enumerate(row):
                draw.text((20 + column * 106, y + 6), value, fill="#27272a", font=font(14))
    else:
        draw.text((18, 78), path.name[:30], fill="#27272a", font=font(17))
    image.save(destination, "JPEG", quality=88)


def build(draft: dict, project: Path, base: Path, dry_run: bool, replace: bool) -> dict:
    start = date.fromisoformat(draft["weekStart"])
    if start.weekday() != 0:
        raise ValueError("weekStart must be a Monday in YYYY-MM-DD format")
    end = start + timedelta(days=6)
    if not isinstance(draft.get("work"), list) or not draft["work"]:
        raise ValueError("Draft needs a nonempty work list")
    target = project / "src" / f"weekly-report-{start.isoformat()}.json"
    if target.exists() and not replace and not dry_run:
        raise FileExistsError(f"Report already exists: {target}. Review it before using --replace.")
    assets_dir = project / "assets" / start.isoformat()
    asset_map: dict[Path, dict] = {}
    chosen: list[dict] = []
    unmatched: list[dict] = []
    work = []
    for work_index, source_item in enumerate(draft["work"], 1):
        text = str(source_item.get("sourceText") or source_item.get("title") or "").strip()
        title = str(source_item.get("title") or text.split("：", 1)[0].split(":", 1)[0]).strip()
        quantity = int(source_item.get("quantity", 0))
        unit = str(source_item.get("unit", "条")).strip()
        if not title or quantity < 1:
            raise ValueError(f"Work item {work_index} needs title and positive quantity")
        details = source_item.get("details")
        if details is None:
            codes = MODEL_CODE.findall(text)
            if len(codes) != quantity:
                raise ValueError(f"Work item {work_index}: {quantity} records, but {len(codes)} model codes. Provide explicit details.")
            details = [{"name": code.upper(), "model": code.upper()} for code in codes]
        if len(details) != quantity:
            raise ValueError(f"Work item {work_index}: quantity {quantity} differs from {len(details)} details")
        linked = []
        attachments = []
        for detail_index, item in enumerate(details, 1):
            name = str(item.get("name") or item.get("model") or "").strip()
            if not name:
                raise ValueError(f"Work item {work_index}, detail {detail_index}: event name is missing")
            selected: Path | None = None
            reason = ""
            try:
                if item.get("file"):
                    selected = path_from(item["file"], base)
                    if selected.is_dir():
                        selected = choose_scene(selected, end)
                elif item.get("model"):
                    root_value = item.get("sourcePath") or source_item.get("sourcePath")
                    if not root_value:
                        reason = "未提供型号图片目录"
                    else:
                        selected = resolve_model(str(item["model"]).upper(), path_from(root_value, base), end)
                else:
                    reason = "未提供对应附件路径"
            except FileNotFoundError:
                reason = "附件或型号目录路径不存在"
            except (OSError, ValueError) as error:
                reason = str(error)
            attachment_id = ""
            if selected is not None:
                if selected.suffix.lower() not in SUPPORTED:
                    raise ValueError(f"Unsupported attachment: {selected}")
                if selected not in asset_map:
                    digest = hashlib.sha256(str(selected).encode("utf-8")).hexdigest()[:10]
                    filename = f"asset-{len(asset_map)+1:03d}-{digest}{selected.suffix.lower()}"
                    relative = f"assets/{start.isoformat()}/{filename}"
                    asset_map[selected] = {"id": f"week-{start.isoformat()}-{digest}", "name": selected.name, "type": mimetypes.guess_type(selected.name)[0] or "application/octet-stream", "size": selected.stat().st_size, "url": "", "localPath": relative}
                    if selected.suffix.lower() in {".pdf", ".xlsx", ".xls", ".csv", ".tsv"}:
                        asset_map[selected]["thumbnailPath"] = f"assets/{start.isoformat()}/thumb-{digest}.jpg"
                attachment = asset_map[selected]
                attachment_id = attachment["id"]
                if attachment_id not in {asset["id"] for asset in attachments}:
                    attachments.append(attachment)
                chosen.append({"work": title, "event": name, "source": str(selected), "asset": attachment["localPath"]})
            else:
                unmatched.append({"work": title, "event": name, "model": str(item.get("model") or ""), "requestedFile": str(item.get("file") or ""), "sourcePath": str(item.get("sourcePath") or source_item.get("sourcePath") or ""), "reason": reason})
            linked.append({"id": f"{start.isoformat()}-{work_index:02d}-{detail_index:02d}", "name": name[:160], "url": str(item.get("url", ""))[:1000], "attachmentId": attachment_id})
        status = source_item.get("status", "done")
        if status not in {"done", "doing", "todo"}:
            raise ValueError(f"Invalid status for {title}: {status}")
        progress = max(0, min(100, int(source_item.get("progress", 100 if status == "done" else 0))))
        work.append({"title": title[:160], "category": str(source_item.get("category") or title)[:80], "status": status, "progress": progress, "quantity": quantity, "quantityUnit": unit[:12], "completedDate": end.isoformat() if status == "done" else "", "owner": str(source_item.get("owner") or draft.get("owner") or "")[:80], "note": text[:240], "detailsIntegrated": True, "details": linked, "attachments": attachments})
    report = {"demo": False, "dateStart": start.isoformat(), "dateEnd": end.isoformat(), "title": str(draft.get("title") or f"第 {start.isocalendar().week} 周 · 工作进展")[:160], "team": str(draft.get("team", ""))[:100], "owner": str(draft.get("owner", ""))[:100], "summary": str(draft.get("summary") or "；".join(f"{item['title']} {item['quantity']}{item['quantityUnit']}" for item in work))[:2000], "conclusion": str(draft.get("conclusion", ""))[:800], "metrics": [{"label": "成果数量", "value": "0", "unit": "项", "note": "含不同单位，请查看事项明细"}, {"label": "事项完成率", "value": "0", "unit": "%", "note": "依据事项状态与进度"}, {"label": "工作类别", "value": "0", "unit": "个", "note": "本期事项类别"}, {"label": "待协调事项", "value": "0", "unit": "项", "note": "依据风险与协同条目"}], "trendMode": "manual", "trendKind": "categories", "trend": [{"label": f"{item['category']}·{item['quantityUnit']}", "value": item["quantity"]} for item in work[:16]], "work": work, "highlights": draft.get("highlights", []), "plans": draft.get("plans", []), "risks": draft.get("risks", []), "updatedAt": None}
    if not dry_run:
        assets_dir.mkdir(parents=True, exist_ok=True)
        for selected, attachment in asset_map.items():
            destination = project / attachment["localPath"]
            if destination.exists() and hashlib.sha256(destination.read_bytes()).digest() != hashlib.sha256(selected.read_bytes()).digest():
                raise FileExistsError(f"Asset path collision: {destination}")
            if not destination.exists():
                shutil.copy2(selected, destination)
            if attachment.get("thumbnailPath"):
                thumbnail = project / attachment["thumbnailPath"]
                if not thumbnail.exists():
                    draw_thumbnail(selected, thumbnail)
        target.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        backup = project / f"周报-{start.isoformat()}-可导入.json"
        backup.write_text(json.dumps({"format": "mailuo-report-v1", "mode": "week", "period": start.isoformat(), "report": report, "attachmentFiles": []}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        (assets_dir / "manifest.json").write_text(json.dumps({"sourceReport": str(draft.get("sourceReport", "")), "week": start.isoformat(), "matches": chosen, "unmatched": unmatched}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return {"period": start.isoformat(), "workItems": len(work), "details": sum(len(item["details"]) for item in work), "uniqueAttachments": len(asset_map), "textOnlyDetails": len(unmatched), "report": str(target), "dryRun": dry_run, "matches": chosen, "unmatched": unmatched}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("draft", type=Path)
    parser.add_argument("--project", required=True, type=Path)
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--replace", action="store_true")
    arguments = parser.parse_args()
    draft_path = arguments.draft.resolve(strict=True)
    project = arguments.project.resolve(strict=True)
    result = build(json.loads(draft_path.read_text(encoding="utf-8")), project, draft_path.parent, arguments.dry_run, arguments.replace)
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
