#!/usr/bin/env bash
# Runs the application chain for real.
#
# The signing-chain E2E proves the cryptographic core: a PDF is signed and
# independently validated by the two Java services over HTTP. This one proves
# the orchestration around it -- the production API, the production worker, the
# control and data databases, the object store and the two Java services, all as
# separate processes, driven through provisioning and then through a document.
#
# Nothing inside the system is mocked. The only doubles are for suppliers
# outside it (the email provider and the BankID broker), they are served over
# real HTTPS so the production provider clients run unchanged, and each one is
# named where it is used. The BankID signature itself cannot be stood in for at
# all -- it is signed by BankID's key -- so the chain asserts that the system
# refuses to mark a signer signed on evidence that did not verify.
#
#   docker compose up -d postgres-control postgres-data minio clamav gotenberg verapdf
#   npm run db:migrate
#   npm run verify:e2e:application
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
E2E="$ROOT/build/e2e-app"
cd "$ROOT"
mkdir -p "$E2E"

log() { printf '  %-44s %s\n' "$1" "$2"; }

: "${CONTROL_DATABASE_URL:=postgresql://kommunsign:local-change-me@127.0.0.1:5433/kommunsign_control}"
: "${DATA_DATABASE_URL:=postgresql://kommunsign:local-change-me@127.0.0.1:5434/kommunsign_data}"
export CONTROL_DATABASE_URL DATA_DATABASE_URL

API_PORT="${E2E_API_PORT:-8790}"
STUB_PORT="${E2E_STUB_PORT:-8443}"
SIGN_PORT="${E2E_SIGN_PORT:-8081}"
VALIDATE_PORT="${E2E_VALIDATE_PORT:-8082}"
STORE_PASS="${E2E_KEYSTORE_PASSWORD:-e2e-local}"

# ---------------------------------------------------------------------------
# 0. The stack this needs, checked before anything is started.
# ---------------------------------------------------------------------------
require_service() {
  if ! curl -fsS --max-time 5 "$2" >/dev/null 2>&1; then
    echo "  $1 is not reachable at $2" >&2
    echo "  start the stack: docker compose up -d postgres-control postgres-data minio clamav gotenberg verapdf" >&2
    exit 1
  fi
}
require_service "object storage" "http://127.0.0.1:9000/minio/health/live"
require_service "PDF/A conversion" "http://127.0.0.1:3007/health"
require_service "PDF/A validation" "http://127.0.0.1:3008/api/profiles"
command -v qpdf >/dev/null || { echo '  qpdf is required by the document pipeline and is not installed' >&2; exit 1; }
psql "$CONTROL_DATABASE_URL" -tAc 'select 1' >/dev/null 2>&1 || { echo '  control database is not reachable' >&2; exit 1; }
psql "$DATA_DATABASE_URL" -tAc 'select 1' >/dev/null 2>&1 || { echo '  data database is not reachable' >&2; exit 1; }
if ! (exec 3<>/dev/tcp/127.0.0.1/3310 && printf 'PING\n' >&3 && head -c 4 <&3 | grep -q PONG); then
  echo '  virus scanning is not reachable on 127.0.0.1:3310' >&2
  exit 1
fi
# A port already in use is not this run's process: the script would start its
# own, watch it die, and then talk to whatever was there -- which is how a run
# ends up green against yesterday's build.
for port in "$API_PORT" "$STUB_PORT" "$SIGN_PORT" "$VALIDATE_PORT"; do
  if (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
    echo "  port $port is already in use; stop whatever holds it before running this" >&2
    exit 1
  fi
done
log "stack" "databases, object store, scanner, PDF/A services up"

# ---------------------------------------------------------------------------
# 1. Secrets and certificates, generated per run and never committed.
# ---------------------------------------------------------------------------
random_token() { head -c 24 /dev/urandom | base64 | tr -d '=+/'; }
random_key() { head -c 32 /dev/urandom | base64; }

export APP_ENV=production
export KOMMUNSIGN_PRODUCTION_ADAPTER_MODULE=./production-adapters/postgres/index.js
export KOMMUNSIGN_OBJECT_STORAGE_ADAPTER_MODULE=../../adapters/s3-object-storage.js
export KOMMUNSIGN_QUEUE_ADAPTER_MODULE=../../adapters/postgres-queue.js
export KOMMUNSIGN_SENSITIVE_DATA_ADAPTER_MODULE=../../adapters/aes-gcm-sensitive-data.js
export KOMMUNSIGN_WORKER_ADAPTER_MODULE=./postgres-production-adapter.js
export STORAGE_PROVIDER=s3
export S3_ENDPOINT="${S3_ENDPOINT:-http://127.0.0.1:9000}"
export S3_REGION="${S3_REGION:-us-east-1}"
export S3_ACCESS_KEY_ID="${S3_ACCESS_KEY_ID:-local-only}"
export S3_SECRET_ACCESS_KEY="${S3_SECRET_ACCESS_KEY:-local-only-change-me}"
export SENSITIVE_DATA_ENCRYPTION_KEY_BASE64="$(random_key)"
export SENSITIVE_DATA_BLIND_INDEX_KEY_BASE64="$(random_key)"
export INTERNAL_GATEWAY_HMAC_KEY="$(random_token)$(random_token)"
export CSRF_SIGNING_KEY="$(random_token)"
export OIDC_STATE_SIGNING_KEY="$(random_token)"
export OIDC_SESSION_ENCRYPTION_KEY="$(random_key)"
export AUTH_CODE_SIGNING_KEY="$(random_token)"
export MAGIC_LINK_SIGNING_KEY="$(random_token)"
export KMS_KEY_REFERENCE=e2e-local-key-reference
# Auth is an external supplier and this chain never calls it. The values are
# structurally valid so the runtime boots; any request that reached them would
# fail, which is the correct outcome for a host that does not exist.
export SUPABASE_AUTH_PROJECT_URL=https://auth.invalid
# Generated rather than written down, so the secret scan does not have to
# decide whether a literal in a script is a credential. It is right to refuse
# one either way.
export SUPABASE_AUTH_ANON_KEY="$(random_token)"
export SUPABASE_AUTH_SERVICE_ROLE_KEY="$(random_token)"
export AUTH_BROKER_URL=https://auth.kommunsign.invalid
export KOMMUNSIGN_ROOT_DOMAIN=kommunsign.invalid
export PLATFORM_ADMIN_URL=https://admin.kommunsign.invalid
export TENANT_DISCOVERY_URL=https://app.kommunsign.invalid
export SIGNER_FALLBACK_URL=https://sign.kommunsign.invalid
# No proxy in front of the API here, so the end-user IP is the socket's.
export TRUSTED_PROXY_PROVIDER=none
export ONBOARDING_PORTAL_URL=https://onboarding.kommunsign.invalid
export CLAMAV_HOST=127.0.0.1
export CLAMAV_PORT=3310
export GOTENBERG_URL=http://127.0.0.1:3007
export VERAPDF_URL=http://127.0.0.1:3008
export SIGNSERVICE_URL="http://127.0.0.1:$SIGN_PORT"
export VALIDATION_SERVICE_URL="http://127.0.0.1:$VALIDATE_PORT"
export SIGNSERVICE_TOKEN="$(random_token)"
export VALIDATION_SERVICE_TOKEN="$(random_token)"
export PORT="$API_PORT"
export E2E_API_PORT="$API_PORT"
export E2E_STUB_PORT="$STUB_PORT"
# The operator plane: reading metrics and reporting a backup are separate
# credentials, and the chain checks that they stay separate.
export METRICS_SCRAPE_TOKEN="$(random_token)$(random_token)"
export BACKUP_SIGNAL_TOKEN="$(random_token)$(random_token)"

# The external suppliers, served over HTTPS with a certificate made here. Both
# provider clients refuse a plaintext base URL, and that refusal is worth
# keeping, so the E2E works with it rather than around it.
if [[ ! -f "$E2E/stub-cert.pem" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -keyout "$E2E/stub-key.pem" -out "$E2E/stub-cert.pem" \
    -days 30 -subj "/CN=e2e-external-stubs" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1" >/dev/null 2>&1
fi
export NODE_EXTRA_CA_CERTS="$E2E/stub-cert.pem"
export EMAIL_PROVIDER=resend
export RESEND_BASE_URL="https://localhost:$STUB_PORT"
export RESEND_API_KEY="$(random_token)"
export RESEND_WEBHOOK_SECRET="$(random_token)"
export EMAIL_DEFAULT_FROM='Kommunsign E2E <e2e@kommunsign.invalid>'
export EMAIL_DEFAULT_REPLY_TO='Kommunsign E2E <e2e@kommunsign.invalid>'
export TIC_BANKID_ENABLED=true
export TIC_BASE_URL="https://localhost:$STUB_PORT"
export TIC_API_KEY="$(random_token)"
export TIC_CALLBACK_URL=https://sign.kommunsign.invalid/callback
export TIC_WEBHOOK_URL=https://api.kommunsign.invalid/v1/provider-webhooks/tic/bankid
export TIC_WEBHOOK_SECRET="$(random_token)"
log "secrets" "generated for this run only"

# ---------------------------------------------------------------------------
# 2. Signing credential and the Java services.
# ---------------------------------------------------------------------------
if [[ ! -f "$E2E/signer.p12" ]]; then
  keytool -genkeypair -alias e2e-ca -keyalg RSA -keysize 2048 -sigalg SHA256withRSA \
    -dname "CN=Kommunsign E2E Test CA,O=Kommunsign Test,C=SE" -validity 365 \
    -ext bc:c=ca:true -ext ku:c=keyCertSign,cRLSign \
    -keystore "$E2E/ca.p12" -storetype PKCS12 -storepass "$STORE_PASS" -keypass "$STORE_PASS" >/dev/null 2>&1
  keytool -exportcert -alias e2e-ca -keystore "$E2E/ca.p12" -storetype PKCS12 \
    -storepass "$STORE_PASS" -rfc -file "$E2E/ca.pem" >/dev/null 2>&1
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
fi
# The trust anchor the worker will accept. There is no fallback to the JDK's
# store anywhere in this system, deliberately.
export SIGNING_TRUST_ANCHORS_BASE64="$(grep -v -- '-----' "$E2E/ca.pem" | tr -d '\n')"
log "signing credential" "CA-issued signer under build/e2e-app"

if [[ ! -f "$ROOT/services/signservice/target/kommunsign-signservice.jar" ]]; then
  ( cd "$ROOT/services" && mvn -q -B package -DskipTests )
fi

stop_everything() {
  for name in api workers stubs; do
    [[ -f "$E2E/$name.pid" ]] && kill "$(cat "$E2E/$name.pid")" >/dev/null 2>&1 || true
  done
  pkill -f 'kommunsign-signservice\.jar' >/dev/null 2>&1 || true
  pkill -f 'kommunsign-validation-service\.jar' >/dev/null 2>&1 || true
}
trap stop_everything EXIT
stop_everything
sleep 1

(
  cd "$ROOT/services/signservice/target"
  PORT="$SIGN_PORT" APP_ENV=test \
  KOMMUNSIGN_SIGNING_BACKEND=SWEDEN_CONNECT KOMMUNSIGN_SIGNING_KEY_PROTECTION=SOFTWARE \
  KOMMUNSIGN_SIGNING_KEYSTORE_PATH="$E2E/signer.p12" KOMMUNSIGN_SIGNING_KEYSTORE_PASSWORD="$STORE_PASS" \
  KOMMUNSIGN_SIGNING_KEY_ALIAS=e2e-signer KOMMUNSIGN_SIGNING_KEY_PASSWORD="$STORE_PASS" \
  setsid nohup java -jar kommunsign-signservice.jar > "$E2E/signservice.log" 2>&1 < /dev/null &
)
(
  cd "$ROOT/services/validation-service/target"
  PORT="$VALIDATE_PORT" APP_ENV=test \
  setsid nohup java -jar kommunsign-validation-service.jar > "$E2E/validation.log" 2>&1 < /dev/null &
)

# A source PDF produced by PDFBox rather than hand-rolled: the pipeline runs it
# through qpdf and Gotenberg, and both are entitled to reject a file that a
# real converter would never emit.
if [[ ! -f "$E2E/source.pdf" ]]; then
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
fi
export E2E_SOURCE_PDF="$E2E/source.pdf"
log "source document" "$(stat -c%s "$E2E/source.pdf") bytes, produced by PDFBox"

# ---------------------------------------------------------------------------
# 3. Stubs, API and worker.
# ---------------------------------------------------------------------------
E2E_STUB_PORT="$STUB_PORT" E2E_STUB_DIR="$E2E" \
  setsid nohup node "$ROOT/scripts/e2e-external-stubs.mjs" > "$E2E/stubs.log" 2>&1 < /dev/null &
echo $! > "$E2E/stubs.pid"

KOMMUNSIGN_API_BOOTSTRAP_MODULE=../../dist/apps/api/src/production-runtime.js \
  setsid nohup node "$ROOT/apps/api/server.mjs" > "$E2E/api.log" 2>&1 < /dev/null &
echo $! > "$E2E/api.pid"

setsid nohup node "$ROOT/dist/apps/workers/src/production-runner.js" > "$E2E/workers.log" 2>&1 < /dev/null &
echo $! > "$E2E/workers.pid"

wait_for() {
  for _ in $(seq 1 40); do
    if curl -fsS --max-time 3 --cacert "$E2E/stub-cert.pem" "$2" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  echo "  $1 did not start" >&2
  tail -20 "$3" >&2
  exit 1
}
wait_for "sign service" "http://127.0.0.1:$SIGN_PORT/health" "$E2E/signservice.log"
wait_for "validation service" "http://127.0.0.1:$VALIDATE_PORT/health" "$E2E/validation.log"
wait_for "external stubs" "https://127.0.0.1:$STUB_PORT/health" "$E2E/stubs.log"
wait_for "api" "http://127.0.0.1:$API_PORT/health/ready" "$E2E/api.log"
if ! grep -q 'worker_runner_started\|worker_started\|"event":"worker' "$E2E/workers.log" 2>/dev/null; then
  sleep 3
fi
if grep -qi 'Error:' "$E2E/workers.log" 2>/dev/null; then
  echo '  worker failed to start' >&2
  head -20 "$E2E/workers.log" >&2
  exit 1
fi
log "processes" "api, worker, sign, validation, stubs"

# ---------------------------------------------------------------------------
# 4. The platform identity the chain acts as.
#
# Seeded directly because the real path issues it through the external identity
# provider, which is not present here. It is the one seam this script opens, and
# it opens no more than a subject with the roles the platform API checks.
# ---------------------------------------------------------------------------
# Wrapped in a CTE so psql returns the id alone: a bare INSERT ... RETURNING
# also prints its command tag, which lands in the variable.
E2E_PLATFORM_SUBJECT="$(psql "$CONTROL_DATABASE_URL" -tAc "
  with upserted as (
    insert into control.platform_subjects(id, external_subject, display_name)
    values (gen_random_uuid(), 'e2e-application-chain', 'E2E application chain')
    on conflict (external_subject) do update set display_name = excluded.display_name
    returning id
  )
  select id from upserted")"
for role in platform_super_admin onboarding_manager onboarding_case_worker provisioning_operator activation_approver tenant_admin_support; do
  psql "$CONTROL_DATABASE_URL" -tAc "
    insert into control.platform_role_assignments(platform_subject_id, role_key, granted_by)
    values ('$E2E_PLATFORM_SUBJECT', '$role', '$E2E_PLATFORM_SUBJECT')
    on conflict do nothing" >/dev/null 2>&1 || true
done
export E2E_PLATFORM_SUBJECT
log "platform subject" "$E2E_PLATFORM_SUBJECT"

echo
node "$ROOT/scripts/e2e-application-chain.mjs"

# The archive descriptor, through a schema processor rather than through the
# code that wrote it. Runs here because validation-service is already up.
echo
node "$ROOT/scripts/verify-fgs-package.mjs"
