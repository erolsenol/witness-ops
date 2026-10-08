export function httpProbeCheckId(name: string): string {
  const id = name
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `http.${id || "probe"}`;
}
