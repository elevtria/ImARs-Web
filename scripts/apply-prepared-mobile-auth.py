"""Apply only the explicitly prepared auth files to the user-named Unity project."""
from pathlib import Path
import hashlib
import json
import sys
import uuid

workspace = Path(__file__).resolve().parents[1]
mobile = Path(sys.argv[1]).resolve()
if str(mobile).replace("\\", "/").lower() != "c:/users/marie/imars":
    raise RuntimeError("This reviewed patch is only for the mobile project explicitly provided in this chat.")
prepared = workspace / ".wrangler" / "mobile-auth-prepared"
target = (mobile / "Assets" / "SCRIPTS").resolve()
expected = json.loads((prepared / "original-hashes.json").read_text(encoding="utf-8"))
for name, digest in expected.items():
    path = (target / name).resolve()
    if path.parent != target:
        raise RuntimeError("Unexpected patch target")
    current = path.read_bytes()
    if hashlib.sha256(current).hexdigest() != digest and current != (prepared / name).read_bytes():
        raise RuntimeError("A mobile source file changed since review; refusing to overwrite it: " + name)
helper = target / "ImarsAccountGateway.cs"
if helper.exists() and helper.read_bytes() != (prepared / helper.name).read_bytes():
    raise RuntimeError("A different account helper already exists; refusing to overwrite it")
for name in (*expected, "ImarsAccountGateway.cs"):
    (target / name).write_bytes((prepared / name).read_bytes())
meta = target / "ImarsAccountGateway.cs.meta"
if not meta.exists():
    meta.write_text("fileFormatVersion: 2\nguid: " + uuid.uuid4().hex + "\n", encoding="utf-8")
print("Applied three mobile auth edits and one helper. No scenes, lessons, quizzes, AR or offline-progress code were changed.")
