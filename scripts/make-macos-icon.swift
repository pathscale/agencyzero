#!/usr/bin/env swift
//
// Rebuild the macOS app icon from a square source image.
//
//   scripts/make-macos-icon.swift <source.png> <out.iconset>
//
// macOS does not round app icons. Every other icon in the Dock is a squircle
// because its artwork *is* one, drawn with transparent margins on a 1024 grid;
// a full-bleed square PNG is shown exactly as supplied, which is why ours reads
// as a plain square wedged between rounded neighbours. Apple's macOS grid puts
// the shape at 824/1024 of the canvas, so the margin is not decoration either:
// it is the space the system expects for shadow and hover growth.
//
// The shape is a continuous-curvature superellipse rather than a rounded rect.
// A plain corner radius is visibly wrong beside real icons: the curvature jumps
// where the arc meets the straight edge, and at icon sizes that reads as a
// cheap imitation of the platform shape.
//
// The artwork is not redesigned here. The source is drawn to fill the shape and
// clipped to it, so the gradient and the ring stay exactly as they were.

import AppKit
import CoreGraphics
import Foundation

let arguments = CommandLine.arguments
guard arguments.count == 3 else {
    FileHandle.standardError.write("usage: make-macos-icon.swift <source.png> <out.iconset>\n".data(using: .utf8)!)
    exit(2)
}
let sourcePath = arguments[1]
let outputPath = arguments[2]

guard let source = NSImage(contentsOfFile: sourcePath),
      let sourceCG = source.cgImage(forProposedRect: nil, context: nil, hints: nil)
else {
    FileHandle.standardError.write("could not read \(sourcePath)\n".data(using: .utf8)!)
    exit(1)
}

/// Apple's macOS icon grid: the shape occupies 824 of a 1024 canvas.
let contentRatio = 824.0 / 1024.0
/// The superellipse exponent Apple's shape approximates.
let squircleExponent = 5.0

/// A continuous-curvature squircle inscribed in `rect`.
func squircle(in rect: CGRect, steps: Int = 720) -> CGPath {
    let path = CGMutablePath()
    let a = rect.width / 2
    let b = rect.height / 2
    let cx = rect.midX
    let cy = rect.midY
    for step in 0...steps {
        let t = Double(step) / Double(steps) * 2 * Double.pi
        let cosT = cos(t)
        let sinT = sin(t)
        // |x/a|^n + |y/b|^n = 1, parameterised so the sign follows the angle.
        let x = cx + a * pow(abs(cosT), 2 / squircleExponent) * (cosT < 0 ? -1 : 1)
        let y = cy + b * pow(abs(sinT), 2 / squircleExponent) * (sinT < 0 ? -1 : 1)
        if step == 0 { path.move(to: CGPoint(x: x, y: y)) } else { path.addLine(to: CGPoint(x: x, y: y)) }
    }
    path.closeSubpath()
    return path
}

func render(size: Int) -> Data? {
    let canvas = CGFloat(size)
    guard let context = CGContext(
        data: nil,
        width: size,
        height: size,
        bitsPerComponent: 8,
        bytesPerRow: 0,
        space: CGColorSpace(name: CGColorSpace.sRGB)!,
        bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
    ) else { return nil }

    context.interpolationQuality = .high
    context.clear(CGRect(x: 0, y: 0, width: canvas, height: canvas))

    let content = canvas * contentRatio
    let inset = (canvas - content) / 2
    let shape = CGRect(x: inset, y: inset, width: content, height: content)

    context.addPath(squircle(in: shape))
    context.clip()
    // The source is square and fills the shape's bounding box, so the ring
    // keeps its position relative to the artwork rather than being re-centred.
    context.draw(sourceCG, in: shape)

    guard let image = context.makeImage() else { return nil }
    let rep = NSBitmapImageRep(cgImage: image)
    return rep.representation(using: .png, properties: [:])
}

let manager = FileManager.default
try? manager.createDirectory(atPath: outputPath, withIntermediateDirectories: true)

// The set `iconutil` expects; anything missing falls back to a scaled
// neighbour, and the 16pt sizes are the ones that show it.
let variants: [(name: String, size: Int)] = [
    ("icon_16x16.png", 16), ("icon_16x16@2x.png", 32),
    ("icon_32x32.png", 32), ("icon_32x32@2x.png", 64),
    ("icon_128x128.png", 128), ("icon_128x128@2x.png", 256),
    ("icon_256x256.png", 256), ("icon_256x256@2x.png", 512),
    ("icon_512x512.png", 512), ("icon_512x512@2x.png", 1024),
]

for variant in variants {
    guard let data = render(size: variant.size) else {
        FileHandle.standardError.write("could not render \(variant.name)\n".data(using: .utf8)!)
        exit(1)
    }
    try data.write(to: URL(fileURLWithPath: "\(outputPath)/\(variant.name)"))
}
print("wrote \(variants.count) sizes to \(outputPath)")
