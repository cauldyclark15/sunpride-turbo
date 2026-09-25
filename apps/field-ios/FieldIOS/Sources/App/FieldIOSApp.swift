import SwiftUI

@main
struct FieldIOSApp: App {
    var body: some Scene {
        WindowGroup {
            let values = [
                "CONVEX_SITE_URL": Bundle.main.object(forInfoDictionaryKey: "CONVEX_SITE_URL") as? String ?? "",
                "CONVEX_URL": Bundle.main.object(forInfoDictionaryKey: "CONVEX_URL") as? String ?? ""
            ]
            let result = Result { try AppEnvironment(values: values) }
            switch result {
            case .success:
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("-showDesignTokens") {
                    DesignTokensPreview()
                } else {
                    SignInShell()
                }
                #else
                SignInShell()
                #endif
            case .failure(let error):
                ConfigurationScreen(message: error.localizedDescription)
            }
        }
    }
}
