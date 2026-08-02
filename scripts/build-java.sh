#!/usr/bin/env bash
set -euo pipefail
rm -rf build/java
mkdir -p build/java/signservice build/java/validation-service build/java/identity-service
javac -d build/java/signservice $(find services/signservice/src/main/java -name '*.java' -print)
javac -d build/java/validation-service $(find services/validation-service/src/main/java -name '*.java' -print)
javac -d build/java/identity-service $(find services/identity-service/src/main/java -name '*.java' -print)
echo "java boundary services: OK"
