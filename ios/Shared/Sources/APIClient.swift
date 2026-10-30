import Foundation

enum APIConfig {
    static let baseURL = URL(string: "https://tognu.zoren.dk")!
}

struct APIClient {
    let baseURL: URL

    init(baseURL: URL = APIConfig.baseURL) {
        self.baseURL = baseURL
    }

    func state(stations: [String]) async throws -> [String: [Departure]] {
        var comps = URLComponents(url: baseURL.appendingPathComponent("api/state"), resolvingAgainstBaseURL: false)!
        comps.queryItems = [URLQueryItem(name: "stations", value: stations.joined(separator: ","))]
        let (data, _) = try await URLSession.shared.data(from: comps.url!)
        return try JSONDecoder().decode([String: [Departure]].self, from: data)
    }
}
