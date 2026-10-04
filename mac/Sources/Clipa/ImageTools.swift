import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Pixel helpers for the stream: a small grayscale thumbnail for change detection, and JPEG encoding.
enum ImageTools {
    /// The image drawn into a `width` x `height` grayscale thumbnail (area-averaged by Core Graphics).
    static func grayThumbnail(_ image: CGImage, width: Int, height: Int) -> [UInt8] {
        var pixels = [UInt8](repeating: 0, count: width * height)
        let space = CGColorSpaceCreateDeviceGray()
        pixels.withUnsafeMutableBytes { raw in
            guard let context = CGContext(
                data: raw.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width,
                space: space,
                bitmapInfo: CGImageAlphaInfo.none.rawValue
            ) else { return }
            context.interpolationQuality = .medium
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        return pixels
    }

    /// How many thumbnail cells moved by more than `threshold` gray levels.
    static func changedCells(_ a: [UInt8], _ b: [UInt8], threshold: Int) -> Int {
        guard a.count == b.count else { return Int.max }
        var changed = 0
        for index in 0..<a.count where abs(Int(a[index]) - Int(b[index])) > threshold {
            changed += 1
        }
        return changed
    }

    /// A copy of `image` in a plain 8-bit RGB bitmap, or nil when Core Graphics cannot make one.
    static func copy(_ image: CGImage) -> CGImage? {
        guard let context = bitmapContext(width: image.width, height: image.height) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: image.width, height: image.height))
        return context.makeImage()
    }

    /// `image` with the mouse pointer marked: a magenta ring (on a white halo, so it shows on any background) and a
    /// dot at the hotspot. `x` and `y` are normalised 0..1, origin top left. Nil when the bitmap cannot be made.
    static func markPointer(_ image: CGImage, x: Double, y: Double) -> CGImage? {
        let width = image.width
        let height = image.height
        guard width > 0, height > 0, let context = bitmapContext(width: width, height: height) else { return nil }
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        // Core Graphics counts y from the bottom.
        let w = CGFloat(width)
        let h = CGFloat(height)
        let cx: CGFloat = CGFloat(x) * w
        let cy: CGFloat = (1 - CGFloat(y)) * h
        let radius: CGFloat = max(8, 0.02 * w)
        let stroke: CGFloat = max(3, min(4, w / 360))
        let ring = CGRect(x: cx - radius, y: cy - radius, width: radius * 2, height: radius * 2)
        let magenta = CGColor(srgbRed: 1, green: 0, blue: 1, alpha: 1)
        let white = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 0.9)
        context.setStrokeColor(white)
        context.setLineWidth(stroke + 2)
        context.strokeEllipse(in: ring)
        context.setStrokeColor(magenta)
        context.setLineWidth(stroke)
        context.strokeEllipse(in: ring)
        let dot: CGFloat = max(2.5, stroke * 0.8)
        context.setFillColor(white)
        context.fillEllipse(in: CGRect(x: cx - dot - 1, y: cy - dot - 1, width: (dot + 1) * 2, height: (dot + 1) * 2))
        context.setFillColor(magenta)
        context.fillEllipse(in: CGRect(x: cx - dot, y: cy - dot, width: dot * 2, height: dot * 2))
        return context.makeImage()
    }

    private static func bitmapContext(width: Int, height: Int) -> CGContext? {
        let space = CGColorSpace(name: CGColorSpace.sRGB) ?? CGColorSpaceCreateDeviceRGB()
        return CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: space,
            bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue
        )
    }

    /// JPEG bytes of `image` at `quality` (0...1); the image is already scaled by ScreenCaptureKit.
    static func jpegData(_ image: CGImage, quality: Double) -> Data? {
        let data = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(data as CFMutableData, UTType.jpeg.identifier as CFString, 1, nil) else {
            return nil
        }
        let options = [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary
        CGImageDestinationAddImage(destination, image, options)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return data as Data
    }
}
