export function parseReleaseOptions(args) {
  const options = args[0] === "--" ? args.slice(1) : args;
  let notesPath = null;
  let dryRun = false;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option === "--notes") notesPath = options[++index] ?? null;
    else if (option === "--dry-run") dryRun = true;
    else throw new Error(`Unknown release option: ${option}`);
  }
  if (!notesPath) throw new Error("Usage: pnpm release:github -- --notes PATH [--dry-run]");
  return { notesPath, dryRun };
}

export function getReleaseTag(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error(`Invalid package version: ${version}`);
  return `v${version}`;
}

export function getChecksumName(version) {
  const suffix = version.includes("-") ? version.slice(version.indexOf("-") + 1) : version;
  return `SHA256SUMS-${suffix}`;
}
