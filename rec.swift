// justrec recorder: screen + microphone into ONE mp4, via ScreenCaptureKit (macOS 15+).
// usage: justrec-rec <out.mp4> [display-index]     stop with Ctrl-C or Enter.
import AVFoundation
import ScreenCaptureKit

final class Done: NSObject, SCRecordingOutputDelegate, @unchecked Sendable {
    let finished = DispatchSemaphore(value: 0)
    func recordingOutputDidFinishRecording(_ o: SCRecordingOutput) { finished.signal() }
    func recordingOutput(_ o: SCRecordingOutput, didFailWithError e: Error) {
        fputs("recording failed: \(e.localizedDescription)\n", stderr)
        finished.signal()
    }
}

func fail(_ msg: String) -> Never { fputs("\(msg)\n", stderr); exit(1) }

@main
struct Rec {
    static func main() async {
        let args = CommandLine.arguments
        guard args.count >= 2 else { fail("usage: justrec-rec <out.mp4> [display-index]") }
        let out = URL(fileURLWithPath: args[1])

        let content: SCShareableContent
        do {
            content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        } catch {
            fail("""
            Can't see the screen: \(error.localizedDescription)
            Give your terminal app Screen Recording permission:
            System Settings > Privacy & Security > Screen & System Audio Recording, then restart the terminal.
            """)
        }
        let displays = content.displays
        let index = args.count >= 3 ? Int(args[2]) ?? 0 : displays.firstIndex { $0.displayID == CGMainDisplayID() } ?? 0
        guard displays.indices.contains(index) else { fail("no display \(index); found \(displays.count)") }
        let display = displays[index]

        let filter = SCContentFilter(display: display, excludingWindows: [])
        let cfg = SCStreamConfiguration()
        let scale = CGFloat(filter.pointPixelScale)
        cfg.width = Int(filter.contentRect.width * scale)
        cfg.height = Int(filter.contentRect.height * scale)
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        cfg.showsCursor = true
        // Mic only. System audio would become a second audio track, which most players
        // ignore: the exact bug that lost the voice in Recordly.
        cfg.capturesAudio = false
        cfg.captureMicrophone = true
        let mic = AVCaptureDevice.default(for: .audio)
        cfg.microphoneCaptureDeviceID = mic?.uniqueID

        let recCfg = SCRecordingOutputConfiguration()
        recCfg.outputURL = out
        recCfg.outputFileType = .mp4
        recCfg.videoCodecType = .h264
        let done = Done()
        let recording = SCRecordingOutput(configuration: recCfg, delegate: done)

        let stream = SCStream(filter: filter, configuration: cfg, delegate: nil)
        do {
            try stream.addRecordingOutput(recording)
            try await stream.startCapture()
        } catch {
            fail("can't start recording: \(error.localizedDescription)")
        }
        print("Recording display \(index) (\(cfg.width)x\(cfg.height)) + mic '\(mic?.localizedName ?? "none")'")
        print("-> \(out.path)")
        print("Press Enter or Ctrl-C to stop.")

        let stop = DispatchSemaphore(value: 0)
        signal(SIGINT, SIG_IGN)
        let sigint = DispatchSource.makeSignalSource(signal: SIGINT)
        sigint.setEventHandler { stop.signal() }
        sigint.resume()
        Thread { _ = readLine(); stop.signal() }.start()

        await withCheckedContinuation { c in DispatchQueue.global().async { stop.wait(); c.resume() } }
        do { try await stream.stopCapture() } catch { fputs("stop failed: \(error.localizedDescription)\n", stderr) }
        await withCheckedContinuation { c in DispatchQueue.global().async { _ = done.finished.wait(timeout: .now() + 10); c.resume() } }
        print("Saved \(out.path)")
    }
}
