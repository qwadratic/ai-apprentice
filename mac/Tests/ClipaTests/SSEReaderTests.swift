import XCTest
@testable import Clipa

/// A byte-at-a-time async sequence over fixed data, standing in for `URLSession.AsyncBytes` in tests: this is
/// exactly why `SSEReader.read` was generalized to `some AsyncSequence<UInt8>` instead of the concrete network type.
private struct ByteSequence: AsyncSequence {
    typealias Element = UInt8
    let bytes: [UInt8]

    struct AsyncIterator: AsyncIteratorProtocol {
        var index = 0
        let bytes: [UInt8]
        mutating func next() async -> UInt8? {
            guard index < bytes.count else { return nil }
            defer { index += 1 }
            return bytes[index]
        }
    }

    func makeAsyncIterator() -> AsyncIterator { AsyncIterator(bytes: bytes) }
}

/// `SSEReader.read` parses `event:`/`data:` lines into (event, data) pairs on the blank line that ends each one,
/// skipping `:` comment (keepalive) lines. The handler is `@MainActor`, like the real cue dispatch; running the
/// whole test class on the main actor keeps that call unambiguous.
@MainActor
final class SSEReaderTests: XCTestCase {
    private func read(_ text: String) async throws -> [(event: String, data: String)] {
        var events: [(event: String, data: String)] = []
        try await SSEReader.read(ByteSequence(bytes: Array(text.utf8))) { event, data in
            events.append((event, data))
        }
        return events
    }

    func testOneNamedEventWithData() async throws {
        let events = try await read("event: cue\ndata: {\"a\":1}\n\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].event, "cue")
        XCTAssertEqual(events[0].data, "{\"a\":1}")
    }

    func testUnnamedEventDefaultsToMessage() async throws {
        let events = try await read("data: hello\n\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].event, "message")
        XCTAssertEqual(events[0].data, "hello")
    }

    func testCommentLinesAreSkipped() async throws {
        let events = try await read(": ping\nevent: cue\ndata: hi\n\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].event, "cue")
        XCTAssertEqual(events[0].data, "hi")
    }

    func testMultipleDataLinesJoinWithNewline() async throws {
        let events = try await read("event: cue\ndata: line1\ndata: line2\n\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].data, "line1\nline2")
    }

    func testTwoEventsInOneStream() async throws {
        let events = try await read("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n")
        XCTAssertEqual(events.map(\.event), ["a", "b"])
        XCTAssertEqual(events.map(\.data), ["1", "2"])
    }

    func testAnEventWithNoDataLineIsNeverDispatched() async throws {
        // The reader only calls the handler when `data` is non-empty.
        let events = try await read("event: cue\n\n")
        XCTAssertEqual(events.count, 0)
    }

    func testCarriageReturnLineEndingsAreHandled() async throws {
        let events = try await read("event: cue\r\ndata: hi\r\n\r\n")
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(events[0].event, "cue")
        XCTAssertEqual(events[0].data, "hi")
    }
}
