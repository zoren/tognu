import Foundation

struct Station: Codable, Hashable, Identifiable {
    let id: String
    let name: String
    let latitude: Double
    let longitude: Double
}

enum StationCatalog {
    static let all: [Station] = {
        guard let url = Bundle.main.url(forResource: "stations", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let stations = try? JSONDecoder().decode([Station].self, from: data)
        else {
            assertionFailure("stations.json missing or malformed")
            return []
        }
        return stations.sorted { $0.name.localizedCompare($1.name) == .orderedAscending }
    }()

    static func lookup(_ id: String) -> Station? {
        all.first { $0.id == id }
    }
}
