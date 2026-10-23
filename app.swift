// justrec.app: the menu bar app (justrec install), kept small on purpose. macOS ties Screen Recording and
// Microphone permission to this exact build, and programs it starts use its permission. So every feature
// lives in what it starts (justrec-picker for screenshots, the recording panel and recorder via the justrec
// command) and those can change freely; changing this file makes the user grant the permission again.
// It has: the menu, one global key (RegisterEventHotKey, no Accessibility permission), the permission check.
// Settings (defaults com.justrec.app, written by install): key, picker, cli, recordings.
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
let home = FileManager.default.homeDirectoryForCurrentUser
let recordingsDir = URL(fileURLWithPath: settings.string(forKey: "recordings") ?? home.appendingPathComponent("Documents/justrec").path)

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

// Starts a helper as this app's child, so it runs with this app's permission. One copy at a time.
var helpers: [String: Process] = [:]
func start(_ path: String, _ arguments: [String] = [], output: Pipe? = nil) -> Process? {
  if let running = helpers[path], running.isRunning { return nil }
  let process = Process()
  process.executableURL = URL(fileURLWithPath: path)
  process.arguments = arguments
  if let output { process.standardOutput = output }
  do { try process.run() } catch { _ = tell("Cannot start \(URL(fileURLWithPath: path).lastPathComponent)", error.localizedDescription); return nil }
  helpers[path] = process
  return process
}

func pick() {
  guard permitted(), let picker = settings.string(forKey: "picker") else { return }
  _ = start(picker)
}

// The menu bar icon: screenshot, and Record… which opens the recording panel (justrec ui, one copy at a time).
final class Menu: NSObject, NSMenuDelegate {
  let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
  var panelURL: URL?

  override init() {
    super.init()
    let menu = NSMenu()
    menu.delegate = self
    item.menu = menu
    item.button?.image = NSImage(systemSymbolName: "record.circle", accessibilityDescription: "justrec")
  }
  func menuNeedsUpdate(_ menu: NSMenu) {
    menu.removeAllItems()
    let shot = NSMenuItem(title: "Take Screenshot", action: #selector(screenshot), keyEquivalent: keyCodes.first { $0.value == code }?.key ?? "")
    shot.keyEquivalentModifierMask = NSEvent.ModifierFlags(rawValue: (modifiers & cmdKey != 0 ? NSEvent.ModifierFlags.command.rawValue : 0)
      | (modifiers & shiftKey != 0 ? NSEvent.ModifierFlags.shift.rawValue : 0) | (modifiers & optionKey != 0 ? NSEvent.ModifierFlags.option.rawValue : 0)
      | (modifiers & controlKey != 0 ? NSEvent.ModifierFlags.control.rawValue : 0))
    for entry in [shot, NSMenuItem(title: "Record…", action: #selector(panel), keyEquivalent: ""), .separator(),
                  NSMenuItem(title: "Open Recordings", action: #selector(folder), keyEquivalent: ""), .separator(),
                  NSMenuItem(title: "Quit justrec", action: #selector(quit), keyEquivalent: "q")] {
      entry.target = self
      menu.addItem(entry)
    }
  }
  @objc func screenshot() { DispatchQueue.main.asyncAfter(deadline: .now() + 0.2, execute: pick) } // after the menu closes
  @objc func folder() { NSWorkspace.shared.open(recordingsDir) }
  @objc func quit() { helpers.values.forEach { $0.terminate() }; NSApp.terminate(nil) }
  // The panel records as a child of this app, so it uses this app's Screen Recording permission.
  @objc func panel() {
    guard permitted(), let cli = settings.string(forKey: "cli") else { return }
    let output = Pipe()
    // ui opens the page itself and prints {"url": …} first; when it already runs, open its page again.
    guard start(cli, ["ui"], output: output) != nil else { if let panelURL { NSWorkspace.shared.open(panelURL) }; return }
    output.fileHandleForReading.readabilityHandler = { handle in
      if let json = try? JSONSerialization.jsonObject(with: handle.availableData) as? [String: Any], let url = json["url"] as? String {
        handle.readabilityHandler = nil
        DispatchQueue.main.async { self.panelURL = URL(string: url) }
      }
    }
  }
}

// Opened again from Finder or Spotlight while running: one menu bar icon is enough.
if NSRunningApplication.runningApplications(withBundleIdentifier: "com.justrec.app").contains(where: { $0.processIdentifier != getpid() }) { exit(0) }
NSApplication.shared.setActivationPolicy(.accessory)
let menu = Menu()
signal(SIGUSR1, SIG_IGN) // kill -USR1 <pid> opens the picker too (for testing)
let usr1 = DispatchSource.makeSignalSource(signal: SIGUSR1, queue: .main)
usr1.setEventHandler(handler: pick)
usr1.resume()
signal(SIGUSR2, SIG_IGN) // kill -USR2 <pid> = Record… from the menu (for testing)
let usr2 = DispatchSource.makeSignalSource(signal: SIGUSR2, queue: .main)
usr2.setEventHandler { menu.panel() }
usr2.resume()
var eventType = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in DispatchQueue.main.async(execute: pick); return noErr }, 1, &eventType, nil, nil)
var reference: EventHotKeyRef?
let status = RegisterEventHotKey(UInt32(code), UInt32(modifiers), EventHotKeyID(signature: OSType(0x4A524543), id: 1), GetApplicationEventTarget(), 0, &reference)
if status != noErr { fputs("The shortcut \(key) is taken by another app (error \(status)): screenshots only from the menu. Pick another with justrec install --key.\n", stderr) }
print("ready \(key)"); fflush(stdout)
NSApplication.shared.run()
