#!/usr/bin/env bash
# Builds and tests the dependency-bearing Java boundary services.
#
# This is a separate gate from `npm run verify` because it needs Maven Central.
# It is not optional: CI runs it on every push, and it carries the only tests
# that prove a PDF is actually signed and independently validated.
set -euo pipefail

if ! command -v mvn >/dev/null 2>&1; then
  echo "Maven is required to build services/signservice and services/validation-service." >&2
  echo "Install Maven 3.9+ or run this gate in CI." >&2
  exit 1
fi

mvn -B -f services/pom.xml verify
echo "java boundary services (Sweden Connect stack): OK"
