"""HTTPS용 로컬 인증서.

- 로컬 CA 1개 + 서버 인증서 1개를 certs/ 에 만든다.
- CA에는 Name Constraints를 걸어서 localhost·이 PC 이름·사설 IP 대역에 대해서만
  인증서를 발급할 수 있게 제한 → CA 키가 유출돼도 google.com 같은 외부 사이트 위조 불가.
- 서버 인증서는 이 PC의 현재 사설 IP가 바뀌면 자동 재발급 (CA는 그대로라 재신뢰 불필요).
"""
import datetime as dt
import ipaddress
import socket
import ssl
import subprocess
import sys
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID

CERTS = Path(__file__).resolve().parent / "certs"
CA_CRT, CA_KEY = CERTS / "ca.crt", CERTS / "ca.key"
SRV_CRT, SRV_KEY = CERTS / "server.crt", CERTS / "server.key"

PRIVATE_NETS = [ipaddress.ip_network(n) for n in
                ("127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "::1/128")]


def _now():
    return dt.datetime.now(dt.timezone.utc)


def _hostname():
    return socket.gethostname().lower()


def _local_ips():
    ips = {ipaddress.ip_address("127.0.0.1"), ipaddress.ip_address("::1")}
    try:
        for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
            ips.add(ipaddress.ip_address(info[4][0]))
    except OSError:
        pass
    return {ip for ip in ips if any(ip in n for n in PRIVATE_NETS)}


def _write_key(path, key):
    path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
                                       serialization.PrivateFormat.PKCS8,
                                       serialization.NoEncryption()))


def _make_ca():
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, f"Web SSH Local CA ({_hostname()})")])
    permitted = [x509.DNSName("localhost"), x509.DNSName(_hostname())]
    permitted += [x509.IPAddress(n) for n in PRIVATE_NETS]
    cert = (x509.CertificateBuilder()
            .subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(_now() - dt.timedelta(days=1))
            .not_valid_after(_now() + dt.timedelta(days=3650))
            .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
            .add_extension(x509.KeyUsage(False, False, False, False, False, True, True, False, False), critical=True)
            .add_extension(x509.NameConstraints(permitted_subtrees=permitted, excluded_subtrees=None), critical=True)
            .add_extension(x509.SubjectKeyIdentifier.from_public_key(key.public_key()), critical=False)
            .sign(key, hashes.SHA256()))
    CERTS.mkdir(exist_ok=True)
    _write_key(CA_KEY, key)
    CA_CRT.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def _make_server(ips):
    ca_key = serialization.load_pem_private_key(CA_KEY.read_bytes(), None)
    ca = x509.load_pem_x509_certificate(CA_CRT.read_bytes())
    key = ec.generate_private_key(ec.SECP256R1())
    san = [x509.DNSName("localhost"), x509.DNSName(_hostname())] + [x509.IPAddress(i) for i in sorted(ips, key=str)]
    cert = (x509.CertificateBuilder()
            .subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")]))
            .issuer_name(ca.subject).public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(_now() - dt.timedelta(days=1))
            .not_valid_after(_now() + dt.timedelta(days=397))
            .add_extension(x509.SubjectAlternativeName(san), critical=False)
            .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
            .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
            .add_extension(x509.AuthorityKeyIdentifier.from_issuer_public_key(ca_key.public_key()), critical=False)
            .sign(ca_key, hashes.SHA256()))
    _write_key(SRV_KEY, key)
    SRV_CRT.write_bytes(cert.public_bytes(serialization.Encoding.PEM))


def _ca_matches_host():
    ca = x509.load_pem_x509_certificate(CA_CRT.read_bytes())
    nc = ca.extensions.get_extension_for_class(x509.NameConstraints).value
    return _hostname() in [n.value for n in nc.permitted_subtrees if isinstance(n, x509.DNSName)]


def _server_ok(ips):
    try:
        c = x509.load_pem_x509_certificate(SRV_CRT.read_bytes())
        have = set(c.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
                   .get_values_for_type(x509.IPAddress))
        return ips <= have and c.not_valid_after_utc - _now() > dt.timedelta(days=30)
    except Exception:
        return False


def ensure_certs():
    """인증서가 없거나 낡았으면 생성. 반환: CA를 새로 만들었는지."""
    new_ca = False
    if not (CA_CRT.exists() and CA_KEY.exists()) or not _ca_matches_host():
        _make_ca()
        new_ca = True
    ips = _local_ips()
    if new_ca or not _server_ok(ips):
        _make_server(ips)
    return new_ca


def ssl_context():
    ctx = ssl.create_default_context(ssl.Purpose.CLIENT_AUTH)
    ctx.minimum_version = ssl.TLSVersion.TLSv1_2
    ctx.load_cert_chain(SRV_CRT, SRV_KEY)
    return ctx


def ca_trusted():
    if sys.platform != "win32":
        return None
    der = x509.load_pem_x509_certificate(CA_CRT.read_bytes()).public_bytes(serialization.Encoding.DER)
    return any(c[0] == der for c in ssl.enum_certificates("ROOT"))


def trust_ca():
    """현재 사용자 '신뢰할 수 있는 루트'에 CA 등록 (Windows가 확인 창을 띄움)."""
    r = subprocess.run(["certutil", "-user", "-addstore", "Root", str(CA_CRT)],
                       capture_output=True, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return r.returncode == 0
