import AVFoundation
import ScreenCaptureKit
import AppKit

func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]) {
        FileHandle.standardOutput.write(data + Data([10]))
    }
}

func fail(_ message: String) -> Never {
    emit(["event": "error", "message": message])
    exit(1)
}

struct Options: Decodable {
    var output: String
    var cursor: String
    var display: Int
    var window: UInt32?
    var region: [Double]?
    var microphone: String?
    var systemAudio: Bool
    var cursorVisible: Bool
    var fps: Int
    var maxWidth: Int
    var camera: String?
    var cameraOutput: String?
    var audioApps: [Int32]?
}

final class CursorLog: @unchecked Sendable {
    let queue = DispatchQueue(label: "justrec.cursor", qos: .utility)
    let file: FileHandle
    var bounds: CGRect
    let windowID: UInt32?
    let region: [Double]?
    var lastBoundsUpdate: Double = 0
    var timer: DispatchSourceTimer?
    var previous = CGPoint(x: -99999, y: -99999)
    var pressed = false

    init(path: String, bounds: CGRect, windowID: UInt32?, region: [Double]?) throws {
        FileManager.default.createFile(atPath: path, contents: nil)
        file = try FileHandle(forWritingTo: URL(fileURLWithPath: path))
        self.bounds = bounds
        self.windowID = windowID
        self.region = region
    }

    func start(at origin: Double) {
        let source = DispatchSource.makeTimerSource(queue: queue)
        source.schedule(deadline: .now(), repeating: .milliseconds(16), leeway: .milliseconds(3))
        source.setEventHandler { [self] in
            let now = ProcessInfo.processInfo.systemUptime
            if let windowID, now - lastBoundsUpdate > 0.25 {
                if let info = CGWindowListCopyWindowInfo(.optionIncludingWindow, windowID) as? [[String: Any]],
                   let rectangle = info.first?[kCGWindowBounds as String] as? NSDictionary,
                   let frame = CGRect(dictionaryRepresentation: rectangle as CFDictionary) {
                    bounds = region.map { CGRect(x: frame.minX + $0[0], y: frame.minY + $0[1], width: $0[2], height: $0[3]) } ?? frame
                }
                lastBoundsUpdate = now
            }
            guard let location = CGEvent(source: nil)?.location else { return }
            let down = CGEventSource.buttonState(.combinedSessionState, button: .left)
            if location != previous || down != pressed {
                let event: [String: Any] = [
                    "t": ProcessInfo.processInfo.systemUptime - origin,
                    "x": (location.x - bounds.minX) / bounds.width,
                    "y": (location.y - bounds.minY) / bounds.height,
                    "type": down && !pressed ? "click" : "move",
                    "visible": bounds.contains(location)
                ]
                if let data = try? JSONSerialization.data(withJSONObject: event) { file.write(data + Data([10])) }
                previous = location
                pressed = down
            }
        }
        timer = source
        source.resume()
    }

    func stop() {
        timer?.cancel()
        queue.sync { try? file.close() }
    }
}

final class RecordingDelegate: NSObject, SCRecordingOutputDelegate, @unchecked Sendable {
    let finished = DispatchSemaphore(value: 0)
    let started = DispatchSemaphore(value: 0)
    let cursor: CursorLog
    var error: String?
    init(cursor: CursorLog) { self.cursor = cursor }
    func recordingOutputDidStartRecording(_ output: SCRecordingOutput) {
        cursor.start(at: ProcessInfo.processInfo.systemUptime)
        emit(["event": "recording", "startedAt": Date().timeIntervalSince1970])
        started.signal()
    }
    func recordingOutputDidFinishRecording(_ output: SCRecordingOutput) { finished.signal() }
    func recordingOutput(_ output: SCRecordingOutput, didFailWithError failure: Error) {
        error = failure.localizedDescription
        started.signal()
        finished.signal()
        emit(["event": "error", "message": failure.localizedDescription])
    }
}

final class CameraDelegate: NSObject, AVCaptureFileOutputRecordingDelegate, @unchecked Sendable {
    let finished = DispatchSemaphore(value: 0)
    let started = DispatchSemaphore(value: 0)
    var error: Error?
    func fileOutput(_ output: AVCaptureFileOutput, didStartRecordingTo url: URL, from connections: [AVCaptureConnection]) {
        emit(["event": "camera", "startedAt": Date().timeIntervalSince1970])
        started.signal()
    }
    func fileOutput(_ output: AVCaptureFileOutput, didFinishRecordingTo url: URL,
                    from connections: [AVCaptureConnection], error: Error?) {
        self.error = error
        finished.signal()
    }
}

func wait(_ semaphore: DispatchSemaphore, seconds: Double) async -> Bool {
    await withCheckedContinuation { continuation in
        DispatchQueue.global().async {
            continuation.resume(returning: semaphore.wait(timeout: .now() + seconds) == .success)
        }
    }
}

@main
struct Rec {
    static func main() async {
        _ = NSApplication.shared
        let arguments = CommandLine.arguments
        guard arguments.count >= 2 else { fail("Expected sources or a capture configuration JSON path") }
        let content: SCShareableContent
        do { content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: false) }
        catch { fail("Screen Recording permission is required for the host app. Enable it in System Settings > Privacy & Security > Screen & System Audio Recording, then restart the host app. \(error.localizedDescription)") }
        let microphones = AVCaptureDevice.DiscoverySession(deviceTypes: [.microphone, .external], mediaType: .audio, position: .unspecified).devices
        let cameras = AVCaptureDevice.DiscoverySession(deviceTypes: [.builtInWideAngleCamera, .external], mediaType: .video, position: .unspecified).devices
        let displays = content.displays.sorted { first, second in
            if first.displayID == second.displayID { return false }
            if first.displayID == CGMainDisplayID() { return true }
            if second.displayID == CGMainDisplayID() { return false }
            return first.displayID < second.displayID
        }
        if arguments[1] == "sources" {
            emit([
                "displays": displays.enumerated().map { index, display in
                    ["index": index, "id": display.displayID, "width": display.width, "height": display.height] as [String: Any]
                },
                "windows": content.windows.filter { $0.windowLayer == 0 && $0.frame.width > 100 && $0.frame.height > 100 }.map {
                    ["id": $0.windowID, "title": $0.title ?? "", "app": $0.owningApplication?.applicationName ?? "", "width": $0.frame.width, "height": $0.frame.height, "onScreen": $0.isOnScreen] as [String: Any]
                },
                "microphones": microphones.map { ["id": $0.uniqueID, "name": $0.localizedName] },
                "cameras": cameras.map { ["id": $0.uniqueID, "name": $0.localizedName] }
            ])
            return
        }
        let options: Options
        do { options = try JSONDecoder().decode(Options.self, from: Data(contentsOf: URL(fileURLWithPath: arguments[1]))) }
        catch { fail("Invalid capture configuration: \(error.localizedDescription)") }
        guard [24, 30, 60].contains(options.fps), options.maxWidth >= 320, options.maxWidth <= 7680 else { fail("Invalid frame rate or maximum width") }
        let filter: SCContentFilter
        var bounds: CGRect
        if let pids = options.audioApps {
            // Audio-only helper for browser recordings: sound from these processes, plus the mic.
            let apps = content.applications.filter { pids.contains($0.processID) }
            guard !apps.isEmpty else { fail("None of the processes \(pids) can be captured") }
            filter = SCContentFilter(display: displays[0], including: apps, exceptingWindows: [])
            bounds = CGDisplayBounds(displays[0].displayID)
        } else if let windowID = options.window {
            guard let window = content.windows.first(where: { $0.windowID == windowID }) else { fail("Window \(windowID) is not available") }
            filter = SCContentFilter(desktopIndependentWindow: window)
            bounds = window.frame
        } else {
            guard displays.indices.contains(options.display) else { fail("Display index \(options.display) is not available") }
            let display = displays[options.display]
            filter = SCContentFilter(display: display, excludingWindows: [])
            bounds = CGDisplayBounds(display.displayID)
        }
        let configuration = SCStreamConfiguration()
        if let region = options.region {
            guard region.count == 4, region.allSatisfy({ $0.isFinite }), region[0] >= 0, region[1] >= 0,
                  region[2] >= 2, region[3] >= 2, region[0] + region[2] <= bounds.width,
                  region[1] + region[3] <= bounds.height else { fail("Region must be x,y,width,height within the capture source, in points") }
            configuration.sourceRect = CGRect(x: region[0], y: region[1], width: region[2], height: region[3])
            bounds = CGRect(x: bounds.minX + region[0], y: bounds.minY + region[1], width: region[2], height: region[3])
        }
        let scale = min(Double(filter.pointPixelScale), Double(options.maxWidth) / bounds.width)
        configuration.width = max(2, Int(bounds.width * scale) / 2 * 2)
        configuration.height = max(2, Int(bounds.height * scale) / 2 * 2)
        if options.audioApps != nil { configuration.width = 64; configuration.height = 64 }
        configuration.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(options.fps))
        // Frames still being encoded hold queue slots; at 3, macOS sent 4 frames in 4 s and recordings froze.
        configuration.queueDepth = 8
        configuration.showsCursor = options.cursorVisible
        configuration.capturesAudio = options.systemAudio
        configuration.excludesCurrentProcessAudio = true
        configuration.sampleRate = 48000
        configuration.channelCount = 2
        configuration.captureMicrophone = options.microphone != nil
        if let name = options.microphone {
            guard await AVCaptureDevice.requestAccess(for: .audio) else { fail("Microphone permission is required. Enable it for the host app in System Settings > Privacy & Security > Microphone.") }
            let microphone = name == "default" ? AVCaptureDevice.default(for: .audio) : microphones.first { $0.uniqueID == name || $0.localizedName == name }
            guard let microphone else { fail("Microphone '\(name)' is not available") }
            configuration.microphoneCaptureDeviceID = microphone.uniqueID
        }
        let cameraSession = AVCaptureSession()
        let cameraOutput = AVCaptureMovieFileOutput()
        let cameraDelegate = CameraDelegate()
        if let name = options.camera {
            guard await AVCaptureDevice.requestAccess(for: .video) else { fail("Camera permission is required for the host app") }
            let camera = name == "default" ? cameras.first : cameras.first { $0.uniqueID == name || $0.localizedName == name }
            guard let camera, let destination = options.cameraOutput else { fail("Camera or camera output is missing") }
            do {
                let input = try AVCaptureDeviceInput(device: camera)
                cameraSession.sessionPreset = .hd1280x720
                guard cameraSession.canAddInput(input), cameraSession.canAddOutput(cameraOutput) else { fail("Cannot configure camera") }
                cameraSession.addInput(input)
                cameraSession.addOutput(cameraOutput)
                cameraSession.startRunning()
                cameraOutput.startRecording(to: URL(fileURLWithPath: destination), recordingDelegate: cameraDelegate)
                guard await wait(cameraDelegate.started, seconds: 20) else { fail("Camera did not start within 20 seconds") }
            } catch { fail("Cannot start camera: \(error.localizedDescription)") }
        }
        let cursor: CursorLog
        do { cursor = try CursorLog(path: options.cursor, bounds: bounds, windowID: options.window, region: options.region) }
        catch { fail("Cannot create cursor log: \(error.localizedDescription)") }
        let delegate = RecordingDelegate(cursor: cursor)
        let recordingConfiguration = SCRecordingOutputConfiguration()
        recordingConfiguration.outputURL = URL(fileURLWithPath: options.output)
        recordingConfiguration.outputFileType = .mp4
        recordingConfiguration.videoCodecType = .h264
        let output = SCRecordingOutput(configuration: recordingConfiguration, delegate: delegate)
        let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
        let stop = DispatchSemaphore(value: 0)
        let signals = [SIGINT, SIGTERM].map { number -> DispatchSourceSignal in
            signal(number, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: number, queue: .global())
            source.setEventHandler { stop.signal() }
            source.resume()
            return source
        }
        do {
            try stream.addRecordingOutput(output)
            try await stream.startCapture()
        } catch { fail("Cannot start recording: \(error.localizedDescription)") }
        guard await wait(delegate.started, seconds: 20), delegate.error == nil else { fail(delegate.error ?? "Recording did not start within 20 seconds") }
        emit(["event": "capture", "width": configuration.width, "height": configuration.height, "fps": options.fps,
              "bounds": [bounds.minX, bounds.minY, bounds.width, bounds.height]])
        while !(await wait(stop, seconds: 0.25)) {
            if let error = delegate.error { fail(error) }
        }
        do { try await stream.stopCapture() }
        catch { fail("Cannot stop recording: \(error.localizedDescription)") }
        guard await wait(delegate.finished, seconds: 20), delegate.error == nil else { fail(delegate.error ?? "Recording finalization timed out") }
        cursor.stop()
        if options.camera != nil {
            cameraOutput.stopRecording()
            guard await wait(cameraDelegate.finished, seconds: 20), cameraDelegate.error == nil else { fail("Camera finalization failed") }
            cameraSession.stopRunning()
        }
        withExtendedLifetime(signals) {}
        emit(["event": "finished", "output": options.output])
    }
}
