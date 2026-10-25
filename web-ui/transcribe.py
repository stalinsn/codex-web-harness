"""One recording per process; release model memory after each transcription."""
import json
import resource
import sys


def main():
    resource.setrlimit(resource.RLIMIT_AS, (2560 * 1024 * 1024, 2560 * 1024 * 1024))
    resource.setrlimit(resource.RLIMIT_CPU, (280, 280))
    from faster_whisper import WhisperModel
    from faster_whisper.audio import decode_audio

    audio = decode_audio(sys.argv[1], sampling_rate=16000)
    duration = len(audio) / 16000
    if duration > 181:
        raise ValueError('O limite é de 3 minutos por áudio. Divida a mensagem em partes.')
    if duration < 0.3:
        raise ValueError('O áudio é muito curto. Grave sua mensagem novamente.')
    model = WhisperModel(sys.argv[2], device='cpu', compute_type='int8', cpu_threads=1, num_workers=1, local_files_only=True)
    segments, _ = model.transcribe(
        audio, language='pt', beam_size=5, temperature=0,
        vad_filter=True, vad_parameters={'threshold': 0.35, 'min_silence_duration_ms': 600, 'speech_pad_ms': 400},
        condition_on_previous_text=False, repetition_penalty=1.0,
        initial_prompt='Conversa em português brasileiro sobre projetos de software, GitHub, Docker e desenvolvimento web.',
    )
    text = ' '.join(segment.text.strip() for segment in segments).strip()
    if not text:
        raise ValueError('Não identifiquei fala neste áudio. Aproxime o microfone e tente novamente.')
    print(json.dumps({'text': text, 'duration': duration}, ensure_ascii=False))


if __name__ == '__main__':
    try:
        main()
    except ValueError as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False))
        sys.exit(1)
    except Exception:
        print(json.dumps({'error': 'Não foi possível processar este áudio. Tente gravar novamente.'}))
        sys.exit(1)
