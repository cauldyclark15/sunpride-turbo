import SwiftUI

@main
struct FieldIOSApp: App {
    init() { BackgroundRetry.register() }
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
    @Environment(\.scenePhase) private var scenePhase
    @State private var model: AppModel

    init(environment: AppEnvironment) {
        #if DEBUG
        if let scenario = StubBackend.scenario {
            let model = BackgroundRetry.shared.model ?? StubBackend.makeModel(environment: environment, scenario: scenario)
            _model = State(initialValue: model)
            BackgroundRetry.shared.model = model
            return
        }
        #endif
        let model = BackgroundRetry.shared.model ?? AppModel.live(environment: environment)
        _model = State(initialValue: model)
        BackgroundRetry.shared.model = model
    }

    var body: some View {
        SignInShell(model: model)
            .task {
                BackgroundRetry.shared.model = model
                model.startConnectivity()
                await model.launch()
                BackgroundRetry.shared.scheduleIfNeeded()
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await model.syncNow() } }
            }
    }
}
