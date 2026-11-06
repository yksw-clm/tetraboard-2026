"""ローカルとFull CIで同じPython品質チェックを実行します。"""

import subprocess
import sys
from pathlib import Path

project = Path(__file__).resolve().parents[1]
for args in (
    ("ruff", "format", "--check", "."),
    ("ruff", "check", "."),
    ("mypy",),
    ("pytest",),
):
    print(f"Python AI: {' '.join(args)}", flush=True)
    result = subprocess.run([sys.executable, "-m", *args], cwd=project, check=False)
    if result.returncode:
        sys.exit(result.returncode)
