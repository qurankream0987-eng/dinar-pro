/**
 * The only place DINAR reads the device location.
 *
 * One call per explicit user tap, via getCurrentPosition — never watchPosition,
 * polling, background reads or a read on page load. Only latitude, longitude and
 * accuracy are kept; altitude, heading and speed are discarded here. The reading is
 * handed straight to the conversation as a preview the user must confirm.
 */
export type OneTimeLocation =
  | { kind: "OK"; latitude: number; longitude: number; accuracyMeters: number }
  | { kind: "DENIED" | "UNAVAILABLE" | "TIMEOUT" };

export function readDeviceLocationOnce(): Promise<OneTimeLocation> {
  if (typeof navigator === "undefined" || !("geolocation" in navigator))
    return Promise.resolve({ kind: "UNAVAILABLE" });
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) =>
        resolve({
          kind: "OK",
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracyMeters: Math.round(position.coords.accuracy),
        }),
      (error) =>
        resolve({
          kind:
            error.code === error.PERMISSION_DENIED
              ? "DENIED"
              : error.code === error.TIMEOUT
                ? "TIMEOUT"
                : "UNAVAILABLE",
        }),
      // A fresh reading only; nothing cached from an earlier session is reused.
      { enableHighAccuracy: true, timeout: 15_000, maximumAge: 0 },
    );
  });
}
