import SwiftUI
import UIKit

/// Semantic native palette derived from packages/ui/docs/DESIGN.md.
enum SunprideTokens {
    struct RGB: Equatable {
        let hex: UInt32
        var luminance: Double {
            let channels = [16, 8, 0].map { Double((hex >> $0) & 0xFF) / 255 }
            let linear = channels.map { $0 <= 0.04045 ? $0 / 12.92 : pow(($0 + 0.055) / 1.055, 2.4) }
            return zip(linear, [0.2126, 0.7152, 0.0722]).reduce(0) { $0 + $1.0 * $1.1 }
        }
        func contrast(with other: RGB) -> Double {
            (max(luminance, other.luminance) + 0.05) / (min(luminance, other.luminance) + 0.05)
        }
        var uiColor: UIColor {
            UIColor(red: CGFloat((hex >> 16) & 0xFF) / 255,
                    green: CGFloat((hex >> 8) & 0xFF) / 255,
                    blue: CGFloat(hex & 0xFF) / 255, alpha: 1)
        }
    }

    static let red = RGB(hex: 0xEE1C25)
    static let yellow = RGB(hex: 0xFEF200)
    static let success = RGB(hex: 0x2E9D59)
    static let danger = RGB(hex: 0xC8102E)
    static let ink = RGB(hex: 0x18181B)
    static let canvas = RGB(hex: 0xF5F5F5)
    static let surface = RGB(hex: 0xFFFFFF)
    static let snow = RGB(hex: 0xFCFCFC)
    // Brand red itself has only 4.35:1 against white; darken for small button text.
    static let action = RGB(hex: 0xB4151D)
    static let darkCanvas = RGB(hex: 0x060606)
    static let darkSurface = RGB(hex: 0x181818)

    static func adaptive(_ light: RGB, _ dark: RGB) -> Color {
        Color(uiColor: UIColor { traits in
            (traits.userInterfaceStyle == .dark ? dark : light).uiColor
        })
    }
    static let background = adaptive(canvas, darkCanvas)
    static let card = adaptive(surface, darkSurface)
    static let text = adaptive(ink, snow)
    static let secondaryText = adaptive(RGB(hex: 0x595959), RGB(hex: 0xA0A0A0))
    static let brand = Color(uiColor: red.uiColor)
    static let warning = Color(uiColor: yellow.uiColor)
    static let warningText = Color(uiColor: ink.uiColor)
    static let actionBackground = Color(uiColor: action.uiColor)
    static let actionText = Color.white
    /// Error text: danger red on light surfaces, lightened red on dark surfaces (>=4.5:1 on both).
    static let dangerLight = RGB(hex: 0xC8102E)
    static let dangerDark = RGB(hex: 0xFF7A85)
    static let dangerText = adaptive(dangerLight, dangerDark)

    enum Space {
        static let one: CGFloat = 4
        static let two: CGFloat = 8
        static let three: CGFloat = 12
        static let four: CGFloat = 16
        static let six: CGFloat = 24
        static let eight: CGFloat = 32
    }
    enum Radius {
        static let regular: CGFloat = 10
        static let control: CGFloat = 10
        static let field: CGFloat = 10
        static let card: CGFloat = 16
    }
    // System text styles automatically respond to Dynamic Type.
    enum TypeStyle {
        static let title: Font = .system(.largeTitle, weight: .semibold)
        static let heading: Font = .system(.title2, weight: .semibold)
        static let row: Font = .system(.subheadline, weight: .medium)
        static let meta: Font = .system(.footnote)
        static let section: Font = .system(.caption, weight: .medium)
        static let body: Font = .system(.body)
        static let caption: Font = .system(.caption)
    }
}
