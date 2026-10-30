import Foundation

struct FavoriteStation: Codable, Hashable, Identifiable {
    let stationId: String
    let name: String
    let latitude: Double
    let longitude: Double
    var hiddenLines: [String]

    var id: String { stationId }

    func shows(line: String) -> Bool {
        !hiddenLines.contains(line)
    }
}
