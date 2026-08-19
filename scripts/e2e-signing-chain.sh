#!/usr/bin/env bash
# Runs the signing chain for real: a PDF is signed by SignService and then
# independently validated by validation-service, both as separate processes over
# HTTP. Nothing is mocked.
#
# This exists because component tests cannot show that one service calls another
# with the arguments it expects. The first time it was run it found two defects
# that 147 unit tests and 17 Java tests had all missed: neither production class
# registered the BouncyCastle provider, and the test fixture had been supplying
# it. Keep it runnable.
#
# Key material is generated here, into build/, and never committed. The
# repository verification gate refuses committed keys for exactly this reason.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E="$ROOT/build/e2e"
STORE_PASS="${E2E_KEYSTORE_PASSWORD:-e2e-local}"
SIGN_PORT="${E2E_SIGN_PORT:-8081}"
VALIDATE_PORT="${E2E_VALIDATE_PORT:-8082}"
# Generated per run rather than written down. A fixed token in a committed
# script is a credential in the repository, whatever it is nominally for, and
# the secret scan is right to refuse one.
SIGN_TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '=+/')"
VALIDATE_TOKEN="$(head -c 24 /dev/urandom | base64 | tr -d '=+/')"

mkdir -p "$E2E"
cd "$ROOT"

log() { printf '  %-44s %s\n' "$1" "$2"; }

# ---------------------------------------------------------------------------
# 1. Test credential, generated fresh every run.
#
# A CA and a signer it issued. Not self-signed: the validator has to build a
# path to a trust anchor, and a self-signed signer would let it pass for the
# wrong reason.
# ---------------------------------------------------------------------------
if [[ ! -f "$E2E/signer.p12" ]]; then
  rm -f "$E2E"/*.p12 "$E2E"/*.pem "$E2E"/*.csr
  keytool -genkeypair -alias e2e-ca -keyalg RSA -keysize 2048 -sigalg SHA256withRSA \
    -dname "CN=Kommunsign E2E Test CA,O=Kommunsign Test,C=SE" -validity 365 \
    -ext bc:c=ca:true -ext ku:c=keyCertSign,cRLSign \
    -keystore "$E2E/ca.p12" -storetype PKCS12 -storepass "$STORE_PASS" -keypass "$STORE_PASS" >/dev/null 2>&1
  keytool -exportcert -alias e2e-ca -keystore "$E2E/ca.p12" -storetype PKCS12 \
    -storepass "$STORE_PASS" -rfc -file "$E2E/ca.pem" >/dev/null 2>&1

  # SHA256withRSA explicitly: keytool's gencert default is SHA384, which the
  # signer's algorithm mapping does not offer.
  keytool -genkeypair -alias e2e-signer -keyalg RSA -keysize 2048 -sigalg SHA256withRSA \
    -dname "CN=Kungalvs kommun E2E,serialNumber=195001011234,O=Kungalvs kommun,C=SE" -validity 365 \
    -keystore "$E2E/signer.p12" -storetype PKCS12 -storepass "$STORE_PASS" -keypass "$STORE_PASS" >/dev/null 2>&1
  keytool -certreq -alias e2e-signer -keystore "$E2E/signer.p12" -storetype PKCS12 \
    -storepass "$STORE_PASS" -file "$E2E/signer.csr" >/dev/null 2>&1
  keytool -gencert -alias e2e-ca -keystore "$E2E/ca.p12" -storetype PKCS12 -storepass "$STORE_PASS" \
    -sigalg SHA256withRSA -infile "$E2E/signer.csr" -outfile "$E2E/signer.pem" -rfc -validity 364 \
    -ext ku:c=nonRepudiation,digitalSignature >/dev/null 2>&1
  keytool -importcert -alias e2e-ca -keystore "$E2E/signer.p12" -storetype PKCS12 \
    -storepass "$STORE_PASS" -file "$E2E/ca.pem" -noprompt >/dev/null 2>&1
  cat "$E2E/signer.pem" "$E2E/ca.pem" > "$E2E/chain.pem"
  keytool -importcert -alias e2e-signer -keystore "$E2E/signer.p12" -storetype PKCS12 \
    -storepass "$STORE_PASS" -file "$E2E/chain.pem" -noprompt >/dev/null 2>&1

  # A CA the signer does not chain to, so "refuses an untrusted signer" is
  # tested against a real anchor rather than against an empty list.
  keytool -genkeypair -alias foreign -keyalg RSA -keysize 2048 -sigalg SHA256withRSA \
    -dname "CN=Nagon Annan CA,O=Inte Kommunsign,C=SE" -validity 365 -ext bc:c=ca:true \
    -keystore "$E2E/foreign.p12" -storetype PKCS12 -storepass "$STORE_PASS" -keypass "$STORE_PASS" >/dev/null 2>&1
  keytool -exportcert -alias foreign -keystore "$E2E/foreign.p12" -storetype PKCS12 \
    -storepass "$STORE_PASS" -rfc -file "$E2E/foreign-ca.pem" >/dev/null 2>&1
fi
log "test credential" "generated under build/e2e (never committed)"

# ---------------------------------------------------------------------------
# 2. Services, built and started as real processes.
# ---------------------------------------------------------------------------
if [[ ! -f "$ROOT/services/signservice/target/kommunsign-signservice.jar" ]]; then
  ( cd "$ROOT/services" && mvn -q -B package -DskipTests )
fi
log "service jars" "built"

# A PDF produced by PDFBox rather than hand-rolled, so the signer is exercised
# against a document a real converter would emit.
mkdir -p "$E2E/mk"
cat > "$E2E/mk/MakePdf.java" <<'JAVA'
import org.apache.pdfbox.pdmodel.*;
import org.apache.pdfbox.pdmodel.common.PDRectangle;
import org.apache.pdfbox.pdmodel.font.*;
public final class MakePdf {
    public static void main(String[] args) throws Exception {
        try (PDDocument document = new PDDocument()) {
            PDPage page = new PDPage(PDRectangle.A4);
            document.addPage(page);
            try (PDPageContentStream stream = new PDPageContentStream(document, page)) {
                stream.beginText();
                stream.setFont(new PDType1Font(Standard14Fonts.FontName.HELVETICA), 14);
                stream.newLineAtOffset(60, 760);
                stream.showText("Kungalvs kommun - beslut KS2026/1005");
                stream.endText();
            }
            document.save(args[0]);
        }
    }
}
JAVA
CP="$ROOT/services/signservice/target/kommunsign-signservice.jar:$ROOT/services/signservice/target/lib/*"
javac -cp "$CP" -d "$E2E/mk" "$E2E/mk/MakePdf.java" >/dev/null 2>&1
java -cp "$E2E/mk:$CP" MakePdf "$E2E/source.pdf" >/dev/null 2>&1
log "source document" "$(stat -c%s "$E2E/source.pdf") bytes, produced by PDFBox"

stop_services() {
  pkill -f kommunsign-signservice.jar >/dev/null 2>&1 || true
  pkill -f kommunsign-validation-service.jar >/dev/null 2>&1 || true
}
trap stop_services EXIT
stop_services
sleep 1

(
  cd "$ROOT/services/signservice/target"
  PORT="$SIGN_PORT" SIGNSERVICE_TOKEN="$SIGN_TOKEN" APP_ENV=test \
  KOMMUNSIGN_SIGNING_BACKEND=SWEDEN_CONNECT KOMMUNSIGN_SIGNING_KEY_PROTECTION=SOFTWARE \
  KOMMUNSIGN_SIGNING_KEYSTORE_PATH="$E2E/signer.p12" KOMMUNSIGN_SIGNING_KEYSTORE_PASSWORD="$STORE_PASS" \
  KOMMUNSIGN_SIGNING_KEY_ALIAS=e2e-signer KOMMUNSIGN_SIGNING_KEY_PASSWORD="$STORE_PASS" \
  setsid nohup java -jar kommunsign-signservice.jar > "$E2E/signservice.log" 2>&1 < /dev/null &
)
(
  cd "$ROOT/services/validation-service/target"
  PORT="$VALIDATE_PORT" VALIDATION_SERVICE_TOKEN="$VALIDATE_TOKEN" APP_ENV=test \
  setsid nohup java -jar kommunsign-validation-service.jar > "$E2E/validation.log" 2>&1 < /dev/null &
)

for attempt in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$SIGN_PORT/health" >/dev/null 2>&1 \
     && curl -sf "http://127.0.0.1:$VALIDATE_PORT/health" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -sf "http://127.0.0.1:$SIGN_PORT/health" >/dev/null || { echo "  sign service did not start"; tail -20 "$E2E/signservice.log"; exit 1; }
curl -sf "http://127.0.0.1:$VALIDATE_PORT/health" >/dev/null || { echo "  validation service did not start"; tail -20 "$E2E/validation.log"; exit 1; }
log "sign service" "$(curl -s "http://127.0.0.1:$SIGN_PORT/health")"
log "validation service" "up"

# ---------------------------------------------------------------------------
# 3. Drive the chain.
# ---------------------------------------------------------------------------
E2E_DIR="$E2E" SIGN_PORT="$SIGN_PORT" VALIDATE_PORT="$VALIDATE_PORT" \
SIGN_TOKEN="$SIGN_TOKEN" VALIDATE_TOKEN="$VALIDATE_TOKEN" \
  node "$ROOT/scripts/e2e-signing-chain.mjs"
