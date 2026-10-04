import AppKit
import CoreGraphics

/// Pixel helpers: difference hash (change detection), downscale, JPEG.
enum ImageTools {
    static let hashColumns = 16

    /// 16x16 = 256-bit difference hash: shrink to 17x16 grayscale, compare each pixel to its right neighbour.
    /// Robust to compression noise and tiny changes, sensitive to windows, dialogs, page changes.
    static func differenceHash(_ image: CGImage) -> [UInt64] {
        let width = hashColumns + 1
        let height = hashColumns
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
            context.interpolationQuality = .high
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        }
        var bits = [UInt64](repeating: 0, count: (hashColumns * height + 63) / 64)
        var index = 0
        for row in 0..<height {
            for column in 0..<hashColumns {
                if pixels[row * width + column] > pixels[row * width + column + 1] {
                    bits[index / 64] |= (UInt64(1) << UInt64(index % 64))
                }
                index += 1
            }
        }
        return bits
    }

    static func hamming(_ a: [UInt64], _ b: [UInt64]) -> Int {
        var total = 0
        for (x, y) in zip(a, b) {
            total += (x ^ y).nonzeroBitCount
        }
        return total
    }

    static func downscaled(_ image: CGImage, maxDimension: Int) -> CGImage? {
        let longest = max(image.width, image.height)
        guard longest > maxDimension else { return image }
        let scale = Double(maxDimension) / Double(longest)
        let newWidth = max(1, Int(Double(image.width) * scale))
        let newHeight = max(1, Int(Double(image.height) * scale))
        guard let context = CGContext(
            data: nil,
            width: newWidth,
            height: newHeight,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
        ) else { return nil }
        context.interpolationQuality = .high
        context.draw(image, in: CGRect(x: 0, y: 0, width: newWidth, height: newHeight))
        return context.makeImage()
    }

    static func jpegData(_ image: CGImage, maxDimension: Int, quality: Double) -> Data? {
        guard let small = downscaled(image, maxDimension: maxDimension) else { return nil }
        let rep = NSBitmapImageRep(cgImage: small)
        return rep.representation(using: .jpeg, properties: [.compressionFactor: quality])
    }
}
