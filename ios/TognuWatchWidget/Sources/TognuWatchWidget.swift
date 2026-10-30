import WidgetKit
import SwiftUI

struct WatchDepartureEntry: TimelineEntry {
    let date: Date
    let stationName: String
    let departures: [Departure]
}

struct WatchDepartureProvider: TimelineProvider {
    func placeholder(in context: Context) -> WatchDepartureEntry {
        WatchDepartureEntry(date: .now, stationName: "—", departures: [])
    }

    func getSnapshot(in context: Context, completion: @escaping (WatchDepartureEntry) -> Void) {
        completion(placeholder(in: context))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<WatchDepartureEntry>) -> Void) {
        let entry = placeholder(in: context)
        completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(60))))
    }
}

struct TognuWatchWidgetEntryView: View {
    let entry: WatchDepartureEntry

    var body: some View {
        Text(entry.stationName)
    }
}

struct TognuWatchWidget: Widget {
    let kind: String = "TognuWatchWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: WatchDepartureProvider()) { entry in
            TognuWatchWidgetEntryView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Departures")
        .description("Next trains at your favorite station.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

@main
struct TognuWatchWidgetBundle: WidgetBundle {
    var body: some Widget {
        TognuWatchWidget()
    }
}
