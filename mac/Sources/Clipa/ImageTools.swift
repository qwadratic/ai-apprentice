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
