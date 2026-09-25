import SwiftUI

#if DEBUG
struct DesignTokensPreview: View {
    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: SunprideTokens.Space.four) {
                Text("Design tokens").font(SunprideTokens.TypeStyle.title)
                    .accessibilityIdentifier("designTokensTitle")
                Text("Semantic colors · 4-point rhythm · Dynamic Type")
                    .font(SunprideTokens.TypeStyle.body)
                HStack(spacing: SunprideTokens.Space.four) {
                    RoundedRectangle(cornerRadius: SunprideTokens.Radius.regular)
                        .fill(SunprideTokens.brand)
                        .frame(width: 48, height: 48)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading) {
                        Text("Brand red").font(SunprideTokens.TypeStyle.heading)
                        Text("Accent only — not small text").font(SunprideTokens.TypeStyle.caption)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(SunprideTokens.Space.four)
                .background(SunprideTokens.card, in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.regular))
                swatch("Accessible action", background: SunprideTokens.actionBackground, foreground: .white, note: "White on deep red")
                swatch("Warning yellow", background: SunprideTokens.warning, foreground: SunprideTokens.warningText, note: "Ink on yellow")
                swatch("Success", background: Color(uiColor: SunprideTokens.success.uiColor), foreground: SunprideTokens.warningText, note: "Ink on green")
                swatch("Danger", background: Color(uiColor: SunprideTokens.danger.uiColor), foreground: .white, note: "White on danger")
                Text("Surface / canvas")
                    .font(SunprideTokens.TypeStyle.heading)
                    .padding(SunprideTokens.Space.four)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(SunprideTokens.card, in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.field))
            }
            .frame(maxWidth: 520, alignment: .leading)
            .padding(SunprideTokens.Space.six)
        }
        .foregroundStyle(SunprideTokens.text)
        .background(SunprideTokens.background)
    }

    private func swatch(_ title: String, background: Color, foreground: Color, note: String) -> some View {
        VStack(alignment: .leading, spacing: SunprideTokens.Space.one) {
            Text(title).font(SunprideTokens.TypeStyle.heading)
            Text(note).font(SunprideTokens.TypeStyle.caption)
        }
        .foregroundStyle(foreground)
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(SunprideTokens.Space.four)
        .background(background, in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.regular))
    }
}
#endif
