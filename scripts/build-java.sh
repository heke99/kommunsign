#!/usr/bin/env bash
# Offline javac gate for the Java SDK, which has no third-party dependencies.
#
# signservice and validation-service are deliberately absent: since ADR 0004 they
# depend on the Sweden Connect stack and are built by scripts/build-java-maven.sh.
# Keeping them here would make `npm run verify` require network access to Maven
# Central for every developer on every run, which is a cost paid by everyone to
# catch a break that the dedicated CI job catches anyway.
set -euo pipefail
rm -rf build/java
mkdir -p build/java/sdk
javac --release 21 -d build/java/sdk $(find sdks/java/src/main/java -name '*.java' -print)
echo "java SDK: OK"
echo "The Java services are covered by: npm run verify:java:maven"
