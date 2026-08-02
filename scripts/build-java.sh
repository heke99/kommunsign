#!/usr/bin/env bash
set -euo pipefail
rm -rf build/java
mkdir -p build/java/signservice build/java/validation-service build/java/identity-service build/java/sdk
javac -d build/java/signservice $(find services/signservice/src/main/java -name '*.java' -print)
javac -d build/java/validation-service $(find services/validation-service/src/main/java -name '*.java' -print)
javac -d build/java/identity-service $(find services/identity-service/src/main/java -name '*.java' -print)
java -cp build/java/identity-service se.kommunsign.identity.FrejaJwsVerifierSelfTest
javac --release 21 -d build/java/sdk $(find sdks/java/src/main/java -name '*.java' -print)
echo "java boundary services and SDK: OK"
