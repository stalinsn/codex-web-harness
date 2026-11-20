import base64, hashlib, json, os, re, sys
from pathlib import Path
entry = json.loads(base64.b64decode(sys.argv[1]))
source = Path.home() / entry.pop("upload")
public = Path.home() / "codex-harness-web/web-ui/public"
feed = public / "android-release.json"
page = public / "android.html"
target = public / entry["name"]
if target.exists() or (feed.exists() and json.loads(feed.read_text())["versionCode"] >= entry["versionCode"]):
    raise SystemExit("Increment the version before publishing.")
if hashlib.sha256(source.read_bytes()).hexdigest() != entry["sha256"]:
    raise SystemExit("APK checksum mismatch.")
html = re.sub(r"Versão [\d.]+", "Versão " + entry["versionName"], page.read_text())
html = re.sub(r"Codex-Harness-Android-[\d.]+\.apk", entry["name"], html)
html = re.sub(r"\d+ kB", f"{round(source.stat().st_size / 1000)} kB", html)
os.replace(source, target)
for path, body in [(page, html), (feed, json.dumps(entry, ensure_ascii=False) + "\n")]:
    tmp = path.with_name("." + path.name + ".publish")
    tmp.write_text(body, encoding="utf-8")
    os.replace(tmp, path)
