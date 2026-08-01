#!/bin/bash

set -euo pipefail
cd "$(dirname "$0")"

PLATFORM="${1:-}"
FLAVOR="${2:-prod}"

if [[ -z "$PLATFORM" ]]; then
  echo "Usage: $0 <ios|android> [flavor]"
  exit 1
fi

VERSION=$(grep '^version:' pubspec.yaml | awk '{print $2}')
echo "Deploying $PLATFORM $FLAVOR — version $VERSION"

flutter pub get

case "$PLATFORM" in
  ios)
    flutter build ipa -t "lib/main_${FLAVOR}.dart" --flavor "${FLAVOR}" --release
    echo "IPA ready at build/ios/ipa/"
    open build/ios/ipa/
    ;;
  android)
    flutter build appbundle -t "lib/main_${FLAVOR}.dart" --flavor "${FLAVOR}" --release
    echo "AAB ready at build/app/outputs/bundle/${FLAVOR}Release/"
    open build/app/outputs/bundle/${FLAVOR}Release/
    ;;
  *)
    echo "Unknown platform: $PLATFORM (expected ios or android)"
    exit 1
    ;;
esac
