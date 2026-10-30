import SwiftUI

@main
struct TognuApp: App {
    @StateObject private var favorites = FavoriteStore.shared

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(favorites)
        }
    }
}
