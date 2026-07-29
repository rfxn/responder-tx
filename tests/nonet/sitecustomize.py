"""tests/nonet/sitecustomize.py — the test gate's network trap.

Python imports this automatically from PYTHONPATH, before any test code, and PYTHONPATH is
inherited by the generator subprocesses the suites spawn, so it covers the indirect paths too.
A blocked reach both raises and appends to RESPONDER_NONET_LOG: the generators deliberately
swallow fetch errors and record them as misses (CLAUDE.md E1), so raising alone would let a
violation pass as a normal degraded run. tests/run.sh fails the run on a non-empty ledger.
"""
import os
import socket
import sys
import traceback

RESPONDER_NONET = True

_LOG = os.environ.get("RESPONDER_NONET_LOG")
_LOCAL_NAMES = frozenset(("", "localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"))


def _is_local(host):
    if host is None:
        return True
    if isinstance(host, (bytes, bytearray)):
        host = bytes(host).decode("utf-8", "replace")
    host = str(host).strip("[]").lower()
    return (host in _LOCAL_NAMES or host.startswith("127.")
            or host in ("::1", "0.0.0.0", "::", "0:0:0:0:0:0:0:1"))


class NetworkReached(OSError):
    """An OSError so client code meets the failure shape it already handles; the ledger below
    is what survives a caller that swallows it."""


def _blocked(target):
    entry = "network reached: %s\n  argv: %s\n%s" % (
        target, " ".join(sys.argv), "".join(traceback.format_stack(limit=14)[:-2]))
    if _LOG:
        with open(_LOG, "a", encoding="utf-8") as f:
            f.write(entry + "\n")
    return NetworkReached("blocked by the test gate's network trap: %s" % target)


_real_getaddrinfo = socket.getaddrinfo
_real_connect = socket.socket.connect
_real_connect_ex = socket.socket.connect_ex


def _guard_getaddrinfo(host, *args, **kwargs):
    if not _is_local(host):
        raise _blocked("getaddrinfo %r" % (host,))
    return _real_getaddrinfo(host, *args, **kwargs)


def _check(sock, address):
    if sock.family not in (socket.AF_INET, socket.AF_INET6):
        return
    if not _is_local(address[0] if isinstance(address, tuple) else address):
        raise _blocked("connect %r" % (address,))


def _guard_connect(self, address):
    _check(self, address)
    return _real_connect(self, address)


def _guard_connect_ex(self, address):
    _check(self, address)
    return _real_connect_ex(self, address)


socket.getaddrinfo = _guard_getaddrinfo
socket.socket.connect = _guard_connect
socket.socket.connect_ex = _guard_connect_ex
