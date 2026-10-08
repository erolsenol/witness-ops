const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(?:-[a-z0-9.-]+)?$/.test(version)) {
  throw new Error("Provide a valid package version.");
}
const response = await fetch(`https://registry.npmjs.org/@erol.senol%2fwitness-ops/${version}`, {
  signal: AbortSignal.timeout(10_000),
});
if (!response.ok) throw new Error(`npm registry returned ${response.status}.`);
const metadata = await response.json();
if (metadata.version !== version) throw new Error("Registry version mismatch.");
if (metadata._npmUser?.name !== "erol.senol") throw new Error("Unexpected npm publisher.");
if (typeof metadata.dist?.integrity !== "string") throw new Error("Registry integrity is missing.");
if (process.env.GITHUB_SHA && metadata.gitHead !== process.env.GITHUB_SHA) throw new Error("Registry source commit mismatch.");
