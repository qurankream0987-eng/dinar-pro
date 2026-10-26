import { checkServerIdentity, type ConnectionOptions } from "node:tls";

// Public CA, independently authenticated via Railway's service access.
// This is NOT a password or private key. Replacing the volume requires re-verification.
export const developmentCa = `-----BEGIN CERTIFICATE-----
MIIDBTCCAe2gAwIBAgIUQen/QtFgb76tmoV4yCY+JbttlfowDQYJKoZIhvcNAQEL
BQAwEjEQMA4GA1UEAwwHcm9vdC1jYTAeFw0yNjEwMDgxMTE0MzNaFw0yOTAxMDUx
MTE0MzNaMBIxEDAOBgNVBAMMB3Jvb3QtY2EwggEiMA0GCSqGSIb3DQEBAQUAA4IB
DwAwggEKAoIBAQCvM1vyBIKpKOG7RwV1c2FCaRLW8ySLxd03+JutwdgDQa+VSFIv
VgD7z+Yil+vTqylQsB51Gwq0WMI4EO9rlkGBf/EiJGcoHbciayxb3xpb7NGvYH6U
t2nLY86iTOjnLp5XtVa8ZkLVdy5yowXW9zK5RwaJAQlhyYvleUej8McPEF2hchpQ
PcSpqToyQifYbmd1p+Ci/eOQjl6x07n63qHVc6NU+EsG4X3F7EXqMe0W7bqt4GA0
j8FTql/e4dfUV9OqTw3Z0XZXpgz2JZQ0cEhA8iFRV20YaUgOmMjjuByt/P7ZwiPD
XgbbKesRdv+l2jYC8jYGLoiSBhKp9LTz3OC7AgMBAAGjUzBRMB0GA1UdDgQWBBQr
5Akukf/a0o6PXxy3cnVf4wR4YzAfBgNVHSMEGDAWgBQr5Akukf/a0o6PXxy3cnVf
4wR4YzAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUAA4IBAQBM+FWVB/nd
FNItSfIB4k+8WPw+JwtwMCHsCoFBYT7bGa7moMX2SSWoodndrqmXHQxoHoVz4hlt
B7pPUoHG/pEHmYDzPP99hlmpLXlT2ixL++NL9BqUB87DWr+RrSW6oe1eyQif6yWo
8sIhjKNF/yylBvAzTXhV/H1VcKSS2xL7NV9A8gK6I9uab6/YZfGuZqTI11/ohQ8I
9uEGygcFT15WbXem4yzrm7Nx47zWbSZGgnSSwwLyQEj875fijzHbe4/BsXQ3nvjo
KEwlhP3ZiRYS8LCuMGlL5rH+lCl0yy/OjW+Z8V0BtpY9+uuxhf+E3LQiPocmD1Un
WIX9fKnKfnPk
-----END CERTIFICATE-----`;

export const developmentServerIdentity = "postgres-57f7f853.railway.internal";

export function verifiedDevelopmentCredentials(
  connectionString: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (env.NODE_ENV !== "development" ||
      connectionString !== env.DINAR_DEV_DATABASE_URL) {
    throw new Error("Verified development credentials require the development override.");
  }
  let url: URL;
  try { url = new URL(connectionString); } catch {
    throw new Error("Invalid development database URI.");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      url.hostname !== "iriguchi.proxy.rlwy.net" || url.port !== "18992" ||
      !url.username || !url.password || url.pathname.length <= 1) {
    throw new Error("Development database endpoint does not match the authenticated Railway service.");
  }
  // Reject unhandled options rather than silently discard connection semantics.
  if ([...url.searchParams.keys()].some(key => key !== "sslmode") ||
      (url.searchParams.has("sslmode") && url.searchParams.get("sslmode") !== "verify-full")) {
    throw new Error("Unsupported development connection options; verified TLS is required.");
  }
  const ssl: ConnectionOptions = {
    ca: developmentCa,
    rejectUnauthorized: true,
    minVersion: "TLSv1.2",
    checkServerIdentity: (_proxyHostname, certificate) =>
      checkServerIdentity(developmentServerIdentity, certificate),
  };
  return {
    host: url.hostname,
    port: Number(url.port),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    ssl,
  };
}
