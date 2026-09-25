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
            case .success(let environment):
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("-showDesignTokens") {
                    DesignTokensPreview()
                } else {
                    RootView(environment: environment)
                }
                #else
                RootView(environment: environment)
                #endif
            case .failure(let error):
                ConfigurationScreen(message: error.localizedDescription)
            }
        }
    }
}

/// Owns the single AppModel for the scene.
struct RootView: View {
    @State private var model: AppModel

    init(environment: AppEnvironment) {
        #if DEBUG
        if let scenario = StubBackend.scenario {
            _model = State(initialValue: StubBackend.makeModel(environment: environment, scenario: scenario))
            return
        }
        #endif
        _model = State(initialValue: AppModel.live(environment: environment))
    }

    var body: some View {
        SignInShell(model: model)
            .task { await model.launch() }
    }
}
