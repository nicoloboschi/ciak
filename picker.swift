// ciak-picker: screenshots, started by ciak.app (⌘1 or the menu). With -mode record (⌘2) the same overlay
// picks what to record instead: see "Quick recording" below. It stays running after the first use, hidden: the app
// sends SIGUSR1 to a running picker, which opens the overlay at once (a fresh start took a noticeable moment). An overlay with a
// glowing border picks an area (or a window: space; Esc cancels); the shot goes on the wallpaper with rounded
// corners and a shadow, is saved and copied. It runs as the app's child, so it uses the app's
// Screen Recording permission: change it freely, the app (and the permission) stay the same.
// Settings: the app's (defaults com.ciak.app: wallpaper, shots), or arguments -wallpaper <png> -shots <dir>.
import AppKit
import Carbon

let traceName = "picker"
// One timeline with the other ciak processes (see trace in lib/common.mjs): ~/.ciak/trace.log
func trace(_ message: String) {
    let now = Date(), formatter = DateFormatter()
    formatter.dateFormat = "HH:mm:ss.SSS"
    let line = "\(formatter.string(from: now)) \(traceName)[\(getpid())] \(message)\n"
    let descriptor = open(NSHomeDirectory() + "/.ciak/trace.log", O_WRONLY | O_APPEND | O_CREAT, 0o644)
    guard descriptor >= 0 else { return }
    _ = line.withCString { write(descriptor, $0, strlen($0)) }
    close(descriptor)
}

func setting(_ name: String) -> String? { UserDefaults.standard.string(forKey: name) ?? UserDefaults(suiteName: "com.ciak.app")?.string(forKey: name) }
let wallpaper = setting("wallpaper").flatMap { NSImage(contentsOfFile: $0)?.cgImage(forProposedRect: nil, context: nil, hints: nil) }
let outputDir = URL(fileURLWithPath: setting("shots") ?? FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Documents/ciak/shots").path)
func color(_ hex: Int) -> CGColor {
  CGColor(srgbRed: CGFloat(hex >> 16) / 255, green: CGFloat((hex >> 8) & 255) / 255, blue: CGFloat(hex & 255) / 255, alpha: 1)
}
let palette = [0x6d4aff, 0x13c2b4, 0xff5fa2, 0x6d4aff].map(color)

final class Overlay: NSWindow { override var canBecomeKey: Bool { true } }
var overlays: [Overlay] = []

// One per screen: dims the screen, the selection is a clear hole with a rotating gradient border and sparkles.
final class Picker: NSView {
  var start: NSPoint?
  var windowMode = false
  var hovered: (id: CGWindowID, rect: NSRect)?
  let dim = CAShapeLayer(), border = CALayer(), spin = CAGradientLayer(), mask = CALayer()
  let line = CAShapeLayer(), halo = CAShapeLayer(), label = CATextLayer(), sparkles = CAEmitterLayer()

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    dim.fillRule = .evenOdd
    dim.fillColor = NSColor(white: 0, alpha: 0.3).cgColor
    spin.type = .conic
    spin.colors = palette
    spin.startPoint = CGPoint(x: 0.5, y: 0.5)
    spin.endPoint = CGPoint(x: 0.5, y: 0)
    let turn = CABasicAnimation(keyPath: "transform.rotation.z")
    turn.byValue = -2 * Double.pi
    turn.duration = 2.4
    turn.repeatCount = .infinity
    spin.add(turn, forKey: "turn")
    for (shape, width, alpha) in [(halo, 10.0, 0.3), (line, 2.0, 1.0)] {
      shape.fillColor = nil
      shape.strokeColor = NSColor.white.cgColor
      shape.lineWidth = width
      shape.opacity = Float(alpha)
      mask.addSublayer(shape)
    }
    border.addSublayer(spin)
    border.mask = mask
    label.fontSize = 11
    label.font = NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
    label.foregroundColor = NSColor.white.cgColor
    label.backgroundColor = NSColor(white: 0, alpha: 0.55).cgColor
    label.cornerRadius = 6
    label.alignmentMode = .center
    let spark = CAEmitterCell()
    spark.contents = dot
    spark.birthRate = 60
    spark.lifetime = 0.7
    spark.velocity = 40
    spark.velocityRange = 30
    spark.emissionRange = 2 * .pi
    spark.scale = 0.5
    spark.scaleRange = 0.4
    spark.scaleSpeed = -0.6
    spark.alphaSpeed = -1.4
    spark.color = palette[2]
    spark.redRange = 0.4; spark.greenRange = 0.6; spark.blueRange = 0.3
    sparkles.emitterCells = [spark]
    sparkles.birthRate = 0
    for item in [dim, border, label, sparkles] { layer!.addSublayer(item as CALayer) }
    for item in [dim, border, mask, spin, label, sparkles] { item.frame = bounds }
    show(nil)
  }
  required init?(coder: NSCoder) { nil }
  override var acceptsFirstResponder: Bool { true }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func resetCursorRects() { addCursorRect(bounds, cursor: .crosshair) }
  override func updateTrackingAreas() {
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(rect: bounds, options: [.activeAlways, .mouseMoved, .inVisibleRect], owner: self))
  }

  // Draws the hole and border around rect (nil: whole screen dimmed, no border).
  func show(_ rect: NSRect?) {
    CATransaction.begin(); CATransaction.setDisableActions(true)
    let hole = CGMutablePath()
    hole.addRect(bounds)
    if let rect { hole.addRect(rect) }
    dim.path = hole
    let outline = rect.map { CGPath(roundedRect: $0, cornerWidth: 4, cornerHeight: 4, transform: nil) }
    line.path = outline; halo.path = outline
    if let rect {
      let side = hypot(bounds.width, bounds.height) * 2
      spin.bounds = CGRect(x: 0, y: 0, width: side, height: side)
      spin.position = CGPoint(x: rect.midX, y: rect.midY)
      let scale = window?.backingScaleFactor ?? 2
      label.string = "\(Int(rect.width * scale)) × \(Int(rect.height * scale))"
      label.frame = CGRect(x: rect.maxX - 92, y: rect.minY - 26, width: 92, height: 18)
    }
    label.isHidden = rect == nil || windowMode
    CATransaction.commit()
  }

  override func mouseDown(with event: NSEvent) {
    if windowMode { if let hovered { if recordMode { quick(window: hovered.id, rect: hovered.rect.offsetBy(dx: window!.frame.minX, dy: window!.frame.minY)) } else { finish { capture(window: hovered.id) } } }; return }
    start = convert(event.locationInWindow, from: nil)
  }
  override func mouseDragged(with event: NSEvent) {
    guard let start else { return }
    let point = convert(event.locationInWindow, from: nil)
    show(NSRect(x: min(start.x, point.x), y: min(start.y, point.y), width: abs(point.x - start.x), height: abs(point.y - start.y)))
    sparkles.emitterPosition = point
    sparkles.birthRate = 1
  }
  override func mouseUp(with event: NSEvent) {
    sparkles.birthRate = 0
    guard let begin = start else { return }
    start = nil
    let point = convert(event.locationInWindow, from: nil)
    let rect = NSRect(x: min(begin.x, point.x), y: min(begin.y, point.y), width: abs(point.x - begin.x), height: abs(point.y - begin.y))
    if rect.width < 4 || rect.height < 4 { show(nil); return }
    let origin = window!.frame.origin
    trace("area drawn: \(Int(rect.width))×\(Int(rect.height))")
    if recordMode { quick(area: rect.offsetBy(dx: origin.x, dy: origin.y)); return }
    finish { capture(area: rect.offsetBy(dx: origin.x, dy: origin.y)) }
  }
  override func mouseMoved(with event: NSEvent) {
    guard windowMode else { return }
    hovered = windowUnderMouse().map { ($0.id, $0.rect.offsetBy(dx: -window!.frame.minX, dy: -window!.frame.minY)) }
    show(hovered?.rect)
  }
  override func keyDown(with event: NSEvent) {
    if event.keyCode == UInt16(kVK_Escape) { finish(nil) }
    if event.keyCode == UInt16(kVK_Space) { windowMode.toggle(); start = nil; hovered = nil; show(nil); if windowMode { mouseMoved(with: event) } }
  }
}

// A soft round particle for the sparkles.
let dot: CGImage = {
  let context = CGContext(data: nil, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  let glow = CGGradient(colorsSpace: nil, colors: [NSColor.white.cgColor, NSColor(white: 1, alpha: 0).cgColor] as CFArray, locations: [0, 1])!
  context.drawRadialGradient(glow, startCenter: CGPoint(x: 8, y: 8), startRadius: 0, endCenter: CGPoint(x: 8, y: 8), endRadius: 8, options: [])
  return context.makeImage()!
}()

// Screen coordinates: AppKit counts from the bottom of the main screen, screencapture and window bounds from the top.
let mainHeight = { NSScreen.screens[0].frame.height }
func windowUnderMouse() -> (id: CGWindowID, rect: NSRect)? {
  let mouse = NSEvent.mouseLocation
  let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  for info in windows where info[kCGWindowLayer as String] as? Int == 0 && info[kCGWindowOwnerPID as String] as? Int32 != getpid() {
    guard let bounds = info[kCGWindowBounds as String] as? NSDictionary, let box = CGRect(dictionaryRepresentation: bounds) else { continue }
    let rect = NSRect(x: box.minX, y: mainHeight() - box.maxY, width: box.width, height: box.height)
    if rect.contains(mouse) { return (info[kCGWindowNumber as String] as! CGWindowID, rect) }
  }
  return nil
}

func screencapture(_ options: [String]) -> CGImage? {
  let file = FileManager.default.temporaryDirectory.appendingPathComponent("ciak-shot-\(getpid()).png")
  let process = Process()
  process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
  process.arguments = ["-x"] + options + [file.path]
  try? process.run()
  process.waitUntilExit()
  defer { try? FileManager.default.removeItem(at: file) }
  return NSImage(contentsOf: file)?.cgImage(forProposedRect: nil, context: nil, hints: nil)
}
func capture(area: NSRect) -> CGImage? {
  screencapture(["-R", "\(Int(area.minX)),\(Int(mainHeight() - area.maxY)),\(Int(area.width)),\(Int(area.height))"])
}
func capture(window id: CGWindowID) -> CGImage? { screencapture(["-o", "-l", "\(id)"]) }

// Same look as ciak shot: padding 7% of the longest side, rounded corners, a soft shadow, a faint edge.
func framed(_ shot: CGImage) -> Data? {
  let (width, height) = (shot.width, shot.height)
  let padding = Int((Double(max(width, height)) * 0.07).rounded())
  let radius = max(10, CGFloat(min(width, height)) * 0.018)
  let shadow = CGFloat(padding) * 0.5
  guard let context = CGContext(data: nil, width: width + 2 * padding, height: height + 2 * padding, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return nil }
  let canvas = CGRect(x: 0, y: 0, width: context.width, height: context.height)
  if let wallpaper { context.draw(wallpaper, in: canvas) } else { context.setFillColor(CGColor(red: 0.06, green: 0.07, blue: 0.15, alpha: 1)); context.fill(canvas) }
  let rect = CGRect(x: padding, y: padding, width: width, height: height)
  let path = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)
  context.saveGState()
  context.setShadow(offset: CGSize(width: 0, height: -shadow * 0.4), blur: shadow, color: CGColor(gray: 0, alpha: 0.6))
  context.addPath(path); context.setFillColor(CGColor(gray: 0, alpha: 1)); context.fillPath()
  context.restoreGState()
  context.saveGState(); context.addPath(path); context.clip(); context.draw(shot, in: rect); context.restoreGState()
  context.addPath(path); context.setStrokeColor(CGColor(gray: 1, alpha: 0.12)); context.setLineWidth(2); context.strokePath()
  return context.makeImage().flatMap { NSBitmapImageRep(cgImage: $0).representation(using: .png, properties: [:]) }
}

let shutter = NSSound(contentsOfFile: "/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/Screen Capture.aif", byReference: true) ?? NSSound(named: "Glass")

// Closes the overlay; then (unless cancelled) takes the shot, frames, saves and copies it. The panel stays closed.
func finish(_ take: (() -> CGImage?)?) {
  overlays.forEach { $0.orderOut(nil) }
  overlays = []
  guard let take else { return }
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { // let the overlay leave the screen first
    guard let shot = take() else { return }
    shutter?.play()
    guard let png = framed(shot) else { return }
    let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-").prefix(19)
    let file = outputDir.appendingPathComponent("shot-\(stamp).png")
    try? FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
    do { try png.write(to: file) } catch { fputs("Could not save \(file.path): \(error)\n", stderr); return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setData(png, forType: .png)
  }
}

// Quick recording (⌘2): the picked area or window records (default mic) with a red frame around it and a small
// timer; ⌘2 again (the app sends SIGUSR1) or a click on the timer stops it, renders it and opens it in the panel.
let recordMode = UserDefaults.standard.string(forKey: "mode") == "record"
let cli = setting("cli") ?? "ciak"
func sound(_ name: String) { NSSound(contentsOfFile: "/System/Library/Components/CoreAudio.component/Contents/SharedSupport/SystemSounds/system/\(name).caf", byReference: true)?.play() }
// Runs the ciak command and returns its JSON (nil and a message on failure).
func ciak(_ arguments: [String], wait: Bool = true) -> [String: Any]? {
  let began = Date()
  trace("runs: ciak \(arguments.joined(separator: " "))")
  defer { if wait { trace("ciak \(arguments[0]) returned after \(String(format: "%.2f", Date().timeIntervalSince(began))) s") } }
  let process = Process(), output = Pipe(), errors = Pipe()
  process.executableURL = URL(fileURLWithPath: cli)
  process.arguments = arguments
  process.standardOutput = wait ? output : FileHandle.nullDevice
  process.standardError = wait ? errors : FileHandle.nullDevice
  do { try process.run() } catch { alert("Cannot run ciak", error.localizedDescription); return nil }
  guard wait else { return [:] }
  let data = output.fileHandleForReading.readDataToEndOfFile(), problem = errors.fileHandleForReading.readDataToEndOfFile()
  process.waitUntilExit()
  if process.terminationStatus != 0 {
    trace("ciak \(arguments[0]) failed: \(String(decoding: problem, as: UTF8.self).suffix(300))")
    let message = String(decoding: problem, as: UTF8.self).split(separator: "\n").last.flatMap { try? JSONSerialization.jsonObject(with: Data($0.utf8)) as? [String: Any] }?["error"] as? String
    alert("Quick recording failed", message ?? String(decoding: problem, as: UTF8.self)); return nil
  }
  return try? JSONSerialization.jsonObject(with: data) as? [String: Any]
}
func alert(_ title: String, _ text: String) {
  // Calls from a background thread (stopping runs on one) crashed the picker: windows only on the main thread.
  guard Thread.isMainThread else { return DispatchQueue.main.async { alert(title, text) } }
  NSApp.activate(ignoringOtherApps: true)
  let box = NSAlert(); box.messageText = title; box.informativeText = text; box.runModal()
}

// The screen holding most of the area (by its id: an index can point at another screen when one comes or goes), and the
// area inside it in points from its top left.
func quick(area: NSRect) {
  guard let screen = NSScreen.screens.max(by: { $0.frame.intersection(area).width * $0.frame.intersection(area).height < $1.frame.intersection(area).width * $1.frame.intersection(area).height }) else { return }
  let id = { (screen: NSScreen) in screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? CGDirectDisplayID ?? 0 }
  let clipped = screen.frame.intersection(area)
  let region = [clipped.minX - screen.frame.minX, screen.frame.maxY - clipped.maxY, clipped.width, clipped.height].map { String(Int($0.rounded())) }
  record(["--display-id", String(id(screen)), "--region", region.joined(separator: ",")], around: clipped)
}
func quick(window id: CGWindowID, rect: NSRect) { record(["--window", String(id)], around: rect) }

var session: String?
var started = Date()
var frames: [NSWindow] = []
final class Timer: NSView {
  let text = CATextLayer()
  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    layer!.backgroundColor = NSColor(calibratedRed: 0.85, green: 0.2, blue: 0.18, alpha: 0.95).cgColor
    layer!.cornerRadius = frame.height / 2
    text.frame = bounds.insetBy(dx: 8, dy: 5)
    text.fontSize = 12
    text.font = NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .semibold)
    text.foregroundColor = NSColor.white.cgColor
    text.alignmentMode = .center
    text.contentsScale = 2
    layer!.addSublayer(text)
  }
  required init?(coder: NSCoder) { nil }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func mouseDown(with event: NSEvent) { stop() }
  override func resetCursorRects() { addCursorRect(bounds, cursor: .pointingHand) }
}

func record(_ source: [String], around rect: NSRect) {
  overlays.forEach { $0.orderOut(nil) }
  overlays = []
  // The frame shows at once (grey: starting, about 2 s); it turns red with a sound when the recording runs.
  let frame = NSWindow(contentRect: rect.insetBy(dx: -3, dy: -3), styleMask: .borderless, backing: .buffered, defer: false)
  frame.isOpaque = false; frame.backgroundColor = .clear; frame.ignoresMouseEvents = true; frame.hasShadow = false
  frame.level = .screenSaver; frame.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]; frame.sharingType = .none
  let border = NSView(); border.wantsLayer = true
  border.layer!.borderColor = NSColor(white: 0.75, alpha: 0.9).cgColor; border.layer!.borderWidth = 3; border.layer!.cornerRadius = 5
  frame.contentView = border
  frame.orderFrontRegardless()
  let pill = NSPanel(contentRect: NSRect(x: rect.midX - 100, y: max(rect.minY - 38, 4), width: 200, height: 26), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
  pill.isOpaque = false; pill.backgroundColor = .clear; pill.level = .screenSaver; pill.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]; pill.sharingType = .none
  let timer = Timer(frame: NSRect(x: 0, y: 0, width: 200, height: 26))
  timer.layer!.backgroundColor = NSColor(white: 0.25, alpha: 0.95).cgColor
  timer.text.string = "Starting…"
  pill.contentView = timer
  pill.orderFrontRegardless()
  frames = [frame, pill]
  trace("grey frame shown")
  DispatchQueue.global().async {
    let result = ciak(["start"] + source + ["--fps", "60", "--name", "Quick recording"])
    DispatchQueue.main.async {
      guard let id = result?["id"] as? String else { done(); return }
      session = id
      started = Date()
      trace("red frame: recording")
      sound("begin_record")
      border.layer!.borderColor = NSColor(calibratedRed: 1, green: 0.27, blue: 0.23, alpha: 1).cgColor
      timer.layer!.backgroundColor = NSColor(calibratedRed: 0.85, green: 0.2, blue: 0.18, alpha: 0.95).cgColor
      func tick() {
        guard session == id, !stopping else { return }
        let seconds = Int(Date().timeIntervalSince(started))
        timer.text.string = "● \(seconds / 60):\(String(format: "%02d", seconds % 60))   ⌘2 or click to stop"
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.5, execute: tick)
      }
      tick()
    }
  }
}

// Stop: the panel opens on the project at once and shows the finishing and render steps as they happen.
var stopping = false
func stop() {
  guard let id = session, !stopping else { return }
  stopping = true
  trace("stop pressed")
  frames.forEach { $0.orderOut(nil) }
  sound("end_record")
  DispatchQueue.global().async {
    // Both at once: by the time the page asks, the recording is already finishing.
    _ = ciak(["ui", "--project", id], wait: false)
    if ciak(["stop", id]) != nil { _ = ciak(["render", id], wait: false) }
    DispatchQueue.main.async(execute: done)
  }
}

// Back to waiting for the next press, hidden.
func done() {
  overlays.forEach { $0.orderOut(nil) }
  overlays = []
  frames.forEach { $0.orderOut(nil) }
  frames = []
  session = nil
  stopping = false
}

// The app's key (SIGUSR1): stop a recording, cancel an open overlay, or open the overlay.
signal(SIGUSR1, SIG_IGN)
let pressed = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
pressed.setEventHandler {
  trace("key pressed (\(stopping ? "stopping" : session != nil ? "recording" : !frames.isEmpty ? "starting" : !overlays.isEmpty ? "overlay open" : "idle"))")
  if stopping || (!frames.isEmpty && session == nil) { return }  // finishing, or still starting
  if session != nil { stop() } else if !overlays.isEmpty { finish(nil) } else { begin() }
}
pressed.resume()

func pick() {
  defer { trace("overlay shown") }
  if recordMode { _ = ciak(["ui", "--no-open"], wait: false) }  // the panel's server, ready for when this recording stops
  for screen in NSScreen.screens {
    let overlay = Overlay(contentRect: screen.frame, styleMask: .borderless, backing: .buffered, defer: false)
    overlay.level = .screenSaver
    overlay.isOpaque = false
    overlay.backgroundColor = .clear
    overlay.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
    overlay.acceptsMouseMovedEvents = true
    overlay.contentView = Picker(frame: NSRect(origin: .zero, size: screen.frame.size))
    overlay.orderFrontRegardless()
    overlays.append(overlay)
  }
  NSApp.activate(ignoringOtherApps: true)
  let mouse = NSEvent.mouseLocation
  let current = overlays.first { $0.frame.contains(mouse) } ?? overlays[0]
  current.makeKey()
  current.makeFirstResponder(current.contentView)
}

// Check the frame without a picker: ciak-picker -frame <shot.png> -wallpaper <png> writes <shot>.framed.png
if let file = UserDefaults.standard.string(forKey: "frame") {
  guard let shot = NSImage(contentsOfFile: file)?.cgImage(forProposedRect: nil, context: nil, hints: nil), let png = framed(shot) else { exit(1) }
  try! png.write(to: URL(fileURLWithPath: file + ".framed.png"))
  exit(0)
}
NSApplication.shared.setActivationPolicy(.accessory)
// For tests: defaults write com.ciak.app area x,y,w,h (screen points from the top left) captures (or records) that area without the overlay.
func begin() {
  CFPreferencesAppSynchronize("com.ciak.app" as CFString)
  if let area = setting("area")?.split(separator: ",").compactMap({ Double($0) }), area.count == 4 {
    let rect = NSRect(x: area[0], y: mainHeight() - area[1] - area[3], width: area[2], height: area[3])
    if recordMode { quick(area: rect) } else { finish { capture(area: rect) } }
  } else { pick() }
}
trace("loaded, \(recordMode ? "quick recording" : "screenshot") mode")
begin()
NSApplication.shared.run()
