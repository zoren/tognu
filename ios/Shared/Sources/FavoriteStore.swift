import Foundation
import Combine

enum AppGroup {
    static let id = "group.dk.zoren.tognu"
}

@MainActor
final class FavoriteStore: ObservableObject {
    static let shared = FavoriteStore()

    @Published private(set) var favorites: [FavoriteStation]

    private let defaults: UserDefaults
    private let key = "favorites.v1"

    private init() {
        self.defaults = UserDefaults(suiteName: AppGroup.id) ?? .standard
        if let data = defaults.data(forKey: key),
           let decoded = try? JSONDecoder().decode([FavoriteStation].self, from: data) {
            self.favorites = decoded
        } else {
            self.favorites = []
        }
    }

    func contains(_ stationId: String) -> Bool {
        favorites.contains { $0.stationId == stationId }
    }

    func favorite(for stationId: String) -> FavoriteStation? {
        favorites.first { $0.stationId == stationId }
    }

    func upsert(_ favorite: FavoriteStation) {
        if let idx = favorites.firstIndex(where: { $0.stationId == favorite.stationId }) {
            favorites[idx] = favorite
        } else {
            favorites.append(favorite)
        }
        persist()
    }

    func remove(stationId: String) {
        favorites.removeAll { $0.stationId == stationId }
        persist()
    }

    private func persist() {
        if let data = try? JSONEncoder().encode(favorites) {
            defaults.set(data, forKey: key)
        }
    }
}
