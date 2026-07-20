#!/bin/bash
# gen-lan-cert.sh [--force] [EXTRA_SAN ...] — generate the self-signed TLS cert
# the LAN server.py uses for HTTPS (secure context; browser geolocation needs it).
# Writes cert.pem (644) + key.pem (600) under /root/.config/responder/tls, OUTSIDE
# the repo so the private key is never committed. Idempotent: skips when both files
# already exist unless --force. Default SANs cover the board host, loopback, and
# localhost; pass extra SANs (bare IP/host or a TYPE:value form) as args or via
# RESPONDER_TLS_EXTRA_SANS. See scripts/README.md "LAN HTTPS (self-signed)".
set -euo pipefail

CERT="${RESPONDER_TLS_CERT:-/root/.config/responder/tls/cert.pem}"
KEY="${RESPONDER_TLS_KEY:-/root/.config/responder/tls/key.pem}"
CN="${RESPONDER_TLS_CN:-responder-tx-lan}"
DAYS="${RESPONDER_TLS_DAYS:-3650}"

FORCE=0
EXTRA_SANS=()
for arg in "$@"; do
    case "$arg" in
        --force) FORCE=1 ;;
        -h|--help)
            echo "usage: gen-lan-cert.sh [--force] [EXTRA_SAN ...]"
            echo "  EXTRA_SAN: bare IP/hostname (auto-typed) or an explicit IP:/DNS: form"
            echo "  env: RESPONDER_TLS_CERT RESPONDER_TLS_KEY RESPONDER_TLS_CN"
            echo "       RESPONDER_TLS_DAYS RESPONDER_TLS_EXTRA_SANS"
            exit 0 ;;
        -*) echo "FAIL: unknown option: $arg (supported: --force)" >&2; exit 2 ;;
        *) EXTRA_SANS+=("$arg") ;;
    esac
done

if ! command -v openssl > /dev/null 2>&1; then
    echo "FAIL: openssl not found on PATH" >&2
    exit 1
fi

if [ -s "$CERT" ] && [ -s "$KEY" ] && [ "$FORCE" -eq 0 ]; then
    echo "cert + key already present, skipping (pass --force to regenerate):"
    echo "  cert: $CERT"
    echo "  key:  $KEY"
    openssl x509 -in "$CERT" -noout -fingerprint -sha256
    openssl x509 -in "$CERT" -noout -ext subjectAltName
    exit 0
fi

# san_of TOKEN — normalize an extra SAN: pass an explicit TYPE:value through, else
# auto-type a bare token (IPv4 dotted-quad -> IP:, anything else -> DNS:).
san_of() {
    local tok="$1"
    if [ "${tok#*:}" != "$tok" ]; then
        printf '%s' "$tok"
    elif [[ "$tok" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
        printf 'IP:%s' "$tok"
    else
        printf 'DNS:%s' "$tok"
    fi
}

SAN_LIST=(IP:192.168.2.250 IP:127.0.0.1 DNS:localhost)
if [ -n "${RESPONDER_TLS_EXTRA_SANS:-}" ]; then
    read -r -a env_sans <<< "${RESPONDER_TLS_EXTRA_SANS//,/ }"
    for tok in "${env_sans[@]}"; do
        [ -n "$tok" ] && SAN_LIST+=("$(san_of "$tok")")
    done
fi
for tok in "${EXTRA_SANS[@]}"; do
    SAN_LIST+=("$(san_of "$tok")")
done

SAN=$(IFS=,; echo "${SAN_LIST[*]}")

CERT_DIR=$(dirname "$CERT")
KEY_DIR=$(dirname "$KEY")
mkdir -p "$CERT_DIR" "$KEY_DIR"

# umask 077 so the freshly written key is never briefly group/world-readable
old_umask=$(umask)
umask 077

openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
    -keyout "$KEY" -out "$CERT" \
    -subj "/CN=${CN}" \
    -addext "subjectAltName=${SAN}"

umask "$old_umask"

chmod 600 "$KEY"
chmod 644 "$CERT"

echo "generated self-signed LAN cert (valid ${DAYS} days):"
echo "  cert: $CERT (644)"
echo "  key:  $KEY (600)"
echo "  CN:   $CN"
openssl x509 -in "$CERT" -noout -fingerprint -sha256
openssl x509 -in "$CERT" -noout -ext subjectAltName
