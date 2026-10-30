import Foundation

struct Departure: Codable, Hashable {
    let line: String
    let trainNumber: String
    let stationId: String
    let aimedTime: String?
    let expectedTime: String?
    let destination: String
    let destinationStationId: String?
    let track: String?

    var epoch: TimeInterval? {
        let iso = expectedTime ?? aimedTime
        guard let iso else { return nil }
        return ISO8601Parser.parse(iso)?.timeIntervalSince1970
    }
}

enum ISO8601Parser {
    private static let withFraction: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let basic: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        return f
    }()

    static func parse(_ s: String) -> Date? {
        withFraction.date(from: s) ?? basic.date(from: s)
    }
}

enum DepartureProjection {
    /// Mirror of web `upcoming`: filter to now-60s forward, cap 2 per destination.
    static func upcoming(_ list: [Departure], now: Date = .now) -> [Departure] {
        let cutoff = now.timeIntervalSince1970 - 60
        let sorted = list
            .filter { ($0.epoch ?? 0) >= cutoff }
            .sorted { ($0.epoch ?? 0) < ($1.epoch ?? 0) }
        var counts: [String: Int] = [:]
        var out: [Departure] = []
        for d in sorted {
            let key = d.destinationStationId ?? d.destination
            let n = counts[key] ?? 0
            if n >= 2 { continue }
            counts[key] = n + 1
            out.append(d)
        }
        return out
    }
}
