"""Build the 2026-11-09 report and copy model-matched local assets.

This reads the source workbook. It never writes to the workbook or shared drive.
"""

from __future__ import annotations

import json
import mimetypes
import re
import shutil
from datetime import datetime
from pathlib import Path

from openpyxl import load_workbook
from PIL import Image


PROJECT = Path(__file__).resolve().parents[1]
SOURCE = PROJECT / "source" / "工作周报-江东.xlsx"
ASSET_DIR = PROJECT / "assets" / "2026-11-09"
REPORT_FILE = PROJECT / "src" / "weekly-report-2026-11-09.json"
MANIFEST_FILE = ASSET_DIR / "manifest.json"
WEEK_START = datetime(2026, 11, 9)
WEEK_END = datetime(2026, 11, 15, 23, 59, 59)


def images(folder: Path) -> list[Path]:
    return sorted(
        (p for p in folder.iterdir() if p.is_file() and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}),
        key=lambda p: p.name.casefold(),
    ) if folder.is_dir() else []


def model_directory(code: str, roots: list[Path]) -> Path:
    matches = [p for root in roots for p in root.iterdir() if p.is_dir() and re.match(rf"^{re.escape(code)}(?=$|[\s_-])", p.name)]
    if len(matches) != 1:
        raise ValueError(f"Expected one folder for {code}, got {matches}")
    return matches[0]


def scene_image(folder: Path) -> Path:
    candidates = images(folder / "场景图")
    if not candidates:
        candidates = [p for p in folder.rglob("*") if p.is_file() and "场景" in str(p.parent) and p.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp"}]
    if not candidates:
        raise FileNotFoundError(f"No scene image in {folder}")
    def is_opaque(path: Path) -> bool:
        with Image.open(path) as image:
            return "A" not in image.getbands() or image.getchannel("A").getextrema()[0] >= 250
    candidates = [p for p in candidates if is_opaque(p)]
    if not candidates:
        raise FileNotFoundError(f"No scene image with a background in {folder}")
    full_scene = [p for p in candidates if not re.search(r"特写|局部|钥匙|白底|抠图|尺寸|面料|色卡|顶视|close.?up", p.name, re.I)]
    candidates = full_scene or candidates
    eye_level = [p for p in candidates if "平视" in p.name]
    candidates = eye_level or candidates
    past = [p for p in candidates if datetime.fromtimestamp(p.stat().st_mtime) <= WEEK_END]
    candidates = past or candidates
    week = [p for p in candidates if WEEK_START <= datetime.fromtimestamp(p.stat().st_mtime) <= WEEK_END]
    candidates = week or candidates
    # Prefer a large original scene image over thumbnails when dates tie.
    return max(candidates, key=lambda p: (p.stat().st_mtime, p.stat().st_size))


def copy_asset(source: Path, key: str, manifest: list[dict]) -> dict:
    extension = source.suffix.lower()
    destination = ASSET_DIR / f"{key}{extension}"
    shutil.copy2(source, destination)
    mime = mimetypes.guess_type(destination.name)[0] or "application/octet-stream"
    dimensions = None
    if mime.startswith("image/"):
        with Image.open(destination) as image:
            dimensions = list(image.size)
            if min(dimensions) < 800:
                raise ValueError(f"Scene image is too small: {source} {dimensions}")
    manifest.append({"key": key, "source": str(source), "asset": str(destination.relative_to(PROJECT)).replace("\\", "/"), "size": destination.stat().st_size, "dimensions": dimensions})
    return {"id": f"week-2026-11-09-{key}", "name": destination.name, "type": mime, "size": destination.stat().st_size, "url": "", "localPath": str(destination.relative_to(PROJECT)).replace("\\", "/")}


def detail(name: str, asset: dict, index: int) -> dict:
    return {"id": f"2026-11-09-detail-{index:02d}", "name": name, "url": "", "attachmentId": asset["id"]}


def work_item(text: str, quantity: int, unit: str, category: str, details: list[dict], assets: list[dict]) -> dict:
    title = text.split("：", 1)[0].split(":", 1)[0].strip()
    return {
        "title": title,
        "category": category,
        "status": "done",
        "progress": 100,
        "quantity": quantity,
        "quantityUnit": unit,
        "completedDate": "2026-11-15",
        "owner": "江东",
        "note": text,
        "detailsIntegrated": True,
        "details": details,
        "attachments": list({asset["id"]: asset for asset in assets}.values()),
    }


def main() -> None:
    workbook = load_workbook(SOURCE, read_only=False, data_only=False)
    sheet = workbook["工作周报"]
    if sheet["A89"].value != "11/9-11/15":
        raise ValueError("The selected week is not at row 89")
    rows = {number: {"text": str(sheet[f"B{number}"].value), "quantity": int(sheet[f"C{number}"].value), "unit": str(sheet[f"D{number}"].value), "root": Path(str(sheet[f"F{number}"].value))} for number in range(89, 94)}
    if [(rows[r]["quantity"], rows[r]["unit"]) for r in range(89, 94)] != [(8, "套"), (10, "条"), (12, "条"), (1, "条"), (2, "套")]:
        raise ValueError("The source counts have changed; review before rebuilding")
    ASSET_DIR.mkdir(parents=True, exist_ok=True)
    manifest: list[dict] = []
    assets: dict[str, dict] = {}

    blogger_root = rows[89]["root"]
    blogger_folders = []
    for folder in blogger_root.iterdir():
        if not folder.is_dir():
            continue
        match = re.match(r"^(\d{2})-", folder.name)
        if not match:
            continue
        if WEEK_START <= datetime.fromtimestamp(folder.stat().st_mtime) <= WEEK_END:
            numbered = [p for p in images(folder / "场景") if re.fullmatch(r"\d+\.jpg", p.name)]
            scene_files = images(folder / "场景")
            if not scene_files:
                raise FileNotFoundError(f"No blogger scene image in {folder}")
            final = numbered[0] if numbered else max(scene_files, key=lambda p: p.stat().st_mtime)
            blogger_folders.append((int(match.group(1)), folder, final))
    blogger_folders.sort()
    if len(blogger_folders) != 8:
        raise ValueError(f"Expected 8 in-week blogger sets, found {len(blogger_folders)}")
    blogger_details = []
    for number, folder, final in blogger_folders:
        asset = copy_asset(final, f"blogger-{number:02d}", manifest)
        assets[asset["id"]] = asset
        model = re.search(r"(SFT\d{3}\+SFD\d{3}\+BJ\d{3})", folder.name)
        name = f"第{number:02d}套 · {model.group(1).replace('+', ' + ') if model else folder.name}"
        blogger_details.append(detail(name, asset, len(blogger_details) + 1))

    sofa_root = rows[90]["root"]
    chair_root = rows[93]["root"]
    model_roots = [sofa_root, chair_root]
    model_names: dict[str, str] = {}
    def model_asset(code: str) -> dict:
        if code not in assets:
            folder = model_directory(code, model_roots)
            model_names[code] = folder.name.split("-", 1)[-1].lstrip(" -_")
            assets[code] = copy_asset(scene_image(folder), code, manifest)
        return assets[code]

    codes_90 = re.findall(r"SFT\d{3}", rows[90]["text"])
    if len(codes_90) != 10 or len(set(codes_90)) != 10:
        raise ValueError("Row 90 model list does not match 10 records")
    details_90 = [detail(f"{code} · {model_names.get(code) or model_directory(code, model_roots).name.split('-', 1)[-1]}", model_asset(code), 9 + index) for index, code in enumerate(codes_90)]

    codes_91 = re.findall(r"(?:SFT|SFD)\d{3}", rows[91]["text"])
    if len(codes_91) != 12 or codes_91.count("SFT009") != 2:
        raise ValueError("Row 91 should have 12 model references including SFT009 twice")
    details_91 = []
    seen_009 = 0
    for index, code in enumerate(codes_91):
        label = f"{code} · {model_directory(code, model_roots).name.split('-', 1)[-1]}"
        if code == "SFT009":
            seen_009 += 1
            label += " · 新增主图" if seen_009 == 1 else " · 增加尺寸图"
        else:
            label += " · 增加尺寸图"
        details_91.append(detail(label, model_asset(code), 19 + index))

    pdf_files = sorted(p for p in rows[92]["root"].iterdir() if p.is_file() and p.suffix.lower() == ".pdf")
    if len(pdf_files) != 1:
        raise ValueError(f"Expected one PDF color card file, found {pdf_files}")
    color_asset = copy_asset(pdf_files[0], "color-card-print", manifest)
    details_92 = [detail("色卡打印文件", color_asset, 31)]

    codes_93 = re.findall(r"SFD\d{3}", rows[93]["text"])
    if codes_93 != ["SFD012", "SFD013"]:
        raise ValueError("Row 93 new-product model list changed")
    details_93 = [detail(f"{code} · {model_directory(code, model_roots).name.split('-', 1)[-1]}", model_asset(code), 32 + index) for index, code in enumerate(codes_93)]

    work = [
        work_item(rows[89]["text"], 8, "套", "博主图", blogger_details, [assets[d["attachmentId"]] for d in blogger_details]),
        work_item(rows[90]["text"], 10, "条", "详情页", details_90, [assets[code] for code in codes_90]),
        work_item(rows[91]["text"], 12, "条", "主图", details_91, [assets[code] for code in codes_91]),
        work_item(rows[92]["text"], 1, "条", "品牌物料", details_92, [color_asset]),
        work_item(rows[93]["text"], 2, "套", "独立站新品", details_93, [assets[code] for code in codes_93]),
    ]
    if sum(len(item["details"]) for item in work) != 33:
        raise ValueError("Detail count does not reconcile to workbook")
    report = {
        "demo": False,
        "dateStart": "2026-11-09",
        "dateEnd": "2026-11-15",
        "title": "第 46 周 · 工作进展",
        "team": "外贸部 · AI 视觉设计",
        "owner": "江东",
        "summary": "本周完成博主图生成、详情页首屏新增与上架、主图新增与上架、色卡打印文件修改，以及 SFD012、SFD013 两款独立站新品设计与上架。各型号的场景图和色卡 PDF 已关联到事项明细。",
        "conclusion": "完成 10 套视觉成果和 23 条上架、主图及文件工作记录；SFD012、SFD013 已完成新品设计与上架。",
        "metrics": [
            {"label": "成果数量", "value": "33", "unit": "项", "note": "10 套视觉成果 + 23 条工作记录"},
            {"label": "事项完成率", "value": "100", "unit": "%", "note": "原表本周 5 类事项均有完成数量"},
            {"label": "工作类别", "value": "5", "unit": "个", "note": "博主图、详情页、主图、色卡、新品"},
            {"label": "待协调事项", "value": "0", "unit": "项", "note": "原表本周未填写风险或待协调事项"},
        ],
        "trendMode": "manual",
        "trendKind": "categories",
        "trend": [
            {"label": "博主图·套", "value": 8},
            {"label": "详情页·条", "value": 10},
            {"label": "主图·条", "value": 12},
            {"label": "色卡·条", "value": 1},
            {"label": "新品·套", "value": 2},
        ],
        "work": work,
        "highlights": [
            "完成 SFD012、SFD013 两款新品的产品、场景、主图与上架工作。",
            "按型号关联场景原图，逐条明细可查看缩略图和完整图片。",
        ],
        "plans": [],
        "risks": [],
        "updatedAt": None,
    }
    REPORT_FILE.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    MANIFEST_FILE.write_text(json.dumps({"sourceWorkbook": str(SOURCE), "sourceRange": "工作周报!A89:F93", "assets": manifest}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    expected = {Path(item["asset"]).name for item in manifest} | {MANIFEST_FILE.name}
    for stale in ASSET_DIR.iterdir():
        if stale.is_file() and stale.name not in expected:
            stale.unlink()
    print(json.dumps({"report": str(REPORT_FILE), "assets": len(manifest), "totalBytes": sum(item["size"] for item in manifest), "details": [len(item["details"]) for item in work]}, ensure_ascii=True))


if __name__ == "__main__":
    main()
