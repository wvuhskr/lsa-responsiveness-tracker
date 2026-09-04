// Display rounding only; exact nanoseconds remain in the JSON report.
export function formatDuration(nanoseconds) {
  if (nanoseconds === null) return "No data";
  const [whole, fraction] = nanoseconds.split(".");
  const halfNs = BigInt(whole) * 2n + (fraction === "5" ? 1n : 0n);
  const tenths = (halfNs + 100_000_000n) / 200_000_000n;
  if (tenths === 0n && halfNs > 0n) return "<0.1s";
  const seconds = tenths / 10n;
  const days = seconds / 86400n;
  const hours = seconds % 86400n / 3600n;
  const minutes = seconds % 3600n / 60n;
  const remainder = seconds % 60n;
  const decimal = tenths % 10n;
  return [days ? `${days}d` : "", hours ? `${hours}h` : "",
    minutes ? `${minutes}m` : "", `${remainder}${decimal ? `.${decimal}` : ""}s`]
    .filter(Boolean).join(" ");
}

export function formatContactTime(nanoseconds, timeZone) {
  const ns = BigInt(nanoseconds);
  const milliseconds = ns / 1_000_000n - (ns < 0n && ns % 1_000_000n ? 1n : 0n);
  return new Intl.DateTimeFormat("en-US", {
    timeZone, year: "numeric", month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit", second: "2-digit", timeZoneName: "short"
  }).format(new Date(Number(milliseconds)));
}
