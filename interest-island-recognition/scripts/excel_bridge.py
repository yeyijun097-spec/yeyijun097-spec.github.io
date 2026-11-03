#!/usr/bin/env python3
import argparse
import json
import posixpath
import re
import shutil
import tempfile
import zipfile
from pathlib import Path
import xml.etree.ElementTree as ET

NS = {
    "a": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
}
REL_NS = {"rel": "http://schemas.openxmlformats.org/package/2006/relationships"}
MAIN_NS = NS["a"]

ET.register_namespace("", MAIN_NS)
ET.register_namespace("r", NS["r"])


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)

    read = sub.add_parser("read")
    read.add_argument("--workbook", required=True)
    read.add_argument("--target-sheet", required=True)
    read.add_argument("--rules-sheet", required=True)

    write = sub.add_parser("write")
    write.add_argument("--workbook", required=True)
    write.add_argument("--target-sheet", required=True)
    write.add_argument("--output", required=True)
    write.add_argument("--updates-json", required=True)

    args = parser.parse_args()
    if args.command == "read":
        print(json.dumps(read_workbook(args.workbook, args.target_sheet, args.rules_sheet), ensure_ascii=False))
    else:
        updates = json.loads(args.updates_json)
        print(json.dumps(write_workbook(args.workbook, args.target_sheet, args.output, updates), ensure_ascii=False))


def read_workbook(workbook, target_sheet, rules_sheet):
    with zipfile.ZipFile(workbook) as z:
        shared = read_shared_strings(z)
        sheet_paths = workbook_sheet_paths(z)
        target_root = ET.fromstring(z.read(sheet_paths[target_sheet]))
        rules_root = ET.fromstring(z.read(sheet_paths[rules_sheet]))
        rows = read_target_rows(target_root, shared)
        rules = read_rules(rules_root, shared)
        return {"rows": rows, "rules": rules}


def write_workbook(workbook, target_sheet, output, updates):
    updates_by_row = {int(item["rowNumber"]): item for item in updates}
    with zipfile.ZipFile(workbook) as src:
        sheet_paths = workbook_sheet_paths(src)
        target_path = sheet_paths[target_sheet]
        root = ET.fromstring(src.read(target_path))
        sheet_data = root.find("a:sheetData", NS)

        updated = 0
        for row in sheet_data.findall("a:row", NS):
            row_number = int(row.attrib["r"])
            update = updates_by_row.get(row_number)
            if not update:
                continue
            if "U" in update:
                set_cell(row, "U", row_number, update.get("U", ""))
            if "V" in update:
                set_cell(row, "V", row_number, update.get("V", ""))
            if "W" in update:
                set_cell(row, "W", row_number, update.get("W", ""))
            if "Q" in update:
                set_cell(row, "Q", row_number, update.get("Q", ""))
            if "R" in update:
                set_cell(row, "R", row_number, update.get("R", ""))
            if "S" in update:
                set_cell(row, "S", row_number, update.get("S", ""))
            if "T" in update:
                set_cell(row, "T", row_number, update.get("T", ""))
            if "Y" in update:
                set_cell(row, "Y", row_number, update.get("Y", ""))
            if "AH" in update:
                set_cell(row, "AH", row_number, update.get("AH", ""))
            if "AI" in update:
                set_cell(row, "AI", row_number, update.get("AI", ""))
            if "AJ" in update:
                set_cell(row, "AJ", row_number, update.get("AJ", ""))
            if "AK" in update:
                set_cell(row, "AK", row_number, update.get("AK", ""))
            updated += 1

        target_xml = ET.tostring(root, encoding="utf-8", xml_declaration=True)
        output_path = Path(output)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(delete=False) as tmp:
            tmp_path = Path(tmp.name)
        try:
            with zipfile.ZipFile(workbook) as zin, zipfile.ZipFile(tmp_path, "w", zipfile.ZIP_DEFLATED) as zout:
                for item in zin.infolist():
                    data = target_xml if item.filename == target_path else zin.read(item.filename)
                    zout.writestr(item, data)
            shutil.move(str(tmp_path), output_path)
        finally:
            if tmp_path.exists():
                tmp_path.unlink()
        return {"updatedRows": updated, "output": str(output_path)}


def read_target_rows(root, shared):
    rows = []
    for row in root.findall(".//a:sheetData/a:row", NS):
        row_number = int(row.attrib["r"])
        if row_number < 3:
            continue
        values = row_values(row, shared)
        if not any(values.get(col) for col in ("D", "I", "K")):
            continue
        rows.append(
            {
                "rowNumber": row_number,
                "dataDate": values.get("B", ""),
                "senderRole": values.get("C", ""),
                "userId": values.get("D", ""),
                "userWechatName": values.get("E", ""),
                "senderName": values.get("F", ""),
                "teacherName": values.get("H", ""),
                "receiverName": values.get("I", ""),
                "sentAt": values.get("J", ""),
                "message": values.get("K", ""),
                "docProductType": values.get("L", ""),
                "docCampName": values.get("M", ""),
                "existing": {
                    "L": values.get("L", ""),
                    "M": values.get("M", ""),
                    "Q": values.get("Q", ""),
                    "R": values.get("R", ""),
                    "S": values.get("S", ""),
                    "T": values.get("T", ""),
                    "U": values.get("U", ""),
                    "V": values.get("V", ""),
                    "W": values.get("W", ""),
                    "Y": values.get("Y", ""),
                    "AH": values.get("AH", ""),
                    "AI": values.get("AI", ""),
                    "AJ": values.get("AJ", ""),
                    "AK": values.get("AK", ""),
                },
            }
        )
    return rows


def read_rules(root, shared):
    raw_rows = []
    for row in root.findall(".//a:sheetData/a:row", NS):
        row_number = int(row.attrib["r"])
        if row_number < 3:
            continue
        values = row_values(row, shared)
        raw_rows.append(values)

    current = {"A": "", "B": "", "C": ""}
    rules = []
    for values in raw_rows:
        for col in ("A", "B", "C"):
            if values.get(col):
                current[col] = values[col]
        third = values.get("D", "")
        scene = values.get("E", "")
        if not any((third, scene)):
            continue
        rules.append(
            {
                "dimension": current["A"],
                "firstCategory": current["B"],
                "secondCategory": current["C"],
                "thirdCategory": third,
                "scene": scene,
                "actionType": values.get("F", ""),
                "ticketType": values.get("G", ""),
            }
        )
    return rules


def row_values(row, shared):
    values = {}
    for cell in row.findall("a:c", NS):
        ref = cell.attrib.get("r")
        if not ref:
            continue
        col = re.match(r"([A-Z]+)", ref).group(1)
        values[col] = cell_value(cell, shared).strip()
    return values


def cell_value(cell, shared):
    cell_type = cell.attrib.get("t")
    if cell_type == "s":
        value = cell.find("a:v", NS)
        if value is None or value.text is None:
            return ""
        index = int(value.text)
        return shared[index] if index < len(shared) else ""
    if cell_type == "inlineStr":
        inline = cell.find("a:is", NS)
        if inline is None:
            return ""
        return "".join(t.text or "" for t in inline.iter(f"{{{MAIN_NS}}}t"))
    value = cell.find("a:v", NS)
    return value.text if value is not None and value.text is not None else ""


def set_cell(row, col, row_number, value):
    ref = f"{col}{row_number}"
    existing = None
    for cell in row.findall("a:c", NS):
        if cell.attrib.get("r") == ref:
            existing = cell
            break
    if existing is None:
        existing = ET.Element(f"{{{MAIN_NS}}}c", {"r": ref})
        insert_cell_sorted(row, existing)
    existing.attrib["t"] = "inlineStr"
    for child in list(existing):
        existing.remove(child)
    inline = ET.SubElement(existing, f"{{{MAIN_NS}}}is")
    text = ET.SubElement(inline, f"{{{MAIN_NS}}}t")
    text.text = str(value or "")


def insert_cell_sorted(row, cell):
    target_col = col_to_num(re.match(r"([A-Z]+)", cell.attrib["r"]).group(1))
    children = list(row)
    inserted = False
    for idx, child in enumerate(children):
        if not child.tag.endswith("c"):
            continue
        ref = child.attrib.get("r", "")
        match = re.match(r"([A-Z]+)", ref)
        if match and col_to_num(match.group(1)) > target_col:
            row.insert(idx, cell)
            inserted = True
            break
    if not inserted:
        row.append(cell)


def col_to_num(col):
    total = 0
    for char in col:
        total = total * 26 + ord(char) - 64
    return total


def read_shared_strings(z):
    if "xl/sharedStrings.xml" not in z.namelist():
        return []
    root = ET.fromstring(z.read("xl/sharedStrings.xml"))
    return ["".join(t.text or "" for t in item.iter(f"{{{MAIN_NS}}}t")) for item in root.findall("a:si", NS)]


def workbook_sheet_paths(z):
    workbook = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    rid_to_target = {rel.attrib["Id"]: rel.attrib["Target"] for rel in rels.findall("rel:Relationship", REL_NS)}
    paths = {}
    for sheet in workbook.find("a:sheets", NS).findall("a:sheet", NS):
        name = sheet.attrib["name"]
        rid = sheet.attrib[f"{{{NS['r']}}}id"]
        target = rid_to_target[rid]
        if target.startswith("/"):
            path = target[1:]
        else:
            path = posixpath.normpath(posixpath.join("xl", target))
        paths[name] = path
    return paths


if __name__ == "__main__":
    main()
