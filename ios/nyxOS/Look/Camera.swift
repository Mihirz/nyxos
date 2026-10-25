// The camera behind "what is this?" / "what am I looking at?". A live preview (for low-vision
// users and sighted helpers) and a still capture that Claude looks at. Without a camera (the
// simulator), a photo from the library stands in.

import AVFoundation
import PhotosUI
import UIKit

@MainActor
final class Camera: NSObject, ObservableObject {
    static let shared = Camera()

    let session = AVCaptureSession()
    private let output = AVCapturePhotoOutput()
    /// Live frames, only to know the camera is really delivering pictures (and how bright they
    /// are) before taking one: a still taken right after starting is black.
    private let frames = AVCaptureVideoDataOutput()
    private let frameQueue = DispatchQueue(label: "nyx.camera.frames")
    private let meter = FrameMeter()
    private var device: AVCaptureDevice?
    private var startedAt = Date.distantPast
    private var configured = false
    private var photoWaiter: CheckedContinuation<UIImage?, Never>?
    private var pickWaiter: CheckedContinuation<UIImage?, Never>?
    @Published var hasCamera = AVCaptureDevice.default(for: .video) != nil
    @Published var running = false
    /// The last picture looked at, shown in the Look view.
    @Published var lastImage: UIImage?
    var lastAt = Date.distantPast

    func start() async -> Bool {
        guard hasCamera else { return false }
        if AVCaptureDevice.authorizationStatus(for: .video) == .notDetermined {
            _ = await AVCaptureDevice.requestAccess(for: .video)
        }
        guard AVCaptureDevice.authorizationStatus(for: .video) == .authorized else { return false }
        if !configured {
            session.beginConfiguration()
            session.sessionPreset = .photo
            if let dev = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back) ?? AVCaptureDevice.default(for: .video),
               let input = try? AVCaptureDeviceInput(device: dev), session.canAddInput(input) {
                session.addInput(input)
                device = dev
                if (try? dev.lockForConfiguration()) != nil {
                    if dev.isExposureModeSupported(.continuousAutoExposure) { dev.exposureMode = .continuousAutoExposure }
                    if dev.isWhiteBalanceModeSupported(.continuousAutoWhiteBalance) { dev.whiteBalanceMode = .continuousAutoWhiteBalance }
                    if dev.isFocusModeSupported(.continuousAutoFocus) { dev.focusMode = .continuousAutoFocus }
                    if dev.isLowLightBoostSupported { dev.automaticallyEnablesLowLightBoostWhenAvailable = true }
                    dev.unlockForConfiguration()
                }
            }
            if session.canAddOutput(output) { session.addOutput(output) }
            frames.alwaysDiscardsLateVideoFrames = true
            frames.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_420YpCbCr8BiPlanarFullRange]
            frames.setSampleBufferDelegate(meter, queue: frameQueue)
            if session.canAddOutput(frames) { session.addOutput(frames) }
            session.commitConfiguration()
            configured = true
        }
        if !session.isRunning {
            meter.reset()
            startedAt = Date()
            let s = session
            await withCheckedContinuation { (c: CheckedContinuation<Void, Never>) in
                DispatchQueue.global(qos: .userInitiated).async { s.startRunning(); c.resume() }
            }
        }
        running = session.isRunning
        return running
    }

    func stop() {
        guard session.isRunning else { return }
        let s = session
        DispatchQueue.global(qos: .utility).async { s.stopRunning() }
        running = false
    }

    /// A still from the camera, or (no camera / no permission) a photo the user picks.
    func takePicture() async -> UIImage? {
        // Simulator smoke tests: -NYX_LOOK_IMAGE /path/to/photo.jpg stands in for the camera.
        if let path = UserDefaults.standard.string(forKey: "NYX_LOOK_IMAGE"), let img = UIImage(contentsOfFile: path) {
            lastImage = img
            lastAt = Date()
            return img
        }
        if await start() {
            await warmUp()
            var img = await capture()
            if let i = img { print("[camera] still brightness \(String(format: "%.3f", Camera.brightness(i))), \(Int(i.size.width))x\(Int(i.size.height))") }
            // Near-black: the sensor hadn't settled (or the lens was covered for a moment). Once more.
            if let i = img, Camera.brightness(i) < 0.06 {
                print("[camera] near-black still (\(String(format: "%.3f", Camera.brightness(i)))); retrying")
                await warmUp(minFrames: meter.count + 10, maxWait: 2.0)
                if let again = await capture() { img = again }
            }
            if let img { lastImage = img; lastAt = Date() }
            return img
        }
        let img = await pickPhoto()
        if let img { lastImage = img; lastAt = Date() }
        return img
    }

    /// Wait until frames are actually arriving and exposure and white balance have settled
    /// (bright enough, not adjusting), at most `maxWait` seconds after the camera started.
    private func warmUp(minFrames: Int = 12, maxWait: Double = 3.0) async {
        let t0 = Date()
        while Date().timeIntervalSince(t0) < maxWait {
            let adjusting = device.map { $0.isAdjustingExposure || $0.isAdjustingWhiteBalance } ?? false
            if meter.count >= minFrames && !adjusting && meter.luma > 0.08 && Date().timeIntervalSince(startedAt) > 0.6 { break }
            try? await Task.sleep(nanoseconds: 80_000_000)
        }
        print("[camera] warm-up: \(meter.count) frames, luma \(String(format: "%.2f", meter.luma)), \(Int(Date().timeIntervalSince(t0) * 1000))ms")
    }

    private func capture() async -> UIImage? {
        await withCheckedContinuation { (c: CheckedContinuation<UIImage?, Never>) in
            photoWaiter = c
            let settings = AVCapturePhotoSettings()
            settings.flashMode = .off
            output.capturePhoto(with: settings, delegate: self)
        }
    }

    /// Average brightness 0-1 of a picture, from a tiny downscaled copy.
    static func brightness(_ img: UIImage) -> Double {
        let side = 24
        var px = [UInt8](repeating: 0, count: side * side * 4)
        guard let cg = img.cgImage, let ctx = CGContext(data: &px, width: side, height: side, bitsPerComponent: 8, bytesPerRow: side * 4,
                                                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return 1 }
        ctx.draw(cg, in: CGRect(x: 0, y: 0, width: side, height: side))
        var sum = 0.0
        for i in stride(from: 0, to: px.count, by: 4) { sum += 0.299 * Double(px[i]) + 0.587 * Double(px[i + 1]) + 0.114 * Double(px[i + 2]) }
        return sum / Double(side * side) / 255
    }

    private func pickPhoto() async -> UIImage? {
        guard let top = UIApplication.topViewController() else { return nil }
        var cfg = PHPickerConfiguration()
        cfg.filter = .images
        cfg.selectionLimit = 1
        let picker = PHPickerViewController(configuration: cfg)
        picker.delegate = self
        return await withCheckedContinuation { (c: CheckedContinuation<UIImage?, Never>) in
            pickWaiter = c
            top.present(picker, animated: true)
        }
    }

    /// JPEG base64 scaled to at most `maxEdge` pixels on the long side.
    static func jpeg(_ img: UIImage, maxEdge: CGFloat = 1024) -> String? {
        let w = img.size.width * img.scale, h = img.size.height * img.scale
        let s = min(1, maxEdge / max(w, h))
        let size = CGSize(width: (w * s).rounded(), height: (h * s).rounded())
        let fmt = UIGraphicsImageRendererFormat()
        fmt.scale = 1
        let out = UIGraphicsImageRenderer(size: size, format: fmt).image { _ in img.draw(in: CGRect(origin: .zero, size: size)) }
        return out.jpegData(compressionQuality: 0.75)?.base64EncodedString()
    }
}

extension Camera: AVCapturePhotoCaptureDelegate {
    nonisolated func photoOutput(_ output: AVCapturePhotoOutput, didFinishProcessingPhoto photo: AVCapturePhoto, error: Error?) {
        let img = photo.fileDataRepresentation().flatMap(UIImage.init(data:))
        Task { @MainActor in
            self.photoWaiter?.resume(returning: img)
            self.photoWaiter = nil
        }
    }
}

extension Camera: PHPickerViewControllerDelegate {
    nonisolated func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        MainActor.assumeIsolated {
            picker.dismiss(animated: true)
            guard let provider = results.first?.itemProvider, provider.canLoadObject(ofClass: UIImage.self) else {
                pickWaiter?.resume(returning: nil)
                pickWaiter = nil
                return
            }
            provider.loadObject(ofClass: UIImage.self) { obj, _ in
                let img = obj as? UIImage
                Task { @MainActor in
                    self.pickWaiter?.resume(returning: img)
                    self.pickWaiter = nil
                }
            }
        }
    }
}

/// Counts live camera frames and keeps a running brightness, off the main thread.
final class FrameMeter: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var _count = 0
    private var _luma = 0.0
    var count: Int { lock.lock(); defer { lock.unlock() }; return _count }
    var luma: Double { lock.lock(); defer { lock.unlock() }; return _luma }
    func reset() { lock.lock(); _count = 0; _luma = 0; lock.unlock() }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        var l = -1.0
        // Sample the luma plane sparsely every few frames.
        if count % 3 == 0, let pb = CMSampleBufferGetImageBuffer(sampleBuffer) {
            CVPixelBufferLockBaseAddress(pb, .readOnly)
            if let base = CVPixelBufferGetBaseAddressOfPlane(pb, 0) {
                let w = CVPixelBufferGetWidthOfPlane(pb, 0), h = CVPixelBufferGetHeightOfPlane(pb, 0), row = CVPixelBufferGetBytesPerRowOfPlane(pb, 0)
                let p = base.assumingMemoryBound(to: UInt8.self)
                var sum = 0, n = 0
                for y in stride(from: 0, to: h, by: max(1, h / 32)) { for x in stride(from: 0, to: w, by: max(1, w / 32)) { sum += Int(p[y * row + x]); n += 1 } }
                if n > 0 { l = Double(sum) / Double(n) / 255 }
            }
            CVPixelBufferUnlockBaseAddress(pb, .readOnly)
        }
        lock.lock()
        _count += 1
        if l >= 0 { _luma = l }
        lock.unlock()
    }
}
