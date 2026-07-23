#!/usr/bin/env bash
#
# Идемпотентная установка in-app Android-плагина ComiFlowBridge в
# сгенерированный Tauri Android-проект (src-tauri/gen/android).
#
# Зачем: `gen/` регенерируется `tauri android init` и не версионирован
# (.gitignore), поэтому наш Kotlin-плагин живёт в постоянном месте
# `mobile/android/`, а этот скрипт копирует его на место перед сборкой.
#
# Запуск перед `cargo tauri android build` (локально и в CI).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
GEN_ANDROID="$SCRIPT_DIR/gen/android"

if [ ! -d "$GEN_ANDROID" ]; then
  echo "[setup-android-plugin] gen/android не найден — сначала запустите:" >&2
  echo "  cargo tauri android init" >&2
  exit 1
fi

DEST_DIR="$GEN_ANDROID/app/src/main/java/com/kylaega/comiflow"
mkdir -p "$DEST_DIR"

SRC="$SCRIPT_DIR/mobile/android/ComiFlowBridge.kt"
DEST="$DEST_DIR/ComiFlowBridge.kt"

if [ ! -f "$SRC" ]; then
  echo "[setup-android-plugin] источник не найден: $SRC" >&2
  exit 1
fi

cp "$SRC" "$DEST"
echo "[setup-android-plugin] ComiFlowBridge.kt → $DEST"

# Добавляем зависимость androidx.documentfile, если её ещё нет в build.gradle.kts.
# (gen/android/app/build.gradle.kts тоже регенерируется, поэтому добавляем каждый раз.)
# Делаем вставку через Python — это переносимо между macOS (BSD) и Linux (GNU),
# в отличие от `sed -i` который на этих ОС принимает разные флаги.
GRADLE="$GEN_ANDROID/app/build.gradle.kts"
if [ -f "$GRADLE" ] && ! grep -q "androidx.documentfile:documentfile" "$GRADLE"; then
  python3 - "$GRADLE" <<'PY'
import sys, io
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
needle = "dependencies {\n"
if needle in src:
    src = src.replace(needle, needle + '    implementation("androidx.documentfile:documentfile:1.0.1")\n', 1)
    open(path, "w", encoding="utf-8").write(src)
    print("[setup-android-plugin] добавлена зависимость androidx.documentfile")
PY
fi

echo "[setup-android-plugin] готово."
