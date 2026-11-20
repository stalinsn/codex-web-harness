#!/bin/bash
# Compila, assina, verifica e publica o APK de release a partir da VPS.
# Uso: scripts/publish.sh "Notas da versão"
# A chave fica em ~/.config/harness-android (fora do projeto). O certificado é fixado em
# cert.sha256 na primeira publicação: depois disso, uma chave diferente aborta a publicação.
set -euo pipefail
cd "$(dirname "$0")/.."
NOTES=${1:?Informe as notas da versão}
export ANDROID_HOME=/home/ubuntu/android-sdk
export QEMU_LD_PREFIX=/home/ubuntu/tools/x86_64-root
SIGN_DIR=/home/ubuntu/.config/harness-android
BT=$ANDROID_HOME/build-tools/$(ls "$ANDROID_HOME/build-tools" | sort -V | tail -1)
HARNESS=/home/ubuntu/codex-harness-web
PUBLIC=$(readlink -f "$HARNESS/web-ui")/public
BUILDS=/home/ubuntu/builds/app-harness
STATUS=$HARNESS/android-publish.status

[ -f "$SIGN_DIR/signing.properties" ] || { echo "Sem chave de assinatura em $SIGN_DIR"; exit 1; }

./gradlew --no-daemon -q assembleRelease -Pandroid.aapt2FromMavenOverride="$BT/aapt2"
APK=build/outputs/apk/release/HarnessAndroid-release.apk
[ -f "$APK" ] || { echo "APK de release não encontrado"; exit 1; }

# Assinatura: válida e com o certificado fixado.
java -jar "$BT/lib/apksigner.jar" verify "$APK"
CERT=$(java -jar "$BT/lib/apksigner.jar" verify --print-certs "$APK" | sed -n 's/^Signer #1 certificate SHA-256 digest: //p')
[ -n "$CERT" ] || { echo "Não li o certificado do APK"; exit 1; }
if [ -f "$SIGN_DIR/cert.sha256" ]; then
  [ "$CERT" = "$(cat "$SIGN_DIR/cert.sha256")" ] || { echo "Certificado diferente do fixado. Publicação abortada."; exit 1; }
else
  echo "$CERT" > "$SIGN_DIR/cert.sha256"; chmod 600 "$SIGN_DIR/cert.sha256"
fi

BADGING=$("$BT/aapt2" dump badging "$APK" | awk 'NR==1')
PKG=$(sed -n "s/.*package: name='\([^']*\)'.*/\1/p" <<<"$BADGING")
CODE=$(sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p" <<<"$BADGING")
NAME=$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<<"$BADGING")
[ "$PKG" = br.com.nyxrooms.harness ] || { echo "Pacote inesperado: $PKG"; exit 1; }
PUBLISHED=$(python3 -I -c "import json,sys;print(json.load(open(sys.argv[1]))['versionCode'])" "$PUBLIC/android-release.json" 2>/dev/null || echo 0)
[ "$CODE" -gt "$PUBLISHED" ] || { echo "versionCode $CODE não é maior que o publicado ($PUBLISHED). Incremente a versão."; exit 1; }

FILE=Codex-Harness-Android-$NAME.apk
SHA=$(sha256sum "$APK" | cut -d' ' -f1)
SIZE=$(( $(stat -c %s "$APK") / 1000 ))

# Build guardado fora do código (só o mais recente).
mkdir -p "$BUILDS"
cp "$APK" "$BUILDS/.$FILE.new" && mv "$BUILDS/.$FILE.new" "$BUILDS/$FILE"
find "$BUILDS" -maxdepth 1 -name 'Codex-Harness-Android-*.apk' ! -name "$FILE" -delete

# Arquivos públicos: APK, manifesto e página, gravados de forma atômica.
cp "$APK" "$PUBLIC/.$FILE.new" && mv "$PUBLIC/.$FILE.new" "$PUBLIC/$FILE"
python3 -I - "$PUBLIC" "$FILE" "$CODE" "$NAME" "$SHA" "$SIZE" "$CERT" "$NOTES" <<'EOF'
import html, json, os, sys
public, name, code, version, sha, size, cert, notes = sys.argv[1:]
manifest = {"versionCode": int(code), "versionName": version, "name": name, "sha256": sha, "signer": cert, "notes": notes}
page = f"""<!doctype html>
<html lang="pt-BR">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex Harness para Android</title>
<style>
:root{{color-scheme:dark;font:17px system-ui;background:#0d0f13;color:#e8eaef}}
main{{max-width:32rem;margin:12vh auto 0;padding:0 1.5rem}}p{{line-height:1.55;color:#a3a9b5}}
a.button{{display:inline-block;background:#a7b2ff;color:#151735;padding:1em 1.2em;border-radius:.8rem;text-decoration:none;font-weight:700}}
.note{{border:1px solid #4a3a2a;background:#1f1a15;border-radius:.7rem;padding:.8em 1em;color:#e8d2b0;font-size:.9rem}}
</style>
<main>
<h1>Codex Harness para Android</h1>
<p>Versão {html.escape(version)} · APK assinado · {size} kB</p>
<p>{html.escape(notes)}</p>
<a class="button" href="./{name}" download="{name}">Baixar APK</a>
<p>Com o app instalado, as próximas versões chegam pelo próprio app: toque em <b>Atualizar agora</b> e confirme.</p>
<p class="note">Veio da versão 1.3 ou anterior? Ela foi assinada com outra chave. Desinstale o app uma vez antes de instalar esta versão (você só precisa entrar de novo).</p>
</main>
</html>
"""
for path, body in [(os.path.join(public, "android-release.json"), json.dumps(manifest, ensure_ascii=False) + "\n"), (os.path.join(public, "android.html"), page)]:
    tmp = os.path.join(os.path.dirname(path), "." + os.path.basename(path) + ".publish")
    with open(tmp, "w", encoding="utf-8") as f: f.write(body)
    os.replace(tmp, path)
EOF

# Verificação depois do reinício: manifesto e APK por HTTPS batem com o que foi publicado.
CHECK=/home/ubuntu/projects/app-harness/build/publish-check.sh
cat > "$CHECK" <<EOF
set -e
m=\$(curl -fsS https://nyxrooms.com/codex-agent/android-release.json)
python3 -I -c "import json,sys; d=json.loads(sys.argv[1]); assert d['versionCode']==$CODE and d['sha256']=='$SHA', d" "\$m"
got=\$(curl -fsS https://nyxrooms.com/codex-agent/$FILE | sha256sum | cut -d' ' -f1)
[ "\$got" = "$SHA" ] || { echo "hash do download difere: \$got"; exit 1; }
curl -fsS https://nyxrooms.com/codex-agent/android.html | grep -q "Versão $NAME"
echo "$NAME ($CODE) publicado; manifesto, página e APK conferidos por HTTPS (sha256 $SHA)."
EOF
echo "$(date -u +%FT%TZ) Publicando $NAME ($CODE), sha256 $SHA, certificado $CERT." >> "$STATUS"
sudo -n systemd-run --quiet --unit="harness-publish-$CODE-$(date +%s)" --on-active=5 "$HARNESS/restart-when-idle.sh" "$STATUS" "$CHECK"
echo "Publicação de $NAME preparada. O harness reinicia quando ficar ocioso; resultado em $STATUS."
