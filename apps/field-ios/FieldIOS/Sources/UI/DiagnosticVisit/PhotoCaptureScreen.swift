import AVFoundation
import SwiftUI
import UIKit

/// Encodes a camera image for evidence: about 2 MP, JPEG quality 0.85 — legible shelves and price
/// tags, well under the 10 MB server limit. Redrawing normalizes orientation and drops all camera
/// metadata (no EXIF, no GPS) from the uploaded bytes.
enum PhotoEncoding {
    static let longEdge: CGFloat = 1600
    static func jpeg(_ image: UIImage) -> Data? {
        let size = image.size
        guard size.width > 0, size.height > 0 else { return nil }
        let scale = min(1, longEdge / max(size.width, size.height))
        let target = CGSize(width: (size.width * scale).rounded(), height: (size.height * scale).rounded())
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let drawn = UIGraphicsImageRenderer(size: target, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: target))
        }
        return drawn.jpegData(compressionQuality: 0.85)
    }
}

/// IOS-016: choose the photo type, take the photo with the back camera, keep it. The JPEG is sealed
/// on the phone immediately; nothing here waits for a network, so photos never hold up the call.
struct PhotoCaptureScreen: View {
    let model: AppModel
    let visit: AppModel.TodayVisit
    @State private var type: String?
    @State private var showingCamera = false
    @State private var message: String?
    @State private var cameraAccess = AVCaptureDevice.authorizationStatus(for: .video)
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    #if DEBUG
    /// UI tests and the stub backend use a generated JPEG instead of the camera.
    private var fakeCamera: Bool {
        ProcessInfo.processInfo.environment["FIELD_FAKE_CAMERA"] != nil || StubBackend.scenario != nil
    }
    #else
    private var fakeCamera: Bool { false }
    #endif
    private var cameraAvailable: Bool { fakeCamera || UIImagePickerController.isSourceTypeAvailable(.camera) }
    private var denied: Bool { !fakeCamera && (cameraAccess == .denied || cameraAccess == .restricted) }
    private var photos: [VisitPhoto] { model.photos(for: visit) }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left").foregroundStyle(SunprideTokens.text).frame(width: 44, height: 44)
                    }
                    .accessibilityIdentifier("photoBack")
                    Text("Photos").font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                    Spacer()
                }
                Text(visit.outlet).font(SunprideTokens.TypeStyle.title)
                SectionCard(title: "Photo type") {
                    VStack(spacing: 0) {
                        ForEach(model.photoTypeChoices, id: \.code) { option in
                            ChoiceRow(label: option.label, selected: type == option.code) { type = option.code }
                                .accessibilityIdentifier("photoType-\(option.code)")
                        }
                    }
                }
                if denied {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Camera access is off. Allow it in Settings to take visit photos.")
                            .font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                            .accessibilityIdentifier("cameraDenied")
                        SecondaryButton(title: "Open Settings") {
                            if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                        }
                    }
                } else if !cameraAvailable {
                    Text("Camera unavailable on this phone.").font(SunprideTokens.TypeStyle.meta)
                        .foregroundStyle(SunprideTokens.secondaryText).accessibilityIdentifier("cameraUnavailable")
                }
                if let message {
                    Text(message).font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
                        .accessibilityIdentifier("photoMessage")
                }
                if !photos.isEmpty {
                    SectionCard(title: "This call · \(photos.count)") {
                        VStack(spacing: 0) {
                            ForEach(photos) { photo in
                                CalmListRow(symbol: photo.state == "uploaded" ? "checkmark.circle" : "photo",
                                            title: model.photoTypeLabel(photo.photoType),
                                            meta: EvidencePhotos.stateLabel(photo))
                                    .accessibilityIdentifier("photo-\(photo.photoType)")
                            }
                        }
                    }
                }
                Text("Photos stay on this phone, locked, until they upload. You can end the call before they do.")
                    .font(SunprideTokens.TypeStyle.meta).foregroundStyle(SunprideTokens.secondaryText)
            }
            .padding(16)
            .padding(.bottom, 64)
        }
        .background(SunprideTokens.background)
        .safeAreaInset(edge: .bottom) {
            PrimaryBottomButton(title: "Take photo", disabled: type == nil || !cameraAvailable || denied) { shoot() }
                .accessibilityIdentifier("photoTake")
                .padding(16)
                .background(SunprideTokens.background)
        }
        .fullScreenCover(isPresented: $showingCamera) {
            CameraPicker { image in
                showingCamera = false
                if let image, let chosen = type { keep(chosen, PhotoEncoding.jpeg(image), at: Date()) }
            }
            .ignoresSafeArea()
        }
        .toolbar(.hidden, for: .navigationBar)
    }

    private func shoot() {
        guard let chosen = type else { return }
        message = nil
        if fakeCamera {
            keep(chosen, PhotoEncoding.jpeg(Self.testImage()), at: Date())
            return
        }
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: showingCamera = true
        case .notDetermined:
            Task {
                let granted = await AVCaptureDevice.requestAccess(for: .video)
                cameraAccess = AVCaptureDevice.authorizationStatus(for: .video)
                if granted { showingCamera = true }
            }
        default: cameraAccess = AVCaptureDevice.authorizationStatus(for: .video)
        }
    }
    /// Saved under the type chosen when the shutter was pressed.
    private func keep(_ chosen: String, _ jpeg: Data?, at: Date) {
        guard let jpeg else { message = AppModel.CallFailure.photoInvalid.message; return }
        do {
            try model.savePhoto(type: chosen, jpeg: jpeg, capturedAt: at, for: visit)
            message = "Photo saved · \(model.photoTypeLabel(chosen))"
        } catch let error as AppModel.CallFailure { message = error.message }
        catch StoreError.leaseExpired { message = "Day access closed · Reconnect to continue" }
        catch StoreError.heldForReview { message = "Work held · Contact supervisor" }
        catch { message = "Photo not saved · Try again" }
    }
    private static func testImage() -> UIImage {
        UIGraphicsImageRenderer(size: CGSize(width: 64, height: 48)).image { context in
            UIColor.darkGray.setFill(); context.fill(CGRect(x: 0, y: 0, width: 64, height: 48))
        }
    }
}

/// The system camera, back lens, still photos only. The image is returned in memory and never
/// written to the photo library.
struct CameraPicker: UIViewControllerRepresentable {
    let done: (UIImage?) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(done: done) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        if UIImagePickerController.isCameraDeviceAvailable(.rear) { picker.cameraDevice = .rear }
        picker.allowsEditing = false
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let done: (UIImage?) -> Void
        init(done: @escaping (UIImage?) -> Void) { self.done = done }
        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            done(info[.originalImage] as? UIImage)
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) { done(nil) }
    }
}
