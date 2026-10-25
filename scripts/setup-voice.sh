#!/usr/bin/env bash
set -euo pipefail
voice_root="${CODEX_VOICE_ENV:-$HOME/.local/venvs/harness-voice}"
voice_model="${CODEX_VOICE_MODEL:-$HOME/.cache/harness-voice/small}"
script_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
python3 -m venv "$voice_root"
"$voice_root/bin/pip" install -r "$script_root/../web-ui/requirements-voice.txt"
"$voice_root/bin/python" - "$voice_model" <<'PY'
import sys
from huggingface_hub import snapshot_download
snapshot_download('Systran/faster-whisper-small', local_dir=sys.argv[1], allow_patterns=['model.bin','config.json','vocabulary.*','tokenizer.json','preprocessor_config.json'])
print('Transcrição local instalada. Reinicie o harness para publicar as rotas de voz.')
PY
