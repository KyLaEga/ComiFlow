#!/usr/bin/env bash
#
# Подписывает собранный Android APK отладочным ключом (debug.keystore),
# чтобы его можно было установить на устройство. Tauri собирает *unsigned*
# APK (`*-unsigned.apk`), а Android отказывается устанавливать неподписанные
# файлы (INSTALL_PARSE_FAILED_NO_CERTIFICATES).
#
# Запуск после `cargo tauri android build --apk`:
#   bash src-tauri/sign-apk.sh
#
# Результат: <исходник без "-unsigned">.apk рядом с исходником.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="$SCRIPT_DIR/gen/android/app/build/outputs/apk/universal/release"

if [ ! -d "$OUT_DIR" ]; then
  echo "[sign-apk] каталог с APK не найден: $OUT_DIR" >&2
  exit 1
fi

UNSIGNED=""
for f in "$OUT_DIR"/*unsigned.apk; do
  [ -f "$f" ] && UNSIGNED="$f" && break
done

if [ -z "$UNSIGNED" ]; then
  echo "[sign-apk] unsigned APK не найден в $OUT_DIR" >&2
  exit 1
fi

# Имя без суффикса "-unsigned"
SIGNED="${UNSIGNED%-unsigned.apk}.apk"

ANDROID_HOME="${ANDROID_HOME:-$HOME/Library/Android/sdk}"
BT="$(ls -d "$ANDROID_HOME"/build-tools/* 2>/dev/null | tail -1 || true)"
if [ -z "$BT" ]; then
  echo "[sign-apk] build-tools не найдены (ANDROID_HOME=$ANDROID_HOME)" >&2
  exit 1
fi

KS="${DEBUG_KEYSTORE:-$HOME/.android/debug.keystore}"
if [ ! -f "$KS" ]; then
  echo "[sign-apk] debug.keystore не найден: $KS" >&2
  exit 1
fi

TMP="/tmp/comiflow-sign-$$"
mkdir -p "$TMP"
trap 'rm -rf "$TMP"' EXIT

echo "[sign-apk] zipalign: $UNSIGNED"
"$BT/zipalign" -f 4 "$UNSIGNED" "$TMP/aligned.apk"
echo "[sign-apk] подпись debug-ключом: $SIGNED"
"$BT/apksigner" sign \
  --ks "$KS" \
  --ks-pass pass:android \
  --key-pass pass:android \
  --out "$SIGNED" \
  "$TMP/aligned.apk"
echo "[sign-apk] готово: $SIGNED"

# Показать, что подпись валидна
"$BT/apksigner" verify --verbose "$SIGNED" 2>&1 | head -4 || true
