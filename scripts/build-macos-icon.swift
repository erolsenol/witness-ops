import AppKit
import Foundation

guard CommandLine.arguments.count == 3 else {
  fputs("Usage: swift build-macos-icon.swift <source.svg> <output.icns>\n", stderr)
  exit(2)
}

let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
guard let image = NSImage(contentsOf: sourceURL) else {
  fputs("Unable to load app icon SVG at \(sourceURL.path)\n", stderr)
  exit(1)
}

let temporaryPNG = FileManager.default.temporaryDirectory
  .appendingPathComponent("witnessops-icon-\(UUID().uuidString).png")
do {
  try FileManager.default.createDirectory(at: outputURL.deletingLastPathComponent(), withIntermediateDirectories: true)
  guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: 512,
    pixelsHigh: 512,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else {
    throw NSError(domain: "WitnessOpsIcon", code: 1, userInfo: [NSLocalizedDescriptionKey: "Could not allocate the 512px app icon."])
  }

  NSGraphicsContext.saveGraphicsState()
  let context = NSGraphicsContext(bitmapImageRep: bitmap)
  NSGraphicsContext.current = context
  context?.imageInterpolation = .high
  image.draw(in: NSRect(x: 0, y: 0, width: 512, height: 512), from: .zero, operation: .copy, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()

  guard let png = bitmap.representation(using: .png, properties: [:]) else {
    throw NSError(domain: "WitnessOpsIcon", code: 2, userInfo: [NSLocalizedDescriptionKey: "Could not encode the app icon PNG."])
  }
  try png.write(to: temporaryPNG, options: .atomic)

  let sips = Process()
  sips.executableURL = URL(fileURLWithPath: "/usr/bin/sips")
  sips.arguments = ["-s", "format", "icns", temporaryPNG.path, "--out", outputURL.path]
  try sips.run()
  sips.waitUntilExit()
  guard sips.terminationStatus == 0 else {
    throw NSError(domain: "WitnessOpsIcon", code: Int(sips.terminationStatus), userInfo: [NSLocalizedDescriptionKey: "sips failed to create the macOS app icon."])
  }

  try FileManager.default.removeItem(at: temporaryPNG)
  print("Created \(outputURL.path)")
} catch {
  try? FileManager.default.removeItem(at: temporaryPNG)
  fputs("App icon generation failed: \(error.localizedDescription)\n", stderr)
  exit(1)
}
