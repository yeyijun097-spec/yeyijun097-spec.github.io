#!/usr/bin/env python3
"""PP-OCRv5 移动模型适配器。仅向 stdout 输出一个 JSON 对象。"""
import json
import sys
from contextlib import redirect_stdout

def main():
    if len(sys.argv) != 2:
        raise RuntimeError("缺少图片路径")
    try:
        from paddleocr import PaddleOCR
    except ImportError as exc:
        raise RuntimeError("未安装 PaddleOCR，请按部署文档安装 paddlepaddle 与 paddleocr") from exc

    image_path = sys.argv[1]
    # 新版 PaddleOCR 使用 predict，旧版保留 ocr；这里兼容服务器实际安装版本。
    lines = []
    confidences = []
    # PaddleX 会把模型下载/探测日志写到 stdout；重定向到 stderr，确保 stdout 始终只有 JSON。
    with redirect_stdout(sys.stderr):
        engine = PaddleOCR(
            lang="ch",
            text_detection_model_name="PP-OCRv5_mobile_det",
            text_recognition_model_name="PP-OCRv5_mobile_rec",
            use_doc_orientation_classify=True,
            use_doc_unwarping=True,
            use_textline_orientation=True,
        )
        if hasattr(engine, "predict"):
            for result in engine.predict(image_path):
                payload = getattr(result, "json", result)
                if callable(payload):
                    payload = payload()
                if isinstance(payload, str):
                    payload = json.loads(payload)
                data = payload.get("res", payload) if isinstance(payload, dict) else {}
                texts = data.get("rec_texts", [])
                scores = data.get("rec_scores", [])
                lines.extend(str(item) for item in texts)
                confidences.extend(float(item) for item in scores)
        else:
            result = engine.ocr(image_path, cls=True)
            for page in result or []:
                for row in page or []:
                    if len(row) >= 2 and row[1]:
                        lines.append(str(row[1][0]))
                        confidences.append(float(row[1][1]))
    print(json.dumps({"text": "\n".join(lines), "lines": lines,
                      "averageConfidence": sum(confidences) / len(confidences) if confidences else 0}, ensure_ascii=False))

if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(json.dumps({"error": str(error)}, ensure_ascii=False))
        sys.exit(1)
