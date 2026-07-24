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

# Убираем разрешение INTERNET из манифеста — ComiFlow полностью офлайн
# (Tauri добавляет его по умолчанию для WebView, но сети здесь нет).
MANIFEST="$GEN_ANDROID/app/src/main/AndroidManifest.xml"
if [ -f "$MANIFEST" ] && grep -q 'android.permission.INTERNET' "$MANIFEST"; then
  python3 - "$MANIFEST" <<'PY'
import sys
path = sys.argv[1]
src = open(path, encoding="utf-8").read()
import re
before = src
src = re.sub(r'\s*<uses-permission android:name="android\.permission\.INTERNET" />\s*', '\n    ', src)
if src != before:
    open(path, "w", encoding="utf-8").write(src)
    print("[setup-android-plugin] убрано разрешение INTERNET из манифеста")
PY
fi

# Добавляем proguard keep-правила для ComiFlowBridge, если их ещё нет.
# Tauri вызывает @Command/@InvokeArg через reflection — без keep R8 вырежет
# плагин в release-сборке (isMinifyEnabled=true), и команды молча не работают.
PROGUARD="$GEN_ANDROID/app/proguard-rules.pro"
if [ -f "$PROGUARD" ] && ! grep -q "ComiFlow SAF bridge plugin" "$PROGUARD"; then
  cat >> "$PROGUARD" <<'KEEP'

# ── ComiFlow SAF bridge plugin ───────────────────────────────────────────
# Tauri invokes @Command methods and instantiates @InvokeArg argument classes
# via reflection, so R8/proguard must not rename or strip them.
-keep class com.kylaega.comiflow.ComiFlowBridge { *; }
-keep class com.kylaega.comiflow.ComiFlowBridge$* { *; }
-keep @app.tauri.annotation.TauriPlugin class * { *; }
-keep @app.tauri.annotation.Command class * { *; }
-keep @app.tauri.annotation.InvokeArg class * { *; }
-keep @app.tauri.annotation.ActivityCallback class * { *; }
-keepclassmembers class * {
    @app.tauri.annotation.Command <methods>;
    @app.tauri.annotation.ActivityCallback <methods>;
}
KEEP
  echo "[setup-android-plugin] добавлены proguard keep-правила для ComiFlowBridge"
fi

echo "[setup-android-plugin] готово."
