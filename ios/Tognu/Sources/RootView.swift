import SwiftUI

struct RootView: View {
    @EnvironmentObject private var favorites: FavoriteStore

    @State private var query = ""
    @State private var state: [String: [Departure]] = [:]
    @State private var tick = Date()

    private let api = APIClient()

    private var searchMatches: [Station] {
        let q = query.trimmingCharacters(in: .whitespaces).lowercased()
        guard !q.isEmpty else { return [] }
        return StationCatalog.all
            .filter { $0.name.lowercased().contains(q) }
            .prefix(10)
            .map { $0 }
    }

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 0, pinnedViews: []) {
                TopBar(query: $query)

                if !searchMatches.isEmpty {
                    SearchResults(
                        matches: searchMatches,
                        isFavorited: { favorites.contains($0.id) },
                        onAdd: addFavorite
                    )
                }

                if favorites.favorites.isEmpty && query.trimmingCharacters(in: .whitespaces).isEmpty {
                    Text("Søg efter en station ovenfor og vælg den for at tilføje til dine favoritter.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                        .padding(24)
                } else {
                    ForEach(favorites.favorites) { fav in
                        StationCard(
                            favorite: fav,
                            departures: state[fav.stationId] ?? [],
                            now: tick,
                            onRemove: { favorites.remove(stationId: fav.stationId) },
                            onToggleLine: { toggleLine($0, for: fav) }
                        )
                    }
                }
            }
        }
        .frame(maxWidth: .infinity)
        .background(Color(.systemBackground))
        .task { await refresh() }
        .task(id: favIdsKey) { await refresh() }
        .task {
            for await _ in Timer.publish(every: 15, on: .main, in: .common).autoconnect().values {
                tick = Date()
                await refresh()
            }
        }
    }

    private var favIdsKey: String {
        favorites.favorites.map(\.stationId).joined(separator: ",")
    }

    private func addFavorite(_ station: Station) {
        favorites.upsert(FavoriteStation(
            stationId: station.id,
            name: station.name,
            latitude: station.latitude,
            longitude: station.longitude,
            hiddenLines: []
        ))
        query = ""
    }

    private func toggleLine(_ line: String, for fav: FavoriteStation) {
        var updated = fav
        var hidden = Set(updated.hiddenLines)
        if hidden.contains(line) { hidden.remove(line) } else { hidden.insert(line) }
        updated.hiddenLines = hidden.sorted()
        favorites.upsert(updated)
    }

    private func refresh() async {
        let ids = favorites.favorites.map(\.stationId)
        guard !ids.isEmpty else {
            state = [:]
            return
        }
        if let fresh = try? await api.state(stations: ids) {
            state = fresh
        }
    }
}

private struct TopBar: View {
    @Binding var query: String

    var body: some View {
        HStack(spacing: 12) {
            Text("S-tog")
                .font(.title3).bold()
                .tracking(-0.5)
            TextField("Søg station…", text: $query)
                .textFieldStyle(.plain)
                .padding(.horizontal, 12)
                .padding(.vertical, 10)
                .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator), lineWidth: 1))
                .autocorrectionDisabled()
                .textInputAutocapitalization(.never)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .background(Color(.secondarySystemBackground))
        .overlay(alignment: .bottom) {
            Divider()
        }
    }
}

private struct SearchResults: View {
    let matches: [Station]
    let isFavorited: (Station) -> Bool
    let onAdd: (Station) -> Void

    var body: some View {
        VStack(spacing: 4) {
            ForEach(matches) { station in
                let added = isFavorited(station)
                Button {
                    if !added { onAdd(station) }
                } label: {
                    HStack {
                        Text(station.name)
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(added ? Color.secondary : Color.primary)
                        Spacer()
                        if added {
                            Text("tilføjet")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(added ? Color(.secondarySystemFill) : Color(.systemBackground),
                                in: RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Color(.separator), lineWidth: 1))
                }
                .buttonStyle(.plain)
                .disabled(added)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity)
        .background(Color(.secondarySystemBackground))
        .overlay(alignment: .bottom) { Divider() }
    }
}

private struct StationCard: View {
    let favorite: FavoriteStation
    let departures: [Departure]
    let now: Date
    let onRemove: () -> Void
    let onToggleLine: (String) -> Void

    private var allLines: [String] {
        let hidden = Set(favorite.hiddenLines)
        let present = Set(departures.map(\.line))
        return Array(hidden.union(present)).sorted()
    }

    private var visible: [Departure] {
        let hidden = Set(favorite.hiddenLines)
        return DepartureProjection.upcoming(
            departures.filter { !hidden.contains($0.line) },
            now: now
        )
    }

    var body: some View {
        VStack(spacing: 0) {
            HStack(alignment: .center, spacing: 10) {
                Text(favorite.name)
                    .font(.title2.weight(.bold))
                    .tracking(-0.4)
                Spacer()
                Button(action: onRemove) {
                    Text("×")
                        .font(.system(size: 26, weight: .regular))
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 2)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Fjern")
            }
            .padding(.horizontal, 20)
            .padding(.top, 14)
            .padding(.bottom, 8)

            if allLines.count > 1 {
                HStack(spacing: 6) {
                    ForEach(allLines, id: \.self) { line in
                        let off = favorite.hiddenLines.contains(line)
                        Button { onToggleLine(line) } label: {
                            LineBadge(line: line, size: .chip)
                                .opacity(off ? 0.3 : 1)
                        }
                        .buttonStyle(.plain)
                    }
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 10)
            }

            VStack(spacing: 0) {
                if visible.isEmpty {
                    Text("Ingen kommende afgange")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .padding(.vertical, 24)
                        .frame(maxWidth: .infinity)
                } else {
                    ForEach(Array(visible.enumerated()), id: \.offset) { index, d in
                        DepartureRow(departure: d, now: now)
                            .background(index.isMultiple(of: 2) ? Color(.secondarySystemBackground) : Color.clear)
                    }
                }
            }
        }
        .overlay(alignment: .bottom) { Divider() }
    }
}

private struct DepartureRow: View {
    let departure: Departure
    let now: Date

    private var minutes: Int {
        guard let epoch = departure.epoch else { return 0 }
        return max(0, Int((epoch - now.timeIntervalSince1970) / 60))
    }

    private var delayMin: Int {
        guard let exp = departure.expectedTime.flatMap(ISO8601Parser.parse),
              let aim = departure.aimedTime.flatMap(ISO8601Parser.parse) else { return 0 }
        return Int((exp.timeIntervalSince(aim)) / 60)
    }

    private var clock: String {
        guard let epoch = departure.epoch else { return "" }
        let d = Date(timeIntervalSince1970: epoch)
        let f = DateFormatter()
        f.dateFormat = "HH:mm"
        return f.string(from: d)
    }

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            LineBadge(line: departure.line, size: .row)
                .frame(width: 60, alignment: .leading)

            HStack(alignment: .firstTextBaseline, spacing: 4) {
                Text("\(minutes)").font(.system(size: 17, weight: .bold).monospacedDigit())
                Text("min").font(.caption).foregroundStyle(.secondary)
                if delayMin > 0 {
                    Text("+\(delayMin)")
                        .font(.caption.bold())
                        .foregroundStyle(Color(red: 0xD0/255, green: 0x40/255, blue: 0x40/255))
                }
                Text(clock).font(.caption).foregroundStyle(.secondary).padding(.leading, 4)
            }
            .frame(width: 100, alignment: .leading)

            Text(departure.destination)
                .font(.system(size: 17, weight: .bold))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)

            Text(departure.track ?? "–")
                .font(.system(size: 17, weight: .bold))
                .frame(width: 44, alignment: .trailing)
        }
        .padding(.horizontal, 20)
        .padding(.vertical, 10)
    }
}

private struct LineBadge: View {
    enum Size { case chip, row }
    let line: String
    let size: Size

    var body: some View {
        Text(line)
            .font(font)
            .foregroundStyle(LineStyle.foreground(for: line))
            .frame(minWidth: minWidth)
            .padding(.horizontal, 8)
            .padding(.vertical, padding)
            .background(LineStyle.background(for: line), in: RoundedRectangle(cornerRadius: 4))
    }

    private var font: Font {
        switch size {
        case .chip: .system(size: 13, weight: .heavy, design: .default)
        case .row:  .system(size: 15, weight: .heavy, design: .default)
        }
    }
    private var minWidth: CGFloat { size == .chip ? 32 : 44 }
    private var padding: CGFloat { size == .chip ? 3 : 4 }
}
