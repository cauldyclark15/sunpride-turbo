import SwiftUI

private let hairline = SunprideTokens.secondaryText.opacity(0.2)

struct SectionCard<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(title.uppercased())
                .font(SunprideTokens.TypeStyle.section)
                .tracking(0.8)
                .foregroundStyle(SunprideTokens.secondaryText)
                .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
                .padding(.horizontal, 16)
            Rectangle().fill(hairline).frame(height: 1)
            content
        }
        .background(SunprideTokens.card, in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.card))
        .overlay(RoundedRectangle(cornerRadius: SunprideTokens.Radius.card).strokeBorder(hairline, lineWidth: 1))
    }
}

struct IconTile: View {
    let symbol: String
    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: 18, weight: .regular))
            .foregroundStyle(SunprideTokens.secondaryText)
            .frame(width: 36, height: 36)
            .background(SunprideTokens.background, in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.control))
            .accessibilityHidden(true)
    }
}

struct CalmListRow: View {
    let symbol: String
    let title: String
    let meta: String
    var trailing: String? = nil
    var body: some View {
        HStack(spacing: 12) {
            IconTile(symbol: symbol)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(SunprideTokens.TypeStyle.row).foregroundStyle(SunprideTokens.text)
                if !meta.isEmpty {
                    Text(meta).font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if let trailing {
                Image(systemName: trailing)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(SunprideTokens.secondaryText)
                    .accessibilityHidden(true)
            }
        }
        .frame(minHeight: 56)
        .padding(.horizontal, 16)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
    }
}

struct StatusPill: View {
    let label: String
    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(SunprideTokens.secondaryText).frame(width: 6, height: 6)
            Text(label)
        }
        .font(SunprideTokens.TypeStyle.caption.weight(.medium))
        .foregroundStyle(SunprideTokens.secondaryText)
        .padding(.horizontal, 10)
        .frame(minHeight: 28)
        .background(SunprideTokens.card, in: Capsule())
        .overlay(Capsule().strokeBorder(hairline, lineWidth: 1))
    }
}

struct PrimaryBottomButton: View {
    let title: String
    var disabled = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(SunprideTokens.TypeStyle.row)
                .frame(maxWidth: .infinity, minHeight: 48)
                .foregroundStyle(SunprideTokens.actionText)
                .background(SunprideTokens.actionBackground.opacity(disabled ? 0.45 : 1),
                            in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.control))
        }
        .disabled(disabled)
    }
}

struct SecondaryButton: View {
    let title: String
    var disabled = false
    var destructive = false
    var fullWidth = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            Text(title).font(SunprideTokens.TypeStyle.row)
                .frame(maxWidth: fullWidth ? .infinity : nil)
                .frame(minHeight: 48)
                .padding(.horizontal, 16)
                .foregroundStyle((destructive ? SunprideTokens.dangerText : SunprideTokens.text).opacity(disabled ? 0.45 : 1))
                .background(SunprideTokens.card, in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.control))
                .overlay(RoundedRectangle(cornerRadius: SunprideTokens.Radius.control).strokeBorder(hairline, lineWidth: 1))
        }
        .disabled(disabled)
    }
}

struct CalmField<Content: View>: View {
    let label: String?
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let label {
                Text(label).font(SunprideTokens.TypeStyle.meta.weight(.medium))
                    .foregroundStyle(SunprideTokens.text)
            }
            content
                .padding(.horizontal, 12)
                .frame(height: 48)
                .background(SunprideTokens.card, in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.control))
                .overlay(RoundedRectangle(cornerRadius: SunprideTokens.Radius.control).strokeBorder(hairline, lineWidth: 1))
        }
    }
}

struct DetailRow: View {
    let label: String
    let value: String
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(label).font(SunprideTokens.TypeStyle.row)
                .foregroundStyle(SunprideTokens.text)
            Spacer(minLength: 4)
            Text(value).font(SunprideTokens.TypeStyle.meta)
                .foregroundStyle(SunprideTokens.secondaryText)
                .multilineTextAlignment(.trailing).textSelection(.enabled)
        }
        .padding(.horizontal, 16)
        .frame(minHeight: 48)
    }
}

struct DetailRows<Content: View>: View {
    @ViewBuilder let content: Content
    var body: some View { VStack(spacing: 0) { content } }
}
