import pino from "pino";

const isProduction = process.env.NODE_ENV === "production";

export function serializeSafeError(value: unknown) {
  if (!value || typeof value !== "object") return { type: "Error" };

  const error = value as { name?: unknown; code?: unknown };
  const name =
    typeof error.name === "string" &&
    /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(error.name)
      ? error.name
      : "Error";
  const code =
    typeof error.code === "string" &&
    /^[A-Za-z0-9_-]{1,64}$/.test(error.code)
      ? error.code
      : undefined;

  return { type: name, ...(code ? { code } : {}) };
}

export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
  serializers: {
    // Database and provider errors can embed SQL, bound values, location data,
    // or credentials in message/stack fields. Keep only bounded metadata.
    err: serializeSafeError,
  },
  redact: [
    "req.headers.authorization",
    "req.headers.cookie",
    "res.headers['set-cookie']",
    "err.query",
    "err.params",
    "err.detail",
    "err.where",
    "err.cause.query",
    "err.cause.params",
    "err.cause.detail",
    "err.cause.where",
  ],
  ...(isProduction
    ? {}
    : {
        transport: {
          target: "pino-pretty",
          options: { colorize: true },
        },
      }),
});
