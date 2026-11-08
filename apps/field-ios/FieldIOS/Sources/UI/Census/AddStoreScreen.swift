import AVFoundation
import SwiftUI
import UIKit

/// Storefront photo for a store capture: long edge 800 px, JPEG stepped down until it fits the server's
/// 160 KiB rule. Redrawing drops camera metadata (no EXIF, no GPS).
enum CensusPhoto {
    static func jpeg(_ image: UIImage, longEdge: CGFloat = 800) -> Data? {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }
        let scale = min(1, longEdge / max(size.width, size.height))
        let target = CGSize(width: max(1, (size.width * scale).rounded()), height: max(1, (size.height * scale).rounded()))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1; format.opaque = true
        let drawn = UIGraphicsImageRenderer(size: target, format: format).image { _ in image.draw(in: CGRect(origin: .zero, size: target)) }
        for quality in [0.75, 0.6, 0.45, 0.3, 0.2] {
            if let data = drawn.jpegData(compressionQuality: quality), data.count <= CensusCapture.maxPhotoBytes { return data }
        }
        return longEdge > 400 ? jpeg(image, longEdge: longEdge * 0.7) : nil
    }
}

/// SP-0164 "Add a store": gather a new store (details, location, storefront photo) and queue it for the
/// office to review. Works offline; address search and the server duplicate check need internet.
struct AddStoreScreen: View {
    let model: AppModel
    var prefillName = ""

    @State private var config: CensusConfig?
    @State private var loading = true
    @State private var savedCopy = false
    @State private var draft = CensusCapture.Draft()
    @State private var message: String?
    @State private var busy = false

    // Location
    enum Mode { case gps, search }
    @State private var mode: Mode?
    @State private var locating = false
    @State private var fix: VisitLocation?
    @State private var gpsProblem: String?
    @State private var addressNote: String?
    @State private var areaLine: String?
    @State private var autoAddress: String?
    @State private var searchText = ""
    @State private var searchSession: UUID?
    @State private var predictions: [PlacePrediction] = []
    @State private var searchTask: Task<Void, Never>?
    @State private var searchNote: String?
    @State private var lastFix: (Double, Double)?
    @State private var locationCapture = LocationCapture()

    // Photo / duplicates
    @State private var showingCamera = false
    @State private var cameraAccess = AVCaptureDevice.authorizationStatus(for: .video)
    @State private var candidates: [CensusCandidate] = []
    @State private var showingDuplicates = false
    @State private var openOutlet: String?
    @State private var saved: [(id: UUID, name: String, state: String)] = []
    @Environment(\.dismiss) private var dismiss

    #if DEBUG
    private var fakeCamera: Bool { ProcessInfo.processInfo.environment["FIELD_FAKE_CAMERA"] != nil || StubBackend.scenario != nil }
    #else
    private var fakeCamera: Bool { false }
    #endif

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                header
                if loading {
                    ProgressView().frame(maxWidth: .infinity).padding()
                } else if let config {
                    if savedCopy {
                        note("Offline · using the setup saved on this phone. The store is sent when you are back online.")
                            .accessibilityIdentifier("addStoreSavedSetup")
                    }
                    storeCard(config)
                    typeCard(config)
                    locationCard(config)
                    photoCard
                } else {
                    Text("Connect to the internet once to download the store gathering setup. After that you can add stores offline.")
                        .font(SunprideTokens.TypeStyle.body).foregroundStyle(SunprideTokens.text)
                        .accessibilityIdentifier("addStoreNoSetup")
                }
                if let message {
                    Text(message).font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.text)
                        .accessibilityIdentifier("addStoreMessage")
                }
                if !saved.isEmpty {
                    SectionCard(title: "Stores you added") {
                        VStack(spacing: 0) {
                            ForEach(saved.prefix(20), id: \.id) { row in
                                CalmListRow(symbol: row.state == "Needs review" ? "exclamationmark.circle" : "storefront",
                                            title: row.name, meta: row.state)
                                    .accessibilityIdentifier("addStoreSaved")
                            }
                        }
                    }
                }
            }
            .frame(maxWidth: 520, alignment: .leading)
            .padding(16)
            .padding(.bottom, 72)
            .frame(maxWidth: .infinity) // iPad: centred column on a full-width background.
        }
        .scrollDismissesKeyboard(.immediately)
        .background(SunprideTokens.background)
        .safeAreaInset(edge: .bottom) {
            if config != nil {
                PrimaryBottomButton(title: busy ? "Checking…" : "Save store", disabled: busy) { Task { await save() } }
                    .accessibilityIdentifier("addStoreSave")
                    .frame(maxWidth: 520) // iPad: the button matches the form column, not the screen.
                    .padding(16).frame(maxWidth: .infinity).background(SunprideTokens.background)
            }
        }
        .sheet(isPresented: $showingDuplicates) { duplicateSheet }
        .fullScreenCover(isPresented: $showingCamera) {
            CameraPicker { image in
                showingCamera = false
                if let image { keepPhoto(CensusPhoto.jpeg(image)) }
            }
            .ignoresSafeArea()
        }
        .navigationDestination(item: $openOutlet) { id in CustomerDetailScreen(model: model, outletId: id) }
        .task {
            if draft.name.isEmpty { draft.name = prefillName }
            let result = await model.loadCensusConfig()
            config = result.config; savedCopy = result.saved && result.config != nil; loading = false
            if let config, !config.showsBatchPicker { draft.batchId = config.batches.first?.id }
            saved = model.censusCaptures()
        }
        .calmScreenChrome()
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "chevron.left").foregroundStyle(SunprideTokens.text).frame(width: 44, height: 44)
                }
                .accessibilityLabel("Back").accessibilityIdentifier("BackButton")
                Text("Customers").font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                Spacer()
            }
            Text("Add a store").font(SunprideTokens.TypeStyle.title).foregroundStyle(SunprideTokens.text)
                .accessibilityIdentifier("addStoreTitle")
            Text("The office checks every new store before it is added to the list.")
                .font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
    }

    private func field(_ label: String, _ text: Binding<String>, id: String, keyboard: UIKeyboardType = .default) -> some View {
        CalmField(label: label) {
            TextField(label, text: text).keyboardType(keyboard).accessibilityIdentifier(id)
        }
    }

    private func picker(_ label: String, _ choices: [CensusConfig.Choice], selected: String?, empty: String, id: String,
                        pick: @escaping (String) -> Void) -> some View {
        CalmField(label: label) {
            Menu {
                ForEach(choices) { choice in Button(choice.label) { pick(choice.id) } }
            } label: {
                HStack {
                    Text(choices.first { $0.id == selected }?.label ?? empty)
                        .foregroundStyle(selected == nil ? SunprideTokens.secondaryText : SunprideTokens.text)
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").foregroundStyle(SunprideTokens.secondaryText)
                }
                .frame(maxWidth: .infinity, minHeight: 44).contentShape(Rectangle())
            }
            .disabled(choices.isEmpty)
            .accessibilityIdentifier(id)
        }
    }

    private func storeCard(_ config: CensusConfig) -> some View {
        SectionCard(title: "Store") {
            VStack(alignment: .leading, spacing: 12) {
                if config.showsBatchPicker {
                    picker("Gathering batch (optional)", config.batches, selected: draft.batchId,
                           empty: "Ongoing gathering (default)", id: "addStoreBatch") { draft.batchId = $0 }
                }
                field("Store name", $draft.name, id: "addStoreName")
                field("Owner name", $draft.ownerName, id: "addStoreOwner")
                field("Owner phone", $draft.ownerPhone, id: "addStorePhone", keyboard: .phonePad)
            }
            .padding(16)
        }
    }

    private func typeCard(_ config: CensusConfig) -> some View {
        SectionCard(title: "Type of store") {
            VStack(alignment: .leading, spacing: 12) {
                picker("Channel", config.channels, selected: draft.channelId, empty: "Choose…", id: "addStoreChannel") {
                    if draft.channelId != $0 { draft.subchannelId = nil }
                    draft.channelId = $0
                }
                picker("Sub-channel", config.subchannels(of: draft.channelId), selected: draft.subchannelId,
                       empty: draft.channelId == nil ? "Choose a channel first" : "Choose…", id: "addStoreSubchannel") { draft.subchannelId = $0 }
                VStack(alignment: .leading, spacing: 6) {
                    Text("Sales potential").font(SunprideTokens.TypeStyle.meta.weight(.medium)).foregroundStyle(SunprideTokens.text)
                    Picker("Sales potential", selection: $draft.estimatedClass) {
                        ForEach(["A", "B", "C", "D"], id: \.self) { Text("Class \($0)").tag($0) }
                    }
                    .pickerStyle(.segmented).accessibilityIdentifier("addStoreClass")
                }
            }
            .padding(16)
        }
    }

    private func locationCard(_ config: CensusConfig) -> some View {
        SectionCard(title: "Location") {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    Button { Task { await useMyLocation(config) } } label: {
                        Label(locating ? "Finding you…" : "Use my location", systemImage: "location.fill")
                            .font(SunprideTokens.TypeStyle.row).frame(maxWidth: .infinity, minHeight: 48)
                            .foregroundStyle(SunprideTokens.actionText)
                            .background(SunprideTokens.actionBackground.opacity(locating ? 0.45 : 1),
                                        in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.control))
                    }
                    .disabled(locating).accessibilityIdentifier("addStoreUseLocation")
                    if config.addressSearch {
                        SecondaryButton(title: "Search address", fullWidth: true) {
                            mode = .search; gpsProblem = nil
                        }
                        .accessibilityIdentifier("addStoreSearchAddress")
                    }
                }
                if case .gps(let fix)? = draft.location {
                    StatusPill(label: "Your location · ±\(Int(fix.accuracyMeters.rounded())) m").accessibilityIdentifier("addStoreAccuracy")
                } else if case .places? = draft.location {
                    StatusPill(label: "Pin from address").accessibilityIdentifier("addStorePinFromAddress")
                }
                if let gpsProblem {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(gpsProblem).font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.dangerText)
                            .accessibilityIdentifier("addStoreGpsProblem")
                        SecondaryButton(title: "Try again") { Task { await useMyLocation(config) } }
                            .accessibilityIdentifier("addStoreGpsRetry")
                    }
                }
                if mode == .search { searchBox }
                CalmField(label: "Address") {
                    TextField("Street, barangay, city", text: $draft.address).accessibilityIdentifier("addStoreAddress")
                }
                if let areaLine { note(areaLine).accessibilityIdentifier("addStoreArea") }
                if let addressNote { note(addressNote).accessibilityIdentifier("addStoreAddressNote") }
                field("Landmark (optional)", $draft.landmark, id: "addStoreLandmark")
            }
            .padding(16)
        }
    }

    private var searchBox: some View {
        VStack(alignment: .leading, spacing: 8) {
            CalmField(label: "Search address") {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundStyle(SunprideTokens.secondaryText).accessibilityHidden(true)
                    TextField("Type at least 3 letters", text: $searchText)
                        .autocorrectionDisabled().accessibilityIdentifier("addStoreSearchField")
                        .onChange(of: searchText) { _, value in typed(value) }
                }
            }
            if let searchNote { note(searchNote).accessibilityIdentifier("addStoreSearchNote") }
            ForEach(predictions) { p in
                Button { Task { await pick(p) } } label: {
                    CalmListRow(symbol: "mappin.and.ellipse", title: p.primary, meta: p.secondary)
                }
                .buttonStyle(.plain).accessibilityIdentifier("addStoreSuggestion")
            }
        }
    }

    private var photoCard: some View {
        SectionCard(title: "Storefront photo") {
            VStack(alignment: .leading, spacing: 12) {
                if let photo = draft.photo, let image = UIImage(data: photo) {
                    Image(uiImage: image).resizable().scaledToFill().frame(maxWidth: .infinity).frame(height: 160)
                        .clipShape(RoundedRectangle(cornerRadius: SunprideTokens.Radius.card))
                        .accessibilityLabel("Storefront photo").accessibilityIdentifier("addStorePhotoPreview")
                }
                if cameraAccess == .denied || cameraAccess == .restricted, !fakeCamera {
                    note("Camera access is off. Allow it in Settings to take the storefront photo.")
                }
                SecondaryButton(title: draft.photo == nil ? "Take storefront photo" : "Retake photo", fullWidth: true) { shoot() }
                    .accessibilityIdentifier("addStorePhoto")
            }
            .padding(16)
        }
    }

    private var duplicateSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("This might already be in the list").font(SunprideTokens.TypeStyle.heading)
                        .accessibilityIdentifier("duplicateTitle")
                    note("Check that you are not adding a store the office already has.")
                    ForEach(candidates) { c in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(c.name).font(SunprideTokens.TypeStyle.row)
                            if let a = c.address, !a.isEmpty { note(a) }
                            note([CensusDuplicates.reasonText(c.reasons), c.distanceText, c.kind == "capture" ? "Added by an agent, not yet checked" : nil]
                                .compactMap { $0 }.joined(separator: " · "))
                        }
                        .frame(maxWidth: .infinity, alignment: .leading).padding(12)
                        .background(SunprideTokens.card, in: RoundedRectangle(cornerRadius: SunprideTokens.Radius.card))
                        .accessibilityElement(children: .combine).accessibilityIdentifier("duplicateCandidate")
                    }
                    PrimaryBottomButton(title: "It's this store") { sameStore() }.accessibilityIdentifier("duplicateSame")
                    SecondaryButton(title: "It's a different store", fullWidth: true) { differentStore() }
                        .accessibilityIdentifier("duplicateDifferent")
                }
                .padding(16)
            }
            .background(SunprideTokens.background)
        }
        .presentationDetents([.medium, .large])
    }

    // MARK: Actions

    private func useMyLocation(_ config: CensusConfig) async {
        mode = .gps; gpsProblem = nil; locating = true
        defer { locating = false }
        let outcome = await locationCapture.capture()
        let now = Int64(Date().timeIntervalSince1970 * 1000)
        switch outcome {
        case .unavailable(let why):
            gpsProblem = switch why {
            case .permissionDenied: "Location is off for this app. Allow it in Settings, or search the address."
            case .locationOff: "Turn on Location Services, or search the address."
            case .noFix: "No location yet. Move outside or wait for a better signal, then try again."
            }
            return
        case .captured(let got):
            lastFix = (got.latitude, got.longitude)
            if got.mockSignal { gpsProblem = "This location looks simulated and can't be used."; return }
            guard CensusCapture.gpsUsable(got, at: now) else {
                gpsProblem = "Signal ±\(Int(got.accuracyMeters.rounded())) m — needs better than ±50 m. Move outside or wait for a better signal, then try again."
                return
            }
            fix = got
            draft.location = .gps(got)
            draft.resolved = nil; areaLine = nil
        }
        guard config.addressSearch, let service = model.censusService, !model.isOffline, let fix else {
            addressNote = "Saved with your location; the address can be fixed later. Type the address."
            return
        }
        do {
            if let address = try await service.reverse(latitude: fix.latitude, longitude: fix.longitude) {
                guard case .gps(let current)? = draft.location, current == fix else { return }
                if draft.address.isEmpty || draft.address == autoAddress {
                    draft.address = address.addressLine; autoAddress = draft.address
                }
                draft.resolved = address
                areaLine = address.areaLine
                addressNote = "Address filled from your location. Check it and fix it if needed."
            } else {
                addressNote = "No address found for this spot. Type the address."
            }
        } catch {
            addressNote = "Saved with your location; the address can be fixed later. Type the address."
        }
    }

    private func typed(_ value: String) {
        searchTask?.cancel()
        let text = value.trimmingCharacters(in: .whitespaces)
        guard text.count >= 3 else { predictions = []; searchNote = nil; if text.isEmpty { searchSession = nil }; return }
        let session = searchSession ?? UUID()
        searchSession = session
        let near = lastFix
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(300))
            guard !Task.isCancelled, let service = model.censusService else { return }
            do {
                let found = try await service.autocomplete(input: String(text.prefix(120)), session: session, near: near)
                guard !Task.isCancelled else { return }
                predictions = found
                searchNote = found.isEmpty ? "No matching address. Try other words." : nil
            } catch let error as CensusServiceError {
                guard !Task.isCancelled else { return }
                predictions = []
                searchNote = error == .offline ? "Address search needs internet. Use my location instead." : error.message
            } catch {
                predictions = []; searchNote = "Address search needs internet. Use my location instead."
            }
        }
    }

    private func pick(_ prediction: PlacePrediction) async {
        guard let service = model.censusService else { return }
        let session = searchSession ?? UUID()
        do {
            let place = try await service.details(placeId: prediction.placeId, session: session)
            draft.location = .places(place)
            draft.resolved = place.address
            draft.address = place.address.addressLine; autoAddress = draft.address
            areaLine = place.address.areaLine
            addressNote = "Pin from address. Check the address and fix it if needed."
            predictions = []; searchSession = nil; searchNote = nil
            searchTask?.cancel(); searchText = ""
            mode = nil
        } catch let error as CensusServiceError {
            searchNote = error == .offline ? "Address search needs internet. Use my location instead." : error.message
        } catch { searchNote = "Address search is not available right now." }
    }

    private func shoot() {
        if fakeCamera { keepPhoto(CensusPhoto.jpeg(Self.testImage())); return }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: showingCamera = UIImagePickerController.isSourceTypeAvailable(.camera)
        case .notDetermined:
            Task {
                let granted = await AVCaptureDevice.requestAccess(for: .video)
                cameraAccess = AVCaptureDevice.authorizationStatus(for: .video)
                if granted { showingCamera = true }
            }
        default: cameraAccess = AVCaptureDevice.authorizationStatus(for: .video)
        }
    }
    private func keepPhoto(_ jpeg: Data?) {
        guard let jpeg else { message = "Couldn't keep that photo. Take it again."; return }
        draft.photo = jpeg
        message = nil
    }
    private static func testImage() -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 64, height: 48)).image { context in
            UIColor.darkGray.setFill(); context.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
        }
    }

    private func save() async {
        message = nil
        // Keep the address text the agent confirmed; drop Google's parts if the agent rewrote the address.
        if draft.address != autoAddress, case .gps? = draft.location { draft.resolved = nil }
        do { _ = try CensusCapture.payload(draft, now: Date()) }
        catch let failure as CensusCapture.Failure { message = failure.message; return }
        catch { message = "Check the store details."; return }
        busy = true
        defer { busy = false }
        var query = CensusDuplicates.Query(name: draft.name, phone: draft.ownerPhone)
        switch draft.location {
        case .gps(let f)?: query.latitude = f.latitude; query.longitude = f.longitude
        case .places(let p)?: query.latitude = p.latitude; query.longitude = p.longitude; query.placeId = p.placeId
        case nil: break
        }
        let local = CensusDuplicates.candidates(query, among: model.censusExisting)
        var server: [CensusCandidate] = []
        if config?.supportsGathering == true, !model.isOffline, let service = model.censusService {
            var body: [String: Any] = ["name": draft.name.trimmingCharacters(in: .whitespaces),
                                       "phone": draft.ownerPhone.trimmingCharacters(in: .whitespaces)]
            if let lat = query.latitude, let lng = query.longitude { body["latitude"] = lat; body["longitude"] = lng }
            if let place = query.placeId { body["placeId"] = place }
            server = (try? await service.duplicateCheck(body)) ?? []
        }
        let merged = CensusDuplicates.merge(local: local, server: server)
            .filter { !draft.acknowledgedDuplicateIds.contains($0.id) }
        if !merged.isEmpty {
            candidates = merged
            showingDuplicates = true
            return
        }
        commit()
    }

    private func sameStore() {
        let outlet = candidates.first { candidate in
            candidate.kind == "outlet" && model.customers.contains(where: { $0.outletId == candidate.id })
        }
        showingDuplicates = false
        reset()
        message = "Not added. That store is already in the list."
        if let outlet { openOutlet = outlet.id }
    }

    private func differentStore() {
        draft.acknowledgedDuplicateIds = Array(Set(draft.acknowledgedDuplicateIds + candidates.map(\.id))).sorted()
        showingDuplicates = false
        commit()
    }

    private func commit() {
        do {
            try model.queueCensus(draft)
            let name = draft.name.trimmingCharacters(in: .whitespaces)
            reset()
            message = "\(name) saved on this phone. It is sent to the office for review when you are online."
            saved = model.censusCaptures()
        } catch let failure as CensusCapture.Failure { message = failure.message }
        catch StoreError.leaseExpired { message = "Day access closed. Connect and sync, then save again." }
        catch StoreError.heldForReview { message = "Work is held for review. Contact your supervisor." }
        catch { message = "Could not save. Check the details and try again." }
    }

    private func reset() {
        let batch = draft.batchId
        draft = CensusCapture.Draft()
        draft.batchId = batch
        fix = nil; mode = nil; gpsProblem = nil; addressNote = nil; areaLine = nil; autoAddress = nil
        searchText = ""; predictions = []; searchSession = nil; candidates = []
    }
}
