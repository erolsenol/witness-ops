module.exports = {
  packagerConfig: {
    name: "WitnessOps",
    appBundleId: "com.erolsenol.witnessops",
    icon: "./assets/witnessops",
    asar: true,
    extraResource: ["build/agent"],
  },
  makers: [{ name: "@electron-forge/maker-zip", platforms: ["darwin"] }],
};
