import SwiftUI

enum LineStyle {
    static func background(for line: String) -> Color {
        switch line {
        case "A": Color(red: 0x5E/255, green: 0xC4/255, blue: 0xE8/255)
        case "B": Color(red: 0x8B/255, green: 0xC3/255, blue: 0x4A/255)
        case "C": Color(red: 0xE8/255, green: 0x6A/255, blue: 0x6A/255)
        case "E": Color(red: 0x8A/255, green: 0x84/255, blue: 0xCA/255)
        case "F": Color(red: 0xF3/255, green: 0xC1/255, blue: 0x3A/255)
        case "H": Color(red: 0xD8/255, green: 0x7F/255, blue: 0xBF/255)
        default:  Color.secondary.opacity(0.15)
        }
    }

    static func foreground(for line: String) -> Color {
        switch line {
        case "A", "B", "C", "E", "H": .white
        default: .primary
        }
    }
}
