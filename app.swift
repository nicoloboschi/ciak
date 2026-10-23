// justrec.app: the menu bar app (justrec install). It owns Screen Recording and Microphone permission for
// what it starts, and has the screenshot shortcut (⌘1): one global key (RegisterEventHotKey, no Accessibility
// permission) that opens a selection overlay with a glowing border, captures the area (or a window: space),
// puts it on the wallpaper with rounded corners and a shadow, saves it, copies it, and shows it in Finder.
// Settings come as arguments: -key cmd+1 -wallpaper <png> -shots <dir> -recordings <dir> -cli <justrec>
import AppKit
import Carbon

let keyCodes: [String: Int] = [
  "a": kVK_ANSI_A, "b": kVK_ANSI_B, "c": kVK_ANSI_C, "d": kVK_ANSI_D, "e": kVK_ANSI_E, "f": kVK_ANSI_F, "g": kVK_ANSI_G,
  "h": kVK_ANSI_H, "i": kVK_ANSI_I, "j": kVK_ANSI_J, "k": kVK_ANSI_K, "l": kVK_ANSI_L, "m": kVK_ANSI_M, "n": kVK_ANSI_N,
  "o": kVK_ANSI_O, "p": kVK_ANSI_P, "q": kVK_ANSI_Q, "r": kVK_ANSI_R, "s": kVK_ANSI_S, "t": kVK_ANSI_T, "u": kVK_ANSI_U,
  "v": kVK_ANSI_V, "w": kVK_ANSI_W, "x": kVK_ANSI_X, "y": kVK_ANSI_Y, "z": kVK_ANSI_Z,
  "0": kVK_ANSI_0, "1": kVK_ANSI_1, "2": kVK_ANSI_2, "3": kVK_ANSI_3, "4": kVK_ANSI_4,
  "5": kVK_ANSI_5, "6": kVK_ANSI_6, "7": kVK_ANSI_7, "8": kVK_ANSI_8, "9": kVK_ANSI_9,
]
let modifierFlags: [String: Int] = ["cmd": cmdKey, "shift": shiftKey, "opt": optionKey, "alt": optionKey, "ctrl": controlKey]

let settings = UserDefaults.standard
let key = settings.string(forKey: "key") ?? "cmd+1"
var keyCode: Int?
var modifiers = 0
for part in key.lowercased().split(separator: "+").map(String.init) {
  if let flag = modifierFlags[part] { modifiers |= flag } else { keyCode = keyCodes[part] }
}
let code = keyCode ?? 0
guard keyCode != nil, modifiers != 0 else { fputs("Shortcut must be modifiers plus a letter or digit, e.g. cmd+1\n", stderr); exit(2) }
let wallpaper = settings.string(forKey: "wallpaper").flatMap { NSImage(contentsOfFile: $0)?.cgImage(forProposedRect: nil, context: nil, hints: nil) }
let home = FileManager.default.homeDirectoryForCurrentUser
let recordingsDir = URL(fileURLWithPath: settings.string(forKey: "recordings") ?? home.appendingPathComponent("Documents/justrec").path)
let outputDir = URL(fileURLWithPath: settings.string(forKey: "shots") ?? recordingsDir.appendingPathComponent("shots").path)
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
    if windowMode { if let hovered { finish { capture(window: hovered.id) } }; return }
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
  let file = FileManager.default.temporaryDirectory.appendingPathComponent("justrec-shot-\(getpid()).png")
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

// Same look as justrec shot: padding 7% of the longest side, rounded corners, a soft shadow, a faint edge.
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

// Closes the overlay; then (unless cancelled) takes the shot, frames, saves, copies, and shows it in Finder.
func finish(_ take: (() -> CGImage?)?) {
  overlays.forEach { $0.orderOut(nil) }
  overlays = []
  guard let take else { NSApp.hide(nil); return }
  DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { // let the overlay leave the screen first
    guard let shot = take() else { NSApp.hide(nil); return }
    shutter?.play()
    guard let png = framed(shot) else { return }
    let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-").prefix(19)
    let file = outputDir.appendingPathComponent("shot-\(stamp).png")
    try? FileManager.default.createDirectory(at: outputDir, withIntermediateDirectories: true)
    do { try png.write(to: file) } catch { fputs("Could not save \(file.path): \(error)\n", stderr); return }
    NSPasteboard.general.clearContents()
    NSPasteboard.general.setData(png, forType: .png)
    NSWorkspace.shared.activateFileViewerSelecting([file])
  }
}

func tell(_ title: String, _ text: String, button: String = "OK") -> Bool {
  NSApp.activate(ignoringOtherApps: true)
  let alert = NSAlert()
  alert.messageText = title
  alert.informativeText = text
  alert.addButton(withTitle: button)
  if button != "OK" { alert.addButton(withTitle: "Later") }
  return alert.runModal() == .alertFirstButtonReturn
}

// Without Screen Recording, captures come out as the bare wallpaper. macOS applies a new grant only to a
// fresh process, so: say so, show the setting, and restart once the user allowed it (launchd starts us again).
func permitted() -> Bool {
  if CGPreflightScreenCaptureAccess() { return true }
  CGRequestScreenCaptureAccess()
  NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")!)
  if tell("justrec needs Screen Recording", "Turn on justrec in System Settings › Privacy & Security › Screen Recording, then restart justrec.", button: "Restart justrec") {
    let restart = Process()
    restart.executableURL = URL(fileURLWithPath: "/bin/launchctl")
    restart.arguments = ["kickstart", "-k", "gui/\(getuid())/com.justrec.app"]
    try? restart.run()
  }
  return false
}

func pick() {
  if !overlays.isEmpty || !permitted() { return }
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

// Runs the justrec command in the background; hands its JSON output back on the main thread, or shows
// what went wrong (the command's last error lines) instead of failing silently.
func justrec(_ arguments: [String], then done: @escaping ([String: Any]) -> Void = { _ in }) {
  DispatchQueue.global().async {
    let process = Process(), output = Pipe(), errors = Pipe()
    process.executableURL = URL(fileURLWithPath: settings.string(forKey: "cli") ?? "justrec")
    process.arguments = arguments
    process.standardOutput = output
    process.standardError = errors
    var problem = ""
    do { try process.run() } catch { problem = error.localizedDescription }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    let said = String(decoding: errors.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    if problem.isEmpty { process.waitUntilExit() }
    let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    DispatchQueue.main.async {
      if let json, process.terminationStatus == 0 { return done(json) }
      fputs("justrec \(arguments.joined(separator: " ")) failed: \(said)\n", stderr)
      let reason = problem.isEmpty ? said.split(separator: "\n").suffix(3).joined(separator: "\n") : problem
      _ = tell("justrec \(arguments[0]) failed", reason.isEmpty ? "No details; see ~/.justrec/app.log" : reason)
      done([:])
    }
  }
}

// The menu bar icon: screenshot, record the main display (with the default mic), the recording panel.
final class Menu: NSObject, NSMenuDelegate {
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  var recording: Date?
  var busy = false
  var timer: Timer?

  override init() {
    super.init()
    let menu = NSMenu()
    menu.delegate = self
    item.menu = menu
    show()
  }
  func show() {
    let symbol = recording == nil ? "record.circle" : "stop.circle.fill"
    item.button?.image = NSImage(systemSymbolName: symbol, accessibilityDescription: "justrec")
    item.button?.contentTintColor = recording == nil ? nil : .systemRed
    item.button?.title = recording.map { String(format: " %d:%02d", Int(-$0.timeIntervalSinceNow) / 60, Int(-$0.timeIntervalSinceNow) % 60) } ?? ""
  }
  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let shot = NSMenuItem(title: "Take Screenshot", action: #selector(screenshot), keyEquivalent: keyCodes.first { $0.value == code }?.key ?? "")
    shot.keyEquivalentModifierMask = NSEvent.ModifierFlags(rawValue: (modifiers & cmdKey != 0 ? NSEvent.ModifierFlags.command.rawValue : 0)
      | (modifiers & shiftKey != 0 ? NSEvent.ModifierFlags.shift.rawValue : 0) | (modifiers & optionKey != 0 ? NSEvent.ModifierFlags.option.rawValue : 0)
      | (modifiers & controlKey != 0 ? NSEvent.ModifierFlags.control.rawValue : 0))
    let record = NSMenuItem(title: busy ? "Saving…" : recording == nil ? "Record Screen" : "Stop Recording", action: busy ? nil : #selector(toggle), keyEquivalent: "")
    for entry in [shot, record, NSMenuItem(title: "Recording Panel…", action: #selector(panel), keyEquivalent: ""), .separator(),
                  NSMenuItem(title: "Open Recordings", action: #selector(folder), keyEquivalent: ""), .separator(),
                  NSMenuItem(title: "Quit justrec", action: #selector(quit), keyEquivalent: "q")] {
      entry.target = self
      menu.addItem(entry)
    }
  }
  @objc func screenshot() { DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: pick) } // after the menu closes
  @objc func panel() { justrec(["ui"]) }
  @objc func folder() { NSWorkspace.shared.open(recordingsDir) }
  @objc func quit() { NSApp.terminate(nil) }
  @objc func toggle() {
    if recording == nil {
      guard permitted() else { return }
      busy = true
      justrec(["start", "--display", "0", "--name", "screen"]) { result in
        self.busy = false
        guard result["id"] != nil else { return }
        self.recording = Date()
        self.timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in self.show() }
        self.show()
      }
    } else {
      busy = true
      timer?.invalidate()
      recording = nil
      show()
      justrec(["stop"]) { result in
        self.busy = false
        if let output = result["output"] as? String { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: output)]) }
      }
    }
  }
}

// Check the frame without a key press: justrec.app/Contents/MacOS/justrec -frame <shot.png> -wallpaper <png> writes <shot>.framed.png
if let file = settings.string(forKey: "frame") {
  guard let shot = NSImage(contentsOfFile: file)?.cgImage(forProposedRect: nil, context: nil, hints: nil), let png = framed(shot) else { exit(1) }
  try! png.write(to: URL(fileURLWithPath: file + ".framed.png"))
  exit(0)
}
// Opened again from Finder or Spotlight while running: one menu bar icon is enough.
if NSRunningApplication.runningApplications(withBundleIdentifier: "com.justrec.app").contains(where: { $0.processIdentifier != getpid() }) { exit(0) }
NSApplication.shared.setActivationPolicy(.accessory)
let menu = Menu()
signal(SIGUSR1, SIG_IGN) // kill -USR1 <pid> opens the picker too (for testing)
let usr1 = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
usr1.setEventHandler(handler: pick)
usr1.resume()
signal(SIGUSR2, SIG_IGN) // kill -USR2 <pid> = Record Screen / Stop Recording from the menu (for testing)
let usr2 = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
usr2.setEventHandler { menu.toggle() }
usr2.resume()
var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in DispatchQueue.main.async(execute: pick); return noErr }, 1, &eventType, nil, nil)
var reference: EventHotKeyRef?
let status = RegisterEventHotKey(UInt32(code), UInt32(modifiers), EventHotKeyID(signature: OSType(0x4A524543), id: 1), GetApplicationEventTarget(), 0, &reference)
if status != noErr { fputs("The shortcut \(key) is taken by another app (error \(status)): screenshots only from the menu. Pick another with justrec install --key.\n", stderr) }
print("ready \(key)"); fflush(stdout)
NSApplication.shared.run()
