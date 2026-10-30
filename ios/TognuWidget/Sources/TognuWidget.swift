import WidgetKit
import SwiftUI

struct DepartureEntry: TimelineEntry {
    let date: Date
    let stationName: String
    let departures: [Departure]
}

struct DepartureProvider: TimelineProvider {
    func placeholder(in context: Context) -> DepartureEntry {
        DepartureEntry(date: .now, stationName: "—", departures: [])
    }

    func getSnapshot(in context: Context, completion: @escaping (DepartureEntry) -> Void) {
        completion(placeholder(in: context))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<DepartureEntry>) -> Void) {
        let entry = placeholder(in: context)
        completion(Timeline(entries: [entry], policy: .after(.now.addingTimeInterval(60))))
    }
}

struct TognuWidgetEntryView: View {
    let entry: DepartureEntry

    var body: some View {
        Text(entry.stationName)
    }
}

struct TognuWidget: Widget {
    let kind: String = "TognuWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: DepartureProvider()) { entry in
            TognuWidgetEntryView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Departures")
        .description("Next trains at your favorite station.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}

@main
struct TognuWidgetBundle: WidgetBundle {
    var body: some Widget {
        TognuWidget()
    }
}
