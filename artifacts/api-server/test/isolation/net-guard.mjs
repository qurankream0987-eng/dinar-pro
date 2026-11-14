// Preloaded into every Node process of an isolation session (NODE_OPTIONS=--import).
// The network namespace already makes non-loopback hosts unreachable; this guard makes
// each attempt visible: it is refused here and appended to DINAR_ISOLATION_NET_LOG, and
// the session fails if that log is non-empty.
import { appendFileSync } from "node:fs";
import dns from "node:dns";
import net from "node:net";

const log = process.env.DINAR_ISOLATION_NET_LOG;
// Wildcard addresses appear when servers listen (Vite binds 0.0.0.0); inside the namespace
// they can only reach loopback.
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "::ffff:127.0.0.1", "0.0.0.0", "::"]);

function record(kind, target) {
  const line = JSON.stringify({ at: new Date().toISOString(), pid: process.pid, kind, target: String(target) });
  if (log) appendFileSync(log, `${line}\n`);
  return Object.assign(new Error(`ISOLATION: outbound ${kind} to ${target} refused`), { code: "EISOLATION" });
}

const isLoopback = (host) => host === undefined || host === null || LOOPBACK.has(String(host).toLowerCase()) || /^127\./.test(String(host));

const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function connect(...args) {
  // net.connect()/tls.connect() hand the socket an already-normalized [options, callback] array.
  const first = Array.isArray(args[0]) ? args[0][0] : args[0];
  const options = typeof first === "object" && first !== null && !Array.isArray(first) ? first : undefined;
  const host = options ? options.host : typeof args[1] === "string" ? args[1] : undefined;
  const isPipe = options ? typeof options.path === "string" : typeof first === "string" && Number.isNaN(Number(first));
  // A hostname that the in-process resolver (the guarded dns.lookup below, or a test's own
  // loopback hook) maps to loopback is allowed: the socket then connects only to the addresses
  // checked here. Any non-loopback answer is refused and recorded, exactly as before.
  if (!isPipe && options && typeof host === "string" && !isLoopback(host) && !net.isIP(host) && !options.lookup) {
    const socket = this;
    const guardedLookup = (hostname, lookupOptions, callback) => {
      dns.lookup(hostname, lookupOptions, (error, address, family) => {
        if (error) return callback(error);
        const addresses = Array.isArray(address) ? address.map((entry) => entry.address) : [address];
        if (addresses.length === 0 || !addresses.every((value) => isLoopback(value))) {
          const refused = record("tcp", `${hostname}:${options.port}`);
          process.nextTick(() => socket.destroy(refused));
          return callback(refused);
        }
        callback(null, address, family);
      });
    };
    options.lookup = guardedLookup;
    return originalConnect.apply(this, args);
  }
  if (!isPipe && !isLoopback(host)) {
    const error = record("tcp", `${host}:${options ? options.port : first}`);
    process.nextTick(() => this.destroy(error));
    return this;
  }
  return originalConnect.apply(this, args);
};

for (const target of [dns, dns.promises]) {
  const originalLookup = target.lookup;
  target.lookup = function lookup(hostname, ...rest) {
    if (!isLoopback(hostname)) {
      const error = record("dns", hostname);
      if (target === dns.promises) return Promise.reject(error);
      const callback = rest.find((value) => typeof value === "function");
      process.nextTick(() => callback?.(error));
      return undefined;
    }
    return originalLookup.call(this, hostname, ...rest);
  };
}
